import type { FloatWordOrder } from './constants';
import { decodeWords } from './modbus/codec';
import type { RegisterEntry } from './registers/types';

/** Result of interpreting the raw words of one register. */
export interface DecodedValue {
    /** the value, or `null` when it is invalid */
    value: number | null;
    /** false for sentinels (device says "not available"), range violations and undecodable words */
    valid: boolean;
}

/**
 * Decode and plausibility-check a register value (spec Modul A, step 5): a sentinel or a value outside `min`/`max`
 * of the register file becomes `null`.
 *
 * @param reg the register
 * @param words raw words of exactly this register
 * @param order FLOAT word order
 */
export function interpretWords(reg: RegisterEntry, words: readonly number[], order: FloatWordOrder): DecodedValue {
    if (reg.lowByte) {
        // Navigator 1.x answers a byte as 0x0101 for 1 (idm-heatpump-hass issue #364); 0xFFFF still means "not available"
        const word = (words[0] ?? 0xffff) & 0xffff;
        return word === 0xffff ? { value: null, valid: false } : checkRange(reg, word & 0xff);
    }
    const value = decodeWords(reg.type, words, order);
    if (value === null) {
        return { value: null, valid: false };
    }
    // The Navigator answers 0xFFFF (-1) for status registers of hardware that is not present (measured at the test device:
    // compressors 2-4, smart grid input, pumps), also where the PDF documents no range.
    if ((reg.type === 'UCHAR' || reg.type === 'BOOL') && value === 0xffff) {
        return { value: null, valid: false };
    }
    return checkRange(reg, value);
}

/**
 * Apply the sentinels and the documented range of a register to a decoded value.
 *
 * @param reg the register
 * @param value the decoded value
 */
function checkRange(reg: RegisterEntry, value: number): DecodedValue {
    if (reg.sentinel.includes(value)) {
        return { value: null, valid: false };
    }
    if ((reg.min !== null && value < reg.min) || (reg.max !== null && value > reg.max)) {
        return { value: null, valid: false };
    }
    return { value, valid: true };
}

/** FLOAT values closer than this to the last written value do not trigger a state update (spec Modul A, step 6). */
const FLOAT_DEADBAND = 0.01;

/** A state is refreshed at least this many cycles after its last write so the timestamp stays current. */
const REFRESH_EVERY_CYCLES = 10;

/**
 * Decide whether a freshly read value must be written to the state.
 *
 * @param reg the register
 * @param previous last written value (`undefined` = never written)
 * @param next freshly read value
 * @param cyclesSinceWrite cycles of this register's group since the last write
 */
export function shouldWrite(
    reg: Pick<RegisterEntry, 'type'>,
    previous: number | null | undefined,
    next: number | null,
    cyclesSinceWrite: number,
): boolean {
    if (previous === undefined || cyclesSinceWrite >= REFRESH_EVERY_CYCLES) {
        return true;
    }
    if (previous === null || next === null) {
        return previous !== next;
    }
    return reg.type === 'FLOAT' ? Math.abs(previous - next) >= FLOAT_DEADBAND : previous !== next;
}
