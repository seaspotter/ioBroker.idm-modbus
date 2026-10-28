import type { Result } from '../modbus/result';
import { type IntervalTimers, type Logger, Ticker } from '../runner-kit';

/** The heartbeat of the demand while a boost runs: the register is meant to be written cyclically (spec Modul E). */
const HEARTBEAT_MS = 30000;
/** Failed writes in a row that end a boost. */
const MAX_WRITE_FAILURES = 3;

/** Why a boost ended or did not start; the text goes to `dhw.boost_status` as a key and to the log. */
export type BoostStatus =
    | 'idle'
    | 'running'
    | 'target_reached'
    | 'timeout'
    | 'stopped'
    | 'stopped_after_restart'
    | 'refused_offline'
    | 'refused_no_temperature'
    | 'refused_at_target'
    | 'error';

/** What the runner needs from the adapter; a fake in the tests. */
export interface BoostHost {
    /** clock in ms */
    now(): number;
    /** log lines */
    log: Logger;
    /** managed timers */
    timers: IntervalTimers;
    /** the Navigator connection is up */
    connected(): boolean;
    /** latest hot water temperature at the top of the heater in °C, `null` when unknown or too old */
    temperature(): number | null;
    /** write the hot water demand register (1 = charge, 0 = end) */
    setDemand(on: boolean): Promise<Result<void>>;
    /** publish a state of the boost (`active`, `remaining`, `status`) */
    publish(id: 'active' | 'remaining' | 'status', value: boolean | number | string): void;
    /** read the persisted boost (JSON) */
    load(): Promise<string | null>;
    /** persist the boost (JSON) */
    save(json: string): void;
}

/** Settings of the runner. */
export interface BoostOptions {
    /** the boost ends when the hot water heater reaches this temperature */
    targetC: number;
    /** the boost ends after this many minutes at the latest */
    maxMinutes: number;
}

/**
 * A one-time hot water boost through the hot water demand (1712): the demand is switched on, refreshed every 30 s, and always
 * switched off again - when the target temperature is reached, when the time is up, on request, after three failed writes, at
 * shutdown and after a restart. The register does not stop on the storage temperature by itself (spec Modul E), so this class
 * is the only thing that ends a boost.
 */
export class BoostRunner {
    private readonly ticker: Ticker;
    private busy = false;
    private deadline = 0;
    private failures = 0;
    private active = false;

    /**
     * @param host adapter services
     * @param options target and time limit
     */
    public constructor(
        private readonly host: BoostHost,
        private readonly options: BoostOptions,
    ) {
        this.ticker = new Ticker(host.timers);
    }

    /** Whether a boost is running. */
    public get running(): boolean {
        return this.active;
    }

    /** Make a boost that was running before a restart end: switch the demand off. */
    public async start(): Promise<void> {
        let leftover = false;
        try {
            const saved = await this.host.load();
            leftover = saved !== null && (JSON.parse(saved) as { active?: unknown }).active === true;
        } catch {
            leftover = false;
        }
        this.host.publish('active', false);
        this.host.publish('remaining', 0);
        if (leftover) {
            const result = await this.host.setDemand(false);
            this.host.log.warn(
                result.ok
                    ? 'A hot water boost was running before the restart and has been ended'
                    : 'A hot water boost was running before the restart and could not be ended - check the hot water demand of the Navigator',
            );
            this.host.save(JSON.stringify({ active: false }));
            this.host.publish('status', 'stopped_after_restart');
        } else {
            this.host.publish('status', 'idle');
        }
    }

    /** Start a boost. Refused when offline, when the temperature is unknown or when the target is already reached. */
    public async begin(): Promise<void> {
        if (this.active || this.busy) {
            return;
        }
        this.busy = true;
        try {
            const temperature = this.host.temperature();
            if (!this.host.connected()) {
                return this.refuse('refused_offline', 'The hot water boost needs a connection to the Navigator');
            }
            if (temperature === null) {
                return this.refuse(
                    'refused_no_temperature',
                    'The hot water boost needs the hot water temperature, which is not available',
                );
            }
            if (temperature >= this.options.targetC) {
                return this.refuse(
                    'refused_at_target',
                    `The hot water is already at ${temperature} °C (target ${this.options.targetC} °C)`,
                );
            }
            const result = await this.host.setDemand(true);
            if (!result.ok) {
                return this.refuse('error', `The hot water boost could not be started: ${result.error.message}`);
            }
            this.active = true;
            this.failures = 0;
            this.deadline = this.host.now() + this.options.maxMinutes * 60000;
            this.host.save(JSON.stringify({ active: true, deadline: this.deadline }));
            this.host.publish('active', true);
            this.host.publish('remaining', this.options.maxMinutes);
            this.host.publish('status', 'running');
            this.ticker.start(() => void this.tick(), HEARTBEAT_MS);
            this.host.log.info(
                `Hot water boost started: target ${this.options.targetC} °C, at most ${this.options.maxMinutes} min`,
            );
        } finally {
            this.busy = false;
        }
    }

    /** End a boost on request. */
    public async cancel(): Promise<void> {
        if (this.active) {
            await this.end('stopped');
        }
    }

    /** End a running boost for good (adapter shutdown); never throws. */
    public async shutdown(): Promise<void> {
        try {
            if (this.active) {
                await this.end('stopped');
            }
        } catch {
            // the adapter is stopping anyway
        }
        this.ticker.stop();
    }

    /** Heartbeat: check target and time, refresh the demand. Never throws. */
    public async tick(): Promise<void> {
        if (!this.active || this.busy) {
            return;
        }
        this.busy = true;
        try {
            const now = this.host.now();
            const temperature = this.host.temperature();
            if (now >= this.deadline) {
                return await this.end('timeout');
            }
            if (temperature !== null && temperature >= this.options.targetC) {
                return await this.end('target_reached');
            }
            this.host.publish('remaining', Math.max(0, Math.ceil((this.deadline - now) / 60000)));
            if (!this.host.connected()) {
                return;
            }
            const result = await this.host.setDemand(true);
            this.failures = result.ok ? 0 : this.failures + 1;
            if (this.failures >= MAX_WRITE_FAILURES) {
                this.host.log.warn('The hot water boost could not refresh the demand three times and is ended');
                await this.end('error');
            }
        } catch (error) {
            this.host.log.debug(`Hot water boost cycle failed: ${(error as Error).message}`);
        } finally {
            this.busy = false;
        }
    }

    private refuse(status: BoostStatus, message: string): void {
        this.host.log.warn(message);
        this.host.publish('status', status);
    }

    private async end(status: BoostStatus): Promise<void> {
        this.active = false;
        this.ticker.stop();
        let result = await this.host.setDemand(false);
        if (!result.ok) {
            result = await this.host.setDemand(false); // one more try: leaving the demand on would keep charging
        }
        if (!result.ok) {
            this.host.log.warn(
                `The hot water demand could not be switched off: ${result.error.message} - check the Navigator`,
            );
            status = 'error';
        }
        this.host.save(JSON.stringify({ active: !result.ok }));
        this.host.publish('active', false);
        this.host.publish('remaining', 0);
        this.host.publish('status', status);
        this.host.log.info(`Hot water boost ended (${status})`);
    }
}
