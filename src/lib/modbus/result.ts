/** Failure classes of the Modbus layer; callers decide on reconnect/absent-marking from `kind`. */
export type ModbusErrorKind =
    /** TCP connect failed or timed out */
    | 'connect'
    /** no open connection (never connected, or dropped) */
    | 'offline'
    /** no response within the request timeout; the connection has been closed */
    | 'timeout'
    /** the device answered with a Modbus exception (e.g. 02 = illegal data address) */
    | 'exception'
    /** malformed or unexpected response; the connection has been closed */
    | 'protocol'
    /** rejected locally before anything was sent */
    | 'invalid';

/** A sanitized error: never contains host names, IP addresses or credentials (CLAUDE.md rule 3 and 16). */
export interface ModbusError {
    kind: ModbusErrorKind;
    message: string;
    /** Modbus exception code when `kind === 'exception'` */
    exceptionCode?: number;
}

/** The failure variant of {@link Result}; assignable to any `Result<T>`. */
export interface Failure {
    ok: false;
    error: ModbusError;
}

/** Result of anything that talks to the outside; the Modbus layer never throws past its boundary. */
export type Result<T> = { ok: true; value: T } | Failure;

/**
 * Build a success result.
 *
 * @param value the payload
 */
export function ok<T>(value: T): Result<T> {
    return { ok: true, value };
}

/**
 * Build a failure result.
 *
 * @param kind failure class
 * @param message sanitized message
 * @param exceptionCode Modbus exception code, if any
 */
export function fail(kind: ModbusErrorKind, message: string, exceptionCode?: number): Failure {
    return { ok: false, error: exceptionCode === undefined ? { kind, message } : { kind, message, exceptionCode } };
}

/** The failure for a call while no connection is open. */
export function notConnected(): Failure {
    return fail('offline', 'Not connected');
}
