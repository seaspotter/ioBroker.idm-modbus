import type { Result } from '../modbus/result';
import type { RegisterEntry } from '../registers/types';
import type { Logger } from '../runner-kit';
import { checkWrite, type WriteContext, type WriteRefusal } from './rules';

/** What the scheduler needs from the connection to the Navigator. */
export interface WriteExecutor {
    /** true while a connection is open; writes are never queued for later (spec "Fehlerbehandlung") */
    connected(): boolean;
    /** read the raw words of a register (fresh from the device) */
    read(reg: RegisterEntry): Promise<Result<number[]>>;
    /** write raw words to a register */
    write(reg: RegisterEntry, words: number[]): Promise<Result<void>>;
}

/** What happened to a requested value. */
export type WriteOutcome =
    /** written and confirmed by reading it back */
    | { kind: 'written'; value: number }
    /** the register already had this value; nothing was written (EEPROM registers only) */
    | { kind: 'unchanged'; value: number }
    /** refused before anything was written */
    | { kind: 'refused'; reason: WriteRefusal | 'locked' | 'offline'; message: string }
    /** the write or the read-back failed */
    | { kind: 'failed'; message: string }
    /** a newer value for the same register replaced this one before it was written */
    | { kind: 'superseded' };

/** Counters per register that survive restarts (`diag.writes.<id>`). */
export interface WriteCounters {
    /** writes since the statistics started */
    total: number;
    /** writes on `date` */
    day: number;
    /** local date the daily count belongs to */
    date: string;
}

/** Settings and services of the scheduler. */
export interface SchedulerOptions {
    /** connection */
    executor: WriteExecutor;
    /** managed timers */
    timers: {
        setTimeout: (cb: () => void, ms: number) => unknown;
        clearTimeout: (handle: unknown) => void;
        delay: (ms: number) => Promise<void>;
    };
    /** clock in ms */
    now(): number;
    /** log lines */
    log: Logger;
    /** values of related registers and the FLOAT word order */
    context: WriteContext;
    /** local date key `YYYY-MM-DD` */
    dateKey(ms: number): string;
    /** minimum time between two writes of one EEPROM register, in ms (spec default 60 s) */
    minEepromIntervalMs: number;
    /** warning threshold for writes of one register per day (spec proposal 24) */
    dailyWarnThreshold: number;
}

/**
 * Registers that get the EEPROM treatment (minimum interval, skip when equal): the starred ones, and those the IDM FAQ warns
 * about, like room setpoints that restart the zone module when written continuously.
 *
 * @param reg the register
 */
function isLimited(reg: RegisterEntry): boolean {
    return reg.eeprom || reg.rateLimited;
}

/** Only the last value within this time counts (spec Modul B, step 3). */
export const DEBOUNCE_MS = 1000;
/** The value is read back this long after writing (spec step 6). */
export const READBACK_DELAY_MS = 1000;
/** Two writes of one register within this time are logged as a warning (spec "Schutzmaßnahmen"). */
export const BURST_WARN_MS = 5000;
/** Consecutive failures after which a register is locked. */
export const LOCK_AFTER_FAILURES = 3;
/** How long a locked register stays locked. */
export const LOCK_MS = 10 * 60 * 1000;

const sameWords = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length && a.every((word, i) => word === b[i]);

interface Pending {
    value: number;
    words: number[];
    resolve: (outcome: WriteOutcome) => void;
}

interface RegisterState {
    pending: Pending | null;
    timer: unknown;
    lastWriteAt: number;
    failures: number;
    lockedUntil: number;
    counters: WriteCounters;
    warnedDate: string;
}

/**
 * Takes requested values and turns them into safe writes (spec Modul B): validation, debounce, minimum interval for EEPROM
 * registers with the newest value kept, skip when the register already has the value, read-back, counters, warnings and a
 * lock after repeated failures. Nothing here talks to a device without the executor, and nothing is written while the
 * connection is down.
 */
export class WriteScheduler {
    private readonly registers = new Map<string, RegisterState>();

    /** @param options services and settings */
    public constructor(private readonly options: SchedulerOptions) {}

    private state(id: string): RegisterState {
        let state = this.registers.get(id);
        if (!state) {
            state = {
                pending: null,
                timer: null,
                lastWriteAt: 0,
                failures: 0,
                lockedUntil: 0,
                counters: { total: 0, day: 0, date: '' },
                warnedDate: '',
            };
            this.registers.set(id, state);
        }
        return state;
    }

    /**
     * Request a value. The returned promise settles when the value was written and confirmed, found unchanged, refused,
     * failed, or replaced by a newer request.
     *
     * @param reg the register
     * @param raw the requested value (number, boolean or numeric string)
     */
    public submit(reg: RegisterEntry, raw: unknown): Promise<WriteOutcome> {
        const check = checkWrite(reg, raw, this.options.context);
        if (!check.ok) {
            return Promise.resolve({ kind: 'refused', reason: check.reason, message: check.message });
        }
        const state = this.state(reg.id);
        const now = this.options.now();
        if (state.lockedUntil > now) {
            const minutes = Math.ceil((state.lockedUntil - now) / 60000);
            return Promise.resolve({
                kind: 'refused',
                reason: 'locked',
                message: `${reg.id} is locked for ${minutes} more minute(s) after repeated write failures`,
            });
        }
        if (state.pending) {
            state.pending.resolve({ kind: 'superseded' });
        }
        if (state.timer !== null) {
            this.options.timers.clearTimeout(state.timer);
        }
        return new Promise<WriteOutcome>(resolve => {
            state.pending = { value: check.value, words: check.words, resolve };
            state.timer = this.options.timers.setTimeout(() => void this.attempt(reg), DEBOUNCE_MS);
        });
    }

    /** Cancel everything that is waiting (adapter unload). Pending requests end as superseded. */
    public shutdown(): void {
        for (const state of this.registers.values()) {
            if (state.timer !== null) {
                this.options.timers.clearTimeout(state.timer);
                state.timer = null;
            }
            state.pending?.resolve({ kind: 'superseded' });
            state.pending = null;
        }
    }

    private async attempt(reg: RegisterEntry): Promise<void> {
        const state = this.state(reg.id);
        state.timer = null;
        const pending = state.pending;
        if (!pending) {
            return;
        }
        const now = this.options.now();
        const remainingMs = state.lastWriteAt + this.options.minEepromIntervalMs - now;
        if (isLimited(reg) && state.lastWriteAt > 0 && remainingMs > 0) {
            // too early for this EEPROM register: keep the newest value and write it when the interval has passed
            this.options.log.debug(
                `${reg.id}: next write allowed in ${Math.ceil(remainingMs / 1000)} s, keeping the newest value`,
            );
            state.timer = this.options.timers.setTimeout(() => void this.attempt(reg), remainingMs);
            return;
        }
        state.pending = null;
        pending.resolve(await this.execute(reg, state, pending));
    }

    private async execute(reg: RegisterEntry, state: RegisterState, pending: Pending): Promise<WriteOutcome> {
        const { executor } = this.options;
        if (!executor.connected()) {
            return {
                kind: 'refused',
                reason: 'offline',
                message: `${reg.id}: not connected to the Navigator, the value was not written`,
            };
        }
        try {
            const readable = reg.access !== 'W';
            if (isLimited(reg) && readable) {
                const current = await executor.read(reg);
                if (current.ok && sameWords(current.value, pending.words)) {
                    return { kind: 'unchanged', value: pending.value };
                }
            }
            const now = this.options.now();
            if (state.lastWriteAt > 0 && now - state.lastWriteAt < BURST_WARN_MS) {
                this.options.log.warn(
                    `${reg.id} is written again after ${Math.round((now - state.lastWriteAt) / 1000)} s - is another automation writing it?`,
                );
            }
            const written = await executor.write(reg, pending.words);
            if (!written.ok) {
                return this.failure(reg, state, `write failed (${written.error.kind})`);
            }
            state.lastWriteAt = now;
            this.count(reg, state, now);
            if (!readable) {
                // write-only register (fault acknowledgement): there is nothing to read back
                state.failures = 0;
                return { kind: 'written', value: pending.value };
            }
            await this.options.timers.delay(READBACK_DELAY_MS);
            const back = await executor.read(reg);
            if (!back.ok) {
                return this.failure(reg, state, `the value could not be read back (${back.error.kind})`);
            }
            if (!sameWords(back.value, pending.words)) {
                return this.failure(
                    reg,
                    state,
                    `the read-back differs from the written value (${back.value.join(' ')} instead of ${pending.words.join(' ')})`,
                );
            }
            state.failures = 0;
            return { kind: 'written', value: pending.value };
        } catch (error) {
            return this.failure(reg, state, `unexpected error: ${(error as Error).message}`);
        }
    }

    private failure(reg: RegisterEntry, state: RegisterState, detail: string): WriteOutcome {
        state.failures++;
        const message = `${reg.id}: ${detail}`;
        if (state.failures >= LOCK_AFTER_FAILURES) {
            state.lockedUntil = this.options.now() + LOCK_MS;
            state.failures = 0;
            this.options.log.warn(
                `${message}; ${reg.id} is locked for ${LOCK_MS / 60000} minutes after ${LOCK_AFTER_FAILURES} failures in a row`,
            );
        }
        return { kind: 'failed', message };
    }

    private count(reg: RegisterEntry, state: RegisterState, now: number): void {
        const date = this.options.dateKey(now);
        if (state.counters.date !== date) {
            state.counters.date = date;
            state.counters.day = 0;
        }
        state.counters.total++;
        state.counters.day++;
        if (reg.eeprom) {
            this.options.log.info(
                `EEPROM register ${reg.id} (${reg.address}) written, ${state.counters.total} writes in total`,
            );
            if (state.counters.day >= this.options.dailyWarnThreshold && state.warnedDate !== date) {
                state.warnedDate = date;
                this.options.log.warn(
                    `${reg.id} was written ${state.counters.day} times today; the EEPROM tolerates about 300,000 writes in its lifetime`,
                );
            }
        }
    }

    /** The write counters of all registers written so far. */
    public get counters(): Record<string, WriteCounters> {
        const result: Record<string, WriteCounters> = {};
        for (const [id, state] of this.registers) {
            if (state.counters.total > 0) {
                result[id] = { ...state.counters };
            }
        }
        return result;
    }

    /**
     * Restore persisted counters.
     *
     * @param data what {@link counters} returned earlier
     */
    public restore(data: Record<string, Partial<WriteCounters>> | null | undefined): void {
        for (const [id, saved] of Object.entries(data ?? {})) {
            if (typeof saved?.total !== 'number' || !Number.isFinite(saved.total)) {
                continue;
            }
            this.state(id).counters = {
                total: saved.total,
                day: typeof saved.day === 'number' ? saved.day : 0,
                date: typeof saved.date === 'string' ? saved.date : '',
            };
        }
    }
}
