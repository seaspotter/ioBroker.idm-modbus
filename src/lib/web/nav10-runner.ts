import { FailureLog, type IntervalTimers, type Logger, Ticker } from '../runner-kit';
import { IoPublisher, type IoHost } from './io-publisher';
import { parseInfoTable, type IoGroup, type IoItem } from './io';
import type { Nav10Client } from './nav10-client';
import { channelObject, stateObject } from './objects';

/** The setting pages of the Navigator 10 that hold the input/output tables (as Xerolux's idm-heatpump-api reads them). */
export const NAV10_IO_SETTINGS: Record<IoGroup, string> = {
    sensors: '4768',
    digital_in: '4775',
    analog_out: '4782',
    digital_out: '4789',
};

/** Pause between the requests: the Navigator answers one request at a time. */
const REQUEST_PAUSE_MS = 50;

/** What the runner needs from the adapter; a fake in the tests. */
export interface Nav10Host extends IoHost {
    /** log lines, never containing the host or the PIN */
    log: Logger;
    /** managed timers */
    timers: IntervalTimers;
    /** wait (managed timer), to pace the requests */
    sleep(ms: number): Promise<void>;
}

/**
 * Reads the input/output tables from the Navigator 10's WebSocket in a fixed interval and publishes them as `web.io` states.
 * Read-only. The other web data of the Navigator 2.0 (rooms, circuit names, statistics) has no counterpart here yet.
 */
export class Nav10Runner {
    private readonly ticker: Ticker;
    private readonly failures: FailureLog;
    private busy = false;
    private readonly io: IoPublisher;

    /**
     * @param host adapter services
     * @param client the WebSocket client
     * @param intervalMs poll interval in ms
     */
    public constructor(
        private readonly host: Nav10Host,
        private readonly client: Nav10Client,
        private readonly intervalMs: number,
    ) {
        this.io = new IoPublisher(host);
        this.ticker = new Ticker(host.timers);
        this.failures = new FailureLog(host.log);
    }

    /** Create the base objects, read once and start the cycle. */
    public async start(): Promise<void> {
        await this.host.createObjects([
            channelObject('web', 'Web interface'),
            stateObject('web.connected', 'Web interface reachable', 'boolean', 'indicator.reachable'),
        ]);
        await this.tick();
        this.ticker.start(() => void this.tick(), this.intervalMs);
        this.host.log.info(`Navigator 10 web interface module started, every ${this.intervalMs / 1000} s`);
    }

    /** Stop the cycle and close the connection. */
    public stop(): void {
        this.ticker.stop();
        this.client.close();
    }

    /** One pass over the four tables. Never throws. */
    public async tick(): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        try {
            const tables: Partial<Record<IoGroup, IoItem[]>> = {};
            let reached = false;
            let complete = true;
            let lastError = '';
            for (const group of Object.keys(NAV10_IO_SETTINGS) as IoGroup[]) {
                const page = await this.client.getSetting(NAV10_IO_SETTINGS[group]);
                if (page.ok) {
                    reached = true;
                    tables[group] = parseInfoTable(page.value);
                } else {
                    lastError = page.error.message;
                    if (page.error.kind !== 'invalid') {
                        complete = false;
                        break; // the connection or the login failed: the other pages would fail the same way
                    }
                }
                await this.host.sleep(REQUEST_PAUSE_MS);
            }
            this.host.publish('web.connected', reached);
            if (reached) {
                this.failures.clear();
                if (complete) {
                    await this.io.update(tables); // a partial read would remove the states of the tables it missed
                }
            } else {
                this.report(lastError);
            }
        } catch (error) {
            this.report((error as Error).message);
        } finally {
            this.busy = false;
        }
    }

    private report(message: string): void {
        this.host.publish('web.connected', false);
        this.failures.report(`Navigator 10 web interface: ${message}`);
    }
}
