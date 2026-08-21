import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CacheRow, ExplanationCache } from '../../cache/explanationCache';

function makeRow(overrides: Partial<CacheRow> = {}): CacheRow {
    return {
        cache_key: 'key-1',
        fn_id: 'a.js::foo::1',
        explanation_json: '{"role_tag":"handler","one_liner":"does a thing"}',
        fn_hash: 'fnhash-1',
        context_hash: 'ctxhash-1',
        model_id: 'qwen2.5-coder:1.5b',
        embedding_model_id: 'all-minilm',
        prompt_version: 'few-shot-v3',
        context_tier: 'call_graph_only',
        generated_at: '2026-08-20T00:00:00.000Z',
        ...overrides,
    };
}

describe('cache/explanationCache', () => {
    let dbPath: string;
    let cache: ExplanationCache;

    beforeEach(() => {
        dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-cache-test-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);
    });

    afterEach(() => {
        cache.dispose();
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    });

    it('returns undefined on a lookup miss against an empty cache', () => {
        assert.strictEqual(
            cache.lookup({
                fnId: 'a.js::foo::1',
                fnHash: 'fnhash-1',
                modelId: 'qwen2.5-coder:1.5b',
                embeddingModelId: 'all-minilm',
                promptVersion: 'few-shot-v3',
            }),
            undefined
        );
    });

    it('round-trips a write through lookup by the exact key tuple', () => {
        const row = makeRow();
        cache.write(row);

        const found = cache.lookup({
            fnId: row.fn_id,
            fnHash: row.fn_hash,
            modelId: row.model_id,
            embeddingModelId: row.embedding_model_id,
            promptVersion: row.prompt_version,
        });
        assert.deepStrictEqual(found, row);
    });

    // Core Rule 4 / Core Design Decision #4: invalidation is content-hash-driven,
    // never assumed-safe-to-skip -- a lookup with any differing key component
    // must miss, forcing regeneration rather than serving a stale/wrong row.
    for (const field of ['fn_hash', 'model_id', 'embedding_model_id', 'prompt_version'] as const) {
        it(`misses when only ${field} differs (content-hash-driven invalidation)`, () => {
            const row = makeRow();
            cache.write(row);

            const params = {
                fnId: row.fn_id,
                fnHash: row.fn_hash,
                modelId: row.model_id,
                embeddingModelId: row.embedding_model_id,
                promptVersion: row.prompt_version,
            };
            const keyMap: Record<typeof field, keyof typeof params> = {
                fn_hash: 'fnHash',
                model_id: 'modelId',
                embedding_model_id: 'embeddingModelId',
                prompt_version: 'promptVersion',
            };
            const mutated = { ...params, [keyMap[field]]: `${params[keyMap[field]]}-different` };
            assert.strictEqual(cache.lookup(mutated), undefined);
        });
    }

    it('getByCacheKey finds a row by its primary key regardless of current cursor position', () => {
        const row = makeRow({ cache_key: 'exact-key' });
        cache.write(row);
        assert.deepStrictEqual(cache.getByCacheKey('exact-key'), row);
        assert.strictEqual(cache.getByCacheKey('nonexistent-key'), undefined);
    });

    it('write is an upsert: same cache_key overwrites rather than duplicating', () => {
        const row = makeRow({ explanation_json: '{"one_liner":"v1"}' });
        cache.write(row);
        cache.write({ ...row, explanation_json: '{"one_liner":"v2"}' });

        const found = cache.getByCacheKey(row.cache_key);
        assert.strictEqual(found?.explanation_json, '{"one_liner":"v2"}');
    });

    describe('getCurrentRowForFnId (staleness detection, Session 13)', () => {
        it('returns undefined for a genuinely new function (no prior row)', () => {
            assert.strictEqual(
                cache.getCurrentRowForFnId({
                    fnId: 'a.js::foo::1',
                    modelId: 'qwen2.5-coder:1.5b',
                    embeddingModelId: 'all-minilm',
                    promptVersion: 'few-shot-v3',
                }),
                undefined
            );
        });

        it('finds the most recent row for fnId even under a different fn_hash (confirmed content change)', () => {
            const older = makeRow({
                cache_key: 'key-old',
                fn_hash: 'fnhash-old',
                generated_at: '2026-08-19T00:00:00.000Z',
            });
            const newer = makeRow({
                cache_key: 'key-new',
                fn_hash: 'fnhash-new',
                generated_at: '2026-08-20T00:00:00.000Z',
            });
            cache.write(older);
            cache.write(newer);

            const found = cache.getCurrentRowForFnId({
                fnId: newer.fn_id,
                modelId: newer.model_id,
                embeddingModelId: newer.embedding_model_id,
                promptVersion: newer.prompt_version,
            });
            assert.strictEqual(found?.cache_key, 'key-new');
        });

        it('does not match across a different model_id/embedding_model_id/prompt_version tuple', () => {
            const row = makeRow();
            cache.write(row);
            assert.strictEqual(
                cache.getCurrentRowForFnId({
                    fnId: row.fn_id,
                    modelId: 'a-different-model',
                    embeddingModelId: row.embedding_model_id,
                    promptVersion: row.prompt_version,
                }),
                undefined
            );
        });
    });

    describe('onDidWrite listeners (Session 10)', () => {
        it('fires with the written row on every write', () => {
            const seen: CacheRow[] = [];
            cache.onDidWrite((row) => seen.push(row));

            const row1 = makeRow({ cache_key: 'k1' });
            const row2 = makeRow({ cache_key: 'k2' });
            cache.write(row1);
            cache.write(row2);

            assert.deepStrictEqual(seen, [row1, row2]);
        });

        it('a disposed listener stops receiving future writes', () => {
            const seen: CacheRow[] = [];
            const subscription = cache.onDidWrite((row) => seen.push(row));
            subscription.dispose();

            cache.write(makeRow());
            assert.strictEqual(seen.length, 0);
        });
    });
});
