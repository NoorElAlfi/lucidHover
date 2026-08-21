import * as assert from 'assert';
import { computeCacheKey, computeFileSummaryFnHash, computeFnHash, computeFnId } from '../../cache/hash';

describe('cache/hash', () => {
    describe('computeFnId', () => {
        it('is deterministic for the same inputs', () => {
            assert.strictEqual(computeFnId('a.js', 'foo', 12), computeFnId('a.js', 'foo', 12));
        });

        it('differs when file, name, or line differ', () => {
            const base = computeFnId('a.js', 'foo', 12);
            assert.notStrictEqual(computeFnId('b.js', 'foo', 12), base);
            assert.notStrictEqual(computeFnId('a.js', 'bar', 12), base);
            assert.notStrictEqual(computeFnId('a.js', 'foo', 13), base);
        });
    });

    describe('computeFnHash', () => {
        it('is deterministic and content-sensitive', () => {
            const src = 'function foo() { return 1; }';
            assert.strictEqual(computeFnHash(src), computeFnHash(src));
            assert.notStrictEqual(computeFnHash(src), computeFnHash(src + ' '));
        });

        it('produces a 64-char lowercase hex sha256 digest', () => {
            assert.match(computeFnHash('x'), /^[0-9a-f]{64}$/);
        });
    });

    describe('computeCacheKey', () => {
        const base = {
            fnSource: 'function foo() {}',
            contextHash: 'ctx1',
            modelId: 'qwen2.5-coder:1.5b',
            embeddingModelId: 'all-minilm',
            promptVersion: 'few-shot-v3',
        };

        it('is deterministic for identical params', () => {
            assert.strictEqual(computeCacheKey(base), computeCacheKey({ ...base }));
        });

        // Core Design Decision #2 / cache-key formula: a change to any one
        // component must change the key, or invalidation would silently miss it.
        for (const field of ['fnSource', 'contextHash', 'modelId', 'embeddingModelId', 'promptVersion'] as const) {
            it(`changes when ${field} changes`, () => {
                const changed = { ...base, [field]: `${base[field]}-changed` };
                assert.notStrictEqual(computeCacheKey(base), computeCacheKey(changed));
            });
        }
    });

    describe('computeFileSummaryFnHash', () => {
        it('is deterministic and order-independent (sorted before hashing)', () => {
            const a = computeFileSummaryFnHash(['h1', 'h2', 'h3']);
            const b = computeFileSummaryFnHash(['h3', 'h1', 'h2']);
            assert.strictEqual(a, b);
        });

        it('changes when the set of hashes changes', () => {
            const a = computeFileSummaryFnHash(['h1', 'h2']);
            const b = computeFileSummaryFnHash(['h1', 'h2', 'h3']);
            assert.notStrictEqual(a, b);
        });

        it('does not mutate the input array', () => {
            const input = ['h3', 'h1', 'h2'];
            const copy = [...input];
            computeFileSummaryFnHash(input);
            assert.deepStrictEqual(input, copy);
        });
    });
});
