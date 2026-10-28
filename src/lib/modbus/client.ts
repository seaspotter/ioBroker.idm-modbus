import TransportController from 'modbus-connect/transport';
import { MODBUS_MAX_READ_WORDS, MODBUS_MAX_WRITE_WORDS } from '../constants';
import { fail, notConnected, ok, type Failure, type ModbusError, type Result } from './result';

/** The adapter's managed timers (CLAUDE.md rule 17) - passed in, the client never uses bare globals for its own waits. */
export interface ClientTimers {
    /** schedule `callback` after `ms` */
    setTimeout: (callback: () => void, ms: number) => unknown;
    /** cancel a timer returned by `setTimeout` */
    clearTimeout: (handle: unknown) => void;
    /** wait `ms` (the adapter's `delay`) */
    delay: (ms: number) => Promise<void>;
}

/** Connection settings. The host is only ever used to connect, never logged or put into an error. */
export interface ClientOptions {
    /** Navigator host */
    host: string;
    /** Modbus TCP port (502) */
    port: number;
    /** Modbus unit id (1) */
    unitId: number;
    /** request and connect timeout */
    timeoutMs: number;
    /** pause between two requests; the Navigator stalls under hard polling */
    pauseMs: number;
    /** the adapter's managed timers */
    timers: ClientTimers;
    /** called once whenever an open connection is lost or closed because of a timeout/protocol error */
    onDisconnect?: (reason: ModbusError) => void;
}

const TRANSPORT_ID = 'navigator';

/** Modbus exception codes by the error class name `modbus-connect` throws for them. */
const EXCEPTION_BY_NAME: Record<string, number> = {
    ModbusIllegalDataAddressError: 2,
    ModbusIllegalDataValueError: 3,
    ModbusSlaveDeviceFailureError: 4,
    ModbusAcknowledgeError: 5,
    ModbusSlaveBusyError: 6,
};

/** The register calls of a `modbus-connect` client that we use. */
interface RegisterClient {
    readHoldingRegisters(address: number, count: number): Promise<number[]>;
    readInputRegisters(address: number, count: number): Promise<number[]>;
    writeSingleRegister(address: number, value: number): Promise<unknown>;
    writeMultipleRegisters(address: number, values: number[]): Promise<unknown>;
    disableLogger(): void;
}

/** The part of a `modbus-connect` TCP transport we reach into to keep host and port out of its logs. */
interface LoggingTransport {
    logger?: { settings: { type: string } };
    setPortStateHandler(handler: (connected: boolean) => void): void;
}

/**
 * Translate whatever `modbus-connect` throws into a sanitized {@link Failure}. The library's own messages are never
 * passed on: connection errors can contain host and port (CLAUDE.md rule 3 and 16).
 *
 * @param error the thrown value
 */
export function mapLibraryError(error: unknown): Failure {
    const name = error instanceof Error ? error.name : '';
    const exceptionCode =
        name === 'ModbusExceptionError'
            ? (error as Error & { exceptionCode?: number }).exceptionCode
            : EXCEPTION_BY_NAME[name];
    if (exceptionCode !== undefined) {
        return fail('exception', `Modbus exception ${exceptionCode}`, exceptionCode);
    }
    if (name.includes('Timeout')) {
        return fail('timeout', 'No response within the timeout');
    }
    if (/Port|Socket|Write|Connection|Flush/i.test(name)) {
        return fail('offline', 'Connection lost');
    }
    return fail('protocol', 'Invalid response from the device');
}

/**
 * Modbus TCP access to the Navigator on top of `modbus-connect`: function codes 03, 04, 06 and 16 over one connection.
 *
 * The library does the framing and the socket; this class adds what the Navigator needs (spec "Modbus-Grundlagen"):
 * strictly serial requests with a pause between them, no automatic retries or reconnects (the adapter reconnects with
 * backoff), the connection is closed on a timeout or protocol error because a late reply could no longer be matched
 * reliably, and nothing that can contain the host ever reaches a log or an error. Nothing here throws, every method
 * returns a {@link Result} (spec O11, CLAUDE.md rule 16).
 */
export class ModbusTcpClient {
    private controller: TransportController | null = null;
    private client: RegisterClient | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private lastRequestEnd = 0;
    private closing = false;

    /** @param options connection settings */
    public constructor(private readonly options: ClientOptions) {}

    /** True while a TCP connection is open. */
    public get connected(): boolean {
        return this.client !== null;
    }

    /**
     * Open the TCP connection (single attempt, bounded by the request timeout).
     *
     * @returns ok, or a `connect` error without host or port
     */
    public async connect(): Promise<Result<void>> {
        if (this.client) {
            return ok(undefined);
        }
        this.closing = false;
        const controller = new TransportController();
        controller.disableLogger();
        try {
            await controller.addTransport(
                TRANSPORT_ID,
                'node-tcp',
                {
                    host: this.options.host,
                    port: this.options.port,
                    readTimeout: this.options.timeoutMs,
                    writeTimeout: this.options.timeoutMs,
                    maxBufferSize: 4096,
                    // The library must not reconnect on its own - backoff is the adapter's job.
                    maxReconnectAttempts: 0,
                },
                { maxReconnectAttempts: 0 },
                { logLevel: 'silent' },
                { logLevel: 'silent' },
            );
            // Loggers are created per object, so switch them off after each one exists (the controller call alone
            // does not reach the transport's, port queue's or client's logger).
            controller.disableLogger();
            const transport = controller.getTransport(TRANSPORT_ID) as unknown as LoggingTransport | null;
            if (transport?.logger) {
                // The transport creates its own logger that prints "Connecting to <host>:<port>" at info level.
                transport.logger.settings.type = 'hidden';
            }
            transport?.setPortStateHandler(connected => {
                if (!connected && this.controller === controller) {
                    this.dropConnection(fail('offline', 'Connection lost').error, !this.closing);
                }
            });
            await this.withTimeout(controller.connectTransport(TRANSPORT_ID));
            const client = (await controller.createClient({
                slaveId: this.options.unitId,
                transportId: TRANSPORT_ID,
                timeout: this.options.timeoutMs,
                retryCount: 0,
                logLevel: 'silent',
            })) as unknown as RegisterClient;
            client.disableLogger();
            controller.disableLogger();
            this.client = client;
            this.controller = controller;
            return ok(undefined);
        } catch {
            this.destroy(controller);
            return fail('connect', 'Connection failed');
        }
    }

    /** Close the connection for good (adapter unload). Pending requests fail with `offline`. */
    public close(): void {
        this.closing = true;
        this.dropConnection(fail('offline', 'Connection closed').error, false);
    }

    /**
     * Read registers with FC03 (holding) or FC04 (input).
     *
     * @param fc function code
     * @param address first register
     * @param count number of registers (1..125)
     * @returns the raw 16-bit words
     */
    public readRegisters(fc: 3 | 4, address: number, count: number): Promise<Result<number[]>> {
        if (!this.validRange(address, count, MODBUS_MAX_READ_WORDS)) {
            return Promise.resolve(fail('invalid', 'Register range out of bounds'));
        }
        return this.enqueue(async client => {
            const words =
                fc === 3
                    ? await client.readHoldingRegisters(address, count)
                    : await client.readInputRegisters(address, count);
            if (!Array.isArray(words) || words.length !== count || words.some(w => !Number.isInteger(w))) {
                return fail('protocol', 'Unexpected read response length');
            }
            return ok(words);
        });
    }

    /**
     * Write one register with FC06. Callers must pass the write guards first (spec Modul B); nothing in the adapter
     * writes to a real device without the user's explicit approval (CLAUDE.md rule 1).
     *
     * @param address register
     * @param value 16-bit value
     */
    public writeSingleRegister(address: number, value: number): Promise<Result<void>> {
        if (!this.validRange(address, 1, 1) || !Number.isInteger(value) || value < 0 || value > 0xffff) {
            return Promise.resolve(fail('invalid', 'Register or value out of bounds'));
        }
        return this.enqueue(async client => {
            await client.writeSingleRegister(address, value);
            return ok(undefined);
        });
    }

    /**
     * Write consecutive registers with FC16 (used for FLOAT, which spans two registers).
     *
     * @param address first register
     * @param words 16-bit values
     */
    public writeMultipleRegisters(address: number, words: readonly number[]): Promise<Result<void>> {
        if (
            !this.validRange(address, words.length, MODBUS_MAX_WRITE_WORDS) ||
            words.some(w => !Number.isInteger(w) || w < 0 || w > 0xffff)
        ) {
            return Promise.resolve(fail('invalid', 'Register range or values out of bounds'));
        }
        return this.enqueue(async client => {
            await client.writeMultipleRegisters(address, [...words]);
            return ok(undefined);
        });
    }

    private validRange(address: number, count: number, maxCount: number): boolean {
        return (
            Number.isInteger(address) &&
            Number.isInteger(count) &&
            address >= 0 &&
            count >= 1 &&
            count <= maxCount &&
            address + count <= 0x10000
        );
    }

    /**
     * Run `task` after all earlier requests, honouring the pause. The chain itself never rejects; a library error is
     * mapped to a sanitized result and, for timeouts and lost connections, the connection is closed.
     *
     * @param task the request to run once its turn comes
     */
    private enqueue<T>(task: (client: RegisterClient) => Promise<Result<T>>): Promise<Result<T>> {
        const run = async (): Promise<Result<T>> => {
            await this.waitPause();
            const client = this.client;
            if (!client) {
                return notConnected();
            }
            try {
                const result = await task(client);
                if (!result.ok && result.error.kind === 'protocol') {
                    this.dropConnection(result.error, true);
                }
                return result;
            } catch (error) {
                const failure = mapLibraryError(error);
                if (failure.error.kind !== 'exception') {
                    this.dropConnection(failure.error, true);
                }
                return failure;
            } finally {
                this.lastRequestEnd = Date.now();
            }
        };
        const next = this.queue.then(run, run);
        this.queue = next;
        return next;
    }

    private waitPause(): Promise<void> {
        const remainingMs = this.lastRequestEnd + this.options.pauseMs - Date.now();
        if (this.lastRequestEnd === 0 || remainingMs <= 0) {
            return Promise.resolve();
        }
        return this.options.timers.delay(remainingMs);
    }

    /**
     * Bound a library promise by the connect timeout using the adapter's timers.
     *
     * @param promise the library call
     */
    private withTimeout<T>(promise: Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = this.options.timers.setTimeout(() => reject(new Error('timeout')), this.options.timeoutMs);
            promise.then(
                value => {
                    this.options.timers.clearTimeout(timer);
                    resolve(value);
                },
                (error: unknown) => {
                    this.options.timers.clearTimeout(timer);
                    reject(error instanceof Error ? error : new Error('failed'));
                },
            );
        });
    }

    private dropConnection(reason: ModbusError, notify: boolean): void {
        const controller = this.controller;
        const wasConnected = this.client !== null;
        this.controller = null;
        this.client = null;
        if (controller) {
            this.destroy(controller);
        }
        if (wasConnected && notify) {
            this.options.onDisconnect?.(reason);
        }
    }

    private destroy(controller: TransportController): void {
        controller.destroy().catch(() => undefined);
    }
}
