import type { PlannedObject } from '../object-tree';
import { FailureLog, type IntervalTimers, type Logger, Ticker } from '../runner-kit';
import { IoPublisher, type IoHost } from './io-publisher';
import { channelObject, stateObject } from './objects';
import { ManagedObjects } from './managed';
import type { Result } from '../modbus/result';
import {
    parseCircuitNames,
    parseRooms,
    parseStatistics,
    WEB_STATISTICS,
    type WebRoom,
    type WebStatistics,
    type WebStatisticsKind,
} from './parse';
import { parseIo } from './io';
import { buildStatisticsStates } from './statistics';

/** How often the heating circuit names are read again (they hardly ever change). */
const CIRCUIT_NAMES_EVERY_MS = 3600000;

/** What the runner needs from the adapter; a fake in the tests. */
export interface WebHost extends IoHost {
    /** clock in ms */
    now(): number;
    /** log lines, never containing the host or the PIN */
    log: Logger;
    /** managed timers */
    timers: IntervalTimers;
    /** read a data page of the web interface */
    getData(name: string): Promise<Result<unknown>>;
    /** wait (managed timer), to pace the requests */
    sleep(ms: number): Promise<void>;
    /** give the channel of a zone room the name from the Navigator */
    setRoomName(zone: number, room: number, name: string): void;
    /** does Modbus deliver the temperature of this zone room? The web copy of the room's values is not needed then. */
    hasModbusRoom(zone: number, room: number): boolean;
    /** give the channel of a heating circuit the name from the Navigator (the adapter ignores it where the user named it) */
    setCircuitName(letter: string, name: string): void;
}

/** Settings of the runner. */
export interface WebOptions {
    /** poll interval in ms */
    intervalMs: number;
    /** interval of the statistics pages in ms, 0 = not read */
    statisticsIntervalMs: number;
}

/**
 * Reads the room data and the names from the Navigator's web interface in a fixed interval (spec Modul H). Read-only.
 */
export class WebRunner {
    private readonly ticker: Ticker;
    private readonly statisticsTicker: Ticker;
    private readonly failures: FailureLog;
    private statisticsBusy = false;
    private statisticsObjects = new Set<string>();
    private readonly io: IoPublisher;
    private readonly roomObjects: ManagedObjects;
    private readonly roomNameStates = new Set<string>();
    private busy = false;
    private namesAt = Number.NEGATIVE_INFINITY;

    /**
     * @param host adapter services
     * @param options settings
     */
    public constructor(
        private readonly host: WebHost,
        private readonly options: WebOptions,
    ) {
        this.io = new IoPublisher(host);
        this.ticker = new Ticker(host.timers);
        this.statisticsTicker = new Ticker(host.timers);
        this.failures = new FailureLog(host.log);
        this.roomObjects = new ManagedObjects(host, 'web.rooms');
    }

    /** Create the base objects, read once and start the cycle. */
    public async start(): Promise<void> {
        await this.host.createObjects([
            channelObject('web', 'Web interface'),
            channelObject('web.rooms', 'Rooms'),
            stateObject('web.connected', 'Web interface reachable', 'boolean', 'indicator.reachable'),
        ]);
        await this.tick();
        this.ticker.start(() => void this.tick(), this.options.intervalMs);
        if (this.options.statisticsIntervalMs > 0) {
            await this.statisticsTick();
            this.statisticsTicker.start(() => void this.statisticsTick(), this.options.statisticsIntervalMs);
        }
        this.host.log.info(`Web interface module started, every ${this.options.intervalMs / 1000} s`);
    }

    /** Stop the cycle. */
    public stop(): void {
        this.ticker.stop();
        this.statisticsTicker.stop();
    }

    /** Read the three statistics pages one after the other and publish them. Never throws. */
    public async statisticsTick(): Promise<void> {
        if (this.statisticsBusy) {
            return;
        }
        this.statisticsBusy = true;
        try {
            const tables: Partial<Record<WebStatisticsKind, WebStatistics>> = {};
            for (const kind of Object.keys(WEB_STATISTICS) as WebStatisticsKind[]) {
                const answer = await this.host.getData(WEB_STATISTICS[kind].query);
                const table = answer.ok ? parseStatistics(answer.value) : null;
                if (table) {
                    tables[kind] = table;
                } else {
                    this.host.log.debug(`Web statistics ${kind} could not be read`);
                }
                await this.host.sleep(1000);
            }
            const states = buildStatisticsStates(tables);
            const fresh = states.objects.filter(o => !this.statisticsObjects.has(o.id));
            if (fresh.length) {
                await this.host.createObjects(fresh);
                fresh.forEach(o => this.statisticsObjects.add(o.id));
            }
            states.values.forEach((value, id) => this.host.publish(id, value));
        } catch (error) {
            this.host.log.debug(`Web statistics failed: ${(error as Error).message}`);
        } finally {
            this.statisticsBusy = false;
        }
    }

    /** One pass: rooms always, circuit names now and then. Never throws. */
    public async tick(): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        try {
            const rooms = await this.host.getData('rooms');
            if (!rooms.ok) {
                this.fail(rooms.error.message);
                return;
            }
            this.failures.clear();
            this.host.publish('web.connected', true);
            await this.publishRooms(parseRooms(rooms.value));
            await this.publishIo();
            if (this.host.now() - this.namesAt >= CIRCUIT_NAMES_EVERY_MS) {
                const heatpump = await this.host.getData('heatpump');
                if (heatpump.ok) {
                    this.namesAt = this.host.now();
                    for (const [letter, name] of Object.entries(parseCircuitNames(heatpump.value))) {
                        this.host.setCircuitName(letter, name);
                    }
                }
            }
        } catch (error) {
            this.fail((error as Error).message);
        } finally {
            this.busy = false;
        }
    }

    /** Inputs and outputs (sensors, digital inputs, analog and digital outputs) from the settings tree; a failure only skips them. */
    private async publishIo(): Promise<void> {
        const settings = await this.host.getData('settings');
        if (!settings.ok) {
            this.host.log.debug(`Web inputs and outputs could not be read: ${settings.error.message}`);
            return;
        }
        await this.io.update(parseIo(settings.value));
    }

    private fail(message: string): void {
        this.host.publish('web.connected', false);
        this.failures.report(`Web interface: ${message}`);
    }

    /**
     * Rooms Modbus delivers keep only their name here (the room's values are the Modbus ones); the others get all their values.
     *
     * @param room the room of the web interface
     */
    private viaModbus(room: WebRoom): boolean {
        return room.zone !== null && room.room !== null && this.host.hasModbusRoom(room.zone, room.room);
    }

    private roomObjectsOf(room: WebRoom): PlannedObject[] {
        if (this.viaModbus(room)) {
            return [];
        }
        const base = `web.rooms.${room.id}`;
        return [
            channelObject(base, room.name, false),
            stateObject(`${base}.name`, 'Room name', 'string', 'text'),
            stateObject(`${base}.mode`, 'Operating mode', 'string', 'text'),
            stateObject(`${base}.temperature`, 'Room temperature', 'number', 'value.temperature', '°C'),
            stateObject(`${base}.target`, 'Target temperature', 'number', 'value.temperature', '°C'),
            stateObject(`${base}.humidity`, 'Room humidity', 'number', 'value.humidity', '%'),
        ];
    }

    /**
     * The name of a room Modbus reads becomes a state `zones.<Z>.rooms.<R>.name` (and the name of its channel), the other rooms get
     * all their values under `web.rooms`.
     *
     * @param rooms the rooms of the web interface
     */
    private async publishRooms(rooms: WebRoom[]): Promise<void> {
        await this.roomObjects.sync(rooms.flatMap(room => this.roomObjectsOf(room)));
        for (const room of rooms) {
            if (room.zone !== null && room.room !== null) {
                await this.publishRoomName(room.zone, room.room, room.name);
            }
            if (!this.viaModbus(room)) {
                const base = `web.rooms.${room.id}`;
                this.host.publish(`${base}.name`, room.name);
                this.host.publish(`${base}.mode`, room.mode);
                this.host.publish(`${base}.temperature`, room.actual);
                this.host.publish(`${base}.target`, room.target);
                this.host.publish(`${base}.humidity`, room.humidity);
            }
        }
    }

    /**
     * Name the channel of a zone room and, where Modbus reads the room, give it a name state.
     *
     * @param zone zone module number
     * @param room room number in the module
     * @param name the name from the Navigator
     */
    private async publishRoomName(zone: number, room: number, name: string): Promise<void> {
        this.host.setRoomName(zone, room, name);
        if (!this.host.hasModbusRoom(zone, room)) {
            return;
        }
        const id = `zones.${zone}.rooms.${room}.name`;
        if (!this.roomNameStates.has(id)) {
            await this.host.createObjects([stateObject(id, 'Room name', 'string', 'text')]);
            this.roomNameStates.add(id);
        }
        this.host.publish(id, name);
    }
}
