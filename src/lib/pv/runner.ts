import type { PvSettings } from '../config';
import { PV_CONFLICT_AFTER, PV_NEUTRAL_VALUES, PV_READBACK_EVERY } from '../constants';
import type { FloatWordOrder } from '../constants';
import { checkWrite } from '../control/rules';
import type { Result } from '../modbus/result';
import type { RegisterEntry } from '../registers/types';
import { interpretWords } from '../value';
import { type PvInput, planPvWrites } from './engine';

/** What the runner needs from the adapter; a fake in the tests. */
export interface PvHost {
    /** clock in ms */
    now(): number;
    /** log lines, never containing host names */
    log: { debug(message: string): void; info(message: string): void; warn(message: string): void };
    /** managed timers */
    timers: { setInterval: (cb: () => void, ms: number) => unknown; clearInterval: (handle: unknown) => void };
    /** the Navigator connection is up */
    connected(): boolean;
    /** read holding registers */
    read(address: number, count: number): Promise<Result<number[]>>;
    /** write holding registers (FC16) */
    write(address: number, words: readonly number[]): Promise<Result<void>>;
    /** subscribe to a foreign state */
    subscribe(stateId: string): void;
    /** current value of a foreign state */
    foreignState(stateId: string): Promise<{ val: unknown; ts: number } | null>;
    /** publish `pv.writer_conflict` and `pv.last_write` */
    publish(id: 'writer_conflict' | 'last_write', value: boolean | number): void;
}

/** Settings of the runner. */
export interface PvOptions {
    /** PV settings */
    settings: PvSettings;
    /** registers of the family (for address and type) */
    registers: readonly RegisterEntry[];
    /** FLOAT word order */
    floatWordOrder: FloatWordOrder;
}

/**
 * Writes PV values from foreign states to the Navigator in a fixed interval (spec Modul D). Every value is written every
 * cycle, even when unchanged, so the Navigator keeps it current. Every few cycles the registers are read back; if they keep
 * differing from what was written, a second writer is active.
 */
export class PvRunner {
    private timer: unknown;
    private busy = false;
    private cycle = 0;
    private mismatches = 0;
    private conflict = false;
    private readonly inputs = new Map<string, PvInput>();
    private readonly lastWritten = new Map<string, number>();
    private readonly warned = new Set<string>();
    private readonly byId: Map<string, RegisterEntry>;

    /**
     * @param host adapter services
     * @param options settings and registers
     */
    public constructor(
        private readonly host: PvHost,
        private readonly options: PvOptions,
    ) {
        this.byId = new Map(options.registers.map(reg => [reg.id, reg]));
    }

    /** Subscribe to the sources, read their current values and start the cycle. */
    public async start(): Promise<void> {
        const { settings } = this.options;
        for (const source of settings.sources) {
            if (!this.byId.has(source.register)) {
                this.host.log.warn(`PV register ${source.register} does not exist in this register family, ignored`);
                continue;
            }
            this.host.subscribe(source.stateId);
            try {
                await this.refresh(source.stateId);
            } catch {
                // the next cycle asks again
            }
        }
        this.host.publish('writer_conflict', false);
        this.timer = this.host.timers.setInterval(() => void this.tick(), settings.intervalMs);
        this.host.log.info(
            `PV module started: ${settings.sources.length} sources, every ${settings.intervalMs / 1000} s, surplus ${settings.surplusMode}`,
        );
    }

    /** Stop the cycle. */
    public stop(): void {
        if (this.timer !== undefined) {
            this.host.timers.clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /**
     * A subscribed foreign state changed.
     *
     * @param stateId foreign state id
     * @param state its new state
     */
    public onForeignState(stateId: string, state: { val: unknown; ts: number } | null | undefined): void {
        if (state && this.options.settings.sources.some(s => s.stateId === stateId)) {
            this.inputs.set(stateId, { val: state.val, ts: state.ts });
        }
    }

    private async refresh(stateId: string): Promise<void> {
        const state = await this.host.foreignState(stateId);
        if (state) {
            this.inputs.set(stateId, { val: state.val, ts: state.ts });
        }
    }

    /** One cycle: plan, write, sometimes read back. Never throws. */
    public async tick(): Promise<void> {
        if (this.busy || !this.host.connected()) {
            return;
        }
        this.busy = true;
        try {
            const now = this.host.now();
            const plan = planPvWrites(this.options.settings, this.inputs, now);
            for (const skipped of plan.skipped) {
                const key = `${skipped.register}:${skipped.reason}`;
                if (!this.warned.has(key)) {
                    this.warned.add(key);
                    this.host.log.warn(
                        `PV source of ${skipped.register} is ${skipped.reason === 'stale' ? 'too old' : 'missing or not a number'}, writing ${PV_NEUTRAL_VALUES[skipped.register] ?? 0}`,
                    );
                }
            }
            for (const key of [...this.warned]) {
                if (!plan.skipped.some(s => `${s.register}:${s.reason}` === key)) {
                    this.warned.delete(key); // warn again if the problem comes back
                }
            }
            let written = 0;
            for (const write of plan.writes) {
                const reg = this.byId.get(write.register);
                if (!reg) {
                    continue;
                }
                const check = checkWrite(reg, write.value, {
                    current: () => undefined,
                    floatWordOrder: this.options.floatWordOrder,
                });
                if (!check.ok) {
                    this.host.log.warn(`PV value for ${write.register} refused: ${check.message}`);
                    continue;
                }
                const result = await this.host.write(reg.address, check.words);
                if (!result.ok) {
                    this.host.log.debug(`PV write of ${write.register} failed: ${result.error.message}`);
                    return;
                }
                this.lastWritten.set(write.register, check.value);
                written++;
            }
            if (written > 0) {
                this.host.publish('last_write', now);
            }
            this.cycle++;
            if (this.cycle % PV_READBACK_EVERY === 0 && written > 0) {
                await this.readBack();
            }
        } catch (error) {
            this.host.log.debug(`PV cycle failed: ${(error as Error).message}`);
        } finally {
            this.busy = false;
        }
    }

    /** Compare what the Navigator holds with what was written; repeated differences mean a second writer. */
    private async readBack(): Promise<void> {
        let different = false;
        for (const [id, expected] of this.lastWritten) {
            const reg = this.byId.get(id);
            if (!reg) {
                continue;
            }
            const result = await this.host.read(reg.address, reg.words);
            if (!result.ok) {
                return;
            }
            const decoded = interpretWords(reg, result.value, this.options.floatWordOrder);
            if (decoded.value === null || Math.abs(decoded.value - expected) > 0.01) {
                different = true;
            }
        }
        this.mismatches = different ? this.mismatches + 1 : 0;
        const conflict = this.mismatches >= PV_CONFLICT_AFTER;
        if (conflict !== this.conflict) {
            this.conflict = conflict;
            this.host.publish('writer_conflict', conflict);
            if (conflict) {
                this.host.log.warn(
                    'The PV registers of the Navigator keep changing after they were written: another energy manager seems to write them too',
                );
            }
        }
    }
}
