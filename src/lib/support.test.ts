import { expect } from 'chai';
import { buildSupportReport, redact, supportSettings, type SupportInput } from './support';

const input = (): SupportInput => ({
    adapterVersion: '0.0.1',
    nodeVersion: 'v24.0.0',
    controllerVersion: '7.2.5',
    language: 'de',
    settings: { family: 'nav20', host: '192.168.1.50', webPin: '4711', zoneModules: 1 },
    runtime: { connected: true, lastError: 'Connect to 192.168.1.50 failed, mail admin@example.org' },
    registers: { enabled: 134, absent: ['compressor_status_2'], invalidReadings: { compressor_status_2: 12 } },
    samples: { outdoor_temp: { value: 8.7, ageSeconds: 4 } },
    scan: null,
    writes: null,
    modules: { pv: { enabled: false } },
});

describe('support report', () => {
    it('removes IP addresses and e-mail addresses from texts and the content of credential-like keys', () => {
        const report = buildSupportReport(input(), new Date('2026-10-10T20:00:00Z'));
        const text = JSON.stringify(report);
        expect(text).to.not.match(/192\.168|4711|admin@example/);
        expect(report.settings).to.deep.include({
            host: '<removed>',
            webPin: '<removed>',
            family: 'nav20',
            zoneModules: 1,
        });
        expect(report.runtime.lastError).to.equal('Connect to <ip> failed, mail <email>');
    });

    it('keeps everything a support person needs', () => {
        const report = buildSupportReport(input(), new Date('2026-10-10T20:00:00Z'));
        expect(report).to.deep.include({
            generatedAt: '2026-10-10T20:00:00.000Z',
            adapterVersion: '0.0.1',
            controllerVersion: '7.2.5',
        });
        expect(report.registers.absent).to.deep.equal(['compressor_status_2']);
        expect(report.samples.outdoor_temp).to.deep.equal({ value: 8.7, ageSeconds: 4 });
        expect(report.description).to.contain('Attach it to a bug report');
    });

    it('redacts nested values and arrays and leaves numbers and booleans alone', () => {
        expect(redact({ a: [{ password: 'x', n: 1, ok: true, t: 'see 10.0.0.1' }] })).to.deep.equal({
            a: [{ password: '<removed>', n: 1, ok: true, t: 'see <ip>' }],
        });
        // camelCase keys are split; ordinary words that merely contain the letters stay
        expect(redact({ webPin: '1', hostName: 'x', description: 'keep', zip: 'keep', pinned: 'keep' })).to.deep.equal({
            webPin: '<removed>',
            hostName: '<removed>',
            description: 'keep',
            zip: 'keep',
            pinned: 'keep',
        });
    });

    it('takes only whitelisted settings and counts what holds names or state ids', () => {
        const settings = supportSettings({
            host: '192.168.1.5',
            webPin: '1234',
            family: 'nav20',
            hcA: true,
            hcNameA: 'Ground floor',
            pvSources: [{ stateId: 'a.b.c' }, { stateId: 'd.e.f' }],
            extElecPowerId: 'x.y.z',
        });
        expect(settings).to.include({
            family: 'nav20',
            hcA: true,
            heatingCircuitNamesSet: 1,
            pvSources: 2,
            externalMeters: 1,
        });
        expect(JSON.stringify(settings)).to.not.contain('192.168').and.not.contain('1234').and.not.contain('x.y.z');
    });
});
