import type { PvSettings } from '../config';
import { PV_CONFLICT_AFTER, PV_NEUTRAL_VALUES, PV_READBACK_EVERY } from '../constants';
import type { FloatWordOrder } from '../constants';
import type { RegisterEntry } from '../registers/types';
import { type FeedHost, FeedRunner } from '../runner-kit';
import { planPvWrites } from './engine';

/** What the runner needs from the adapter; a fake in the tests. `publish` sets `pv.writer_conflict` and `pv.last_write`. */
export type PvHost = FeedHost;

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
export class PvRunner extends FeedRunner {
    private cycles = 0;
    private mismatches = 0;
    private readonly lastWritten = new Map<string, number>();
    private readonly warned = new Set<string>();
    private readonly byId: Map<string, RegisterEntry>;

    /**
     * @param host adapter services
     * @param options settings and registers
     */
    public constructor(
        host: PvHost,
        private readonly options: PvOptions,
    ) {
        super(host, options.floatWordOrder, options.settings.sources, 'PV value');
        this.byId = new Map(options.registers.map(reg => [reg.id, reg]));
    }

    /** Subscribe to the sources, read their current values and start the cycle. */
    public async start(): Promise<void> {
        const { settings } = this.options;
        for (const source of settings.sources) {
            if (this.byId.has(source.register)) {
                await this.watch(source.stateId);
            } else {
                this.host.log.warn(`PV register ${source.register} does not exist in this register family, ignored`);
            }
        }
        this.startCycle(settings.intervalMs);
        this.host.log.info(
            `PV module started: ${settings.sources.length} sources, every ${settings.intervalMs / 1000} s, surplus ${settings.surplusMode}`,
        );
    }

    /** One cycle: plan, write, sometimes read back. Never throws. */
    public tick(): Promise<void> {
        return this.cycle(async () => {
            const now = this.host.now();
            const plan = planPvWrites(this.options.settings, this.inputs, now);
            this.warnOnce(plan.skipped);
            let written = 0;
            for (const write of plan.writes) {
                const reg = this.byId.get(write.register);
                if (!reg) {
                    continue;
                }
                const value = await this.write(reg, write.value);
                if (value === 'failed') {
                    return;
                }
                if (value !== 'refused') {
                    this.lastWritten.set(write.register, value);
                    written++;
                }
            }
            if (written > 0) {
                this.host.publish('last_write', now);
            }
            this.cycles++;
            if (this.cycles % PV_READBACK_EVERY === 0 && written > 0) {
                await this.readBack();
            }
        });
    }

    /**
     * Warn once per problem and register; warn again if the problem comes back.
     *
     * @param skipped registers whose source is missing or too old in this cycle
     */
    private warnOnce(skipped: { register: string; reason: 'stale' | 'invalid' }[]): void {
        const keys = new Set(skipped.map(s => `${s.register}:${s.reason}`));
        for (const { register, reason } of skipped) {
            if (!this.warned.has(`${register}:${reason}`)) {
                this.host.log.warn(
                    `PV source of ${register} is ${reason === 'stale' ? 'too old' : 'missing or not a number'}, writing ${PV_NEUTRAL_VALUES[register] ?? 0}`,
                );
            }
        }
        this.warned.clear();
        keys.forEach(key => this.warned.add(key));
    }

    /** Compare what the Navigator holds with what was written; repeated differences mean a second writer. */
    private async readBack(): Promise<void> {
        let different = false;
        for (const [id, expected] of this.lastWritten) {
            const reg = this.byId.get(id);
            if (!reg) {
                continue;
            }
            const differs = await this.differs(reg, expected, 0.01);
            if (differs === undefined) {
                return;
            }
            different ||= differs;
        }
        this.mismatches = different ? this.mismatches + 1 : 0;
        this.setConflict(
            this.mismatches >= PV_CONFLICT_AFTER,
            'The PV registers of the Navigator keep changing after they were written: another energy manager seems to write them too',
        );
    }
}
