import { expect } from 'chai';
import type { PlannedObject } from '../object-tree';
import { ManagedObjects, type ObjectHost } from './managed';

const object = (id: string, name: string): PlannedObject => ({
    id,
    object: { type: 'state', common: { name, type: 'number', role: 'value', read: true, write: false }, native: {} },
});

describe('ManagedObjects', () => {
    const make = (existing: string[]): { objects: ManagedObjects; written: string[] } => {
        const written: string[] = [];
        const host: ObjectHost = {
            createObjects: planned => {
                written.push(...planned.map(o => o.id));
                return Promise.resolve();
            },
            existingIds: prefix => Promise.resolve(existing.filter(id => id.startsWith(`${prefix}.`))),
        };
        return { objects: new ManagedObjects(host, 'web.io'), written };
    };

    it('creates new objects and brings the existing planned ones up to date on the first call of a start', async () => {
        const { objects, written } = make(['web.io.a', 'web.io.old']);
        await objects.sync([object('web.io.a', 'A renamed'), object('web.io.b', 'B')]);
        // "a" exists already: its name follows the plan (a renamed part reaches an installation that created it earlier)
        expect(written).to.have.members(['web.io.a', 'web.io.b']);
        // "old" is not planned any more: it stays untouched (nothing is deleted or rewritten)
        expect(written).to.not.include('web.io.old');
    });

    it('writes an object once per start, not again on later calls', async () => {
        const { objects, written } = make(['web.io.a']);
        await objects.sync([object('web.io.a', 'A')]);
        await objects.sync([object('web.io.a', 'A'), object('web.io.c', 'C')]);
        await objects.sync([object('web.io.a', 'A'), object('web.io.c', 'C')]);
        expect(written).to.deep.equal(['web.io.a', 'web.io.c']);
    });
});
