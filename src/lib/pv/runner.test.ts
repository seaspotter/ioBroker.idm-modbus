import { expect } from 'chai';
import type { PvSettings } from '../config';
import { loadRegisters } from '../registers/plant';
import type { RegisterEntry } from '../registers/types';
import { PvRunner, type PvHost } from './runner';

const nav20 = loadRegisters('nav20') as RegisterEntry[];
const NOW = 5_000_000;

const settings: PvSettings = {
    enabled: true,
    intervalMs: 30000,
    maxAgeMs: 120000,
    surplusMode: 'direct',
    sources: [
        { register: 'pv_surplus', stateId: 'src.surplus', factor: 1, invert: false, min: 0, max: null },
        { register: 'battery_soc', stateId: 'src.soc', factor: 1, invert: false, min: null, max: null },
    ],
    warnings: [],
};

class Fake implements PvHost {
    public time = NOW;
    public online = true;
    public memory = new Map<number, number>();
    public writes: { address: number; words: number[] }[] = [];
    public logs: string[] = [];
    public published: Record<string, boolean | number> = {};
    public sources = new Map<string, { val: unknown; ts: number }>([
        ['src.surplus', { val: 2.5, ts: NOW }],
        ['src.soc', { val: 57.4, ts: NOW }],
    ]);
    public foreignWriter = false;
    public log = {
        debug: (m: string): void => void this.logs.push(`debug ${m}`),
        info: (m: string): void => void this.logs.push(`info ${m}`),
        warn: (m: string): void => void this.logs.push(`warn ${m}`),
    };
    public timers = { setInterval: (): unknown => 1, clearInterval: (): void => {} };
    public now = (): number => this.time;
    public connected = (): boolean => this.online;
    public subscribe = (): void => {};
    public foreignState = (id: string): Promise<{ val: unknown; ts: number } | null> =>
        Promise.resolve(this.sources.get(id) ?? null);
    public publish = (id: string, value: boolean | number): void => {
        this.published[id] = value;
    };
    public read = (address: number, count: number): ReturnType<PvHost['read']> =>
        Promise.resolve({
            ok: true,
            value: Array.from({ length: count }, (_, i) =>
                this.foreignWriter ? 0x1234 : (this.memory.get(address + i) ?? 0),
            ),
        });
    public write = (address: number, words: readonly number[]): ReturnType<PvHost['write']> => {
        this.writes.push({ address, words: [...words] });
        words.forEach((w, i) => this.memory.set(address + i, w));
        return Promise.resolve({ ok: true, value: undefined });
    };
}

const make = async (host: Fake): Promise<PvRunner> => {
    const runner = new PvRunner(host, { settings, registers: nav20, floatWordOrder: 'lowFirst' });
    await runner.start();
    return runner;
};

describe('PvRunner', () => {
    it('writes the surplus as FLOAT (low word first) and the battery level as INT16 in every cycle, even when unchanged', async () => {
        const host = new Fake();
        const runner = await make(host);
        await runner.tick();
        await runner.tick();
        expect(host.writes.slice(0, 2)).to.deep.equal([
            { address: 74, words: [0x0000, 0x4020] },
            { address: 86, words: [57] },
        ]);
        expect(host.writes).to.have.length(4);
        expect(host.published.last_write).to.equal(NOW);
    });

    it('writes 0 for an old surplus and -1 for an old battery level, with one warning each', async () => {
        const host = new Fake();
        const runner = await make(host);
        host.time = NOW + 600000;
        await runner.tick();
        await runner.tick();
        expect(host.writes[0]).to.deep.equal({ address: 74, words: [0, 0] });
        expect(host.writes.find(w => w.address === 86)?.words).to.deep.equal([0xffff]); // -1: not available
        expect(host.logs.filter(l => l.startsWith('warn') && l.includes('too old'))).to.have.length(2); // surplus and battery, once each
    });

    it('does not write while the Navigator is offline', async () => {
        const host = new Fake();
        const runner = await make(host);
        host.online = false;
        await runner.tick();
        expect(host.writes).to.deep.equal([]);
    });

    it('takes new values from state changes', async () => {
        const host = new Fake();
        const runner = await make(host);
        runner.onForeignState('src.surplus', { val: 0.5, ts: NOW });
        await runner.tick();
        expect(host.writes[0].words).to.deep.equal([0x0000, 0x3f00]);
    });

    it('reports a second writer after repeated read-back differences and clears it again', async () => {
        const host = new Fake();
        const runner = await make(host);
        host.foreignWriter = true;
        for (let i = 0; i < 12; i++) {
            await runner.tick();
        }
        expect(host.published.writer_conflict).to.equal(true);
        expect(host.logs.filter(l => l.includes('another energy manager'))).to.have.length(1);
        host.foreignWriter = false;
        for (let i = 0; i < 4; i++) {
            await runner.tick();
        }
        expect(host.published.writer_conflict).to.equal(false);
    });
});
