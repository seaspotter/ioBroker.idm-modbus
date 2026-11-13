import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    compareWithPdfIndex,
    expandRegisters,
    loadFamilySource,
    type PdfIndex,
    type RegisterEntry,
} from '../../../tools/build-registers';
import { activeRegisters, type PlantConfig } from './plant';

const root = path.join(__dirname, '..', '..', '..');
const pdfIndex = JSON.parse(fs.readFileSync(path.join(root, 'tools/sources/nav10.pdf-index.json'), 'utf8')) as PdfIndex;
const generated = JSON.parse(fs.readFileSync(path.join(__dirname, 'nav10.json'), 'utf8')) as {
    registers: RegisterEntry[];
};

describe('nav10 register file', () => {
    const registers = expandRegisters(loadFamilySource('nav10', root));
    const byId = new Map(registers.map(r => [r.id, r]));

    it('is up to date with the source file (run npm run build:registers -- nav10)', () => {
        expect(generated.registers).to.deep.equal(registers);
    });

    it('contains every PDF address with matching type, access and EEPROM flag', () => {
        expect(compareWithPdfIndex(registers, pdfIndex)).to.deep.equal([]);
        expect(registers).to.have.length(pdfIndex.rows.length);
    });

    it('has six rooms per zone module and no room 9, unlike Navigator 2.0', () => {
        expect(byId.has('zm1_room6_relay')).to.equal(true);
        expect(byId.has('zm1_room7_temp')).to.equal(false);
        expect(byId.has('zm10_room9_relay')).to.equal(false);
        expect(byId.get('zm2_room1_temp')?.address).to.equal(2067);
    });

    it('has the registers only Navigator 10 documents, with the Xerolux ids', () => {
        expect(byId.get('pv_target_value')?.address).to.equal(88);
        expect(byId.get('smart_grid_status')?.address).to.equal(90);
        expect(byId.get('heat_sink_flow_temp')?.address).to.equal(1070);
        expect(byId.get('booster_b_compressor')?.address).to.equal(4052);
        expect(byId.get('power_limit_cascade')?.access).to.equal('RW');
        expect(byId.has('thermal_power_flow_sensor')).to.equal(false);
    });

    it('uses the Navigator 10 ranges where the document differs', () => {
        expect(byId.get('variable_input')?.max).to.equal(3);
        expect(byId.get('bivalence_point_1_2nd_gen')).to.deep.include({ min: -40, max: 40, default: -5 });
        expect(byId.get('ext_pump_demand_1')).to.deep.include({ min: 0, max: 100, default: -1, unit: '%' });
        expect(byId.get('current_electricity_price')?.unit).to.equal('€/MWh');
    });

    it('is documented only: nothing is verified at a device', () => {
        expect(registers.every(r => r.verified !== 'device')).to.equal(true);
    });

    it('reads the B2 flow rate as a FLOAT of two words, not as the UCHAR of the document', () => {
        // a support file showed 41699 (0xA2E3, the low word of 21.45 l/min) when only one word was read; the flow of that plant
        // computed from its heat output and spread is 21.4 l/min
        expect(byId.get('heat_sink_flow_rate')).to.deep.include({
            type: 'FLOAT',
            words: 2,
            pdfType: 'UCHAR',
            verified: 'community',
        });
    });

    it('enables the booster registers only with the booster block', () => {
        const plant: PlantConfig = {
            heatingCircuits: ['A'],
            zoneModules: 0,
            roomsPerZone: 6,
            blocks: { solar: false, isc: false, cascade: false, bivalence: false, pv: false, booster: false },
        };
        expect(activeRegisters(registers, plant).some(r => r.id.startsWith('booster_'))).to.equal(false);
        const withBooster = activeRegisters(registers, { ...plant, blocks: { ...plant.blocks, booster: true } });
        expect(withBooster.filter(r => r.id.startsWith('booster_'))).to.have.length(18);
    });
});
