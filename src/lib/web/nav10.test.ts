import { expect } from 'chai';
import type { PlannedObject } from '../object-tree';
import { Nav10Client, type SocketLike } from './nav10-client';
import { Nav10Runner, type Nav10Host } from './nav10-runner';

const TABLE = (rows: string): string => `<table id="idm_info">${rows}</table>`;
const PAGES: Record<string, string> = {
    4768: TABLE(
        '<tr><td>B33</td><td>Wärmepumpenvorlauftemp.</td><td>30.1</td><td>°C</td></tr><tr><td>B2</td><td>Durchflußsensor Heizung</td><td>12.5</td><td>l/min</td></tr>',
    ),
    4775: TABLE('<tr><td>B1</td><td>Durchfluss Warmwasser</td><td>1</td><td></td></tr>'),
    4782: TABLE('<tr><td>M22</td><td>Warmwasserstation</td><td>40</td><td>%</td></tr>'),
    4789: TABLE('<tr><td>M31</td><td>Pumpe Heizkreis A</td><td>1</td><td></td></tr>'),
};

/** A Navigator 10 that answers like the real one (as documented by Xerolux), without a network. */
class FakeSocket implements SocketLike {
    public onopen: (() => void) | null = null;
    public onmessage: ((event: { data: unknown }) => void) | null = null;
    public onclose: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public readonly sent: string[] = [];
    public closed = false;

    public constructor(
        public readonly url: string,
        private readonly behaviour: {
            authorized?: boolean;
            unreachable?: boolean;
            silent?: boolean;
            missing?: string[];
        },
    ) {
        setTimeout(() => {
            if (behaviour.unreachable) {
                this.onerror?.();
                return;
            }
            this.onopen?.();
            setTimeout(
                () => this.onmessage?.({ data: JSON.stringify({ authorized: behaviour.authorized ?? true }) }),
                1,
            );
        }, 1);
    }

    public send(data: string): void {
        this.sent.push(data);
        if (this.behaviour.silent) {
            return;
        }
        const id = (JSON.parse(data) as { data: { settingId: string } }).data.settingId;
        const reply = this.behaviour.missing?.includes(id)
            ? { setting: { note: { text: `setting item [${id}] is not accessible!` } } }
            : { settingDetail: { id, value: PAGES[id] } };
        setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply) }), 1);
    }

    public close(): void {
        this.closed = true;
    }
}

const client = (behaviour: ConstructorParameters<typeof FakeSocket>[1], sockets: FakeSocket[] = []): Nav10Client =>
    new Nav10Client({
        host: '10.9.9.9',
        port: 61220,
        pin: 'p@ss 1',
        timeoutMs: 200,
        createSocket: url => {
            const socket = new FakeSocket(url, behaviour);
            sockets.push(socket);
            return socket;
        },
    });

describe('Nav10Client', () => {
    it('logs in with the PIN in the URL and reads a setting page as the documented request', async () => {
        const sockets: FakeSocket[] = [];
        const nav10 = client({}, sockets);
        const page = await nav10.getSetting('4768');
        expect(page.ok && page.value).to.equal(PAGES['4768']);
        expect(sockets[0].url).to.equal('ws://10.9.9.9:61220/?auth_code=p%40ss%201');
        expect(JSON.parse(sockets[0].sent[0])).to.deep.equal({
            controller: 'setting',
            command: 'detail',
            data: { settingId: '4768' },
        });
        await nav10.getSetting('4775'); // the connection is reused
        expect(sockets).to.have.length(1);
        nav10.close();
        expect(sockets[0].closed).to.equal(true);
    });

    it('reports a wrong PIN, an unreachable Navigator and a silent one without host or PIN', async () => {
        const results = [
            await client({ authorized: false }).getSetting('4768'),
            await client({ unreachable: true }).getSetting('4768'),
            await client({ silent: true }).getSetting('4768'),
        ];
        expect(results.map(r => !r.ok && r.error.kind)).to.deep.equal(['protocol', 'connect', 'timeout']);
        expect(JSON.stringify(results)).to.not.match(/10\.9\.9\.9|p@ss|p%40ss/);
    });

    it('tells a page the plant does not have from a broken connection', async () => {
        const page = await client({ missing: ['4789'] }).getSetting('4789');
        expect(!page.ok && page.error.kind).to.equal('invalid');
    });
});

describe('Nav10Runner', () => {
    const make = (
        behaviour: ConstructorParameters<typeof FakeSocket>[1],
        modbusTags: string[] = [],
    ): { runner: Nav10Runner; created: string[]; published: Map<string, unknown>; log: string[] } => {
        const created: string[] = [];
        const published = new Map<string, unknown>();
        const log: string[] = [];
        const host: Nav10Host = {
            log: {
                debug: m => log.push(`debug ${m}`),
                info: m => log.push(`info ${m}`),
                warn: m => log.push(`warn ${m}`),
            },
            timers: { setInterval: () => 1, clearInterval: () => undefined },
            sleep: () => Promise.resolve(),
            createObjects: (objects: PlannedObject[]) => {
                created.push(...objects.map(o => o.id));
                return Promise.resolve();
            },
            existingIds: () => Promise.resolve([]),
            publish: (id, value) => void published.set(id, value),
            hasModbusValue: tag => modbusTags.includes(tag),
        };
        return { runner: new Nav10Runner(host, client(behaviour), 60000), created, published, log };
    };

    it('publishes the four tables as web.io states and leaves out what Modbus delivers', async () => {
        const t = make({}, ['B33']);
        await t.runner.start();
        expect(t.published.get('web.connected')).to.equal(true);
        expect(t.published.get('web.io.sensors.b2')).to.equal(12.5);
        expect(t.published.get('web.io.digital_in.b1')).to.equal(true);
        expect(t.published.get('web.io.analog_out.m22')).to.equal(40);
        expect(t.published.get('web.io.digital_out.m31')).to.equal(1);
        expect(t.created).to.not.include('web.io.sensors.b33');
    });

    it('marks the web interface unreachable with one warning', async () => {
        const t = make({ authorized: false });
        await t.runner.start();
        await t.runner.tick();
        expect(t.published.get('web.connected')).to.equal(false);
        expect(t.log.filter(l => l.startsWith('warn'))).to.have.length(1);
        expect(t.log.join('\n')).to.contain('rejected the PIN').and.to.not.contain('p@ss');
    });
});
