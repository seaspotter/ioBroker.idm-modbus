import type { FloatWordOrder } from './constants';
import type { RegisterReader } from './poller';
import { HEATING_CIRCUITS, type PlantConfig } from './registers/plant';
import type { RegisterEntry } from './registers/types';
import { interpretWords } from './value';

/** Result of reading one register with one function code. */
export interface ScanRead {
    /** the device answered with data */
    ok: boolean;
    /** raw 16-bit words (only when `ok`) */
    raw?: number[];
    /** Modbus exception code (only when the device answered with an exception) */
    exceptionCode?: number;
    /** response time including the request pause, in ms */
    ms: number;
}

/** How a register behaved at the device. */
export type ScanStatus =
    /** answered with a plausible value */
    | 'present'
    /** answered, but with the "not available" marker or an out-of-range value */
    | 'unavailable'
    /** exception on every function code */
    | 'absent';

/** One register of the scan. */
export interface ScanEntry {
    /** register id from the register file */
    id: string;
    /** first register address */
    address: number;
    /** number of 16-bit registers */
    words: number;
    /** register type (FLOAT, UCHAR, ...) */
    type: string;
    /** how the register behaved at the device */
    status: ScanStatus;
    /** decoded value when `status` is `present` */
    value: number | null;
    /** reads by function code (`"4"` input registers, `"3"` holding registers) */
    reads: Partial<Record<'3' | '4', ScanRead>>;
}

/** Complete scan of a device, free of host names and addresses of the network (CLAUDE.md rule 3). */
export interface ScanResult {
    /** register family that was scanned */
    family: string;
    /** free text, e.g. the device model */
    device: string;
    /** adapter version that ran the scan */
    adapterVersion: string;
    /** ISO timestamp of the start */
    startedAt: string;
    /** ISO timestamp of the end */
    finishedAt: string;
    /** FLOAT word order used for the decoded values */
    floatWordOrder: FloatWordOrder;
    /** per register */
    entries: ScanEntry[];
    /** set when the scan ended early (connection lost) */
    aborted?: string;
}

/** Scan settings. */
export interface ScanOptions {
    /** registers to scan (write-only registers are skipped) */
    registers: readonly RegisterEntry[];
    /** connected client; the scan only reads */
    client: Pick<RegisterReader, 'readRegisters'>;
    /** FLOAT word order for the decoded values */
    floatWordOrder: FloatWordOrder;
    /** clock */
    now(): number;
    /** family name for the result */
    family: string;
    /** device description for the result */
    device: string;
    /** adapter version for the result */
    adapterVersion: string;
    /** called after every register */
    progress?(done: number, total: number): void;
    /** return true to stop early (adapter unload) */
    shouldStop?(): boolean;
}

/**
 * Read every register one by one, with FC04 first and then FC03 (spec "Scan"). Only read requests are sent. A connection
 * problem ends the scan early (the client has closed the connection); the partial result is returned.
 *
 * @param options scan settings
 */
export async function runScan(options: ScanOptions): Promise<ScanResult> {
    const readable = options.registers.filter(reg => reg.access !== 'W');
    const startedAt = new Date(options.now()).toISOString();
    const entries: ScanEntry[] = [];
    let aborted: string | undefined;

    for (const [index, reg] of readable.entries()) {
        if (options.shouldStop?.()) {
            aborted = 'stopped';
            break;
        }
        const reads: ScanEntry['reads'] = {};
        let connectionProblem: string | undefined;
        for (const fc of [4, 3] as const) {
            const started = options.now();
            const result = await options.client.readRegisters(fc, reg.address, reg.words);
            const ms = options.now() - started;
            if (result.ok) {
                reads[fc] = { ok: true, raw: result.value, ms };
            } else if (result.error.kind === 'exception') {
                reads[fc] = { ok: false, exceptionCode: result.error.exceptionCode, ms };
            } else {
                connectionProblem = result.error.kind;
                break;
            }
        }
        if (connectionProblem) {
            aborted = connectionProblem;
            break;
        }
        entries.push(classify(reg, reads, options.floatWordOrder));
        options.progress?.(index + 1, readable.length);
    }

    return {
        family: options.family,
        device: options.device,
        adapterVersion: options.adapterVersion,
        startedAt,
        finishedAt: new Date(options.now()).toISOString(),
        floatWordOrder: options.floatWordOrder,
        entries,
        ...(aborted ? { aborted } : {}),
    };
}

/**
 * Recompute status and value of every entry from the raw words, with the current register rules. The raw words are the
 * ground truth of a scan; the judgement changes whenever a range or sentinel in the register file is corrected.
 *
 * @param scan scan result (a fixture)
 * @param registers registers of the scanned family
 */
export function reclassifyScan(scan: ScanResult, registers: readonly RegisterEntry[]): ScanResult {
    const byId = new Map(registers.map(r => [r.id, r]));
    return {
        ...scan,
        entries: scan.entries.map(entry => {
            const reg = byId.get(entry.id);
            return reg ? classify(reg, entry.reads, scan.floatWordOrder) : entry;
        }),
    };
}

/**
 * Judge the reads of one register: the first function code that answered decides the value.
 *
 * @param reg the register
 * @param reads reads by function code
 * @param order FLOAT word order
 */
function classify(reg: RegisterEntry, reads: ScanEntry['reads'], order: FloatWordOrder): ScanEntry {
    const answered = reads['4']?.ok ? reads['4'] : reads['3']?.ok ? reads['3'] : undefined;
    let status: ScanStatus = 'absent';
    let value: number | null = null;
    if (answered?.raw) {
        const decoded = interpretWords(reg, answered.raw, order);
        status = decoded.valid ? 'present' : 'unavailable';
        value = decoded.value;
    }
    return { id: reg.id, address: reg.address, words: reg.words, type: reg.type, status, value, reads };
}

/**
 * Suggest the installation layout from a scan (spec: the scan only suggests, the user confirms).
 *
 * @param scan scan result
 * @returns the layout that the answering registers imply
 */
export function suggestPlant(scan: ScanResult): PlantConfig {
    const present = new Set(scan.entries.filter(e => e.status === 'present').map(e => e.id));
    const has = (id: string): boolean => present.has(id);
    const heatingCircuits = HEATING_CIRCUITS.filter(letter => has(`hc_${letter.toLowerCase()}_flow_temp`));
    let zoneModules = 0;
    let roomsPerZone = 0;
    for (let z = 1; z <= 10; z++) {
        if (has(`zm${z}_mode_heat_cool`) || [...present].some(id => id.startsWith(`zm${z}_room`))) {
            zoneModules = z;
            for (let r = 1; r <= 8; r++) {
                if (has(`zm${z}_room${r}_temp`)) {
                    roomsPerZone = Math.max(roomsPerZone, r);
                }
            }
        }
    }
    return {
        heatingCircuits,
        zoneModules,
        roomsPerZone: roomsPerZone || 8,
        blocks: {
            solar: has('solar_collector_temp'),
            isc: has('isc_charging_temp_cooling'),
            cascade: has('cascade_available_heating'),
            bivalence: has('bivalence_state'),
            pv: has('pv_surplus'),
            booster: has('booster_fault'),
        },
    };
}

/**
 * The configuration values (checkboxes and numbers of the Installation tab) that correspond to a suggested layout.
 *
 * @param plant the layout from {@link suggestPlant}
 */
export function plantToNative(plant: PlantConfig): Record<string, boolean | number> {
    const native: Record<string, boolean | number> = {
        zoneModules: plant.zoneModules,
        roomsPerZone: plant.roomsPerZone,
        blockSolar: plant.blocks.solar,
        blockIsc: plant.blocks.isc,
        blockCascade: plant.blocks.cascade,
        blockBivalence: plant.blocks.bivalence,
        blockPv: plant.blocks.pv,
        blockBooster: plant.blocks.booster,
    };
    for (const letter of HEATING_CIRCUITS) {
        native[`hc${letter}`] = plant.heatingCircuits.includes(letter);
    }
    return native;
}

/**
 * CSV of the scan for spreadsheets (spec: "Datei und CSV").
 *
 * @param scan scan result
 */
export function scanToCsv(scan: ScanResult): string {
    const cell = (read?: ScanRead): string[] =>
        read
            ? [
                  read.ok ? 'ok' : `exception ${read.exceptionCode ?? '?'}`,
                  read.raw ? read.raw.join(' ') : '',
                  String(read.ms),
              ]
            : ['', '', ''];
    const lines = [
        'address,id,type,status,value,fc4,fc4_raw,fc4_ms,fc3,fc3_raw,fc3_ms',
        ...scan.entries.map(e =>
            [e.address, e.id, e.type, e.status, e.value ?? '', ...cell(e.reads['4']), ...cell(e.reads['3'])].join(','),
        ),
    ];
    return `${lines.join('\n')}\n`;
}

/**
 * Count the registers per status.
 *
 * @param scan scan result
 */
export function summarizeScan(scan: ScanResult): {
    present: number;
    unavailable: number;
    absent: number;
    total: number;
} {
    const count = (status: ScanStatus): number => scan.entries.filter(e => e.status === status).length;
    return {
        present: count('present'),
        unavailable: count('unavailable'),
        absent: count('absent'),
        total: scan.entries.length,
    };
}
