import { expect } from 'chai';
import { buildIoStates, ioKey, parseInfoTable, parseIo } from './io';

const SENSORS =
    '<table id="idm_info"> <tr><td>B32</td><td>Außentemperatur</td><td>8.5</td><td>°C</td></tr>   <tr><td>B2</td><td>Durchflußsensor Heizung</td><td>0.0</td><td>l/min</td></tr> <tr><td>B78</td><td>Verdampfungsdruck 1</td><td>9.4</td><td>bar</td></tr> <tr><td></td><td>Batteriespannung Zentraleinheit</td><td>3.23</td><td>V</td></tr> </table>';
const DIGITAL_IN =
    '<table id="idm_info"> <tr><td>B1</td><td>Durchfluss Warmwasser</td><td>1</td><td></td></tr> <tr><td>B5</td><td>Taupunktwächter&nbsp;Heizkreis A</td><td>0</td><td></td></tr> </table>';
const ANALOG_OUT =
    '<table id="idm_info"> <tr><td>M22</td><td>Warmwasserstation</td><td>-1</td><td>%</td></tr> <!-- iPumps ok --> </table>';
const DIGITAL_OUT =
    '<table id="idm_info"> <tr><td>M22</td><td>Warmwasserstation</td><td>100</td><td></td></tr> <tr><td>M41</td><td>Mischer Heizkreis A</td><td>Aus</td><td></td></tr> </table>';
const SETTINGS = [
    {
        name: 'Informationen',
        items: [
            {
                items: [
                    { id: 'INFOAIN', value: SENSORS },
                    { id: 'INFODIN', value: DIGITAL_IN },
                    { id: 'INFOAOUT', value: ANALOG_OUT },
                    { id: 'INFODOUT', value: DIGITAL_OUT },
                    { id: 'INFONETWORK', value: '<table><tr><td>IP:</td><td>10.9.9.9</td></tr></table>' },
                ],
            },
        ],
    },
];

describe('web information tables', () => {
    it('reads rows with tag, name, number or text and unit', () => {
        const rows = parseInfoTable(DIGITAL_IN + SENSORS);
        expect(rows[0]).to.deep.equal({ tag: 'B1', name: 'Durchfluss Warmwasser', value: 1, unit: '' });
        expect(rows[1].name).to.equal('Taupunktwächter Heizkreis A');
        expect(rows.find(r => r.tag === 'B2')).to.deep.equal({
            tag: 'B2',
            name: 'Durchflußsensor Heizung',
            value: 0,
            unit: 'l/min',
        });
        expect(parseInfoTable(DIGITAL_OUT)[1].value).to.equal('Aus');
        expect(parseInfoTable('<table><tr><td>x</td></tr></table>')).to.deep.equal([]);
    });

    it('finds the four tables in the settings tree and ignores everything else', () => {
        const io = parseIo(SETTINGS);
        expect(Object.keys(io)).to.have.members(['sensors', 'digital_in', 'analog_out', 'digital_out']);
        expect(JSON.stringify(io)).to.not.contain('10.9.9.9');
        expect(parseIo({ nothing: true })).to.deep.equal({});
    });

    it('keeps the device text for parts it does not know', () => {
        const states = buildIoStates(
            { digital_out: [{ tag: 'M99', name: 'Sonderpumpe', value: 1, unit: '' }] },
            () => false,
        );
        expect(states.objects.find(o => o.id === 'web.io.digital_out.m99')?.object.common?.name).to.equal(
            'M99 Sonderpumpe',
        );
    });

    it('builds keys from the tag or a plain version of the name', () => {
        expect(ioKey({ tag: 'B78v', name: 'x', value: 1, unit: '' })).to.equal('b78v');
        expect(ioKey({ tag: '', name: 'Batteriespannung Zentraleinheit', value: 1, unit: 'V' })).to.equal(
            'batteriespannung_zentraleinheit',
        );
        expect(ioKey({ tag: '', name: 'Störung Äpfel', value: 1, unit: '' })).to.equal('stoerung_aepfel');
    });

    it('creates states, skips sensors Modbus already has and types digital inputs as boolean', () => {
        const states = buildIoStates(parseIo(SETTINGS), tag => tag === 'B32');
        expect(states.values.has('web.io.sensors.b32')).to.equal(false);
        expect(states.copies.has('web.io.sensors.b32')).to.equal(true);
        expect(states.objects.some(o => o.id === 'web.io.sensors.b32')).to.equal(false);
        expect(states.values.get('web.io.sensors.b2')).to.equal(0);
        expect(states.values.get('web.io.digital_in.b1')).to.equal(true);
        expect(states.values.get('web.io.digital_in.b5')).to.equal(false);
        expect(states.values.get('web.io.analog_out.m22')).to.equal(-1);
        expect(states.values.get('web.io.digital_out.m22')).to.equal(100);
        expect(states.values.get('web.io.digital_out.m41')).to.equal('Aus');
        const byId = new Map(states.objects.map(o => [o.id, o.object.common as Record<string, unknown>]));
        expect(byId.get('web.io.sensors.b78')).to.deep.include({ role: 'value.pressure', unit: 'bar', type: 'number' });
        expect(byId.get('web.io.digital_in.b1')).to.deep.include({ type: 'boolean', role: 'indicator' });
        expect(byId.get('web.io.digital_out.m41')).to.deep.include({ type: 'string' });
        // known parts are named in all languages (with the tag in front), unknown ones as the device shows them
        expect(byId.get('web.io.sensors.b2')?.name).to.deep.include({
            en: 'B2 Heating flow sensor',
            de: 'B2 Durchflußsensor Heizung',
        });
        expect(Object.keys(byId.get('web.io.sensors.b2')?.name as object)).to.have.length(11);
        expect(byId.has('web.io')).to.equal(true);
    });
});
