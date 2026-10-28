import type { ControlSettings } from '../config';
import type { FloatWordOrder } from '../constants';
import type { RegisterEntry } from '../registers/types';
import type { Logger } from '../runner-kit';
import { stateIdFor, toStateValue } from '../state-model';
import { ACKNOWLEDGE_ID, isWritable } from './groups';
import { toNumber } from './rules';
import {
    type WriteCounters,
    type WriteExecutor,
    type SchedulerOptions,
    type WriteOutcome,
    WriteScheduler,
} from './scheduler';

/** What the runner needs from the adapter; a fake in the tests. */
export interface ControlHost {
    /** clock in ms */
    now(): number;
    /** log lines */
    log: Logger;
    /** managed timers */
    timers: SchedulerOptions['timers'];
    /** connection to the Navigator */
    executor: WriteExecutor;
    /** latest value the poller read for a register (to restore a state after a refused write) */
    lastKnown(registerId: string): number | undefined;
    /** subscribe to changes of one of our states */
    subscribe(stateId: string): void;
    /** set one of our states, acknowledged */
    acknowledge(stateId: string, value: number | boolean | null): void;
    /** report an error for `diag.lastError` */
    reportError(message: string): void;
    /** publish the write counter of a register (`diag.writes.<id>`) */
    publishCounter(registerId: string, counters: WriteCounters): void;
    /** read the persisted counters (JSON) */
    loadCounters(): Promise<string | null>;
    /** persist the counters (JSON) */
    saveCounters(json: string): void;
}

/** Settings of the runner. */
export interface ControlOptions {
    /** all registers of the family */
    registers: readonly RegisterEntry[];
    /** which groups may be written */
    control: ControlSettings;
    /** FLOAT word order */
    floatWordOrder: FloatWordOrder;
    /** local date key `YYYY-MM-DD` */
    dateKey(ms: number): string;
}

/**
 * Turns changes of writable states (`ack=false`) into safe writes and reports the result back to the states
 * (spec Modul B). Only registers of groups the user switched on are subscribed at all.
 */
export class ControlRunner {
    private readonly scheduler: WriteScheduler;
    private readonly byStateId = new Map<string, RegisterEntry>();
    private readonly modeWarned = new Map<string, number>();

    /**
     * @param host adapter services
     * @param options registers and settings
     */
    public constructor(
        private readonly host: ControlHost,
        private readonly options: ControlOptions,
    ) {
        for (const reg of options.registers) {
            if (isWritable(reg, options.control)) {
                this.byStateId.set(stateIdFor(reg), reg);
            }
        }
        this.scheduler = new WriteScheduler({
            executor: host.executor,
            timers: host.timers,
            now: () => host.now(),
            log: host.log,
            context: { current: id => host.lastKnown(id), floatWordOrder: options.floatWordOrder },
            dateKey: options.dateKey,
            minEepromIntervalMs: options.control.minEepromIntervalMs,
            dailyWarnThreshold: options.control.dailyWarnThreshold,
        });
    }

    /** Number of writable states. */
    public get writableCount(): number {
        return this.byStateId.size;
    }

    /** Restore the write counters and subscribe to the writable states. */
    public async start(): Promise<void> {
        try {
            const saved = await this.host.loadCounters();
            if (saved) {
                this.scheduler.restore(JSON.parse(saved));
            }
        } catch {
            this.host.log.warn('The saved write counters could not be read and are ignored');
        }
        for (const stateId of this.byStateId.keys()) {
            this.host.subscribe(stateId);
        }
        this.host.log.info(`Control enabled: ${this.byStateId.size} states may be written`);
    }

    /** Cancel pending writes and save the counters. */
    public stop(): void {
        this.scheduler.shutdown();
        this.saveCounters();
    }

    /**
     * A state of ours changed.
     *
     * @param stateId state id relative to the namespace
     * @param state the new state
     */
    public onStateChange(stateId: string, state: { val: unknown; ack: boolean } | null | undefined): void {
        const reg = this.byStateId.get(stateId);
        if (!reg || !state || state.ack) {
            return;
        }
        void this.scheduler.submit(reg, state.val).then(outcome => this.finish(reg, stateId, state.val, outcome));
    }

    private finish(reg: RegisterEntry, stateId: string, requested: unknown, outcome: WriteOutcome): void {
        switch (outcome.kind) {
            case 'written':
            case 'unchanged': {
                const value = reg.id === ACKNOWLEDGE_ID ? false : toStateValue(reg, outcome.value);
                this.host.acknowledge(stateId, value);
                if (outcome.kind === 'written') {
                    this.host.log.info(`${reg.id} set to ${String(toNumber(requested))}`);
                    this.warnIfRoomModeIgnoresSetpoint(reg);
                    const counters = this.scheduler.counters[reg.id];
                    if (counters) {
                        this.host.publishCounter(reg.id, counters);
                    }
                    this.saveCounters();
                }
                break;
            }
            case 'refused':
            case 'failed':
                this.host.log.warn(outcome.message);
                this.host.reportError(outcome.message);
                this.restore(reg, stateId);
                break;
            case 'superseded':
                break;
        }
    }

    /**
     * A room takes a setpoint from the GLT only in operating mode "Normal" (IDM document, note at register 2004). Say so when
     * the user sets a setpoint while the room is in another mode - at most once per hour and room.
     *
     * @param reg the register that was written
     */
    private warnIfRoomModeIgnoresSetpoint(reg: RegisterEntry): void {
        if (!/^zm\d+_room\d+_setpoint$/.test(reg.id)) {
            return;
        }
        const modeId = reg.id.replace('_setpoint', '_mode');
        const mode = this.host.lastKnown(modeId);
        const now = this.host.now();
        if (mode !== undefined && mode !== 3 && now - (this.modeWarned.get(modeId) ?? 0) > 3600000) {
            this.modeWarned.set(modeId, now);
            this.host.log.warn(
                `${reg.id} was set, but the room's operating mode is ${mode}, not Normal (3): the Navigator ignores a setpoint from the building automation unless the room is in Normal mode`,
            );
        }
    }

    /**
     * After a refused or failed write the state shows what the Navigator really has again.
     *
     * @param reg the register
     * @param stateId its state id
     */
    private restore(reg: RegisterEntry, stateId: string): void {
        if (reg.id === ACKNOWLEDGE_ID) {
            this.host.acknowledge(stateId, false);
            return;
        }
        const known = this.host.lastKnown(reg.id);
        if (known !== undefined) {
            this.host.acknowledge(stateId, toStateValue(reg, known));
        }
    }

    private saveCounters(): void {
        this.host.saveCounters(JSON.stringify(this.scheduler.counters));
    }
}
