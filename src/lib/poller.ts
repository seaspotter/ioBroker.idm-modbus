import { type FloatWordOrder, KEEPALIVE_AFTER_MS, KEEPALIVE_CHECK_MS } from './constants';
import { buildReadBlocks, type ReadBlock } from './modbus/batching';
import { nextReconnectDelayMs } from './modbus/backoff';
import { notConnected, type ModbusError, type Result } from './modbus/result';
import type { PollGroup, RegisterEntry } from './registers/types';
import { interpretWords, shouldWrite } from './value';

/** Failed reads (Modbus exception) before a register is treated as not present (spec "Fehlerbehandlung"). */
const ABSENT_AFTER_FAILURES = 3;

/** The part of the Modbus client the poller needs - a fake in the tests. */
export interface RegisterReader {
    /** open the connection */
    connect(): Promise<Result<void>>;
    /** read raw words */
    readRegisters(fc: 3 | 4, address: number, count: number): Promise<Result<number[]>>;
    /** write consecutive registers with FC16 */
    writeMultipleRegisters(address: number, words: readonly number[]): Promise<Result<void>>;
    /** close for good */
    close(): void;
}

/** What the poller reports to the adapter. */
export interface PollSink {
    /** a value changed or needs its periodic refresh; `null` = invalid (sentinel/out of range) */
    write(reg: RegisterEntry, value: number | null, valid: boolean): void;
    /** connection state changed */
    connection(connected: boolean): void;
    /** a register answered with an invalid value (counter `diag.invalid.<id>`) */
    invalid(reg: RegisterEntry): void;
    /** a register was marked absent after repeated exceptions */
    absent(reg: RegisterEntry): void;
    /** a request failed (sanitized message), for `diag.lastError` */
    error(message: string): void;
    /** a read cycle succeeded at least once, for `info.lastSuccess` */
    success(): void;
    /** every decoded reading, changed or not, with its time (feeds the statistics) */
    sample?(reg: RegisterEntry, value: number | null, at: number): void;
    /** log lines, never containing host or credentials */
    log: { debug(msg: string): void; info(msg: string): void; warn(msg: string): void };
}

/** The adapter's managed timers (CLAUDE.md rule 17). */
export interface PollTimers {
    /** schedule `callback` after `ms` */
    setTimeout: (callback: () => void, ms: number) => unknown;
    /** cancel a timer */
    clearTimeout: (handle: unknown) => void;
}

/** Poller settings. */
export interface PollerOptions {
    /** registers to read (already filtered by the plant configuration) */
    registers: readonly RegisterEntry[];
    /** FLOAT word order */
    floatWordOrder: FloatWordOrder;
    /** cycle interval per polling group in ms */
    intervalsMs: Record<PollGroup, number>;
    /** build a client; `onDisconnect` must be called when its connection is lost */
    createClient(onDisconnect: (reason: ModbusError) => void): RegisterReader;
    /** managed timers */
    timers: PollTimers;
    /** clock in ms */
    now(): number;
    /** receiver of results */
    sink: PollSink;
    /** small read sent when the connection was idle for a while (the Navigator closes idle connections after ~10 s) */
    keepAlive?: { fc: 3 | 4; address: number; count: number };
}

const GROUPS: PollGroup[] = ['config', 'fast', 'medium', 'slow'];

/**
 * Reads the registers of all polling groups over one connection, serially, and reports results to the adapter.
 *
 * Connection: a single attempt per try, wait 5 s doubling to 60 s between tries (spec), `info.connection` mirrors the
 * state. Cycle: per group, due registers are bundled into blocks (spec Modul A); a block that raises a Modbus exception is
 * re-read register by register so one missing register cannot hide its neighbours; a register that raises exceptions
 * three times in a row is marked absent and no longer requested. A timeout or lost connection ends the cycle, the
 * client closes the socket and the poller reconnects.
 */
export class Poller {
    private client: RegisterReader | null = null;
    private stopped = true;
    private connected = false;
    /** incremented on every disconnect so running cycles notice that their connection is gone */
    private epoch = 0;
    private reconnectDelayMs: number | null = null;
    private reconnectTimer: unknown = null;
    private connectFailureLogged = false;
    private readonly groupTimers = new Map<PollGroup, unknown>();
    private readonly lastWritten = new Map<string, number | null>();
    private readonly cyclesSinceWrite = new Map<string, number>();
    private readonly failures = new Map<string, number>();
    private readonly absentIds = new Set<string>();
    private keepAliveTimer: unknown = null;
    private lastRequestAt = 0;
    private requests = 0;
    private requestMs = 0;

    /** @param options poller settings */
    public constructor(private readonly options: PollerOptions) {}

    /** Start connecting and polling. */
    public start(): void {
        if (!this.stopped) {
            return;
        }
        this.stopped = false;
        this.client = this.options.createClient(reason => this.onDisconnect(reason));
        void this.connect();
    }

    /** Stop everything and close the connection. Safe to call twice. */
    public stop(): void {
        this.stopped = true;
        this.epoch++;
        this.reconnectTimer = this.cancel(this.reconnectTimer);
        this.clearGroupTimers();
        this.client?.close();
        this.client = null;
        this.markDisconnected();
    }

    /** True while the connection to the Navigator is open. */
    public get isConnected(): boolean {
        return this.connected && this.client !== null;
    }

    /**
     * Read raw words over the poller's connection (used for the read-back of writes). Fails with `offline` when there is
     * no connection; nothing is queued for later.
     *
     * @param fc function code
     * @param address first register
     * @param count number of registers
     */
    public readRaw(fc: 3 | 4, address: number, count: number): Promise<Result<number[]>> {
        return this.whenConnected(client => client.readRegisters(fc, address, count));
    }

    /**
     * Write words over the poller's connection. Only the write controller calls this, after its safety checks. Fails with
     * `offline` when there is no connection.
     *
     * @param address first register
     * @param words values
     */
    public writeRaw(address: number, words: readonly number[]): Promise<Result<void>> {
        return this.whenConnected(client => client.writeMultipleRegisters(address, words));
    }

    private whenConnected<T>(call: (client: RegisterReader) => Promise<Result<T>>): Promise<Result<T>> {
        return this.client && this.connected ? call(this.client) : Promise.resolve(notConnected());
    }

    /** Request statistics since the last call: number of requests and their average duration. */
    public takeStats(): { requests: number; avgMs: number } {
        const stats = { requests: this.requests, avgMs: this.requests ? this.requestMs / this.requests : 0 };
        this.requests = 0;
        this.requestMs = 0;
        return stats;
    }

    /** IDs of registers marked absent so far. */
    public get absentRegisterIds(): string[] {
        return [...this.absentIds];
    }

    private async connect(): Promise<void> {
        const client = this.client;
        if (this.stopped || !client) {
            return;
        }
        const result = await client.connect();
        if (this.stopped) {
            return;
        }
        if (!result.ok) {
            this.scheduleReconnect(result.error);
            return;
        }
        this.reconnectDelayMs = null;
        this.connectFailureLogged = false;
        this.connected = true;
        this.options.sink.connection(true);
        this.options.sink.log.info('Connected to the Navigator');
        this.startGroups();
    }

    private onDisconnect(reason: ModbusError): void {
        if (this.stopped) {
            return;
        }
        this.epoch++;
        this.clearGroupTimers();
        this.markDisconnected();
        this.options.sink.error(reason.message);
        this.options.sink.log.warn(`Connection lost (${reason.kind}), reconnecting`);
        // the warning above already tells the user; do not repeat it as "not reachable" for the first retry
        this.connectFailureLogged = true;
        this.scheduleReconnect(reason);
    }

    private scheduleReconnect(reason: ModbusError): void {
        if (this.stopped || this.reconnectTimer !== null) {
            return;
        }
        this.reconnectDelayMs = nextReconnectDelayMs(this.reconnectDelayMs);
        if (!this.connectFailureLogged) {
            this.options.sink.log.warn(
                `Navigator not reachable (${reason.message}), retrying in ${this.reconnectDelayMs / 1000} s`,
            );
            this.connectFailureLogged = true;
        } else {
            this.options.sink.log.debug(`Still not reachable, next try in ${this.reconnectDelayMs / 1000} s`);
        }
        this.options.sink.error(reason.message);
        this.reconnectTimer = this.options.timers.setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, this.reconnectDelayMs);
    }

    private clearGroupTimers(): void {
        for (const handle of this.groupTimers.values()) {
            this.options.timers.clearTimeout(handle);
        }
        this.groupTimers.clear();
        this.keepAliveTimer = this.cancel(this.keepAliveTimer);
    }

    private markDisconnected(): void {
        if (this.connected) {
            this.connected = false;
            this.options.sink.connection(false);
        }
    }

    /**
     * Cancel a timer handle if set.
     *
     * @param handle timer handle or `null`
     * @returns `null`, for reassignment
     */
    private cancel(handle: unknown): null {
        if (handle !== null) {
            this.options.timers.clearTimeout(handle);
        }
        return null;
    }

    private startGroups(): void {
        this.clearGroupTimers();
        this.lastRequestAt = this.options.now();
        for (const group of GROUPS) {
            this.scheduleGroup(group, 0);
        }
        this.scheduleKeepAlive();
    }

    private scheduleKeepAlive(): void {
        if (this.stopped || !this.connected || !this.options.keepAlive || this.keepAliveTimer !== null) {
            return;
        }
        const epoch = this.epoch;
        this.keepAliveTimer = this.options.timers.setTimeout(() => {
            this.keepAliveTimer = null;
            void this.sendKeepAlive(epoch);
        }, KEEPALIVE_CHECK_MS);
    }

    private async sendKeepAlive(epoch: number): Promise<void> {
        const client = this.client;
        const keepAlive = this.options.keepAlive;
        if (epoch !== this.epoch || !client || !keepAlive) {
            return;
        }
        if (this.options.now() - this.lastRequestAt >= KEEPALIVE_AFTER_MS) {
            const result = await client.readRegisters(keepAlive.fc, keepAlive.address, keepAlive.count);
            this.lastRequestAt = this.options.now();
            if (!result.ok && result.error.kind !== 'exception') {
                // the client has closed the connection; onDisconnect starts the reconnect
                this.options.sink.error(result.error.message);
            }
        }
        if (epoch === this.epoch) {
            this.scheduleKeepAlive();
        }
    }

    private scheduleGroup(group: PollGroup, delayMs: number): void {
        if (this.stopped || !this.connected) {
            return;
        }
        const epoch = this.epoch;
        this.groupTimers.set(
            group,
            this.options.timers.setTimeout(() => {
                this.groupTimers.delete(group);
                void this.runGroup(group, epoch);
            }, delayMs),
        );
    }

    private groupRegisters(group: PollGroup): RegisterEntry[] {
        return this.options.registers.filter(reg => reg.poll === group && !this.absentIds.has(reg.id));
    }

    private async runGroup(group: PollGroup, epoch: number): Promise<void> {
        const startedAt = this.options.now();
        const registers = this.groupRegisters(group);
        // Neighbours of other groups that sit right next to a due register are read in the same request (cheaper than a
        // request of their own); only the due registers decide whether a request is needed at all.
        const wanted = new Set(registers.map(reg => reg.id));
        const candidates = this.options.registers.filter(reg => !this.absentIds.has(reg.id));
        let completed = true;
        for (const block of buildReadBlocks(candidates, undefined, wanted)) {
            if (!(await this.readBlock(block, epoch))) {
                completed = false;
                break;
            }
        }
        if (epoch !== this.epoch) {
            return;
        }
        if (completed && registers.length > 0) {
            this.options.sink.success();
        }
        for (const reg of registers) {
            this.cyclesSinceWrite.set(reg.id, (this.cyclesSinceWrite.get(reg.id) ?? 0) + 1);
        }
        const elapsed = this.options.now() - startedAt;
        this.scheduleGroup(group, Math.max(0, this.options.intervalsMs[group] - elapsed));
    }

    /**
     * Read one block and report its registers.
     *
     * @param block the block
     * @param epoch connection generation the cycle belongs to
     * @returns false when the cycle must end (connection problem or a newer generation)
     */
    private async readBlock(block: ReadBlock, epoch: number): Promise<boolean> {
        const client = this.client;
        if (!client || epoch !== this.epoch) {
            return false;
        }
        const startedAt = this.options.now();
        const result = await client.readRegisters(block.fc, block.start, block.count);
        this.requests++;
        this.lastRequestAt = this.options.now();
        this.requestMs += this.lastRequestAt - startedAt;
        if (epoch !== this.epoch) {
            return false;
        }
        if (result.ok) {
            for (const { reg, offset } of block.items) {
                this.failures.delete(reg.id);
                this.report(reg, result.value.slice(offset, offset + reg.words));
            }
            return true;
        }
        if (result.error.kind !== 'exception') {
            // timeout / offline / protocol: the client has closed the connection and onDisconnect handles the rest
            this.options.sink.error(result.error.message);
            return false;
        }
        if (block.items.length > 1) {
            // find the register that raised the exception
            for (const { reg } of block.items) {
                // single register with the documented function code: the safe fallback
                const single = buildReadBlocks([reg], undefined, undefined, false)[0];
                if (!(await this.readBlock(single, epoch))) {
                    return false;
                }
            }
            return true;
        }
        this.registerFailure(block.items[0].reg, result.error);
        return true;
    }

    private registerFailure(reg: RegisterEntry, error: ModbusError): void {
        const count = (this.failures.get(reg.id) ?? 0) + 1;
        this.failures.set(reg.id, count);
        this.options.sink.error(`${reg.id}: ${error.message}`);
        if (count >= ABSENT_AFTER_FAILURES) {
            this.absentIds.add(reg.id);
            this.options.sink.log.info(
                `Register ${reg.id} (${reg.address}) does not exist on this device, no longer requested`,
            );
            this.options.sink.absent(reg);
        }
    }

    private report(reg: RegisterEntry, words: readonly number[]): void {
        const decoded = interpretWords(reg, words, this.options.floatWordOrder);
        this.options.sink.sample?.(reg, decoded.value, this.options.now());
        if (!decoded.valid) {
            this.options.sink.invalid(reg);
        }
        const previous = this.lastWritten.get(reg.id);
        const cycles = this.cyclesSinceWrite.get(reg.id) ?? 0;
        if (shouldWrite(reg, previous, decoded.value, cycles)) {
            this.lastWritten.set(reg.id, decoded.value);
            this.cyclesSinceWrite.set(reg.id, 0);
            this.options.sink.write(reg, decoded.value, decoded.valid);
        }
    }
}
