import * as assert from 'assert';
import * as sinon from 'sinon';
import { KeyedDebouncer } from '../../debounce';

describe('debounce/KeyedDebouncer', () => {
    let clock: sinon.SinonFakeTimers;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
    });

    afterEach(() => {
        clock.restore();
    });

    it('fires once after the delay elapses', () => {
        const debouncer = new KeyedDebouncer<string>(100);
        const fn = sinon.stub();

        debouncer.schedule('a', fn);
        clock.tick(99);
        assert.strictEqual(fn.callCount, 0);
        clock.tick(1);
        assert.strictEqual(fn.callCount, 1);
    });

    it('several rapid triggers within the window collapse to a single fire (session-08 behavior)', () => {
        const debouncer = new KeyedDebouncer<string>(100);
        const fn = sinon.stub();

        debouncer.schedule('a', fn);
        clock.tick(50);
        debouncer.schedule('a', fn);
        clock.tick(50);
        debouncer.schedule('a', fn);
        clock.tick(99);
        assert.strictEqual(fn.callCount, 0);
        clock.tick(1);
        assert.strictEqual(fn.callCount, 1);
    });

    it('different keys debounce independently', () => {
        const debouncer = new KeyedDebouncer<string>(100);
        const fnA = sinon.stub();
        const fnB = sinon.stub();

        debouncer.schedule('a', fnA);
        clock.tick(60);
        debouncer.schedule('b', fnB);
        clock.tick(40);
        assert.strictEqual(fnA.callCount, 1);
        assert.strictEqual(fnB.callCount, 0);
        clock.tick(60);
        assert.strictEqual(fnB.callCount, 1);
    });

    it('dispose cancels all pending timers', () => {
        const debouncer = new KeyedDebouncer<string>(100);
        const fn = sinon.stub();

        debouncer.schedule('a', fn);
        debouncer.dispose();
        clock.tick(1000);
        assert.strictEqual(fn.callCount, 0);
    });
});
