import * as utils from '@iobroker/adapter-core';
import {
    readBoostSettings,
    readDiagramSettings,
    readControlSettings,
    readGltSettings,
    readWebSettings,
    readPlantSettings,
    readPvSettings,
    readRoomSettings,
    readStatsSettings,
} from './lib/config';
import { isWritable } from './lib/control/groups';
import { ControlRunner } from './lib/control/runner';
import {
    DEFAULT_PORT,
    DEFAULT_REQUEST_PAUSE_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_UNIT_ID,
    DIAG_INTERVAL_MS,
    INVALID_LOG_INTERVAL_MS,
    MIN_REQUEST_PAUSE_MS,
    NAVIGATOR_FAMILIES,
    type FloatWordOrder,
    type NavigatorFamily,
} from './lib/constants';
import { readFunctionCode } from './lib/modbus/batching';
import { ModbusTcpClient } from './lib/modbus/client';
import { notConnected } from './lib/modbus/result';
import { BoostRunner } from './lib/boost/runner';
import { detectFamily } from './lib/detect';
import { faultText } from './lib/faults';
import { buildSupportReport, type SupportInput } from './lib/support';
import { decodeWords } from './lib/modbus/codec';
import { planCleanup, planObjects, type PlannedObject } from './lib/object-tree';
import { Poller, type PollSink } from './lib/poller';
import type { PlantConfig } from './lib/registers/plant';
import { plantToNative, runScan, type ScanResult, scanToCsv, summarizeScan, suggestPlant } from './lib/scan';
import { activeRegisters, HEATING_CIRCUITS, loadRegisters } from './lib/registers/plant';
import type { RegisterEntry } from './lib/registers/types';
import { stateIdFor, toStateValue } from './lib/state-model';
import { movePvRowsToFields } from './lib/pv/migrate';
import { PvRunner } from './lib/pv/runner';
import { RoomRunner } from './lib/rooms/runner';
import { WebClient } from './lib/web/client';
import { Nav10Client } from './lib/web/nav10-client';
import { Nav10Runner } from './lib/web/nav10-runner';
import { WebRunner } from './lib/web/runner';
import { localDateKey, StatsRunner, type Sample } from './lib/stats/runner';
import { clampTimerMs } from './lib/timers';
import { modbusTagRegisters } from './lib/web/tags';
import { localized, textIn, type LocalizedText } from './lib/translations';

/** ioBroker quality code "sensor reports error" for invalid values (sentinel / out of range). */
const QUALITY_INVALID = 0x44;
/** `info.lastSuccess` is written at most this often. */
const LAST_SUCCESS_THROTTLE_MS = 5000;

/** Status line after a finished scan; the admin page tells the user what to do next. */
const SCAN_FINISHED_TEXT =
    'Scan finished {time}: {present} registers answered, {unavailable} "not available", {absent} do not exist. Press "Apply suggestion" to take over the layout, then save.';

/** The numbers of a scan summary that the status line shows. */
interface ScanSummaryNumbers {
    present: number;
    unavailable: number;
    absent: number;
}

/** Time after the start in which the web copy of a part waits for Modbus: the first poll of every group is done by then. */
const MODBUS_WARMUP_MS = 120000;

/**
 * Rough duration of a scan in whole minutes (measured: about 0.22 s per register at the default pause of 100 ms).
 *
 * @param count number of registers read
 * @param pauseMs configured pause between requests
 */
function scanMinutes(count: number, pauseMs: number): number {
    const pause = Number.isFinite(pauseMs) ? Math.max(MIN_REQUEST_PAUSE_MS, pauseMs) : DEFAULT_REQUEST_PAUSE_MS;
    return Math.max(1, Math.ceil((count * (pause + 120)) / 60000));
}

/** Registers that carry a fault number; each gets a state with the text next to it (`<state>_text`). */
const FAULT_REGISTER_IDS = ['internal_message', 'error_number'];

/** Result of a raw Modbus call while the adapter has no poller. */
const OFFLINE = notConnected();

/** The parts of `diag.scan` the admin commands read. */
interface StoredScan {
    finishedAt: string;
    summary: ScanSummaryNumbers;
    suggestion: {
        heatingCircuits: string[];
        zoneModules: number;
        roomsPerZone: number;
        blocks: Record<string, boolean>;
    };
}

/**
 * Names of the switched-on blocks of a suggested layout.
 *
 * @param blocks block name -> on
 */
function blockNames(blocks: Record<string, boolean>): string[] {
    return Object.entries(blocks)
        .filter(([, on]) => on)
        .map(([name]) => name);
}

/**
 * Compact timestamp for file names (`20261010-123456`).
 *
 * @param iso ISO date string
 */
function fileStamp(iso: string): string {
    return iso.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

/** Timers the Modbus client and the scan use (the adapter's managed ones). */
interface ManagedTimers {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    delay: (ms: number) => Promise<void>;
}

/**
 * The connection values of a `sendTo` form as a Modbus client configuration.
 *
 * @param host trimmed host
 * @param config the values currently entered in the admin form
 * @param pauseMs pause between requests
 * @param timers the adapter's timers
 */
function clientOptions(
    host: string,
    config: Record<string, unknown> | undefined,
    pauseMs: number,
    timers: ManagedTimers,
): ConstructorParameters<typeof ModbusTcpClient>[0] {
    return {
        host,
        port: Number(config?.port) || DEFAULT_PORT,
        unitId: Number.isFinite(Number(config?.unitId)) ? Number(config?.unitId) : DEFAULT_UNIT_ID,
        timeoutMs: clampTimerMs(Number(config?.requestTimeoutMs), DEFAULT_REQUEST_TIMEOUT_MS, 500),
        pauseMs,
        timers,
    };
}

/**
 * The host of a `sendTo` form, trimmed (empty when missing).
 *
 * @param config the values currently entered in the admin form
 */
function formHost(config: Record<string, unknown> | undefined): string {
    return typeof config?.host === 'string' ? config.host.trim() : '';
}

/** Names of the Navigator generations in the test message. */
const FAMILY_NAMES: Record<NavigatorFamily, string> = {
    nav20: 'Navigator 2.0',
    nav17: 'Navigator 1.7',
    nav10: 'Navigator 10',
};

class IdmModbus extends utils.Adapter {
    private poller: Poller | null = null;
    /** builds a fresh poller from the saved configuration (used at start and after a scan) */
    private createPoller: (() => Poller) | null = null;
    private scanRunning = false;
    /** states are created when the Navigator reports the first real value (spec: no empty states for hardware that is not there) */
    private lazyStates = false;
    private readonly createdStates = new Set<string>();
    private readonly validSeen = new Set<string>();
    private readonly validNow = new Set<string>();
    private readonly startedAt = Date.now();
    private objectQueue: Promise<void> = Promise.resolve();
    private objectContext: {
        names: Record<string, string>;
        writable: (reg: RegisterEntry) => boolean;
    } = { names: {}, writable: () => false };
    private stats: StatsRunner | null = null;
    private control: ControlRunner | null = null;
    private pv: PvRunner | null = null;
    private rooms: RoomRunner | null = null;
    private glt: RoomRunner | null = null;
    private web: WebRunner | null = null;
    private nav10: Nav10Runner | null = null;
    private boost: BoostRunner | null = null;
    /** latest reading of every register, for the statistics */
    private readonly samples = new Map<string, Sample>();
    private unloading = false;
    private diagTimer: ioBroker.Interval | undefined;
    private errorCount = 0;
    private lastSuccessWritten = 0;
    private readonly invalidCounts = new Map<string, number>();
    private readonly absentIds = new Set<string>();
    private registerCount = 0;
    private readonly invalidFlushed = new Map<string, number>();
    private readonly invalidLogged = new Map<string, number>();

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'idm-modbus',
            // without this the js-controller never sets `this.language`, and every plain-text state (scan status, fault texts,
            // enum texts) would stay English whatever the system language is
            useFormatDate: true,
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', obj => void this.onMessage(obj));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     * Creates the object tree for the configured installation and starts the read-only poller (spec Step 4).
     */
    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);
        await this.defineState('diag.scanStatus', 'Scan status', 'string', 'text');
        await this.initScanStatus();
        await this.defineState('diag.scanProgress', 'Scan progress', 'number', 'value', { unit: '%', def: 0 });

        if (await this.movePvRows()) {
            return; // the instance restarts with the new settings
        }

        await this.publishDiagramSettings();

        const settings = readPlantSettings(this.config);
        this.warnAll(settings.warnings);
        await this.setState('info.family', settings.family, true);

        if (!this.config.host) {
            this.log.warn('No Navigator host configured - nothing will happen until configured in the Connection tab');
            return;
        }

        const registers = loadRegisters(settings.family);
        if (!registers) {
            this.log.error(`Register file for ${settings.family} is not available yet - select Navigator 2.0`);
            return;
        }
        const active = activeRegisters(registers, settings.plant);
        this.registerCount = active.length;
        this.log.info(
            `Family ${settings.family}: ${active.length} registers enabled (${settings.plant.heatingCircuits.length} heating circuits, ${settings.plant.zoneModules} zone modules)`,
        );

        const controlSettings = readControlSettings(this.config);
        this.warnAll(controlSettings.warnings);
        // the fault acknowledgement is write-only, so it is not polled; it gets a state only when control is switched on
        const writeOnly = registers.filter(reg => reg.access === 'W' && isWritable(reg, controlSettings));
        this.objectContext = {
            names: settings.heatingCircuitNames,
            writable: reg => isWritable(reg, controlSettings),
        };
        this.lazyStates = this.config.hideUnavailable !== false;
        await this.createObjects(
            // writable states always exist (the user must be able to set them), read-only ones appear with their first value
            this.lazyStates
                ? [...active.filter(reg => this.objectContext.writable(reg)), ...writeOnly]
                : [...active, ...writeOnly],
            settings.heatingCircuitNames,
            this.objectContext.writable,
        );
        if (this.config.removeInactiveStates) {
            await this.removeInactive(registers, active);
        }

        const port = this.config.port || DEFAULT_PORT;
        const unitId = this.config.unitId ?? DEFAULT_UNIT_ID;
        const timeoutMs = clampTimerMs(this.config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 500);
        const pauseMs = clampTimerMs(this.config.requestPauseMs, DEFAULT_REQUEST_PAUSE_MS, MIN_REQUEST_PAUSE_MS);
        const timers = this.managedTimers();

        this.createPoller = () =>
            new Poller({
                registers: active,
                floatWordOrder: this.floatWordOrder,
                intervalsMs: settings.intervalsMs,
                createClient: onDisconnect =>
                    new ModbusTcpClient({
                        host: this.config.host,
                        port,
                        unitId,
                        timeoutMs,
                        pauseMs,
                        timers,
                        onDisconnect,
                    }),
                timers,
                now: () => Date.now(),
                sink: this.createSink(),
                keepAlive: { fc: 4, address: 1000, count: 2 }, // outdoor temperature, present on every Navigator
            });
        this.poller = this.createPoller();
        this.poller.start();
        this.diagTimer = this.setInterval(() => void this.writeDiagnostics(), DIAG_INTERVAL_MS);
        await this.startStatistics(settings.plant.heatingCircuits, settings.intervalsMs, registers);
        await this.startControl([...active, ...writeOnly], controlSettings);
        await this.startPv(registers);
        await this.startFeeds(registers);
        await this.startWeb(settings.family, settings.heatingCircuitNames, registers);
        await this.startBoost(registers, settings.intervalsMs.medium);
    }

    /**
     * Publish the diagram settings as JSON in `diagram.settings`: the diagram page runs in the browser, reads them through the
     * web adapter and follows a change at once.
     */
    private async publishDiagramSettings(): Promise<void> {
        const { settings, warnings } = readDiagramSettings(this.config);
        this.warnAll(warnings);
        await this.extendObject('diagram', {
            type: 'channel',
            common: { name: localized('Heat pump diagram') },
            native: {},
        });
        await this.defineState('diagram.settings', 'Diagram settings', 'string', 'json');
        await this.setState('diagram.settings', JSON.stringify(settings), true);
    }

    /**
     * Start the hot water boost (spec Modul E): a one-time charge through the hot water demand that always ends again.
     *
     * @param registers all registers of the family
     * @param mediumIntervalMs polling interval of the hot water temperature (a reading older than three intervals is unknown)
     */
    private async startBoost(registers: readonly RegisterEntry[], mediumIntervalMs: number): Promise<void> {
        const settings = readBoostSettings(this.config);
        this.warnAll(settings.warnings);
        const demand = registers.find(reg => reg.id === 'demand_dhw_charging');
        if (!settings.enabled) {
            return;
        }
        if (!demand || !registers.some(reg => reg.id === 'dhw_temp_top')) {
            this.log.warn(
                'The hot water boost needs the hot water demand and the hot water temperature, which this register family does not have',
            );
            return;
        }
        const statuses = {
            idle: 'Idle',
            running: 'Boost running',
            target_reached: 'Target temperature reached',
            timeout: 'Time limit reached',
            stopped: 'Stopped',
            stopped_after_restart: 'Ended after a restart',
            refused_offline: 'Refused: no connection to the Navigator',
            refused_no_temperature: 'Refused: hot water temperature unknown',
            refused_at_target: 'Refused: hot water already at the target temperature',
            error: 'Error - check the hot water demand of the Navigator',
        };
        await this.defineState('dhw.boost_start', 'Start hot water boost', 'boolean', 'button', {
            read: false,
            write: true,
        });
        await this.defineState('dhw.boost_stop', 'Stop hot water boost', 'boolean', 'button', {
            read: false,
            write: true,
        });
        await this.defineState('dhw.boost_active', 'Hot water boost active', 'boolean', 'indicator.working');
        await this.defineState('dhw.boost_remaining', 'Boost time remaining', 'number', 'value', { unit: 'min' });
        await this.defineState('dhw.boost_status', 'Hot water boost status', 'string', 'text', {
            // plain strings in the system language: translated objects are not allowed in `common.states`
            states: Object.fromEntries(
                Object.entries(statuses).map(([key, text]) => [key, textIn(localized(text), this.language)]),
            ),
        });
        await this.defineState('dhw.boost_data', 'Hot water boost data (internal)', 'string', 'json');
        this.subscribeStates('dhw.boost_start');
        this.subscribeStates('dhw.boost_stop');
        this.boost = new BoostRunner(
            {
                now: () => Date.now(),
                log: this.log,
                timers: this.intervalTimers(),
                connected: () => this.poller?.isConnected === true,
                temperature: () => {
                    const sample = this.samples.get('dhw_temp_top');
                    return sample && sample.value !== null && Date.now() - sample.at <= mediumIntervalMs * 3
                        ? sample.value
                        : null;
                },
                setDemand: async on => (await this.poller?.writeRaw(demand.address, [on ? 1 : 0])) ?? OFFLINE,
                publish: (id, value) => this.put(`dhw.boost_${id}`, { val: value, ack: true }),
                load: async () => {
                    const state = await this.getStateAsync('dhw.boost_data');
                    return typeof state?.val === 'string' ? state.val : null;
                },
                save: json => this.put('dhw.boost_data', json, true),
            },
            { targetC: settings.targetC, maxMinutes: settings.maxMinutes },
        );
        await this.boost.start();
    }

    /**
     * Start the web interface module (spec Modul H), read only. The Navigator 2.0 / Pro is read through its PHP pages (rooms, circuit
     * names, statistics, inputs and outputs), the Navigator 10 through its WebSocket (inputs and outputs); the Navigator 1.0/1.7 has
     * no web interface the adapter can read.
     *
     * @param family the Navigator generation
     * @param userCircuitNames heating circuit names the user entered (they win over the names from the Navigator)
     * @param registers all registers of the family (their IDM tags tell which parts Modbus already delivers)
     */
    private async startWeb(
        family: NavigatorFamily,
        userCircuitNames: Record<string, string>,
        registers: readonly RegisterEntry[],
    ): Promise<void> {
        const settings = readWebSettings(this.config, family);
        this.warnAll(settings.warnings);
        if (!settings.enabled) {
            return;
        }
        if (family === 'nav17') {
            this.log.info(
                'The Navigator 1.0/1.7 has no web interface the adapter can read: the web interface module stays off',
            );
            return;
        }
        const tagRegisters = modbusTagRegisters(registers);
        const timeoutMs = clampTimerMs(this.config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 500) * 3;
        const common = {
            log: this.log,
            timers: this.intervalTimers(),
            sleep: (ms: number) => this.delay(ms),
            createObjects: (planned: PlannedObject[]) => this.createPlanned(planned),
            existingIds: async (prefix: string) => {
                const start = `${this.namespace}.${prefix}.`;
                const list = await this.getObjectListAsync({ startkey: start, endkey: `${start}\u9999` });
                return list.rows.map(row => row.id.slice(this.namespace.length + 1));
            },
            hasModbusValue: (tag: string) => {
                const registerId = tagRegisters.get(tag);
                // "now", not "ever": a register that reports invalid again (M73 = -1 while the pump stands) needs the web copy
                return (
                    registerId !== undefined &&
                    (this.validNow.has(registerId) || Date.now() - this.startedAt < MODBUS_WARMUP_MS)
                );
            },
            publish: (id: string, value: string | number | boolean | null) => this.put(id, { val: value, ack: true }),
        };
        if (family === 'nav10') {
            const client = new Nav10Client({
                host: this.config.host,
                port: settings.port,
                pin: settings.pin,
                timeoutMs,
            });
            this.nav10 = new Nav10Runner(common, client, settings.intervalMs);
            await this.nav10.start();
            return;
        }
        const client = new WebClient({ host: this.config.host, port: settings.port, pin: settings.pin, timeoutMs });
        const rename = (id: string, name: string): void => {
            void this.getObjectAsync(id)
                .then(async object => {
                    if (object && (object.common.name as unknown) !== name) {
                        await this.extendObject(id, { common: { name } });
                    }
                })
                .catch(() => undefined);
        };
        this.web = new WebRunner(
            {
                ...common,
                now: () => Date.now(),
                getData: name => client.getData(name),
                hasModbusRoom: (zone, room) => this.validSeen.has(`zm${zone}_room${room}_temp`),
                setRoomName: (zone, room, name) => rename(`zones.${zone}.rooms.${room}`, name),
                setCircuitName: (letter, name) => {
                    if (!userCircuitNames[letter]) {
                        rename(`hc.${letter}`, name);
                    }
                },
            },
            { intervalMs: settings.intervalMs, statisticsIntervalMs: settings.statisticsIntervalMs },
        );
        await this.web.start();
    }

    /**
     * Start the room temperature feeding (spec Modul C, target 1) and the other GLT values (Modul E): foreign states cyclically
     * to registers of the Navigator.
     *
     * @param registers all registers of the family
     */
    private async startFeeds(registers: readonly RegisterEntry[]): Promise<void> {
        const rooms = readRoomSettings(this.config);
        this.warnAll(rooms.warnings);
        if (rooms.enabled && rooms.sources.length) {
            this.rooms = await this.startFeed('rooms', rooms, registers, {
                conflict: 'Room temperature writer conflict',
                last: 'Last room temperature write',
            });
        }
        const glt = readGltSettings(this.config);
        this.warnAll(glt.warnings);
        if (glt.enabled && glt.sources.length) {
            this.glt = await this.startFeed('glt', glt, registers, {
                conflict: 'GLT writer conflict',
                last: 'Last GLT write',
            });
        }
    }

    /**
     * Start one feeding runner.
     *
     * @param channel channel of its states (`rooms` or `glt`)
     * @param settings its sources
     * @param settings.sources rows to write
     * @param registers all registers of the family
     * @param names names of its two states
     * @param names.conflict name of the conflict state
     * @param names.last name of the last-write state
     */
    private async startFeed(
        channel: 'rooms' | 'glt',
        settings: { sources: ReturnType<typeof readRoomSettings>['sources'] },
        registers: readonly RegisterEntry[],
        names: { conflict: string; last: string },
    ): Promise<RoomRunner> {
        await this.defineWriterStates(channel, names.conflict, names.last);
        const runner = new RoomRunner(this.writerHost(channel), {
            settings,
            registers,
            floatWordOrder: this.floatWordOrder,
        });
        await runner.start();
        return runner;
    }

    /**
     * Versions before 0.1.16 had the PV sources as a table of rows; the settings page now has a fixed block per register. Moves the
     * rows of an existing configuration into the new fields once (the table is emptied, so this does not repeat). Changing the
     * settings restarts the instance.
     *
     * @returns true when the settings were changed
     */
    private async movePvRows(): Promise<boolean> {
        const rows: unknown = this.config.pvSources;
        if (!Array.isArray(rows) || !rows.length) {
            return false;
        }
        try {
            const moved = await movePvRowsToFields(this, `system.adapter.${this.namespace}`, rows);
            if (moved === null) {
                return false;
            }
            this.log.info(
                `The PV sources moved from the table to the fixed fields of the settings page (${moved} registers); the adapter restarts once`,
            );
            return true;
        } catch (error) {
            // the old rows stay and keep working (readPvSettings reads them as long as the fields are empty)
            this.log.warn(`The PV sources could not be moved to the new fields: ${(error as Error).message}`);
            return false;
        }
    }

    /**
     * Create the two states every writing module has: the conflict flag and the time of the last write.
     *
     * @param channel channel of the module
     * @param conflict name of the conflict state
     * @param last name of the last-write state
     */
    private async defineWriterStates(channel: string, conflict: string, last: string): Promise<void> {
        await this.defineState(`${channel}.writer_conflict`, conflict, 'boolean', 'indicator.alarm');
        await this.defineState(`${channel}.last_write`, last, 'number', 'date');
    }

    /**
     * What the PV and the feeding runners need from the adapter: raw Modbus access through the poller, foreign states, publishing.
     *
     * @param channel channel of the module's states
     */
    private writerHost(channel: string): ConstructorParameters<typeof RoomRunner>[0] {
        return {
            now: () => Date.now(),
            log: this.log,
            timers: this.intervalTimers(),
            connected: () => this.poller?.isConnected === true,
            read: async (address, count) => (await this.poller?.readRaw(3, address, count)) ?? OFFLINE,
            write: async (address, words) => (await this.poller?.writeRaw(address, words)) ?? OFFLINE,
            subscribe: id => this.subscribeForeignStates(id),
            foreignState: id => this.foreignState(id),
            publish: (id, value) => this.put(`${channel}.${id}`, { val: value, ack: true }),
        };
    }

    /**
     * A foreign state as the runners want it.
     *
     * @param id foreign state id
     */
    private async foreignState(id: string): Promise<{ val: ioBroker.StateValue; ts: number } | null> {
        const state = await this.getForeignStateAsync(id);
        return state ? { val: state.val, ts: state.ts } : null;
    }

    /**
     * Start the PV module (spec Modul D): writes PV values from foreign states to the Navigator in a fixed interval.
     *
     * @param registers all registers of the family
     */
    private async startPv(registers: readonly RegisterEntry[]): Promise<void> {
        const settings = readPvSettings(this.config);
        this.warnAll(settings.warnings);
        if (!settings.enabled) {
            return;
        }
        if (!settings.sources.length) {
            this.log.warn('The PV module is on, but no source is configured - nothing is written');
            return;
        }
        await this.defineWriterStates('pv', 'PV writer conflict', 'Last PV write');
        this.pv = new PvRunner(this.writerHost('pv'), { settings, registers, floatWordOrder: this.floatWordOrder });
        await this.pv.start();
    }

    /**
     * Start the statistics module (spec Modul G) or remove its objects when it is switched off.
     *
     * @param circuits enabled heating circuit letters
     * @param intervalsMs polling intervals per group
     * @param registers all registers of the family (to know the polling group of each reading)
     */
    private async startStatistics(
        circuits: string[],
        intervalsMs: Record<'fast' | 'medium' | 'slow' | 'config', number>,
        registers: readonly RegisterEntry[],
    ): Promise<void> {
        const settings = readStatsSettings(this.config);
        this.warnAll(settings.warnings);
        if (!settings.enabled) {
            if (this.config.removeInactiveStates) {
                for (const id of ['calc', 'stats']) {
                    try {
                        await this.delObjectAsync(id, { recursive: true });
                    } catch {
                        // nothing to remove
                    }
                }
            }
            return;
        }
        const known = new Set(registers.map(reg => reg.id));
        if (!known.has('power_consumption_hp')) {
            this.log.warn(
                'The statistics need register power_consumption_hp, which this register family does not have',
            );
            return;
        }
        this.stats = new StatsRunner(
            {
                now: () => Date.now(),
                log: this.log,
                timers: this.intervalTimers(),
                sample: id => this.samples.get(id),
                createObjects: planned => this.createPlanned(planned),
                publish: (id, value) => this.put(id, { val: value, ack: true }),
                loadData: async () => {
                    const state = await this.getStateAsync('stats.data');
                    return typeof state?.val === 'string' ? state.val : null;
                },
                saveData: json => this.put('stats.data', json, true),
                foreignUnit: async id => {
                    const object = await this.getForeignObjectAsync(id);
                    const unit = (object?.common as { unit?: unknown } | undefined)?.unit;
                    return typeof unit === 'string' ? unit : undefined;
                },
                subscribe: id => this.subscribeForeignStates(id),
                foreignState: id => this.foreignState(id),
            },
            { settings, circuits, intervalsMs, tickMs: intervalsMs.fast },
        );
        await this.stats.start();
        this.log.info('Statistics started');
    }

    /**
     * Start the control module (spec Modul B) when at least one group is switched on. Nothing is writable otherwise.
     *
     * @param registers the registers of the configured installation (so that no state is subscribed that does not exist)
     * @param control the control settings
     */
    private async startControl(
        registers: readonly RegisterEntry[],
        control: ReturnType<typeof readControlSettings>,
    ): Promise<void> {
        if (!registers.some(reg => isWritable(reg, control))) {
            return;
        }
        this.control = new ControlRunner(
            {
                now: () => Date.now(),
                log: this.log,
                timers: this.managedTimers(),
                executor: {
                    connected: () => this.poller?.isConnected === true,
                    read: async reg => {
                        const fc = readFunctionCode(reg);
                        const result =
                            fc && this.poller ? await this.poller.readRaw(fc, reg.address, reg.words) : undefined;
                        return result ?? OFFLINE;
                    },
                    write: async (reg, words) => (await this.poller?.writeRaw(reg.address, words)) ?? OFFLINE,
                },
                lastKnown: id => this.samples.get(id)?.value ?? undefined,
                subscribe: stateId => this.subscribeStates(stateId),
                acknowledge: (stateId, value) => this.put(stateId, { val: value, ack: true }),
                reportError: message => {
                    this.errorCount++;
                    this.put('diag.lastError', message, true);
                },
                publishCounter: (registerId, counters) => void this.publishWriteCounter(registerId, counters.total),
                loadCounters: async () => {
                    const state = await this.getStateAsync('diag.writesData');
                    return typeof state?.val === 'string' ? state.val : null;
                },
                saveCounters: json => this.put('diag.writesData', json, true),
            },
            {
                registers,
                control,
                floatWordOrder: this.floatWordOrder,
                dateKey: localDateKey,
            },
        );
        await this.control.start();
    }

    /**
     * Publish the number of writes of a register (`diag.writes.<id>`), creating the state on first use.
     *
     * @param registerId register id
     * @param total writes since the counters started
     */
    private async publishWriteCounter(registerId: string, total: number): Promise<void> {
        const id = `diag.writes.${registerId}`;
        await this.defineState(id, localized('Writes of {id}', { id: registerId }), 'number', 'value', { def: 0 });
        await this.setState(id, total, true);
    }

    /** FLOAT word order from the configuration. */
    private get floatWordOrder(): FloatWordOrder {
        return this.config.floatWordOrder === 'highFirst' ? 'highFirst' : 'lowFirst';
    }

    /**
     * Log every problem the config readers found.
     *
     * @param warnings the warnings of a settings reader
     */
    private warnAll(warnings: readonly string[]): void {
        warnings.forEach(warning => this.log.warn(warning));
    }

    /**
     * Create or update a read-only state (writable ones through `extra`).
     *
     * @param id state id
     * @param name English name from the dictionary, or an already localized one
     * @param type value type
     * @param role ioBroker role
     * @param extra further `common` fields, also overriding `read`/`write`
     */
    private async defineState(
        id: string,
        name: string | LocalizedText,
        type: ioBroker.CommonType,
        role: string,
        extra: Partial<ioBroker.StateCommon> = {},
    ): Promise<void> {
        await this.extendObject(id, {
            type: 'state',
            common: {
                name: typeof name === 'string' ? localized(name) : name,
                type,
                role,
                read: true,
                write: false,
                ...extra,
            },
            native: {},
        });
    }

    /**
     * Create the objects a module planned.
     *
     * @param planned ids with their objects
     */
    private async createPlanned(planned: readonly PlannedObject[]): Promise<void> {
        for (const { id, object } of planned) {
            await this.extendObject(id, object);
        }
    }

    /** The adapter's managed interval timers, handed to the runners (CLAUDE.md rule 17). */
    private intervalTimers(): {
        setInterval: (cb: () => void, ms: number) => unknown;
        clearInterval: (handle: unknown) => void;
    } {
        return {
            setInterval: (cb, ms) => this.setInterval(cb, ms),
            clearInterval: handle => this.clearInterval(handle as ioBroker.Interval | undefined),
        };
    }

    /** The adapter's managed timers, handed to helper classes (CLAUDE.md rule 17). */
    private managedTimers(): ManagedTimers {
        return {
            setTimeout: (cb, ms) => this.setTimeout(cb, ms),
            clearTimeout: handle => this.clearTimeout(handle as ioBroker.Timeout | undefined),
            delay: ms => this.delay(ms),
        };
    }

    /**
     * Create channels and states of the enabled registers (extendObject keeps user changes like custom settings).
     *
     * @param active enabled registers
     * @param heatingCircuitNames configured heating circuit names
     * @param writable whether the user may write the state of a register
     */
    private async createObjects(
        active: readonly RegisterEntry[],
        heatingCircuitNames: Record<string, string>,
        writable: (reg: RegisterEntry) => boolean,
    ): Promise<void> {
        for (const { id, object } of planObjects(active, heatingCircuitNames, writable, this.language ?? 'en')) {
            if (!this.createdStates.has(id)) {
                await this.extendObject(id, object);
                this.createdStates.add(id);
            }
        }
        for (const reg of active.filter(r => FAULT_REGISTER_IDS.includes(r.id))) {
            const id = `${stateIdFor(reg)}_text`;
            if (!this.createdStates.has(id)) {
                await this.defineState(id, 'Fault text', 'string', 'text');
                this.createdStates.add(id);
            }
        }
    }

    /**
     * Delete states (and channels) of registers the configuration no longer enables.
     *
     * @param all every register of the family
     * @param active enabled registers
     */
    private async removeInactive(all: readonly RegisterEntry[], active: readonly RegisterEntry[]): Promise<void> {
        let removed = 0;
        for (const id of planCleanup(all, active)) {
            try {
                if (await this.getObjectAsync(id)) {
                    await this.delObjectAsync(id);
                    removed++;
                }
            } catch (error) {
                this.log.debug(`Could not remove ${id}: ${(error as Error).message}`);
            }
        }
        if (removed) {
            this.log.info(`Removed ${removed} objects of registers that are no longer enabled`);
        }
    }

    /**
     * Fire-and-forget state write for the poller callbacks: the poller must not wait for the database, and a failed write
     * is only worth a debug line (the next cycle writes again).
     *
     * @param id state id
     * @param state value or full state
     * @param ack acknowledge flag when `state` is a plain value
     */
    private put(id: string, state: ioBroker.StateValue | ioBroker.SettableState, ack?: boolean): void {
        const result = ack === undefined ? this.setState(id, state) : this.setState(id, state, ack);
        result.catch((error: Error) => this.log.debug(`Could not write ${id}: ${error.message}`));
    }

    /** Receiver for everything the poller reports. */
    private createSink(): PollSink {
        return {
            write: (reg, value, valid) => {
                const send = (): void => {
                    this.put(stateIdFor(reg), {
                        val: toStateValue(reg, value),
                        ack: true,
                        q: valid ? 0 : QUALITY_INVALID,
                    });
                    if (FAULT_REGISTER_IDS.includes(reg.id)) {
                        const text = valid && typeof value === 'number' ? faultText(value, this.language ?? 'en') : '';
                        this.put(`${stateIdFor(reg)}_text`, { val: text, ack: true });
                    }
                };
                if (valid) {
                    this.validSeen.add(reg.id);
                    this.validNow.add(reg.id);
                } else {
                    this.validNow.delete(reg.id);
                }
                if (this.lazyStates && !this.createdStates.has(stateIdFor(reg))) {
                    if (!valid) {
                        return; // nothing to show yet: the state appears with the first real value
                    }
                    this.objectQueue = this.objectQueue
                        .then(() => this.createObjects([reg], this.objectContext.names, this.objectContext.writable))
                        .then(send, error =>
                            this.log.debug(`Could not create ${stateIdFor(reg)}: ${(error as Error).message}`),
                        );
                    return;
                }
                send();
            },
            connection: connected => {
                this.put('info.connection', connected, true);
            },
            invalid: reg => {
                this.invalidCounts.set(reg.id, (this.invalidCounts.get(reg.id) ?? 0) + 1);
                const now = Date.now();
                if (now - (this.invalidLogged.get(reg.id) ?? 0) >= INVALID_LOG_INTERVAL_MS) {
                    this.invalidLogged.set(reg.id, now);
                    this.log.debug(
                        `${reg.id} (${reg.address}) reports an invalid value (not available or out of range)`,
                    );
                }
            },
            absent: reg => {
                this.absentIds.add(reg.id);
                if (this.createdStates.has(stateIdFor(reg))) {
                    this.put(stateIdFor(reg), { val: null, ack: true, q: QUALITY_INVALID });
                }
            },
            error: message => {
                this.errorCount++;
                this.put('diag.lastError', message, true);
            },
            sample: (reg, value, at) => {
                this.samples.set(reg.id, { value, at, poll: reg.poll });
            },
            success: () => {
                const now = Date.now();
                if (now - this.lastSuccessWritten >= LAST_SUCCESS_THROTTLE_MS) {
                    this.lastSuccessWritten = now;
                    this.put('info.lastSuccess', now, true);
                }
            },
            log: this.log,
        };
    }

    /** Write request statistics, error and invalid counters (once a minute). */
    private async writeDiagnostics(): Promise<void> {
        const stats = this.poller?.takeStats();
        if (stats) {
            await this.setState(
                'diag.requestsPerMinute',
                Math.round((stats.requests * 60000) / DIAG_INTERVAL_MS),
                true,
            );
            await this.setState('diag.avgResponseMs', Math.round(stats.avgMs), true);
        }
        await this.setState('info.errors', this.errorCount, true);
        for (const [id, count] of this.invalidCounts) {
            if (this.invalidFlushed.get(id) === count) {
                continue;
            }
            this.invalidFlushed.set(id, count);
            const stateId = `diag.invalid.${id}`;
            await this.defineState(stateId, localized('Invalid readings of {id}', { id }), 'number', 'value', {
                def: 0,
            });
            await this.setState(stateId, count, true);
        }
    }

    /**
     * Handles `sendTo` calls from the admin UI. `testConnection` opens a short-lived connection with the values currently
     * entered (not yet saved) and reads the outdoor temperature; it only reads.
     *
     * @param obj the message
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (obj.command === 'scan') {
            this.startScan(obj);
            return;
        }
        if (obj.command === 'supportExport') {
            void this.createSupportFile(obj);
            return;
        }
        if (obj.command === 'scanApply') {
            this.sendScanApply(obj);
            return;
        }
        if (obj.command === 'scanResult') {
            this.sendScanResult(obj);
            return;
        }
        if (obj.command === 'resetStatistics') {
            this.stats?.reset();
            this.sendTo(
                obj.from,
                obj.command,
                this.stats ? { result: 'statsReset' } : { error: 'statsOff' },
                obj.callback,
            );
            return;
        }
        if (obj.command !== 'testConnection') {
            return;
        }
        const config = (obj.message as { config?: Record<string, unknown> } | undefined)?.config;
        const host = formHost(config);
        if (!host) {
            this.sendTo(obj.from, obj.command, { error: 'testNoHost' }, obj.callback);
            return;
        }
        const client = new ModbusTcpClient(clientOptions(host, config, MIN_REQUEST_PAUSE_MS, this.managedTimers()));
        try {
            const connected = await client.connect();
            if (!connected.ok) {
                this.sendTo(obj.from, obj.command, { error: 'testConnectFailed' }, obj.callback);
                return;
            }
            const read = await client.readRegisters(4, 1000, 2);
            const order = config?.floatWordOrder === 'highFirst' ? 'highFirst' : 'lowFirst';
            const temperature = read.ok ? decodeWords('FLOAT', read.value, order) : null;
            if (!read.ok || temperature === null) {
                this.sendTo(obj.from, obj.command, { error: 'testReadFailed' }, obj.callback);
                return;
            }
            const detection = await detectFamily((fc, address, count) => client.readRegisters(fc, address, count));
            const selected = FAMILY_NAMES[config?.family as NavigatorFamily];
            const temperatureText = String(Math.round(temperature * 10) / 10);
            let answer: { result: string; args: string[] };
            if (!detection.family) {
                answer = { result: 'testOkUnknown', args: [temperatureText] };
            } else if (selected && detection.family !== config?.family) {
                answer = {
                    result: 'testOkMismatch',
                    args: [temperatureText, FAMILY_NAMES[detection.family], selected],
                };
            } else {
                answer = { result: 'testOk', args: [temperatureText, FAMILY_NAMES[detection.family]] };
            }
            this.log.debug(
                `Family detection: ${detection.family ?? 'undecided'} (${detection.confidence}); ${detection.evidence.join(', ')}`,
            );
            this.sendTo(obj.from, obj.command, answer, obj.callback);
        } finally {
            client.close();
        }
    }

    /**
     * Handles the `supportExport` command: writes a support report (configuration without secrets, connection state, problem
     * registers, latest readings) to the file area `support` and answers with a link to download it.
     *
     * @param obj the message
     */
    private async createSupportFile(obj: ioBroker.Message): Promise<void> {
        try {
            const report = buildSupportReport(await this.collectSupport(), new Date());
            const name = `support-${fileStamp(report.generatedAt)}.json`;
            await this.writeFileAsync(`${this.namespace}.support`, name, JSON.stringify(report, null, 2));
            // keep the last five files only
            const files = (await this.readDirAsync(`${this.namespace}.support`, '')).map(f => f.file).sort();
            for (const old of files.slice(0, Math.max(0, files.length - 5))) {
                await this.delFileAsync(`${this.namespace}.support`, old);
            }
            this.sendTo(
                obj.from,
                obj.command,
                {
                    result: 'supportCreated',
                    args: [name],
                    openUrl: `/files/${this.namespace}.support/${name}`,
                    window: '_blank',
                },
                obj.callback,
            );
        } catch (error) {
            this.log.warn(`Could not create the support file: ${(error as Error).message}`);
            this.sendTo(obj.from, obj.command, { error: 'supportFailed' }, obj.callback);
        }
    }

    /** Collect what the support report is made of; only whitelisted configuration values, never hosts, PINs or state ids. */
    private async collectSupport(): Promise<SupportInput> {
        const config = this.config as unknown as Record<string, unknown>;
        const keep = [
            'family',
            'port',
            'unitId',
            'requestTimeoutMs',
            'requestPauseMs',
            'intervalFastS',
            'intervalMediumS',
            'intervalSlowS',
            'intervalConfigS',
            ...HEATING_CIRCUITS.map(letter => `hc${letter}`),
            'zoneModules',
            'roomsPerZone',
            'blockSolar',
            'blockIsc',
            'blockCascade',
            'blockBivalence',
            'blockPv',
            'blockBooster',
            'hideUnavailable',
            'removeInactiveStates',
            'writeSystem',
            'writeDhw',
            'writeZones',
            'writeExpert',
            'writeSolar',
            'eepromMinIntervalS',
            'dailyWriteWarn',
            'statsEnabled',
            'thermalSource',
            'currency',
            'pvEnabled',
            'pvIntervalS',
            'pvMaxAgeS',
            'pvSurplusMode',
            'roomsEnabled',
            'gltEnabled',
            'boostEnabled',
            'boostTargetC',
            'boostMaxMinutes',
            'webEnabled',
            'webPort',
            'webIntervalS',
            'webStatisticsIntervalS',
        ];
        const settings: Record<string, unknown> = Object.fromEntries(keep.map(key => [key, config[key]]));
        settings.heatingCircuitNamesSet = HEATING_CIRCUITS.filter(l => config[`hcName${l}`]).length;
        for (const key of ['pvSources', 'roomSources', 'gltSources']) {
            settings[key] = Array.isArray(config[key]) ? config[key].length : 0;
        }
        settings.externalMeters = ['extElecCounterId', 'extElecPowerId', 'extHeatCounterId', 'extHeatPowerId'].filter(
            k => config[k],
        ).length;
        const value = async (id: string): Promise<unknown> => (await this.getStateAsync(id))?.val ?? null;
        const now = Date.now();
        let controllerVersion: string | null = null;
        try {
            const hosts = await this.getObjectViewAsync('system', 'host', {});
            controllerVersion =
                (hosts.rows[0]?.value as { common?: { installedVersion?: string } } | undefined)?.common
                    ?.installedVersion ?? null;
        } catch {
            controllerVersion = null;
        }
        const json = async (id: string): Promise<Record<string, unknown> | null> => {
            try {
                return JSON.parse(String(await value(id))) as Record<string, unknown>;
            } catch {
                return null;
            }
        };
        const stored = await json('diag.scan');
        const scan = stored && {
            finishedAt: stored.finishedAt,
            aborted: stored.aborted,
            summary: stored.summary,
            suggestion: stored.suggestion,
        };
        const writes = await json('diag.writesData');
        return {
            adapterVersion: this.version ?? 'unknown',
            nodeVersion: process.version,
            controllerVersion,
            language: this.language ?? 'en',
            settings,
            runtime: {
                connected: this.poller?.isConnected === true,
                requestsPerMinute: await value('diag.requestsPerMinute'),
                averageResponseMs: await value('diag.avgResponseMs'),
                errorCount: this.errorCount,
                lastError: await value('diag.lastError'),
                scanRunning: this.scanRunning,
            },
            registers: {
                enabled: this.registerCount,
                absent: [...this.absentIds].sort(),
                invalidReadings: Object.fromEntries([...this.invalidCounts].sort()),
            },
            samples: Object.fromEntries(
                [...this.samples]
                    .sort()
                    .map(([id, s]) => [id, { value: s.value, ageSeconds: Math.round((now - s.at) / 1000) }]),
            ),
            scan,
            writes,
            modules: {
                pv: { conflict: await value('pv.writer_conflict'), lastWrite: await value('pv.last_write') },
                rooms: { conflict: await value('rooms.writer_conflict'), lastWrite: await value('rooms.last_write') },
                glt: { conflict: await value('glt.writer_conflict'), lastWrite: await value('glt.last_write') },
                web: { connected: await value('web.connected') },
                boost: { status: await value('dhw.boost_status'), active: await value('dhw.boost_active') },
            },
        };
    }

    /**
     * Show a status line of the scan, in the language of the system (the admin page displays this state).
     *
     * @param template English text of the dictionary
     * @param vars values for its placeholders
     */
    private setScanStatus(template: string, vars: Record<string, string> = {}): void {
        this.put('diag.scanStatus', { val: textIn(localized(template, vars), this.language), ack: true });
    }

    /** The status line after a start: the result of the last scan if there is one. */
    private async initScanStatus(): Promise<void> {
        const state = await this.getStateAsync('diag.scan');
        try {
            const scan = JSON.parse(String(state?.val)) as StoredScan;
            this.setScanStatus(SCAN_FINISHED_TEXT, this.scanStatusVars(scan.finishedAt, scan.summary));
        } catch {
            this.setScanStatus('Scan not started yet');
        }
    }

    /**
     * Placeholder values of the "scan finished" status line.
     *
     * @param finishedAt ISO time the scan ended
     * @param summary numbers of the scan summary
     */
    private scanStatusVars(finishedAt: string, summary: ScanSummaryNumbers): Record<string, string> {
        return {
            time: new Date(finishedAt).toLocaleString(this.language ?? 'en'),
            present: String(summary.present),
            unavailable: String(summary.unavailable),
            absent: String(summary.absent),
        };
    }

    /**
     * Answer an admin command from the last scan stored in `diag.scan`.
     *
     * @param obj the message
     * @param answer builds the answer from the stored scan
     */
    private sendFromScan(obj: ioBroker.Message, answer: (scan: StoredScan) => Record<string, unknown>): void {
        void this.getStateAsync('diag.scan').then(state => {
            let reply: Record<string, unknown>;
            try {
                reply = answer(JSON.parse(String(state?.val)) as StoredScan);
            } catch {
                reply = { error: 'scanNone' };
            }
            this.sendTo(obj.from, obj.command, reply, obj.callback);
        });
    }

    /**
     * Handles the `scanApply` command: the suggested installation layout of the last scan as configuration values. The admin
     * page puts them into the form (the user still saves).
     *
     * @param obj the message
     */
    private sendScanApply(obj: ioBroker.Message): void {
        this.sendFromScan(obj, ({ suggestion: s }) => ({
            result: 'scanApplied',
            native: plantToNative({ ...s, blocks: s.blocks as PlantConfig['blocks'] }),
            saveConfig: false,
            args: [s.heatingCircuits.join(', ') || '-', String(s.zoneModules), blockNames(s.blocks).join(', ') || '-'],
        }));
    }

    /**
     * Handles the `scanResult` command: the summary of the last scan (from `diag.scan`) for the admin page.
     *
     * @param obj the message
     */
    private sendScanResult(obj: ioBroker.Message): void {
        this.sendFromScan(obj, ({ finishedAt, summary, suggestion }) => ({
            result: 'scanResult',
            args: [
                new Date(finishedAt).toLocaleString(this.language ?? 'en'),
                String(summary.present),
                String(summary.unavailable),
                String(summary.absent),
                suggestion.heatingCircuits.join(', ') || '-',
                String(suggestion.zoneModules),
                String(suggestion.roomsPerZone),
                blockNames(suggestion.blocks).join(', ') || '-',
            ],
        }));
    }

    /**
     * Handles the `scan` command: answers at once (a scan takes minutes, longer than a `sendTo` waits) and runs the scan in
     * the background. The result lands in `diag.scan`, the scan files and the log.
     *
     * @param obj the message; its `config` carries the connection values currently entered in the admin UI
     */
    private startScan(obj: ioBroker.Message): void {
        const config = (obj.message as { config?: Record<string, unknown> } | undefined)?.config;
        const family = config?.family as string | undefined;
        if (!formHost(config)) {
            this.sendTo(obj.from, obj.command, { error: 'scanNoHost' }, obj.callback);
            return;
        }
        if (this.scanRunning) {
            this.sendTo(obj.from, obj.command, { error: 'scanAlreadyRunning' }, obj.callback);
            return;
        }
        const registers = loadRegisters(
            (NAVIGATOR_FAMILIES as readonly string[]).includes(family ?? '') ? (family as NavigatorFamily) : 'nav20',
        );
        if (!registers) {
            this.sendTo(obj.from, obj.command, { error: 'scanFamilyUnavailable' }, obj.callback);
            return;
        }
        this.sendTo(
            obj.from,
            obj.command,
            {
                result: 'scanStarted',
                args: [
                    String(scanMinutes(registers.filter(r => r.access !== 'W').length, Number(config?.requestPauseMs))),
                ],
            },
            obj.callback,
        );
        void this.performScan(config ?? {}, registers, (family as NavigatorFamily | undefined) ?? 'nav20');
    }

    /**
     * Scan the device (read requests only) while the poller is paused, so the Navigator sees a single connection. The poller
     * is started again afterwards.
     *
     * @param config connection values
     * @param registers registers of the family to scan
     * @param family the family name for the result
     */
    private async performScan(
        config: Record<string, unknown>,
        registers: readonly RegisterEntry[],
        family: NavigatorFamily,
    ): Promise<void> {
        this.scanRunning = true;
        await this.setState('diag.scanRunning', true, true);
        this.setScanStatus('Scan running: {percent} % - do not restart the adapter', { percent: '0' });
        const resumePolling = this.poller !== null;
        this.poller?.stop();
        this.poller = null;
        const pauseMs = clampTimerMs(Number(config.requestPauseMs), DEFAULT_REQUEST_PAUSE_MS, MIN_REQUEST_PAUSE_MS);
        const client = new ModbusTcpClient(clientOptions(formHost(config), config, pauseMs, this.managedTimers()));
        try {
            const connected = await client.connect();
            if (!connected.ok) {
                this.log.error('Scan not started: connection to the Navigator failed');
                this.setScanStatus('Scan not started: no connection to the Navigator');
                return;
            }
            const count = registers.filter(r => r.access !== 'W').length;
            this.log.info(
                `Scan started: reading ${count} registers one by one, about ${scanMinutes(count, Number(config.requestPauseMs))} minutes. Do not restart the adapter meanwhile`,
            );
            this.put('diag.scanProgress', { val: 0, ack: true });
            let lastPercent = -1;
            let lastLogged = -1;
            const scan = await runScan({
                registers,
                client,
                floatWordOrder: config.floatWordOrder === 'highFirst' ? 'highFirst' : 'lowFirst',
                now: () => Date.now(),
                family,
                device: 'unknown',
                adapterVersion: this.version ?? '0.0.0',
                shouldStop: () => this.unloading,
                progress: (done, total) => {
                    const percent = Math.floor((done * 100) / total);
                    if (percent !== lastPercent) {
                        lastPercent = percent;
                        this.put('diag.scanProgress', { val: percent, ack: true });
                        this.setScanStatus('Scan running: {percent} % - do not restart the adapter', {
                            percent: String(percent),
                        });
                        if (percent - lastLogged >= 10) {
                            lastLogged = percent;
                            this.log.info(`Scan ${percent}% (${done}/${total})`);
                        }
                    }
                },
            });
            await this.publishScan(scan);
        } catch (error) {
            this.log.error(`Scan failed: ${(error as Error).message}`);
            this.setScanStatus('Scan failed - see the log');
        } finally {
            client.close();
            this.scanRunning = false;
            if (this.unloading) {
                this.log.warn(
                    'The scan was interrupted because the adapter stopped; start it again and leave the adapter running',
                );
            }
            if (!this.unloading) {
                await this.setState('diag.scanRunning', false, true);
                if (resumePolling && this.createPoller) {
                    this.poller = this.createPoller();
                    this.poller.start();
                }
            }
        }
    }

    /**
     * Store a finished scan: JSON and CSV files, the summary state and a log line with the suggested layout.
     *
     * @param scan the scan result
     */
    private async publishScan(scan: ScanResult): Promise<void> {
        const summary = summarizeScan(scan);
        const suggestion = suggestPlant(scan);
        const base = `scan-${scan.family}-${fileStamp(scan.finishedAt)}`;
        try {
            await this.writeFileAsync(`${this.namespace}.scans`, `${base}.json`, JSON.stringify(scan));
            await this.writeFileAsync(`${this.namespace}.scans`, `${base}.csv`, scanToCsv(scan));
        } catch (error) {
            this.log.warn(`Could not write the scan files: ${(error as Error).message}`);
        }
        const blocks = blockNames(suggestion.blocks);
        const layout = `heating circuits ${suggestion.heatingCircuits.join(', ') || 'none'}; zone modules ${suggestion.zoneModules}${suggestion.zoneModules ? ` (up to ${suggestion.roomsPerZone} rooms)` : ''}; blocks ${blocks.join(', ') || 'none'}`;
        await this.setState(
            'diag.scan',
            JSON.stringify({
                finishedAt: scan.finishedAt,
                aborted: scan.aborted ?? null,
                summary,
                suggestion,
                files: base,
            }),
            true,
        );
        if (scan.aborted) {
            this.setScanStatus('Scan ended early - see the log');
        } else {
            this.setScanStatus(SCAN_FINISHED_TEXT, this.scanStatusVars(scan.finishedAt, summary));
        }
        this.log.info(
            `Scan ${scan.aborted ? `ended early (${scan.aborted})` : 'finished'}: ${summary.present} registers answered, ${summary.unavailable} answered "not available", ${summary.absent} do not exist. Suggested installation: ${layout}. Files: ${base}.json / .csv`,
        );
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
        const finish = (): void => {
            try {
                for (const key of ['web', 'nav10', 'glt', 'rooms', 'pv', 'control', 'stats', 'poller'] as const) {
                    this[key]?.stop();
                    this[key] = null;
                }
                if (this.diagTimer) {
                    this.clearInterval(this.diagTimer);
                    this.diagTimer = undefined;
                }
            } catch (error) {
                this.log.error(`Error during unloading: ${(error as Error).message}`);
            }
            callback();
        };
        this.unloading = true;
        const boost = this.boost;
        this.boost = null;
        if (boost?.running) {
            // a running boost must be ended while the connection is still up (3 s at most)
            void Promise.race([
                boost.shutdown(),
                new Promise<void>(resolve => void this.setTimeout(resolve, 3000)),
            ]).then(finish, finish);
        } else {
            void boost?.shutdown();
            finish();
        }
    }

    /**
     * Is called if a subscribed state changes: writable states go to the control module, foreign states to the statistics.
     *
     * @param id - State ID
     * @param state - State object
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!id.startsWith(`${this.namespace}.`)) {
            // a foreign state of the statistics (external meters, price)
            const foreign = state ? { val: state.val, ts: state.ts } : null;
            this.stats?.onForeignState(id, foreign);
            this.pv?.onForeignState(id, foreign);
            this.rooms?.onForeignState(id, foreign);
            this.glt?.onForeignState(id, foreign);
            return;
        }
        if (state && !state.ack && (id.endsWith('.dhw.boost_start') || id.endsWith('.dhw.boost_stop'))) {
            if (state.val === true && this.boost) {
                void (id.endsWith('boost_start') ? this.boost.begin() : this.boost.cancel());
            }
            this.put(id.slice(this.namespace.length + 1), { val: false, ack: true });
            return;
        }
        if (state && !state.ack) {
            if (this.control) {
                this.control.onStateChange(id.slice(this.namespace.length + 1), state);
            } else {
                this.log.debug(`Ignoring command for ${id}: writing is not enabled`);
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new IdmModbus(options);
} else {
    // otherwise start the instance directly
    (() => new IdmModbus())();
}
