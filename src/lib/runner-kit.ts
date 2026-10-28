import type { FloatWordOrder } from './constants';
import { checkWrite } from './control/rules';
import type { Result } from './modbus/result';
import type { RegisterEntry } from './registers/types';
import { interpretWords } from './value';

/** Log lines of a runner, never containing host names, PINs or credentials. */
export interface Logger {
    /** details for the debug level */
    debug(message: string): void;
    /** normal events */
    info(message: string): void;
    /** things the user should look at */
    warn(message: string): void;
}

/** The adapter's managed interval timers (CLAUDE.md rule 17). */
export interface IntervalTimers {
    /** start an interval */
    setInterval: (callback: () => void, ms: number) => unknown;
    /** stop an interval */
    clearInterval: (handle: unknown) => void;
}

/** The latest value of a foreign state. */
export interface ForeignState {
    /** the value as the state holds it */
    val: unknown;
    /** time of the last update in ms */
    ts: number;
}

/** One managed interval that can be started and stopped again. */
export class Ticker {
    private handle: unknown;

    /**
     * @param timers the adapter's managed timers
     */
    public constructor(private readonly timers: IntervalTimers) {}

    /**
     * Start the interval.
     *
     * @param callback what to call
     * @param ms interval in ms
     */
    public start(callback: () => void, ms: number): void {
        this.handle = this.timers.setInterval(callback, ms);
    }

    /** Stop the interval; harmless when it is not running. */
    public stop(): void {
        if (this.handle !== undefined) {
            this.timers.clearInterval(this.handle);
            this.handle = undefined;
        }
    }
}

/** Reports a failure that repeats once as `warn` and afterwards as `debug`, until it was gone in between. */
export class FailureLog {
    private failing = false;

    /**
     * @param log the log
     */
    public constructor(private readonly log: Logger) {}

    /**
     * Report a failure.
     *
     * @param message the text
     */
    public report(message: string): void {
        this.log[this.failing ? 'debug' : 'warn'](message);
        this.failing = true;
    }

    /** The failure is over. */
    public clear(): void {
        this.failing = false;
    }
}

/** What a feed runner (PV values, room temperatures) needs from the adapter; a fake in the tests. */
export interface FeedHost {
    /** clock in ms */
    now(): number;
    /** log lines */
    log: Logger;
    /** managed timers */
    timers: IntervalTimers;
    /** the Navigator connection is up */
    connected(): boolean;
    /** read holding registers */
    read(address: number, count: number): Promise<Result<number[]>>;
    /** write holding registers (FC16) */
    write(address: number, words: readonly number[]): Promise<Result<void>>;
    /** subscribe to a foreign state */
    subscribe(stateId: string): void;
    /** current value of a foreign state */
    foreignState(stateId: string): Promise<ForeignState | null>;
    /** publish `writer_conflict` and `last_write` of the module */
    publish(id: 'writer_conflict' | 'last_write', value: boolean | number): void;
}

/**
 * Common part of the runners that write values of foreign states to the Navigator and read them back to find a second writer:
 * source subscription, cycle guard, checked write, read-back and the conflict flag.
 */
export abstract class FeedRunner {
    /** latest values of the source states, by state id */
    protected readonly inputs = new Map<string, ForeignState>();
    private readonly ticker: Ticker;
    private busy = false;
    private conflict = false;

    /**
     * @param host adapter services
     * @param floatWordOrder FLOAT word order of the device
     * @param sources the configured sources (only their state ids are used here)
     * @param label what is fed, for the log (`PV value`, `Room temperature`)
     */
    protected constructor(
        protected readonly host: FeedHost,
        private readonly floatWordOrder: FloatWordOrder,
        private readonly sources: readonly { stateId: string }[],
        private readonly label: string,
    ) {
        this.ticker = new Ticker(host.timers);
    }

    /** One cycle; must not throw. */
    public abstract tick(): Promise<void>;

    /** Stop the cycle. */
    public stop(): void {
        this.ticker.stop();
    }

    /**
     * A subscribed foreign state changed.
     *
     * @param stateId foreign state id
     * @param state its new state
     */
    public onForeignState(stateId: string, state: ForeignState | null | undefined): void {
        if (state && this.sources.some(s => s.stateId === stateId)) {
            this.inputs.set(stateId, { val: state.val, ts: state.ts });
        }
    }

    /**
     * Subscribe to a source and take its current value; a failed read is made up for by the subscription or the next cycle.
     *
     * @param stateId foreign state id
     */
    protected async watch(stateId: string): Promise<void> {
        this.host.subscribe(stateId);
        try {
            const state = await this.host.foreignState(stateId);
            if (state) {
                this.inputs.set(stateId, { val: state.val, ts: state.ts });
            }
        } catch {
            // the next cycle or the subscription delivers it
        }
    }

    /**
     * Clear the conflict flag and start the cycle.
     *
     * @param ms cycle interval in ms
     */
    protected startCycle(ms: number): void {
        this.host.publish('writer_conflict', false);
        this.ticker.start(() => void this.tick(), ms);
    }

    /**
     * Run one cycle unless the last one is still running or the Navigator is offline; never throws.
     *
     * @param body the cycle
     */
    protected async cycle(body: () => Promise<void>): Promise<void> {
        if (this.busy || !this.host.connected()) {
            return;
        }
        this.busy = true;
        try {
            await body();
        } catch (error) {
            this.host.log.debug(`${this.label} cycle failed: ${(error as Error).message}`);
        } finally {
            this.busy = false;
        }
    }

    /**
     * Check a value against the register's limits and write it.
     *
     * @param reg the register
     * @param value the value in the register's unit
     * @returns the value as written (rounded to the register's resolution), `'refused'` when the checks refuse it (logged) or
     * `'failed'` when the write did not go through (the caller ends its cycle)
     */
    protected async write(reg: RegisterEntry, value: number): Promise<number | 'refused' | 'failed'> {
        const check = checkWrite(reg, value, { current: () => undefined, floatWordOrder: this.floatWordOrder });
        if (!check.ok) {
            this.host.log.warn(`${this.label} of ${reg.id} refused: ${check.message}`);
            return 'refused';
        }
        const result = await this.host.write(reg.address, check.words);
        if (!result.ok) {
            this.host.log.debug(`${this.label} write of ${reg.id} failed: ${result.error.message}`);
            return 'failed';
        }
        return check.value;
    }

    /**
     * Whether the register holds something other than `expected`.
     *
     * @param reg the register
     * @param expected the value written
     * @param tolerance accepted difference
     * @returns `undefined` when the register could not be read
     */
    protected async differs(reg: RegisterEntry, expected: number, tolerance: number): Promise<boolean | undefined> {
        const result = await this.host.read(reg.address, reg.words);
        if (!result.ok) {
            return undefined;
        }
        const { value } = interpretWords(reg, result.value, this.floatWordOrder);
        return value === null || Math.abs(value - expected) > tolerance;
    }

    /**
     * Publish a change of the conflict flag.
     *
     * @param conflict whether a second writer is active
     * @param message warning for the log when a conflict begins
     */
    protected setConflict(conflict: boolean, message: string): void {
        if (conflict !== this.conflict) {
            this.conflict = conflict;
            this.host.publish('writer_conflict', conflict);
            if (conflict) {
                this.host.log.warn(message);
            }
        }
    }
}
