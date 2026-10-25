const fs = require('fs');
const path = require('path');
const { tests } = require('@iobroker/testing');
const { expect } = require('chai');

// The mock Navigator is TypeScript (shared with the unit tests), so let ts-node compile it on the fly.
require('ts-node').register({ transpileOnly: true, project: path.join(__dirname, '..', 'tsconfig.json') });
const { MockModbusServer } = require('../src/lib/modbus/mock-server.test.ts');

const NAMESPACE = 'idm-modbus.0';
let scanConfig;

/**
 * Wait until a state has a value.
 *
 * @param harness the test harness
 * @param id state id below the namespace
 * @param timeoutMs how long to wait
 * @param expected wait for exactly this value (default: any value)
 */
async function waitForState(harness, id, timeoutMs = 20000, expected = undefined) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const state = await harness.states.getStateAsync(`${NAMESPACE}.${id}`);
        if (
            state &&
            state.val !== null &&
            state.val !== undefined &&
            (expected === undefined || state.val === expected)
        ) {
            return state;
        }
        if (Date.now() > end) {
            throw new Error(`State ${id} did not get a value within ${timeoutMs} ms`);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

/**
 * Wait until a numeric state is above zero.
 *
 * @param harness the test harness
 * @param id state id below the namespace
 * @param timeoutMs how long to wait
 */
async function waitForPositive(harness, id, timeoutMs) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const state = await harness.states.getStateAsync(`${NAMESPACE}.${id}`);
        if (state && typeof state.val === 'number' && state.val > 0) {
            return state.val;
        }
        if (Date.now() > end) {
            throw new Error(`State ${id} did not become positive within ${timeoutMs} ms`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    // the released js-controller, not the daily development build (the default): an alpha that breaks the test setup would otherwise
    // fail every pull request (2026-10-16: 8.0.0-alpha.8 left no iobroker.json in the test directory)
    controllerVersion: 'latest',
    defineAdditionalTests({ suite }) {
        suite('Polling a mock Navigator (no real device involved)', getHarness => {
            let harness;
            let server;

            before(async () => {
                server = new MockModbusServer();
                server.registers[1000] = 0x0000; // outdoor temperature 21.5 (low word first)
                server.registers[1001] = 0x41ac;
                server.registers[1005] = 1; // system mode: automatic
                server.registers[1090] = 4; // heat pump mode: hot water
                server.registers[1091] = 1; // heating demand
                server.registers[1101] = 0xffff; // compressor 2: the plant does not have it ("not available")
                server.registers[1350] = 0x0000; // heating circuit A flow temperature 35.25
                server.registers[1351] = 0x420d;
                const port = await server.listen();

                harness = getHarness();
                await harness.changeAdapterConfig('idm-modbus', {
                    native: {
                        host: '127.0.0.1',
                        port,
                        hcA: true,
                        hcNameA: 'Ground floor',
                        intervalFastS: 10,
                        intervalMediumS: 10,
                        intervalSlowS: 10,
                    },
                });
            });

            after(async () => {
                await server.stop();
            });

            it('connects, creates the object tree for the configured plant and writes the values', async function () {
                this.timeout(60000);
                await harness.startAdapterAndWait(true);

                const outdoor = await waitForState(harness, 'system.outdoor_temp');
                expect(outdoor.val).to.equal(21.5);
                expect(outdoor.ack).to.equal(true);
                expect((await waitForState(harness, 'system.system_mode')).val).to.equal(1);
                expect((await waitForState(harness, 'hp.hp_operating_mode')).val).to.equal(4);
                expect((await waitForState(harness, 'hp.heating_demand')).val).to.equal(true);
                expect((await waitForState(harness, 'hc.A.flow_temp')).val).to.equal(35.3); // one decimal
                expect((await harness.states.getStateAsync(`${NAMESPACE}.info.connection`)).val).to.equal(true);
                expect((await harness.states.getStateAsync(`${NAMESPACE}.info.family`)).val).to.equal('nav20');

                // hardware that reports "not available" gets no state; hardware with a value does
                await waitForState(harness, 'hp.compressor_status_1');
                expect(await harness.objects.getObjectAsync(`${NAMESPACE}.hp.compressor_status_1`)).to.not.equal(null);
                expect(await harness.objects.getObjectAsync(`${NAMESPACE}.hp.compressor_status_2`)).to.equal(null);

                // object definitions: channels for every parent, translated names, roles from the catalogue
                const channel = await harness.objects.getObjectAsync(`${NAMESPACE}.hc.A`);
                expect(channel.type).to.equal('channel');
                expect(channel.common.name).to.equal('Ground floor');
                const hcChannel = await harness.objects.getObjectAsync(`${NAMESPACE}.hc`);
                expect(hcChannel.common.name).to.include({ en: 'Heating circuits', de: 'Heizkreise' });
                expect(Object.keys(hcChannel.common.name)).to.have.members([
                    'en',
                    'de',
                    'ru',
                    'pt',
                    'nl',
                    'fr',
                    'it',
                    'es',
                    'pl',
                    'uk',
                    'zh-cn',
                ]);
                const mode = await harness.objects.getObjectAsync(`${NAMESPACE}.system.system_mode`);
                expect(mode.common).to.deep.include({ type: 'number', role: 'value', read: true, write: false });
                // plain strings in the system language (translated objects would show as [object Object] in the admin)
                expect(mode.common.states['2']).to.equal('Away');
                const flow = await harness.objects.getObjectAsync(`${NAMESPACE}.hc.A.flow_temp`);
                expect(flow.common).to.deep.include({ role: 'value.temperature', unit: '°C' });
                expect(flow.native).to.deep.equal({ address: 1350 });

                // nothing the plant does not have
                expect(await harness.objects.getObjectAsync(`${NAMESPACE}.hc.B`)).to.equal(null);
                expect(await harness.objects.getObjectAsync(`${NAMESPACE}.zones`)).to.equal(null);
                expect(await harness.objects.getObjectAsync(`${NAMESPACE}.solar`)).to.equal(null);

                // the diagram settings the page reads: defaults, nothing else is served by the adapter
                const diagram = await harness.states.getStateAsync(`${NAMESPACE}.diagram.settings`);
                expect(JSON.parse(diagram.val)).to.deep.equal({ hidden: [], zoneCircuit: [] });

                // the host never shows up in the log, and the adapter logged no errors
                // the support file: created in the file area, without the host
                const answer = await new Promise(resolve => harness.sendTo(NAMESPACE, 'supportExport', {}, resolve));
                expect(answer.result).to.equal('supportCreated');
                expect(answer.openUrl).to.match(/^\/files\/idm-modbus\.0\.support\/support-\d{8}-\d{6}\.json$/);
                const file = await new Promise((resolve, reject) =>
                    harness.objects.readFile(`${NAMESPACE}.support`, answer.args[0], (error, data) =>
                        error ? reject(error) : resolve(data),
                    ),
                );
                const report = JSON.parse(String(file.file ?? file));
                expect(report).to.deep.include({ adapterVersion: report.adapterVersion });
                expect(report.settings).to.deep.include({ family: 'nav20', zoneModules: 0 });
                expect(report.samples.outdoor_temp.value).to.equal(21.5);
                expect(report.registers.enabled).to.be.greaterThan(50);
                expect(JSON.stringify(report)).to.not.contain('127.0.0.1');
                expect(JSON.stringify(report.settings)).to.not.match(/host|[Pp]in\b/);

                expect(harness.getLogs('error').map(l => l.raw)).to.deep.equal([]);
                expect(
                    harness
                        .getLogs()
                        .map(l => l.raw)
                        .join('\n'),
                ).to.not.contain('127.0.0.1');
            });
        });

        suite('Scan command (mock Navigator replaying the scan fixture)', getHarness => {
            let harness;
            let server;

            const send = message => new Promise(resolve => harness.sendTo(NAMESPACE, 'scan', message, resolve));
            const command = name => new Promise(resolve => harness.sendTo(NAMESPACE, name, {}, resolve));

            before(async () => {
                server = new MockModbusServer();
                server.loadScan(
                    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'scan-nav20.json'), 'utf8')),
                );
                const port = await server.listen();
                harness = getHarness();
                await harness.changeAdapterConfig('idm-modbus', {
                    native: { host: '127.0.0.1', port, intervalFastS: 10 },
                });
                scanConfig = { host: '127.0.0.1', port, family: 'nav20' };
            });

            after(async () => {
                await server.stop();
            });

            it('answers at once, pauses polling, rejects a second scan and stops on unload', async function () {
                this.timeout(60000);
                await harness.startAdapterAndWait(true);

                expect(await send({})).to.deep.equal({ error: 'scanNoHost' });
                expect(await command('scanResult')).to.deep.equal({ error: 'scanNone' }); // nothing scanned yet
                expect((await waitForState(harness, 'diag.scanProgress', 10000)).val).to.equal(0); // the page can show it from the start
                const started = await send({ config: scanConfig });
                expect(started).to.include({ result: 'scanStarted' });
                expect(started.args).to.have.length(1); // the estimated minutes
                expect(await send({ config: scanConfig })).to.deep.equal({ error: 'scanAlreadyRunning' });

                const running = await waitForState(harness, 'diag.scanRunning', 20000, true);
                expect(running.val).to.equal(true);
                // the log line can arrive a moment after the state (slow runners), so wait for it
                let logged = false;
                for (let i = 0; i < 50 && !logged; i++) {
                    logged = harness.hasLog(/Scan started: reading \d+ registers/, 'info');
                    if (!logged) {
                        await new Promise(resolve => setTimeout(resolve, 200));
                    }
                }
                expect(logged).to.equal(true);
                // polling is paused while the scan owns the single connection
                await waitForState(harness, 'info.connection', 10000, false);
                expect(harness.getLogs('error').map(l => l.raw)).to.deep.equal([]);
            });
        });

        suite('Statistics with an external meter (mock Navigator, states of a "foreign" adapter)', getHarness => {
            let harness;
            let server;

            const setFloat = (address, value) => {
                const buffer = Buffer.alloc(4);
                buffer.writeFloatBE(value);
                server.registers[address] = buffer.readUInt16BE(2); // low word first
                server.registers[address + 1] = buffer.readUInt16BE(0);
            };

            before(async () => {
                server = new MockModbusServer();
                server.registers[1090] = 1; // heating
                setFloat(4122, 2); // 2 kW electrical
                setFloat(4126, 9); // 9 kW thermal
                setFloat(1050, 35);
                setFloat(1052, 30);
                const port = await server.listen();
                harness = getHarness();
                // the external meter lives in another adapter's namespace
                const meter = { type: 'state', native: {} };
                await harness.objects.setObjectAsync('meterdemo.0.power', {
                    ...meter,
                    common: { name: 'power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false },
                });
                await harness.objects.setObjectAsync('meterdemo.0.energy', {
                    ...meter,
                    common: {
                        name: 'energy',
                        type: 'number',
                        role: 'value.energy',
                        unit: 'kWh',
                        read: true,
                        write: false,
                    },
                });
                await harness.states.setStateAsync('meterdemo.0.power', { val: 2100, ack: true });
                await harness.states.setStateAsync('meterdemo.0.energy', { val: 1000, ack: true });
                await harness.changeAdapterConfig('idm-modbus', {
                    native: {
                        host: '127.0.0.1',
                        port,
                        intervalFastS: 10,
                        intervalMediumS: 10,
                        intervalSlowS: 10,
                        extElecPowerId: 'meterdemo.0.power',
                        extElecCounterId: 'meterdemo.0.energy',
                    },
                });
            });

            after(async () => {
                await server.stop();
            });

            it('creates the statistics objects, calculates values and counts the external meter', async function () {
                this.timeout(120000);
                await harness.startAdapterAndWait(true);

                // momentary values from the Navigator readings
                expect((await waitForState(harness, 'calc.hp_delta_t', 30000)).val).to.equal(5);
                // the external counter delivers its delta (0.2 kWh within a plausible time; energies show one decimal)
                await harness.states.setStateAsync('meterdemo.0.energy', { val: 1000.2, ack: true });
                const external = await waitForPositive(harness, 'stats.energy.electrical.external.all.day', 60000);
                expect(external).to.equal(0.2);

                // objects: channels with translated names, states with units
                const channel = await harness.objects.getObjectAsync(`${NAMESPACE}.stats.cop.external`);
                expect(channel.type).to.equal('channel');
                expect(channel.common.name).to.include({ en: 'External meter', de: 'Externer Zähler' });
                const energy = await harness.objects.getObjectAsync(
                    `${NAMESPACE}.stats.energy.electrical.external.all.day`,
                );
                expect(energy.common).to.deep.include({ unit: 'kWh', role: 'value.energy', read: true, write: false });
                expect(Object.keys(energy.common.name)).to.have.members([
                    'en',
                    'de',
                    'ru',
                    'pt',
                    'nl',
                    'fr',
                    'it',
                    'es',
                    'pl',
                    'uk',
                    'zh-cn',
                ]);
                expect(energy.common.name).to.include({ en: 'Today', de: 'Heute' });

                // the statistics are persisted and nothing was logged as an error
                const data = await waitForState(harness, 'stats.data', 90000);
                expect(JSON.parse(data.val)).to.have.property('version', 1);
                // internal electrical energy is integrated from register 4122 (2 kW); the states show one decimal, the saved totals are exact
                const totals = JSON.parse(data.val).ledger.totals.elecInternal;
                expect(Object.values(totals).reduce((a, b) => a + b, 0)).to.be.greaterThan(0);
                expect(harness.getLogs('error').map(l => l.raw)).to.deep.equal([]);
                expect(
                    harness
                        .getLogs()
                        .map(l => l.raw)
                        .join('\n'),
                ).to.not.contain('127.0.0.1');
            });
        });

        suite(
            'Control: writes reach only the MOCK Navigator, only for enabled groups, validated and read back',
            getHarness => {
                let harness;
                let server;

                const set = (id, val) => harness.states.setStateAsync(`${NAMESPACE}.${id}`, { val, ack: false });

                before(async () => {
                    server = new MockModbusServer();
                    server.registers[1005] = 1; // system mode: automatic
                    server.registers[1032] = 46; // hot water setpoint
                    server.registers[2002] = 0x0000; // room 1 of zone module 1: 21.0 degrees
                    server.registers[2003] = 0x41a8;
                    server.registers[1014] = 0x0000; // hot water top 40.0 degrees (FLOAT 0x42200000, low word first)
                    server.registers[1015] = 0x4220;
                    const port = await server.listen();
                    harness = getHarness();
                    await harness.changeAdapterConfig('idm-modbus', {
                        native: {
                            host: '127.0.0.1',
                            port,
                            intervalFastS: 10,
                            intervalMediumS: 10,
                            intervalSlowS: 10,
                            statsEnabled: false,
                            writeSystem: true, // the hot water group stays off
                            zoneModules: 1,
                            roomsPerZone: 2,
                            writeZones: true,
                            boostEnabled: true,
                            boostTargetC: 55,
                            boostMaxMinutes: 30,
                        },
                    });
                });

                after(async () => {
                    await server.stop();
                });

                it('writes an allowed value, refuses invalid and unauthorised ones, counts and acknowledges', async function () {
                    this.timeout(120000);
                    await harness.startAdapterAndWait(true);
                    expect((await waitForState(harness, 'system.system_mode', 30000)).val).to.equal(1);

                    // object definitions: writable only where control is enabled
                    const mode = await harness.objects.getObjectAsync(`${NAMESPACE}.system.system_mode`);
                    expect(mode.common).to.deep.include({ write: true, role: 'level' });
                    const ack = await harness.objects.getObjectAsync(`${NAMESPACE}.system.error_acknowledge`);
                    expect(ack.common).to.deep.include({ write: true, role: 'button', type: 'boolean' });
                    await waitForState(harness, 'dhw.dhw_setpoint', 30000); // states appear with their first value
                    const dhw = await harness.objects.getObjectAsync(`${NAMESPACE}.dhw.dhw_setpoint`);
                    expect(dhw.common.write).to.equal(false);

                    // an allowed value is written to the mock after the debounce, read back and acknowledged
                    await set('system.system_mode', 2);
                    await waitForState(harness, 'diag.writes.system_mode', 30000, 1);
                    expect(server.registers[1005]).to.equal(2);
                    const confirmed = await harness.states.getStateAsync(`${NAMESPACE}.system.system_mode`);
                    expect(confirmed).to.include({ val: 2, ack: true });

                    // a value that is not allowed (3 does not exist) never reaches the device, the state returns to the real value
                    await set('system.system_mode', 3);
                    await waitForState(harness, 'system.system_mode', 20000, 2);
                    expect(server.registers[1005]).to.equal(2);
                    expect((await waitForState(harness, 'diag.lastError', 20000)).val).to.contain('allowed values');

                    // a group that is not enabled is not even subscribed
                    await set('dhw.dhw_setpoint', 50);
                    await new Promise(resolve => setTimeout(resolve, 3500));
                    expect(server.registers[1032]).to.equal(46);

                    // a room setpoint is rounded to 0.5 degrees and written as FLOAT (low word first); temperature stays read-only
                    const room = await harness.objects.getObjectAsync(`${NAMESPACE}.zones.1.rooms.1.setpoint`);
                    expect(room.common).to.deep.include({ write: true });
                    const roomTemp = await harness.objects.getObjectAsync(`${NAMESPACE}.zones.1.rooms.1.temp`);
                    expect(roomTemp.common.write).to.equal(false);
                    await set('zones.1.rooms.1.setpoint', 21.3);
                    const roomEnd = Date.now() + 20000;
                    while (server.registers[2005] !== 0x41ac && Date.now() < roomEnd) {
                        await new Promise(resolve => setTimeout(resolve, 250));
                    }
                    expect([server.registers[2004], server.registers[2005]]).to.deep.equal([0x0000, 0x41ac]);

                    // the hot water boost switches the demand (1712) on, and off again on request
                    await new Promise(resolve => setTimeout(resolve, 3000)); // let the first poll cycle deliver the hot water temperature
                    await set('dhw.boost_start', true);
                    const boostEnd = Date.now() + 20000;
                    while (server.registers[1712] !== 1 && Date.now() < boostEnd) {
                        await new Promise(resolve => setTimeout(resolve, 250));
                    }
                    expect(server.registers[1712]).to.equal(1);
                    expect((await waitForState(harness, 'dhw.boost_status', 10000)).val).to.equal('running');
                    await set('dhw.boost_stop', true);
                    const stopEnd = Date.now() + 20000;
                    while (server.registers[1712] !== 0 && Date.now() < stopEnd) {
                        await new Promise(resolve => setTimeout(resolve, 250));
                    }
                    expect(server.registers[1712]).to.equal(0);

                    // the fault acknowledgement writes once and resets itself
                    await set('system.error_acknowledge', true);
                    const end = Date.now() + 20000;
                    while (server.registers[1999] !== 1 && Date.now() < end) {
                        await new Promise(resolve => setTimeout(resolve, 250));
                    }
                    expect(server.registers[1999]).to.equal(1);

                    expect(harness.getLogs('error').map(l => l.raw)).to.deep.equal([]);
                    expect(
                        harness
                            .getLogs()
                            .map(l => l.raw)
                            .join('\n'),
                    ).to.not.contain('127.0.0.1');
                });
            },
        );

        suite('PV: values from a foreign state reach only the MOCK Navigator, converted and cyclic', getHarness => {
            let harness;
            let server;

            before(async () => {
                server = new MockModbusServer();
                const port = await server.listen();
                harness = getHarness();
                await harness.states.setStateAsync('0_userdata.0.test.surplus_w', { val: 2500, ack: true });
                await harness.states.setStateAsync('0_userdata.0.test.soc', { val: 57.4, ack: true });
                await harness.states.setStateAsync('0_userdata.0.test.room_a', { val: 21.3, ack: true });
                await harness.states.setStateAsync('0_userdata.0.test.humidity', { val: 45, ack: true });
                await harness.changeAdapterConfig('idm-modbus', {
                    native: {
                        host: '127.0.0.1',
                        port,
                        intervalFastS: 10,
                        intervalMediumS: 10,
                        intervalSlowS: 10,
                        statsEnabled: false,
                        writeSystem: false,
                        zoneModules: 0,
                        roomsEnabled: true,
                        roomSources: [
                            {
                                circuit: 'A',
                                stateId: '0_userdata.0.test.room_a',
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
                        gltEnabled: true,
                        gltSources: [
                            {
                                function: 'humidity',
                                stateId: '0_userdata.0.test.humidity',
                                factor: 1,
                                offset: 0,
                                heartbeatS: null,
                                min: null,
                                max: null,
                                maxAgeS: null,
                            },
                        ],
                        pvEnabled: true,
                        pvIntervalS: 10,
                        pvMaxAgeS: 300,
                        // the fixed fields of the settings page (text fields: a comma works as a decimal separator too)
                        pvSurplusStateId: '0_userdata.0.test.surplus_w',
                        pvSurplusFactor: '0,001',
                        pvSurplusInvert: false,
                        pvSurplusMin: '0',
                        pvSurplusMax: '',
                        pvSocStateId: '0_userdata.0.test.soc',
                        pvSocFactor: '1',
                    },
                });
            });

            after(async () => {
                await server.stop();
            });

            it('writes the converted surplus as FLOAT and the battery level as integer, and reports no conflict', async function () {
                this.timeout(120000);
                await harness.startAdapterAndWait(true);
                const end = Date.now() + 40000;
                while (server.registers[86] !== 57 && Date.now() < end) {
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
                expect([server.registers[74], server.registers[75]]).to.deep.equal([0x0000, 0x4020]); // 2.5 kW, low word first
                expect(server.registers[86]).to.equal(57);
                // the global humidity (register 1692): 45 as FLOAT, low word first
                const humEnd = Date.now() + 30000;
                while (server.registers[1693] !== 0x4234 && Date.now() < humEnd) {
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
                expect([server.registers[1692], server.registers[1693]]).to.deep.equal([0x0000, 0x4234]);
                // the room temperature of heating circuit A: 21.3 as FLOAT, low word first (register 1650)
                const roomEnd = Date.now() + 30000;
                while (server.registers[1651] !== 0x41aa && Date.now() < roomEnd) {
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
                expect([server.registers[1650], server.registers[1651]]).to.deep.equal([0x6666, 0x41aa]);
                expect((await waitForState(harness, 'pv.last_write', 20000)).val).to.be.a('number');
                expect((await harness.states.getStateAsync(`${NAMESPACE}.pv.writer_conflict`)).val).to.equal(false);
                expect(harness.getLogs('error').map(l => l.raw)).to.deep.equal([]);
            });
        });
    },
});
