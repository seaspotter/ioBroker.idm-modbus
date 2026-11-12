import { expect } from 'chai';
import { IoPublisher } from './io-publisher';
import type { IoItem } from './io';

describe('IoPublisher', () => {
    const m73 = (value: number): { analog_out: IoItem[] } => ({
        analog_out: [{ tag: 'M73', name: 'Ladepumpe', value, unit: '%' }],
    });

    const make = (
        existing: string[] = [],
    ): { publisher: IoPublisher; modbus: { has: boolean }; published: Map<string, unknown> } => {
        const modbus = { has: false };
        const published = new Map<string, unknown>();
        const publisher = new IoPublisher({
            createObjects: () => Promise.resolve(),
            existingIds: () => Promise.resolve(existing),
            publish: (id, value) => void published.set(id, value),
            hasModbusValue: () => modbus.has,
        });
        return { publisher, modbus, published };
    };

    it('keeps the web copy current when Modbus takes the part over after the object was created', async () => {
        const t = make();
        await t.publisher.update(m73(-1)); // pump stands: Modbus reads -1 (invalid), the web copy is created
        expect(t.published.get('web.io.analog_out.m73')).to.equal(-1);
        t.modbus.has = true; // pump runs: Modbus delivers a value now
        await t.publisher.update(m73(40));
        expect(t.published.get('web.io.analog_out.m73')).to.equal(40);
    });

    it('creates no object and publishes nothing for a part Modbus delivers from the start', async () => {
        const t = make();
        t.modbus.has = true;
        await t.publisher.update(m73(40));
        expect(t.published.size).to.equal(0);
    });

    it('updates an object an earlier start created even when Modbus delivers the part', async () => {
        const t = make(['web.io.analog_out.m73']);
        t.modbus.has = true;
        await t.publisher.update(m73(40));
        expect(t.published.get('web.io.analog_out.m73')).to.equal(40);
    });
});
