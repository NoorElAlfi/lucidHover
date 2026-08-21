import * as assert from 'assert';
import { computeCacheKey, computeFileSummaryFnHash, computeFnHash, computeFnId } from '../../cache/hash';

describe('cache/hash', () => {
    describe('computeFnId', () => {
        it('is deterministic for the same inputs', () => {
            assert.strictEqual(computeFnId('a.js', 'foo'), computeFnId('a.js', 'foo'));
        });

        it('differs when file or qualified name differ', () => {
            const base = computeFnId('a.js', 'foo');
            assert.notStrictEqual(computeFnId('b.js', 'foo'), base);
            assert.notStrictEqual(computeFnId('a.js', 'bar'), base);
        });

        // Session 18 (fnId cache-identity fix): identity is now file +
        // enclosing-scope-qualified name, not a line number, specifically so
        // it stays stable when a function shifts lines due to an unrelated
        // earlier edit -- assert that invariant directly, not just infer it
        // from the signature no longer taking a line param.
        it('is line-shift stable: qualified name alone determines identity', () => {
            assert.strictEqual(computeFnId('a.js', 'Foo.handle'), computeFnId('a.js', 'Foo.handle'));
        });

        it('distinguishes same-name functions in different enclosing scopes via qualified name', () => {
            assert.notStrictEqual(computeFnId('a.js', 'Foo.handle'), computeFnId('a.js', 'Bar.handle'));
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
