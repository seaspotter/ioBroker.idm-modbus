/**
 * Register file generator (spec Step 2).
 *
 * Reads a transcribed source file (`tools/sources/<family>.source.json`, facts from the binding IDM document)
 * and expands its address formulas into the flat register file `src/lib/registers/<family>.json`.
 * The adapter code itself contains no addresses; it only reads the generated file.
 *
 * Register data credit: IDs follow Xerolux/idm-heatpump-api (MIT, Copyright (c) 2026 Basti) so sources stay comparable.
 *
 * Usage: `npm run build:registers` (ts-node tools/build-registers.ts [family])
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PollGroup, RegisterEntry, RegisterType } from '../src/lib/registers/types';
import dictionaryFile from '../src/lib/dictionary.json';
import type { ScanResult } from '../src/lib/scan';
import {
    type Dictionary,
    fillPlaceholders as substitute,
    type LocalizedText,
    localized,
    missingLanguages,
} from '../src/lib/translations';

export type { RegisterEntry };

/** One axis of a repeated block: `address = base + stride * index`. */
export interface SourceAxis {
    name: string;
    values?: string[];
    from?: number;
    to?: number;
    stride: number;
}

/** A (possibly repeated) entry of the transcribed source file. */
export interface SourceEntry {
    id: string;
    address: number;
    repeat?: SourceAxis[];
    pdfType: 'FLOAT' | 'UCHAR' | 'WORD' | 'BOOL';
    /** Overrides the type derived from `pdfType`; `typeSource` then says where that came from. */
    type?: RegisterType;
    typeSource?: 'doc' | 'community' | 'device';
    access: 'R' | 'RW' | 'W';
    /** PDF access `RW/RO`: writable with external sensors, read-only with IDM sensors. */
    idmSensorRo?: boolean;
    unit?: string;
    group: string;
    instance?: string;
    room?: string;
    poll: PollGroup | null;
    min?: number;
    max?: number;
    default?: number;
    eeprom?: boolean;
    /**
     * Ids (templates) of registers that share words with this one at the device although the document lists separate addresses
     * (found at the device: a block read that contains both returns wrong data for one of them).
     */
    overlapWith?: string[];
    /** The firmware returns the byte in both bytes of the word (`0x0101` for 1): decode the low byte. */
    lowByte?: boolean;
    /** Where the entry comes from; default `doc` (the family's IDM document). */
    verified?: 'doc' | 'community';
    rateLimited?: boolean;
    step?: number;
    ownRange?: boolean;
    cyclicSec?: number;
    sentinel?: number[];
    enum?: Record<string, { de: string; en: string }>;
    requires?: string[];
    note?: string;
    label: { de: string; en: string };
}

/** Parsed `<family>.source.json`. */
export interface SourceFile {
    family: string;
    document: string;
    /** Base family: its entries are taken first, then adjusted by the fields below (spec step 10, `extends`). */
    extends?: string;
    /** Entry ids (templates, e.g. `zm{z}_room9_relay`) of the base that this family's document does not have. */
    removeIds?: string[];
    /** New upper bound for repeat axes of the base entries, by axis name (e.g. rooms per zone module). */
    axisTo?: Record<string, number>;
    /** Changes to base entries where this family's document differs, matched by entry id (template). */
    overrides?: (Partial<SourceEntry> & { id: string })[];
    /** Entries only this family's document has (with `extends`: added to the base entries). */
    entries: SourceEntry[];
}

/**
 * Resolve `extends`: start from the base family's entries, drop what this family's document lacks, narrow axes, apply the
 * overrides and add the family's own entries. A source without `extends` is returned as it is.
 *
 * @param source parsed source file
 * @param loadBase loads the (already resolved) source of the base family
 * @throws {Error} when an id in `removeIds` or `overrides` does not exist in the base
 */
export function resolveSource(source: SourceFile, loadBase: (family: string) => SourceFile): SourceFile {
    if (!source.extends) {
        return source;
    }
    const base = loadBase(source.extends);
    const ids = new Set(base.entries.map(e => e.id));
    for (const id of [...(source.removeIds ?? []), ...(source.overrides ?? []).map(o => o.id)]) {
        if (!ids.has(id)) {
            throw new Error(`${source.family}: ${id} does not exist in ${source.extends}`);
        }
    }
    const removed = new Set(source.removeIds ?? []);
    const overrides = new Map((source.overrides ?? []).map(o => [o.id, o]));
    const entries = base.entries
        .filter(entry => !removed.has(entry.id))
        .map(entry => {
            const patched = { ...entry, ...overrides.get(entry.id) };
            if (patched.repeat) {
                patched.repeat = patched.repeat.map(axis =>
                    source.axisTo && axis.name in source.axisTo && axis.to !== undefined
                        ? { ...axis, to: Math.min(axis.to, source.axisTo[axis.name]) }
                        : axis,
                );
            }
            return patched;
        });
    return { family: source.family, document: source.document, entries: [...entries, ...source.entries] };
}

/** Parsed `<family>.pdf-index.json`. */
export interface PdfIndex {
    rows: [number, string, string, number][];
}

/**
 * PDF `WORD` has no sign in the IDM document; the community treats it as INT16 (negative bivalence points,
 * pump status -1), see spec "Modbus-Grundlagen".
 */
const PDF_TYPE_MAP: Record<string, { type: RegisterType; source: 'doc' | 'community' }> = {
    FLOAT: { type: 'FLOAT', source: 'doc' },
    UCHAR: { type: 'UCHAR', source: 'doc' },
    BOOL: { type: 'BOOL', source: 'doc' },
    WORD: { type: 'INT16', source: 'community' },
};

/**
 * Enumerate the combinations of all axes of one repeated entry.
 *
 * @param axes the axes of the entry (empty for a single register)
 * @returns one record per combination: substitution values plus the address offset
 */
function combinations(axes: SourceAxis[]): { vars: Record<string, string>; offset: number }[] {
    let result: { vars: Record<string, string>; offset: number }[] = [{ vars: {}, offset: 0 }];
    for (const axis of axes) {
        const values =
            axis.values ??
            Array.from({ length: (axis.to ?? 0) - (axis.from ?? 0) + 1 }, (_, k) => String((axis.from ?? 0) + k));
        const next: typeof result = [];
        for (const base of result) {
            values.forEach((value, index) => {
                next.push({
                    vars: { ...base.vars, [axis.name]: value },
                    offset: base.offset + axis.stride * index,
                });
            });
        }
        result = next;
    }
    return result;
}

/**
 * Expand the source file into flat register entries (sorted by address) and detect address overlaps.
 *
 * @param source parsed source file
 * @param dictionary translations by English template (default: `src/lib/dictionary.json`)
 * @throws {Error} on duplicate IDs or duplicate start addresses, and when a label or enum text lacks a translation
 * (generator input is trusted and fails loudly; `npm run translate:strings` fills the dictionary)
 */
export function expandRegisters(source: SourceFile, dictionary: Dictionary = dictionaryFile): RegisterEntry[] {
    const registers: RegisterEntry[] = [];
    const sharedWith = new Map<string, string[]>();
    const untranslated = new Set<string>();
    /**
     * English text in all languages; German stays the wording of the IDM document.
     *
     * @param en English template (key of the dictionary)
     * @param de German wording from the IDM document
     * @param vars values for the placeholders
     */
    const text = (en: string, de: string, vars: Record<string, string>): LocalizedText => {
        if (missingLanguages(en, dictionary).length) {
            untranslated.add(en);
        }
        return { ...localized(en, vars, dictionary), de: substitute(de, vars) };
    };
    for (const entry of source.entries) {
        const mapped = PDF_TYPE_MAP[entry.pdfType];
        if (!mapped) {
            throw new Error(`Unknown pdfType ${entry.pdfType} in ${entry.id}`);
        }
        const type = entry.type ?? mapped.type;
        const typeSource = entry.type ? (entry.typeSource ?? 'community') : mapped.source;
        for (const combo of combinations(entry.repeat ?? [])) {
            const vars = combo.vars;
            if (entry.overlapWith) {
                sharedWith.set(
                    substitute(entry.id, vars),
                    entry.overlapWith.map(other => substitute(other, vars)),
                );
            }
            registers.push({
                id: substitute(entry.id, vars),
                address: entry.address + combo.offset,
                words: type === 'FLOAT' ? 2 : 1,
                type,
                pdfType: entry.pdfType,
                access: entry.access,
                idmSensorRo: entry.idmSensorRo ?? false,
                unit: entry.unit ?? null,
                group: entry.group,
                instance: entry.instance ? substitute(entry.instance, vars) : null,
                room: entry.room ? substitute(entry.room, vars) : null,
                poll: entry.poll,
                min: entry.min ?? null,
                max: entry.max ?? null,
                default: entry.default ?? null,
                eeprom: entry.eeprom ?? false,
                ...(entry.lowByte ? { lowByte: true } : {}),
                rateLimited: entry.rateLimited ?? false,
                step: entry.step ?? null,
                ownRange: entry.ownRange ?? false,
                cyclicSec: entry.cyclicSec ?? null,
                sentinel: entry.sentinel ?? [],
                enum: entry.enum
                    ? Object.fromEntries(
                          Object.entries(entry.enum).map(([value, t]) => [value, text(t.en, t.de, vars)]),
                      )
                    : null,
                requires: (entry.requires ?? []).map(r => substitute(r, vars)),
                overlaps: [],
                verified: entry.verified ?? 'doc',
                deviceStatus: null,
                deviceFc: null,
                typeSource,
                note: entry.note ?? null,
                label: text(entry.label.en, entry.label.de, vars),
            });
        }
    }
    if (untranslated.size) {
        throw new Error(
            `${untranslated.size} texts lack translations (first: "${[...untranslated][0]}") - run npm run translate:strings`,
        );
    }
    registers.sort((a, b) => a.address - b.address);

    const ids = new Set<string>();
    const addresses = new Set<number>();
    for (const reg of registers) {
        if (ids.has(reg.id)) {
            throw new Error(`Duplicate id ${reg.id}`);
        }
        if (addresses.has(reg.address)) {
            throw new Error(`Duplicate address ${reg.address} (${reg.id})`);
        }
        ids.add(reg.id);
        addresses.add(reg.address);
    }
    markOverlaps(registers);
    // overlaps found at the device (not visible in the address ranges of the document)
    const byId = new Map(registers.map(r => [r.id, r]));
    for (const [id, others] of sharedWith) {
        for (const otherId of others) {
            const a = byId.get(id);
            const b = byId.get(otherId);
            if (!a || !b) {
                throw new Error(`overlapWith: ${id} / ${otherId} does not exist`);
            }
            if (!a.overlaps.includes(b.id)) {
                a.overlaps.push(b.id);
                b.overlaps.push(a.id);
            }
        }
    }
    return registers;
}

/**
 * Mark registers whose word ranges intersect (e.g. FLOAT 1392 occupies 1392-1393, UCHAR 1393 starts there).
 *
 * @param registers registers sorted by address
 */
export function markOverlaps(registers: RegisterEntry[]): void {
    for (let i = 0; i < registers.length; i++) {
        const a = registers[i];
        for (let j = i + 1; j < registers.length; j++) {
            const b = registers[j];
            if (b.address >= a.address + a.words) {
                break;
            }
            a.overlaps.push(b.id);
            b.overlaps.push(a.id);
        }
    }
}

/**
 * Record what a scan of the test device showed (spec step 5): a register that answered with a plausible value is
 * `verified: device` (address, width and function code are confirmed); registers that answered "not available" or raised
 * exceptions keep their documented origin but carry the observed status.
 *
 * @param registers expanded registers
 * @param scan scan of the test device
 */
export function applyDeviceScan(registers: RegisterEntry[], scan: ScanResult): void {
    const byAddress = new Map(scan.entries.map(e => [e.address, e]));
    for (const reg of registers) {
        const entry = byAddress.get(reg.address);
        if (!entry || entry.id !== reg.id) {
            continue;
        }
        reg.deviceStatus = entry.status;
        reg.deviceFc = ([4, 3] as const).filter(fc => entry.reads[String(fc) as '3' | '4']?.ok);
        if (entry.status === 'present') {
            reg.verified = 'device';
        }
    }
}

/**
 * Compare the expanded registers with the PDF address index.
 *
 * @param registers expanded registers
 * @param index address index extracted from the binding PDF
 * @returns human-readable problems; empty when every PDF address is present with matching type and access
 */
export function compareWithPdfIndex(registers: RegisterEntry[], index: PdfIndex): string[] {
    const problems: string[] = [];
    const byAddress = new Map(registers.map(r => [r.address, r]));
    const known = new Set<number>();
    for (const [address, pdfType, access, eeprom] of index.rows) {
        known.add(address);
        const reg = byAddress.get(address);
        if (!reg) {
            problems.push(`PDF address ${address} missing in register file`);
            continue;
        }
        if (reg.pdfType !== pdfType) {
            problems.push(`${address} ${reg.id}: type ${reg.pdfType} != PDF ${pdfType}`);
        }
        const expectedAccess = access === 'RO' ? 'R' : access === 'W' ? 'W' : 'RW';
        if (reg.access !== expectedAccess) {
            problems.push(`${address} ${reg.id}: access ${reg.access} != PDF ${access}`);
        }
        if (reg.idmSensorRo !== (access === 'RW/RO')) {
            problems.push(`${address} ${reg.id}: idmSensorRo mismatch for PDF access ${access}`);
        }
        if (reg.eeprom !== (eeprom === 1)) {
            problems.push(`${address} ${reg.id}: eeprom flag ${reg.eeprom} != PDF ${eeprom === 1}`);
        }
    }
    for (const reg of registers) {
        if (!known.has(reg.address) && reg.verified !== 'community') {
            problems.push(`${reg.address} ${reg.id}: not in the PDF`);
        }
    }
    return problems;
}

/**
 * Read the source file of a family from `tools/sources` and resolve `extends`.
 *
 * @param family family name (`nav20`, `nav10`, ...)
 * @param root repository root
 */
export function loadFamilySource(family: string, root: string): SourceFile {
    return resolveSource(
        JSON.parse(fs.readFileSync(path.join(root, 'tools', 'sources', `${family}.source.json`), 'utf8')) as SourceFile,
        name => loadFamilySource(name, root),
    );
}

/** CLI entry: build one family and fail on any mismatch with the PDF index. */
function main(): void {
    const family = process.argv[2] ?? 'nav20';
    const root = path.join(__dirname, '..');
    const source = loadFamilySource(family, root);
    const index = JSON.parse(
        fs.readFileSync(path.join(root, 'tools', 'sources', `${family}.pdf-index.json`), 'utf8'),
    ) as PdfIndex;

    const registers = expandRegisters(source);
    const fixture = path.join(root, 'test', 'fixtures', `scan-${family}.json`);
    if (fs.existsSync(fixture)) {
        applyDeviceScan(registers, JSON.parse(fs.readFileSync(fixture, 'utf8')) as ScanResult);
    }
    const problems = compareWithPdfIndex(registers, index);
    if (problems.length) {
        console.error(problems.join('\n'));
        process.exit(1);
    }

    const out = {
        $comment:
            `Generated by tools/build-registers.ts from tools/sources/${family}.source.json - do not edit. ` +
            `Facts from ${source.document}. IDs follow Xerolux/idm-heatpump-api (MIT, Copyright (c) 2026 Basti).`,
        family,
        document: source.document,
        registers,
    };
    const target = path.join(root, 'src', 'lib', 'registers', `${family}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(out, null, 4)}\n`);
    const verifiedCount = registers.filter(r => r.verified === 'device').length;
    const overlaps = registers.filter(r => r.overlaps.length).map(r => `${r.address}(${r.id})`);
    console.log(
        `${family}: ${registers.length} registers (${verifiedCount} verified at the device), overlaps: ${overlaps.join(', ') || 'none'}`,
    );
}

if (require.main === module) {
    main();
}
