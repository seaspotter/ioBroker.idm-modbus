import { expect } from 'chai';
import {
    readDiagramSettings,
    readGltSettings,
    readPlantSettings,
    readRoomSettings,
    readStatsSettings,
    readWebSettings,
} from './config';

describe('readPlantSettings', () => {
    it('uses the spec defaults for an empty configuration', () => {
        const settings = readPlantSettings({});
        expect(settings.family).to.equal('nav20');
        expect(settings.plant.heatingCircuits).to.deep.equal([]);
        expect(settings.plant.zoneModules).to.equal(0);
        expect(settings.intervalsMs).to.deep.equal({ fast: 30000, medium: 60000, slow: 300000, config: 3600000 });
        expect(settings.warnings).to.deep.equal([]);
    });

    it('reads heating circuits, names and blocks', () => {
        const settings = readPlantSettings({
            hcA: true,
            hcC: true,
            hcNameA: ' Ground floor ',
            blockSolar: true,
            blockPv: true,
            zoneModules: 2,
            roomsPerZone: 6,
        });
        expect(settings.plant.heatingCircuits).to.deep.equal(['A', 'C']);
        expect(settings.heatingCircuitNames).to.deep.equal({ A: 'Ground floor' });
        expect(settings.plant.blocks).to.deep.equal({
            solar: true,
            isc: false,
            cascade: false,
            bivalence: false,
            pv: true,
            booster: false,
        });
        expect(settings.plant.zoneModules).to.equal(2);
        expect(settings.plant.roomsPerZone).to.equal(6);
    });

    it('corrects bad entries with a warning and never throws', () => {
        const settings = readPlantSettings({
            family: 'nav99',
            intervalFastS: 2,
            intervalMediumS: 'soon',
            zoneModules: 99,
            roomsPerZone: 'many',
        } as unknown as Partial<ioBroker.AdapterConfig>);
        expect(settings.family).to.equal('nav20');
        expect(settings.intervalsMs.fast).to.equal(30000);
        expect(settings.intervalsMs.medium).to.equal(60000);
        expect(settings.plant.zoneModules).to.equal(10);
        expect(settings.plant.roomsPerZone).to.equal(8);
        expect(settings.warnings).to.have.length(5);
        expect(readPlantSettings({ intervalConfigS: 5 }).intervalsMs.config).to.equal(3600000);
        expect(readPlantSettings({ intervalConfigS: 600 }).intervalsMs.config).to.equal(600000);
    });
});

describe('readStatsSettings', () => {
    it('defaults to statistics on, no external meters, fixed price and the Navigator as heat source', () => {
        const stats = readStatsSettings({});
        expect(stats).to.deep.include({
            enabled: true,
            electricalCounter: null,
            electricalPower: null,
            heatCounter: null,
            heatPower: null,
            thermalSource: 'navigator',
            pricePerKwh: 0.3,
            priceStateId: null,
            co2StateId: null,
            currency: 'EUR',
            co2GramsPerKwh: 350,
            priceStateFactor: 1,
            co2StateFactor: 1,
            externalMaxAgeMs: 120000,
        });
        expect(stats.warnings).to.deep.equal([]);
    });
    it('reads the external meters of the test installation', () => {
        const stats = readStatsSettings({
            extElecPowerId: 'modbus.2.inputRegisters.30041_Gesamtleistung',
            extElecCounterId: 'modbus.2.inputRegisters.30275_Gesamtbezug',
            extElecPowerUnit: 'W',
        });
        expect(stats.electricalPower).to.deep.equal({ id: 'modbus.2.inputRegisters.30041_Gesamtleistung', unit: 'W' });
        expect(stats.electricalCounter).to.deep.equal({
            id: 'modbus.2.inputRegisters.30275_Gesamtbezug',
            unit: 'auto',
        });
    });
    it('switches off only the broken source and warns', () => {
        const stats = readStatsSettings({
            extElecCounterId: 'not a state id',
            extElecPowerId: 'a.b',
            extElecPowerUnit: 'MW',
            pricePerKwh: -1,
            thermalSource: 'external',
        });
        expect(stats.electricalCounter).to.equal(null);
        expect(stats.electricalPower).to.deep.equal({ id: 'a.b', unit: 'auto' });
        expect(stats.pricePerKwh).to.equal(null);
        expect(stats.thermalSource).to.equal('navigator'); // no heat counter configured
        expect(stats.warnings).to.have.length(4);
    });
});

describe('price and CO2 units', () => {
    it('turns cent and kg values into currency per kWh and g/kWh', () => {
        const stats = readStatsSettings({ pricePerKwh: 28, priceUnit: 'cent', co2GramsPerKwh: 0.35, co2Unit: 'kg' });
        expect(stats.pricePerKwh).to.be.closeTo(0.28, 1e-9);
        expect(stats.co2GramsPerKwh).to.be.closeTo(350, 1e-9);
        expect(stats.priceStateFactor).to.equal(0.01);
        expect(stats.co2StateFactor).to.equal(1000);
    });
    it('keeps the values as they are for the default units and for unknown ones', () => {
        const stats = readStatsSettings({ pricePerKwh: 0.28, priceUnit: 'euro', co2GramsPerKwh: 350, co2Unit: 'lb' });
        expect(stats.pricePerKwh).to.equal(0.28);
        expect(stats.co2GramsPerKwh).to.equal(350);
        expect(stats.priceStateFactor).to.equal(1);
        expect(stats.co2StateFactor).to.equal(1);
    });
});

describe('readGltSettings', () => {
    it('takes the defaults of the function and drops unusable or duplicate rows with a warning', () => {
        const settings = readGltSettings({
            gltEnabled: true,
            gltSources: [
                {
                    function: 'outdoor_temp',
                    stateId: 'a.b',
                    factor: 1,
                    offset: 0,
                    heartbeatS: null,
                    min: null,
                    max: null,
                    maxAgeS: null,
                },
                {
                    function: 'outdoor_temp',
                    stateId: 'c.d',
                    factor: 1,
                    offset: 0,
                    heartbeatS: null,
                    min: null,
                    max: null,
                    maxAgeS: null,
                },
                {
                    function: 'nonsense',
                    stateId: 'x',
                    factor: 1,
                    offset: 0,
                    heartbeatS: null,
                    min: null,
                    max: null,
                    maxAgeS: null,
                },
                {
                    function: 'humidity',
                    stateId: '',
                    factor: 1,
                    offset: 0,
                    heartbeatS: null,
                    min: null,
                    max: null,
                    maxAgeS: null,
                },
                {
                    function: 'demand_dhw',
                    stateId: 'e.f',
                    factor: 0,
                    offset: 0,
                    heartbeatS: null,
                    min: null,
                    max: null,
                    maxAgeS: null,
                },
            ],
        });
        expect(settings.enabled).to.equal(true);
        expect(settings.sources).to.have.length(1);
        expect(settings.sources[0]).to.deep.include({
            registerId: 'ext_outdoor_temp',
            heartbeatMs: 60000,
            min: -50,
            max: 60,
            maxAgeMs: 900000,
        });
        expect(settings.warnings).to.have.length(4);
    });
});

describe('readRoomSettings', () => {
    it('maps a heating circuit to its external room temperature register', () => {
        const settings = readRoomSettings({
            roomsEnabled: true,
            roomSources: [
                {
                    circuit: 'C',
                    stateId: 'a.b',
                    factor: 1,
                    offset: 0,
                    heartbeatS: 300,
                    toleranceC: 0.2,
                    min: 15,
                    max: 30,
                    maxAgeS: 900,
                    onStale: 'stop',
                    fixedValue: null,
                },
            ],
        });
        expect(settings.sources[0].registerId).to.equal('hc_c_ext_room_temp');
    });
});

describe('readWebSettings', () => {
    const base = { webEnabled: true, webPin: '1234' };
    it('uses the port of the Navigator generation unless one is set', () => {
        expect(readWebSettings({ ...base, webPort: 0 }, 'nav20').port).to.equal(80);
        expect(readWebSettings({ ...base, webPort: 0 }, 'nav10').port).to.equal(61220);
        expect(readWebSettings({ ...base, webPort: 8080 }, 'nav10').port).to.equal(8080);
    });
    it('stays off without a PIN', () => {
        const settings = readWebSettings({ webEnabled: true, webPin: ' ' }, 'nav10');
        expect(settings.enabled).to.equal(false);
        expect(settings.warnings).to.have.length(1);
    });
});

describe('readDiagramSettings', () => {
    it('defaults to automatic detection with everything shown', () => {
        const { settings, warnings } = readDiagramSettings({});
        expect(settings).to.deep.equal({ hidden: [], zoneCircuit: [] });
        expect(warnings).to.deep.equal([]);
    });
    it('keeps valid entries and drops unknown parts, bad zones and doubled rows with a warning', () => {
        const { settings, warnings } = readDiagramSettings({
            diagramHeatSource: 'ground',
            diagramHidden: ['solar', 'freshwater', 'garden'],
            diagramZoneCircuit: [
                { zone: 1, circuit: 'b' },
                { zone: 1, circuit: 'C' },
                { zone: 11, circuit: 'A' },
                { zone: 2, circuit: 'X' },
            ],
        });
        expect(settings).to.deep.equal({
            heatSource: 'ground',
            hidden: ['solar', 'freshwater'],
            zoneCircuit: [{ zone: 1, circuit: 'B' }],
        });
        expect(warnings).to.have.length(4);
    });
    it('reads the source of power and COP and the COP rows, and leaves the defaults out', () => {
        expect(readDiagramSettings({ diagramSource: 'internal' }).settings.source).to.equal(undefined);
        expect(readDiagramSettings({ diagramSource: 'external' }).settings.source).to.equal('external');
        expect(readDiagramSettings({ diagramCop: 'source' }).settings.cop).to.equal(undefined);
        expect(readDiagramSettings({ diagramCop: 'both' }).settings.cop).to.equal('both');
        expect(readDiagramSettings({ diagramCop: 'none' }).settings.cop).to.equal('none');
        expect(readDiagramSettings({ diagramCop: 'average' }).settings).to.deep.equal({ hidden: [], zoneCircuit: [] });
    });
    it('still understands the COP choice of versions before the source setting', () => {
        expect(readDiagramSettings({ diagramCop: 'internal' }).settings).to.deep.equal({ hidden: [], zoneCircuit: [] });
        expect(readDiagramSettings({ diagramCop: 'external' }).settings).to.deep.equal({
            source: 'external',
            hidden: [],
            zoneCircuit: [],
        });
    });
    it('survives values of the wrong type', () => {
        const wrong = { diagramHidden: '', diagramZoneCircuit: 'x' } as unknown as Partial<ioBroker.AdapterConfig>;
        expect(readDiagramSettings(wrong).settings).to.deep.equal({ hidden: [], zoneCircuit: [] });
    });
    it('treats auto and unknown heat sources as automatic', () => {
        expect(readDiagramSettings({ diagramHeatSource: 'auto' }).settings.heatSource).to.equal(undefined);
        expect(readDiagramSettings({ diagramHeatSource: 'steam' }).settings.heatSource).to.equal(undefined);
    });
});
