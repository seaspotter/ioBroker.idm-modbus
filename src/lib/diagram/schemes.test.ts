import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { buildSnapshot, loadSchemes } from '../../../tools/diagram-fixtures';

const load = <T>(file: string): T => {
    const exported: { module: { exports: unknown } } = { module: { exports: {} } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'www', file), 'utf8'), exported);
    return exported.module.exports as T;
};
const diagram = load<{ buildModel(input: object): Record<string, any> }>('model.js');
const labels = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'www', 'labels.json'), 'utf8'),
) as object;

describe('plant schemes of the IDM manuals (tools/sources/diagram-schemes.json)', () => {
    const schemes = loadSchemes();

    it('has the schemes of all the manuals, each with an id, a title and tags', () => {
        expect(schemes.length).to.be.greaterThan(60);
        expect(new Set(schemes.map(s => s.id)).size).to.equal(schemes.length);
        for (const scheme of schemes) {
            expect(scheme.title, scheme.id).to.not.equal('');
            expect(scheme.tags.length, scheme.id).to.be.greaterThan(4);
        }
    });

    for (const scheme of schemes) {
        it(`${scheme.id}: the model follows from the tags (${scheme.unit})`, () => {
            const snapshot = buildSnapshot(scheme);
            const model = diagram.buildModel({
                language: 'en',
                labels,
                states: snapshot.states,
                objects: snapshot.objects,
                settings: snapshot.settings,
            });
            expect(model.heatSource, 'drawn heat source').to.equal(scheme.family === 'air' ? 'air' : 'ground');
            expect(model.circuits.length, 'circuits').to.be.greaterThan(0);
        });
    }
});
