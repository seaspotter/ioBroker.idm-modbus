import { expect } from 'chai';
import { confirmedValue } from './foreign';

describe('confirmedValue', () => {
    it('passes a confirmed state', () => {
        expect(confirmedValue({ val: 3, ts: 10, ack: true })).to.deep.equal({ val: 3, ts: 10 });
    });

    it('rejects an unconfirmed or missing state', () => {
        expect(confirmedValue({ val: 3, ts: 10, ack: false })).to.equal(null);
        expect(confirmedValue(null)).to.equal(null);
        expect(confirmedValue(undefined)).to.equal(null);
    });
});
