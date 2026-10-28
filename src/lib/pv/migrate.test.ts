import { expect } from 'chai';
import { movePvRowsToFields, type PvMoveHost } from './migrate';

const ID = 'system.adapter.idm-modbus.0';

function hostWith(object: ioBroker.Object | null): { host: PvMoveHost; written: ioBroker.Object[] } {
    const written: ioBroker.Object[] = [];
    return {
        written,
        host: {
            getForeignObjectAsync: async () => object,
            setForeignObjectAsync: async (_id, obj) => {
                written.push(obj);
            },
        },
    };
}

describe('movePvRowsToFields', () => {
    it('writes the fields and an empty table back as a whole object', async () => {
        const { host, written } = hostWith({
            _id: ID,
            type: 'instance',
            common: {},
            native: { host: 'x', pvSources: [{ register: 'pv_surplus', stateId: 'a.b' }] },
        } as unknown as ioBroker.Object);
        const moved = await movePvRowsToFields(host, ID, [
            { register: 'pv_surplus', stateId: 'a.b', factor: 1 },
            { register: 'pv_production', stateId: 'c.d', factor: 1 },
        ]);
        expect(moved).to.equal(2);
        expect(written).to.have.length(1);
        const native = written[0].native as Record<string, unknown>;
        expect(native.pvSources).to.deep.equal([]);
        expect(native.pvSurplusStateId).to.equal('a.b');
        expect(native.pvProductionStateId).to.equal('c.d');
        expect(native.host).to.equal('x');
    });

    it('does nothing when the instance object is missing', async () => {
        const { host, written } = hostWith(null);
        expect(await movePvRowsToFields(host, ID, [{ register: 'pv_surplus', stateId: 'a.b' }])).to.equal(null);
        expect(written).to.have.length(0);
    });
});
