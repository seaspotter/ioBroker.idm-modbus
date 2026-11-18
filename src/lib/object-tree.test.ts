import { expect } from 'chai';
import { hasCustom, planCleanup, planGuardedDeletion, planObjects } from './object-tree';
import { activeRegisters, loadRegisters, type PlantConfig } from './registers/plant';
import type { RegisterEntry } from './registers/types';

const nav20 = loadRegisters('nav20') as RegisterEntry[];
const plant: PlantConfig = {
    heatingCircuits: ['A', 'B'],
    zoneModules: 2,
    roomsPerZone: 3,
    blocks: { solar: true, isc: false, cascade: false, bivalence: true, pv: true, booster: false },
};

describe('planObjects', () => {
    const planned = planObjects(activeRegisters(nav20, plant), { A: 'Ground floor' });
    const ids = planned.map(p => p.id);

    it('creates every parent channel before its children, no orphans', () => {
        for (const [index, p] of planned.entries()) {
            if (p.object.type !== 'state') {
                continue;
            }
            const parts = p.id.split('.');
            for (let i = 1; i < parts.length; i++) {
                const parent = parts.slice(0, i).join('.');
                expect(ids.indexOf(parent), `${p.id} needs ${parent}`).to.be.within(0, index - 1);
            }
        }
        expect(new Set(ids).size).to.equal(ids.length);
    });

    it('names channels, using the configured heating circuit names', () => {
        const names = Object.fromEntries(
            planned.map(p => [p.id, (p.object.common as { name?: unknown } | undefined)?.name]),
        );
        expect(names['hc.A']).to.equal('Ground floor');
        expect(names['hc.B']).to.include({ en: 'Heating circuit B', de: 'Heizkreis B' });
        expect(names['zones.2.rooms.3']).to.include({ en: 'Room 3', de: 'Raum 3' });
        expect(planned.find(p => p.id === 'hp')?.object.type).to.equal('channel');
    });

    it('creates only what the plant enables', () => {
        expect(ids).to.include('hc.A.flow_temp');
        expect(ids).to.not.include('hc.C.flow_temp');
        expect(ids).to.include('zones.2.rooms.3.temp');
        expect(ids).to.not.include('zones.2.rooms.4.temp');
        expect(ids).to.not.include('zones.3');
        expect(ids).to.not.include('cascade');
    });

    it('stores the Modbus address in native for diagnostics', () => {
        const state = planned.find(p => p.id === 'system.outdoor_temp');
        expect(state?.object.native).to.deep.equal({ address: 1000 });
    });
});

describe('planCleanup', () => {
    it('removes states of disabled registers and channels nothing needs any more, deepest first', () => {
        const before = activeRegisters(nav20, plant);
        const after = activeRegisters(nav20, {
            ...plant,
            heatingCircuits: ['A'],
            blocks: { ...plant.blocks, solar: false },
        });
        const removed = planCleanup(before, after);
        expect(removed).to.include('hc.B.flow_temp');
        expect(removed).to.include('hc.B');
        expect(removed).to.not.include('hc.A');
        expect(removed).to.not.include('hc');
        expect(removed).to.include('solar');
        expect(removed.indexOf('hc.B.flow_temp')).to.be.lessThan(removed.indexOf('hc.B'));
    });
});

describe('hasCustom', () => {
    it('is true only for non-empty common.custom', () => {
        expect(hasCustom({ common: { custom: { 'history.0': { enabled: true } } } })).to.equal(true);
        expect(hasCustom({ common: { custom: {} } })).to.equal(false);
        expect(hasCustom({ common: {} })).to.equal(false);
        expect(hasCustom(null)).to.equal(false);
    });
});

describe('planGuardedDeletion', () => {
    it('deletes everything, deepest first, when nothing has custom settings', () => {
        const plan = planGuardedDeletion([
            { id: 'stats', custom: false },
            { id: 'stats.a.b', custom: false },
            { id: 'stats.a', custom: false },
        ]);
        expect(plan.remove).to.deep.equal(['stats.a.b', 'stats.a', 'stats']);
        expect(plan.protectedIds).to.deep.equal([]);
    });

    it('keeps a state with custom settings and its parents, deletes the rest', () => {
        const plan = planGuardedDeletion([
            { id: 'stats', custom: false },
            { id: 'stats.a', custom: false },
            { id: 'stats.a.kept', custom: true },
            { id: 'stats.a.gone', custom: false },
            { id: 'stats.b', custom: false },
        ]);
        expect(plan.remove).to.have.members(['stats.a.gone', 'stats.b']);
        expect(plan.protectedIds).to.deep.equal(['stats.a.kept']);
    });
});
