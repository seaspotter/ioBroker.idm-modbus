import { expect } from 'chai';
import {
    readDiagramSettings,
    readGltSettings,
    readDecimal,
    readPlantSettings,
    pvRowsToFields,
    readPvSettings,
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

describe('decimal fields', () => {
    it('reads a number as typed: point or comma, empty is not set, nonsense is not a number', () => {
        expect(readDecimal(0.2)).to.equal(0.2);
        expect(readDecimal('0.001')).to.equal(0.001);
        expect(readDecimal(' 0,25 ')).to.equal(0.25);
        expect(readDecimal('-1,5')).to.equal(-1.5);
        expect(readDecimal('')).to.equal(null);
        expect(readDecimal('  ')).to.equal(null);
        expect(readDecimal(null)).to.equal(null);
        expect(readDecimal('abc')).to.equal(null);
        expect(readDecimal('1,2,3')).to.equal(null);
        expect(readDecimal(Number.NaN)).to.equal(null);
    });

    it('takes the PV scaling from text fields and clears a limit that was emptied', () => {
        const settings = readPvSettings({
            pvEnabled: true,
            pvSources: [
                { register: 'pv_surplus', stateId: 'a.b', factor: '0,001', invert: false, min: '', max: '12,5' },
                { register: 'battery_discharge', stateId: 'a.c', factor: 1, invert: true, min: null, max: 'x' },
            ],
        });
        expect(settings.sources.map(s => [s.register, s.factor, s.min, s.max])).to.deep.equal([
            ['pv_surplus', 0.001, null, 12.5],
            ['battery_discharge', 1, null, null],
        ]);
        // a limit that is neither empty nor a number is said, not dropped silently
        expect(settings.warnings.join(' ')).to.include('battery_discharge').and.include('max "x" is not a number');
    });

    it('takes room and building automation scaling from text fields', () => {
        const rooms = readRoomSettings({
            roomsEnabled: true,
            roomSources: [
                {
                    circuit: 'A',
                    stateId: 'a.b',
                    factor: '1,0',
                    offset: '-0,5',
                    heartbeatS: 300,
                    toleranceC: '0,3',
                    min: '16',
                    max: '28,5',
                    maxAgeS: 900,
                    onStale: 'fixed',
                    fixedValue: '21,5',
                },
            ],
        }).sources[0];
        expect([rooms.factor, rooms.offset, rooms.toleranceC, rooms.min, rooms.max]).to.deep.equal([
            1, -0.5, 0.3, 16, 28.5,
        ]);
        expect([rooms.onStale, rooms.fixedValue]).to.deep.equal(['fixed', 21.5]);
    });

    it('reads price and CO2 factor typed with a comma', () => {
        const settings = readStatsSettings({ pricePerKwh: '0,32', co2GramsPerKwh: '380,5' });
        expect(settings.pricePerKwh).to.equal(0.32);
        expect(settings.co2GramsPerKwh).to.equal(380.5);
        // a cleared price field is "no price", without a complaint
        expect(readStatsSettings({ pricePerKwh: '' }).warnings).to.deep.equal([]);
    });
});

describe('PV fields of the settings page', () => {
    it('sends only the blocks that have a source state, with the scaling of the block', () => {
        const settings = readPvSettings({
            pvEnabled: true,
            pvSurplusStateId: 'a.surplus',
            pvSurplusFactor: '0,001',
            pvSurplusInvert: true,
            pvSurplusMin: '0',
            pvSurplusMax: '',
            pvProductionStateId: '',
            pvProductionFactor: '1',
            pvSocStateId: 'a.soc',
            pvSocFactor: '1',
        });
        expect(settings.sources.map(s => [s.register, s.stateId, s.factor, s.invert, s.min, s.max])).to.deep.equal([
            ['pv_surplus', 'a.surplus', 0.001, true, 0, null],
            ['battery_soc', 'a.soc', 1, false, null, null],
        ]);
    });

    it('still reads the table of an older version until it is moved, and the fields win once they are set', () => {
        const oldRows = [{ register: 'pv_surplus', stateId: 'old.s', factor: 1, invert: false, min: null, max: null }];
        expect(readPvSettings({ pvEnabled: true, pvSources: oldRows }).sources.map(s => s.stateId)).to.deep.equal([
            'old.s',
        ]);
        expect(
            readPvSettings({
                pvEnabled: true,
                pvSources: oldRows,
                pvSurplusStateId: 'new.s',
                pvSurplusFactor: 1,
            }).sources.map(s => s.stateId),
        ).to.deep.equal(['new.s']);
    });

    it('moves the rows of the table into the fields: first row of a register, no heating rod, no empty values lost', () => {
        const fields = pvRowsToFields([
            { register: 'pv_surplus', stateId: 'a.s', factor: 0.001, invert: true, min: 0, max: null },
            { register: 'pv_surplus', stateId: 'a.second', factor: 1, invert: false },
            { register: 'electric_heater_power', stateId: 'a.rod', factor: 1 },
            { register: 'battery_soc', stateId: 'a.soc', factor: 1 },
            { register: 'nonsense', stateId: 'a.x', factor: 1 },
        ]);
        expect(fields).to.deep.equal({
            pvSurplusStateId: 'a.s',
            pvSurplusFactor: '0.001',
            pvSurplusInvert: true,
            pvSurplusMin: '0',
            pvSurplusMax: '',
            pvSocStateId: 'a.soc',
            pvSocFactor: '1',
        });
        // and the fields read back as the same source
        expect(
            readPvSettings({ pvEnabled: true, ...fields }).sources.map(s => [s.register, s.factor, s.invert, s.min]),
        ).to.deep.equal([
            ['pv_surplus', 0.001, true, 0],
            ['battery_soc', 1, false, null],
        ]);
    });

    it('says what is not set up, once the PV values are switched on', () => {
        const warn = (config: Record<string, unknown>): string =>
            readPvSettings({ pvEnabled: true, ...config }).warnings.join(' | ');
        expect(warn({})).to.include('no source row');
        expect(warn({ pvProductionStateId: 'a.p', pvProductionFactor: 1 })).to.include('no surplus');
        expect(warn({ pvSurplusMode: 'calculated', pvProductionStateId: 'a.p', pvProductionFactor: 1 })).to.include(
            'needs rows for PV production (78) and house consumption (82)',
        );
        expect(warn({ pvSurplusStateId: 'a.s', pvSurplusFactor: 1, pvSocStateId: 'a.c', pvSocFactor: 1 })).to.include(
            'Battery level (86) without battery power (84)',
        );
        expect(warn({ pvSurplusStateId: 'a.s', pvSurplusFactor: 1 })).to.equal('');
        // switched off: nothing to complain about
        expect(readPvSettings({ pvEnabled: false }).warnings).to.deep.equal([]);
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
    it('reads the storage layout and leaves the default (one vessel) out', () => {
        expect(readDiagramSettings({ diagramStorage: 'separate' }).settings).to.deep.equal({
            storage: 'separate',
            hidden: [],
            zoneCircuit: [],
        });
        expect(readDiagramSettings({ diagramStorage: 'combined' }).settings).to.deep.equal({
            hidden: [],
            zoneCircuit: [],
        });
        expect(readDiagramSettings({ diagramStorage: 'three' }).settings).to.deep.equal({
            hidden: [],
            zoneCircuit: [],
        });
    });
    it('reads the size of the diagram: the default is left out, limits apply, rubbish falls back', () => {
        expect(readDiagramSettings({ diagramScale: 90 }).settings).to.deep.equal({ hidden: [], zoneCircuit: [] });
        expect(readDiagramSettings({ diagramScale: 120 }).settings).to.deep.equal({
            scale: 120,
            hidden: [],
            zoneCircuit: [],
        });
        const high = readDiagramSettings({ diagramScale: 500 });
        expect(high.settings.scale).to.equal(200);
        expect(high.warnings).to.have.length(1);
        expect(readDiagramSettings({ diagramScale: 10 }).settings.scale).to.equal(40);
        expect(readDiagramSettings({ diagramScale: 'big' as unknown as number }).settings).to.deep.equal({
            hidden: [],
            zoneCircuit: [],
        });
        expect(readDiagramSettings({}).settings).to.deep.equal({ hidden: [], zoneCircuit: [] });
        // a cleared number field is "not set": the default, without a warning (not 0, which would be clamped to the minimum)
        const cleared = readDiagramSettings({ diagramScale: '' as unknown as number });
        expect(cleared.settings).to.deep.equal({ hidden: [], zoneCircuit: [] });
        expect(cleared.warnings).to.deep.equal([]);
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
