import { expect } from 'chai';
import { fail, ok } from '../modbus/result';
import type { PlannedObject } from '../object-tree';
import { WebClient } from './client';
import { copOf, parseCircuitNames, parseRooms, parseStatistics } from './parse';
import { WebRunner, type WebHost } from './runner';
import { buildStatisticsStates } from './statistics';

/** The shape of the real responses, with made-up names. */
const rooms = [
    { id: 101, name: 'Room One', mode: 'auto_normal', humidity: 43, temperature: { actual: 23.5, target: 23 } },
    { id: 109, name: 'Room Nine', mode: 'auto_comfort', temperature: { actual: '--.-', target: 22.5 } },
    { id: 5, name: 'Odd id', mode: '', temperature: {} },
    { id: 102, name: '   ', mode: 'x' },
];
const heatpump = {
    hk: [
        { hk: 'A', name: 'Circuit One' },
        { hk: 'x', name: 'Bad' },
        { hk: 'B', name: '' },
    ],
};

describe('parseRooms', () => {
    it('reads names, modes and values; no temperature or humidity becomes null; zone and room come from the id', () => {
        const parsed = parseRooms(rooms);
        expect(parsed.map(r => r.id)).to.deep.equal([101, 109, 5]);
        expect(parsed[0]).to.deep.include({
            zone: 1,
            room: 1,
            name: 'Room One',
            actual: 23.5,
            target: 23,
            humidity: 43,
        });
        expect(parsed[1]).to.deep.include({ zone: 1, room: 9, actual: null, target: 22.5, humidity: null });
        expect(parsed[2]).to.deep.include({ zone: null, room: null });
        expect(parseRooms({ not: 'a list' })).to.deep.equal([]);
    });
    it('reads circuit names by letter and ignores unusable entries', () => {
        expect(parseCircuitNames(heatpump)).to.deep.equal({ A: 'Circuit One' });
        expect(parseCircuitNames(null)).to.deep.equal({});
    });
});

describe('WebClient', () => {
    const response = (status: number, body: string, cookie?: string): Response =>
        ({
            status,
            text: () => Promise.resolve(body),
            headers: { getSetCookie: () => (cookie ? [cookie] : []) },
        }) as unknown as Response;

    it('logs in with the PIN, sends the CSRF token and the cookie with every data request, and uses only GET for data', async () => {
        const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
        const fetchFn = ((url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
            calls.push({ method: init.method, url, headers: init.headers, body: init.body });
            if (url.endsWith('/enterpin.html')) {
                return Promise.resolve(response(200, '<form>', 'MYIDM=abc; path=/'));
            }
            if (url.endsWith('/index.php')) {
                return Promise.resolve(response(200, '<script>csrf_token="1f2e3d"</script>'));
            }
            return Promise.resolve(response(200, JSON.stringify(rooms)));
        }) as unknown as typeof fetch;
        const client = new WebClient({ host: 'navigator.local', port: 80, pin: '4711', timeoutMs: 1000, fetchFn });
        const result = await client.getData('rooms');
        expect(result.ok).to.equal(true);
        const data = calls.find(c => c.url.endsWith('/data/rooms.php'));
        expect(data?.method).to.equal('GET');
        expect(data?.headers).to.deep.include({ 'CSRF-Token': '1f2e3d', Cookie: 'MYIDM=abc' });
        expect(calls.find(c => c.url.endsWith('/index.php'))?.body).to.equal('pin=4711');
        await client.getData('rooms'); // the session is reused
        expect(calls.filter(c => c.url.endsWith('/index.php'))).to.have.length(1);
    });

    it('reports a wrong PIN without the PIN or the host in the message, and logs in again when the session expired', async () => {
        let login = 0;
        const rejecting = ((url: string) =>
            Promise.resolve(
                response(200, url.endsWith('/index.php') ? '<form name="pin">' : ''),
            )) as unknown as typeof fetch;
        const wrong = await new WebClient({
            host: 'secret.host',
            port: 80,
            pin: '9999',
            timeoutMs: 1000,
            fetchFn: rejecting,
        }).getData('rooms');
        expect(wrong.ok).to.equal(false);
        expect(JSON.stringify(wrong)).to.not.match(/9999|secret\.host/);

        let expired = false;
        const fetchFn = ((url: string) => {
            if (url.endsWith('/index.php')) {
                login++;
                return Promise.resolve(response(200, 'csrf_token="aa11"'));
            }
            if (url.endsWith('/data/rooms.php')) {
                const gone = !expired;
                expired = true;
                return Promise.resolve(response(gone ? 302 : 200, gone ? '' : '[]'));
            }
            return Promise.resolve(response(200, ''));
        }) as unknown as typeof fetch;
        const again = await new WebClient({ host: 'h', port: 80, pin: '1', timeoutMs: 1000, fetchFn }).getData('rooms');
        expect(again.ok).to.equal(true);
        expect(login).to.equal(2);
    });

    it('turns network problems into results instead of throwing', async () => {
        const fetchFn = (() => Promise.reject(new Error('ECONNREFUSED 10.0.0.1'))) as unknown as typeof fetch;
        const result = await new WebClient({ host: 'h', port: 80, pin: '1', timeoutMs: 1000, fetchFn }).getData(
            'rooms',
        );
        expect(result.ok).to.equal(false);
        expect(JSON.stringify(result)).to.not.contain('10.0.0.1');
    });
});

describe('WebRunner', () => {
    interface Harness {
        runner: WebRunner;
        log: string[];
        published: Map<string, unknown>;
        created: string[];
        roomNames: string[];
        circuitNames: string[];
    }
    /** What Modbus delivers (tags and zone rooms as `zone.room`) and what an earlier start left in the object tree. */
    interface Modbus {
        tags?: string[];
        rooms?: string[];
        existing?: string[];
    }
    const make = (
        answer: () => ReturnType<WebHost['getData']>,
        settings: unknown = {},
        modbus: Modbus = {},
    ): Harness => {
        const log: string[] = [];
        const published = new Map<string, unknown>();
        const created: string[] = [];
        const roomNames: string[] = [];
        const circuitNames: string[] = [];
        const host: WebHost = {
            now: () => 0,
            log: {
                debug: m => log.push(`debug ${m}`),
                info: m => log.push(`info ${m}`),
                warn: m => log.push(`warn ${m}`),
            },
            timers: { setInterval: () => 1, clearInterval: () => undefined },
            getData: name =>
                name === 'rooms'
                    ? answer()
                    : name === 'settings'
                      ? Promise.resolve(ok(settings))
                      : Promise.resolve(ok(heatpump)),
            sleep: () => Promise.resolve(),
            createObjects: (objects: PlannedObject[]) => {
                created.push(...objects.map(o => o.id));
                return Promise.resolve();
            },
            publish: (id, value) => void published.set(id, value),
            setRoomName: (zone, room, name) => void roomNames.push(`${zone}.${room}=${name}`),
            setCircuitName: (letter, name) => void circuitNames.push(`${letter}=${name}`),
            existingIds: prefix => Promise.resolve((modbus.existing ?? []).filter(id => id.startsWith(`${prefix}.`))),
            hasModbusValue: tag => (modbus.tags ?? []).includes(tag),
            hasModbusRoom: (zone, room) => (modbus.rooms ?? []).includes(`${zone}.${room}`),
        };
        return {
            runner: new WebRunner(host, { intervalMs: 60000, statisticsIntervalMs: 0 }),
            log,
            published,
            created,
            roomNames,
            circuitNames,
        };
    };

    it('creates the objects once, publishes the values and hands the names on', async () => {
        const t = make(() => Promise.resolve(ok(rooms)));
        await t.runner.start();
        await t.runner.tick();
        expect(t.created.filter(id => id === 'web.rooms.101')).to.have.length(1);
        expect(t.created).to.include.members([
            'web',
            'web.connected',
            'web.rooms.101.temperature',
            'web.rooms.109.humidity',
        ]);
        expect(t.published.get('web.rooms.101.name')).to.equal('Room One');
        expect(t.published.get('web.rooms.109.temperature')).to.equal(null);
        expect(t.published.get('web.connected')).to.equal(true);
        expect(t.roomNames).to.include('1.1=Room One').and.include('1.9=Room Nine');
        expect(t.circuitNames).to.deep.equal(['A=Circuit One']);
    });

    it('publishes the inputs and outputs of the settings tree and leaves out sensors Modbus has', async () => {
        const table = (rows: string): string => `<table id="idm_info">${rows}</table>`;
        const settings = [
            {
                id: 'INFOAIN',
                value: table(
                    '<tr><td>B32</td><td>Outdoor</td><td>8.5</td><td>°C</td></tr><tr><td>B2</td><td>Flow</td><td>1.5</td><td>l/min</td></tr>',
                ),
            },
            { id: 'INFODIN', value: table('<tr><td>B1</td><td>DHW flow</td><td>1</td><td></td></tr>') },
        ];
        const t = make(() => Promise.resolve(ok(rooms)), settings, { tags: ['B32'] });
        await t.runner.start();
        await t.runner.tick();
        expect(t.created).to.include.members(['web.io', 'web.io.sensors', 'web.io.sensors.b2', 'web.io.digital_in.b1']);
        expect(t.created).to.not.include('web.io.sensors.b32');
        expect(t.published.get('web.io.sensors.b2')).to.equal(1.5);
        expect(t.published.get('web.io.digital_in.b1')).to.equal(true);
        expect(t.created.filter(id => id === 'web.io.sensors.b2')).to.have.length(1);
    });

    it('creates nothing for a room that Modbus delivers, and keeps what an earlier start left', async () => {
        const t = make(
            () => Promise.resolve(ok(rooms)),
            {},
            {
                rooms: ['1.1'],
                existing: ['web.rooms.101.temperature', 'web.rooms.109.temperature', 'web.io.sensors.b51'],
            },
        );
        await t.runner.start();
        await t.runner.tick();
        expect(t.created.filter(id => id.startsWith('web.rooms.101'))).to.deep.equal([]); // Modbus reads it: nothing here
        expect(t.created).to.include('web.rooms.109.humidity'); // not read by Modbus: all values from the web
        expect(t.published.has('web.rooms.101.name')).to.equal(false);
        expect(t.roomNames).to.include('1.1=Room One'); // the name goes to the channel of the zone room
    });

    it('gives a room that Modbus reads a name state, once, and the channel its name', async () => {
        const t = make(() => Promise.resolve(ok(rooms)), {}, { rooms: ['1.1'] });
        await t.runner.start();
        await t.runner.tick();
        await t.runner.tick();
        expect(t.created.filter(id => id === 'zones.1.rooms.1.name')).to.have.length(1);
        expect(t.published.get('zones.1.rooms.1.name')).to.equal('Room One');
        expect(t.created).to.not.include('zones.1.rooms.9.name'); // Modbus does not read room 9: its name stays under web.rooms
        expect(t.roomNames).to.include('1.1=Room One');
    });

    it('marks the interface unreachable with one warning and recovers', async () => {
        let up = false;
        const t = make(() => Promise.resolve(up ? ok(rooms) : fail('connect', 'The web interface is not reachable')));
        await t.runner.start();
        await t.runner.tick();
        expect(t.published.get('web.connected')).to.equal(false);
        expect(t.log.filter(l => l.startsWith('warn'))).to.have.length(1);
        up = true;
        await t.runner.tick();
        expect(t.published.get('web.connected')).to.equal(true);
    });
});

describe('web statistics', () => {
    /**
     * The shape of the real pages, with made-up numbers.
     *
     * @param unitTotal unit of the lifetime totals
     * @param totals lifetime total per category
     * @param rows category names, one array per row of columns
     * @param period values of one period, arranged like the rows
     */
    const page = (unitTotal: string, totals: number[], rows: string[][], period: number[][]): unknown => ({
        data: {
            unitTotal,
            total: rows.flat().map((name, i) => ({ name, value: totals[i] })),
            daily: [{ name: '10.10', values: period }],
            monthly: [{ name: '2026.10', values: period.map(r => r.map(v => v * 10)) }],
            yearly: [{ name: '2026', values: period.map(r => r.map(v => v * 100)) }],
        },
        items: rows.map(row => row.map(name => ({ name }))),
    });
    const heat = page('MWh', [60, 4, 24, 2.5], [['Heizen', 'Kühlen', 'Warmwasser'], ['Abtauung']], [[6, 0, 12], [0.5]]);
    const electricity = page(
        'kWh',
        [12000, 700, 2000, 400],
        [['Heizen', 'Kühlen', 'Warmwasser', 'Abtauung']],
        [[1, 0, 2, 0.5]],
    );

    it('reads totals in their unit, periods in the base unit, and the categories of every row', () => {
        const table = parseStatistics(heat);
        expect(table?.total).to.deep.equal({ heating: 60000, cooling: 4000, hot_water: 24000, defrost: 2500 });
        expect(table?.daily[0]).to.deep.equal({
            name: '10.10',
            values: { heating: 6, cooling: 0, hot_water: 12, defrost: 0.5 },
        });
        // a period without the second row (no defrost) has 0 for it, not nothing
        const short = parseStatistics({
            data: { unitTotal: 'kWh', daily: [{ name: '10.10', values: [[1, 2, 3]] }] },
            items: [[{ name: 'Heizen' }, { name: 'Kühlen' }, { name: 'Warmwasser' }], [{ name: 'Abtauung' }]],
        });
        expect(short?.daily[0].values).to.deep.equal({ heating: 1, cooling: 2, hot_water: 3, defrost: 0 });
        expect(parseStatistics({ nothing: true })).to.equal(null);
        expect(
            parseStatistics({
                data: { unitTotal: 'furlongs', total: [{ name: 'Heizen', value: 1 }] },
                items: [[{ name: 'Heizen' }]],
            })?.total,
        ).to.deep.equal({});
    });

    it('builds states per kind, category and period, the history, and the COP', () => {
        const states = buildStatisticsStates({
            heat: parseStatistics(heat) ?? undefined,
            electricity: parseStatistics(electricity) ?? undefined,
        });
        expect(states.values.get('web.statistics.heat.heating.total')).to.equal(60000);
        expect(states.values.get('web.statistics.heat.all.today')).to.equal(18.5);
        expect(states.values.get('web.statistics.electricity.all.total')).to.equal(15100);
        expect(states.values.get('web.statistics.cop.heating.total')).to.equal(5);
        expect(states.values.get('web.statistics.cop.all.month')).to.equal(5.29);
        expect(JSON.parse(String(states.values.get('web.statistics.heat.history'))).monthly[0].name).to.equal(
            '2026.10',
        );
        // every state has its channels as objects, no orphans
        const ids = new Set(states.objects.map(o => o.id));
        for (const id of ids) {
            const parent = id.split('.').slice(0, -1).join('.');
            if (parent) {
                expect(ids.has(parent) || parent === 'web', `${id} has no parent ${parent}`).to.equal(true);
            }
        }
    });

    it('leaves out the COP when a page is missing and does not divide by (almost) nothing', () => {
        expect(
            buildStatisticsStates({ heat: parseStatistics(heat) ?? undefined }).values.has(
                'web.statistics.cop.all.total',
            ),
        ).to.equal(false);
        expect(copOf(10, 0.05)).to.equal(null);
        expect(copOf(undefined, 5)).to.equal(null);
    });

    it('refuses pages that are not on the list of read-only pages', async () => {
        const client = new WebClient({
            host: 'h',
            port: 80,
            pin: '1',
            timeoutMs: 100,
            fetchFn: () => Promise.reject(new Error('no')),
        });
        expect((await client.getData('settings.php')).ok).to.equal(false);
        expect(JSON.stringify(await client.getData('../etc/passwd'))).to.contain('not read by the adapter');
    });
});
