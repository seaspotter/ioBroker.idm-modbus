import { BATCH_MAX_WORDS } from '../constants';
import type { RegisterEntry } from '../registers/types';

/** Read function code: input registers (RO) or holding registers (RW). */
export type ReadFunctionCode = 3 | 4;

/** One bundled read request covering one or more registers. */
export interface ReadBlock {
    /** function code of the request */
    fc: ReadFunctionCode;
    /** first register address */
    start: number;
    /** number of 16-bit registers */
    count: number;
    /** the registers inside the block, with their word offset from `start` */
    items: { reg: RegisterEntry; offset: number }[];
}

/**
 * Function code used to read a register as documented: RO via FC04, RW via FC03 (spec "Modbus-Grundlagen").
 *
 * @param reg the register
 * @returns the code, or `null` for write-only registers
 */
export function readFunctionCode(reg: Pick<RegisterEntry, 'access'>): ReadFunctionCode | null {
    return reg.access === 'R' ? 4 : reg.access === 'RW' ? 3 : null;
}

/**
 * Function codes a register may be read with in a bundled request: the ones that answered at the test device
 * (`deviceFc`, the scan found that every answering register of the Navigator 2.0 accepts both), otherwise only the
 * documented one.
 *
 * @param reg the register
 * @param useDeviceFc false = only the documented function code (the safe fallback)
 */
function allowedFunctionCodes(reg: RegisterEntry, useDeviceFc: boolean): Set<ReadFunctionCode> {
    const documented = readFunctionCode(reg);
    const codes = new Set<ReadFunctionCode>();
    if (useDeviceFc && reg.deviceFc?.length) {
        reg.deviceFc.forEach(fc => codes.add(fc));
    } else if (documented) {
        codes.add(documented);
    }
    return codes;
}

/**
 * Bundle registers into read requests.
 *
 * Registers that sit exactly next to each other form a run, cut into requests of at most `maxWords` and wherever the function
 * code changes. Neighbours of other polling groups are bundled too (no extra request, a fresher value). A request is only sent
 * when it holds at least one `wanted` register. Registers with address overlaps (1392, 1441, 1483 and their neighbours) are read
 * alone so a neighbour is never decoded out of a shared block. Gaps of unknown addresses are never bridged: they answer with
 * exception 02 and would fail the whole request.
 *
 * @param registers all candidate registers (any order); write-only registers are skipped
 * @param maxWords request size limit
 * @param wanted ids of the registers that are due; `undefined` = all of them
 * @param useDeviceFc false = use only the documented function code per register (single-register fallback)
 */
export function buildReadBlocks(
    registers: readonly RegisterEntry[],
    maxWords = BATCH_MAX_WORDS,
    wanted?: ReadonlySet<string>,
    useDeviceFc = true,
): ReadBlock[] {
    const sorted = registers.filter(reg => reg.access !== 'W').sort((a, b) => a.address - b.address);
    const blocks: ReadBlock[] = [];
    let current: ReadBlock | null = null;
    let codes = new Set<ReadFunctionCode>();

    for (const reg of sorted) {
        const own = allowedFunctionCodes(reg, useDeviceFc);
        const single = reg.overlaps.length > 0;
        const shared = current ? [...codes].filter(fc => own.has(fc)) : [];
        const fits =
            current !== null &&
            !single &&
            !current.items.some(item => item.reg.overlaps.length > 0) &&
            current.start + current.count === reg.address &&
            current.count + reg.words <= maxWords &&
            shared.length > 0;
        if (current && fits) {
            current.items.push({ reg, offset: current.count });
            current.count += reg.words;
            codes = new Set(shared);
            current.fc = codes.has(4) ? 4 : 3;
        } else {
            codes = own;
            current = { fc: own.has(4) ? 4 : 3, start: reg.address, count: reg.words, items: [{ reg, offset: 0 }] };
            blocks.push(current);
        }
    }
    return wanted ? blocks.filter(block => block.items.some(item => wanted.has(item.reg.id))) : blocks;
}
