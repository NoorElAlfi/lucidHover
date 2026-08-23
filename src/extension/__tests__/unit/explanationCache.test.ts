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

    describe('automatic narrow eviction in write() (Session 39)', () => {
        it('deletes the old row when a regeneration under the same tuple produces a new cache_key', () => {
            const older = makeRow({ cache_key: 'key-old', fn_hash: 'fnhash-old', generated_at: '2026-08-19T00:00:00.000Z' });
            const newer = makeRow({ cache_key: 'key-new', fn_hash: 'fnhash-new', generated_at: '2026-08-20T00:00:00.000Z' });

            cache.write(older);
            cache.write(newer);

            assert.strictEqual(cache.getByCacheKey('key-old'), undefined);
            assert.deepStrictEqual(cache.getByCacheKey('key-new'), newer);
        });

        it('never deletes the row that write() itself just wrote (upsert on the same cache_key)', () => {
            const row = makeRow({ explanation_json: '{"one_liner":"v1"}' });
            cache.write(row);
            cache.write({ ...row, explanation_json: '{"one_liner":"v2"}' });

            const found = cache.getByCacheKey(row.cache_key);
            assert.strictEqual(found?.explanation_json, '{"one_liner":"v2"}');
        });

        it('leaves the old row in place when a different fn_id regenerates (no cross-fn_id deletion)', () => {
            const rowA = makeRow({ cache_key: 'a-old', fn_id: 'a.js::foo::1', generated_at: '2026-08-19T00:00:00.000Z' });
            const rowB = makeRow({ cache_key: 'b-1', fn_id: 'a.js::bar::1', generated_at: '2026-08-19T00:00:00.000Z' });
            cache.write(rowA);
            cache.write(rowB);

            const rowANewer = makeRow({ cache_key: 'a-new', fn_id: 'a.js::foo::1', fn_hash: 'fnhash-new', generated_at: '2026-08-20T00:00:00.000Z' });
            cache.write(rowANewer);

            assert.deepStrictEqual(cache.getByCacheKey('b-1'), rowB);
        });

        it('leaves the old row in place across a prompt_version/model_id/embedding_model_id bump (narrow -- different tuple)', () => {
            const oldPromptRow = makeRow({ cache_key: 'v3-key', prompt_version: 'few-shot-v3', generated_at: '2026-08-19T00:00:00.000Z' });
            cache.write(oldPromptRow);

            const newPromptRow = makeRow({ cache_key: 'v4-key', prompt_version: 'few-shot-v4', generated_at: '2026-08-20T00:00:00.000Z' });
            cache.write(newPromptRow);

            assert.deepStrictEqual(cache.getByCacheKey('v3-key'), oldPromptRow);
            assert.deepStrictEqual(cache.getByCacheKey('v4-key'), newPromptRow);
        });

        it('honors evictSuperseded=false -- both rows survive (the manual-only toggle)', () => {
            const older = makeRow({ cache_key: 'key-old', fn_hash: 'fnhash-old', generated_at: '2026-08-19T00:00:00.000Z' });
            const newer = makeRow({ cache_key: 'key-new', fn_hash: 'fnhash-new', generated_at: '2026-08-20T00:00:00.000Z' });

            cache.write(older, false);
            cache.write(newer, false);

            assert.deepStrictEqual(cache.getByCacheKey('key-old'), older);
            assert.deepStrictEqual(cache.getByCacheKey('key-new'), newer);
        });

        // Code-review finding (Session 39): generated_at is a caller-supplied
        // ISO string, not guaranteed unique -- two stacked rows for the same
        // tuple (evictSuperseded=false) can share an identical value. Without
        // an explicit rowid tiebreaker, getCurrentRowForFnId's `ORDER BY
        // generated_at DESC LIMIT 1` and purgeSupersededRows's differently
        // shaped window-function query could disagree about which row is
        // "current" on a tie, letting the purge sweep delete the exact row
        // getCurrentRowForFnId had just reported as live.
        it('agrees with purgeSupersededRows on which row is current even when generated_at ties (rowid tiebreaker)', () => {
            const tiedAt = '2026-08-20T00:00:00.000Z';
            cache.write(makeRow({ cache_key: 'tie-1', fn_hash: 'h1', generated_at: tiedAt }), false);
            cache.write(makeRow({ cache_key: 'tie-2', fn_hash: 'h2', generated_at: tiedAt }), false);
            cache.write(makeRow({ cache_key: 'tie-3', fn_hash: 'h3', generated_at: tiedAt }), false);

            const reportedCurrent = cache.getCurrentRowForFnId({
                fnId: 'a.js::foo::1',
                modelId: 'qwen2.5-coder:1.5b',
                embeddingModelId: 'all-minilm',
                promptVersion: 'few-shot-v3',
            });
            assert.strictEqual(reportedCurrent?.cache_key, 'tie-3');

            cache.purgeSupersededRows();

            assert.notStrictEqual(cache.getByCacheKey('tie-3'), undefined);
            assert.strictEqual(cache.getByCacheKey('tie-1'), undefined);
            assert.strictEqual(cache.getByCacheKey('tie-2'), undefined);
        });

        it('after an evicting write, getCurrentRowForFnId still resolves to the row that was just written (never-delete-the-live-row invariant)', () => {
            const older = makeRow({ cache_key: 'key-old', fn_hash: 'fnhash-old', generated_at: '2026-08-19T00:00:00.000Z' });
            const newer = makeRow({ cache_key: 'key-new', fn_hash: 'fnhash-new', generated_at: '2026-08-20T00:00:00.000Z' });
            cache.write(older);
            cache.write(newer);

            const current = cache.getCurrentRowForFnId({
                fnId: newer.fn_id,
                modelId: newer.model_id,
                embeddingModelId: newer.embedding_model_id,
                promptVersion: newer.prompt_version,
            });
            assert.deepStrictEqual(current, newer);
        });
    });

    describe('purgeSupersededRows (Session 39, manual sweep)', () => {
        it('collapses rows that piled up while auto-evict was off down to one per tuple', () => {
            cache.write(makeRow({ cache_key: 'k1', fn_hash: 'h1', generated_at: '2026-08-18T00:00:00.000Z' }), false);
            cache.write(makeRow({ cache_key: 'k2', fn_hash: 'h2', generated_at: '2026-08-19T00:00:00.000Z' }), false);
            cache.write(makeRow({ cache_key: 'k3', fn_hash: 'h3', generated_at: '2026-08-20T00:00:00.000Z' }), false);

            const purged = cache.purgeSupersededRows();

            assert.strictEqual(purged, 2);
            assert.strictEqual(cache.getByCacheKey('k1'), undefined);
            assert.strictEqual(cache.getByCacheKey('k2'), undefined);
            assert.notStrictEqual(cache.getByCacheKey('k3'), undefined);
        });

        it('returns 0 and deletes nothing against an already-clean cache', () => {
            cache.write(makeRow());
            assert.strictEqual(cache.purgeSupersededRows(), 0);
        });

        it('never deletes the row that getCurrentRowForFnId reports as live, even for two different fn_ids interleaved', () => {
            cache.write(makeRow({ cache_key: 'a1', fn_id: 'a.js::foo::1', generated_at: '2026-08-18T00:00:00.000Z' }), false);
            cache.write(makeRow({ cache_key: 'b1', fn_id: 'a.js::bar::1', generated_at: '2026-08-18T00:00:00.000Z' }), false);
            cache.write(makeRow({ cache_key: 'a2', fn_id: 'a.js::foo::1', fn_hash: 'fnhash-a2', generated_at: '2026-08-19T00:00:00.000Z' }), false);
            cache.write(makeRow({ cache_key: 'b2', fn_id: 'a.js::bar::1', fn_hash: 'fnhash-b2', generated_at: '2026-08-19T00:00:00.000Z' }), false);

            cache.purgeSupersededRows();

            const currentA = cache.getCurrentRowForFnId({
                fnId: 'a.js::foo::1',
                modelId: 'qwen2.5-coder:1.5b',
                embeddingModelId: 'all-minilm',
                promptVersion: 'few-shot-v3',
            });
            const currentB = cache.getCurrentRowForFnId({
                fnId: 'a.js::bar::1',
                modelId: 'qwen2.5-coder:1.5b',
                embeddingModelId: 'all-minilm',
                promptVersion: 'few-shot-v3',
            });
            assert.strictEqual(currentA?.cache_key, 'a2');
            assert.strictEqual(currentB?.cache_key, 'b2');
            assert.notStrictEqual(cache.getByCacheKey('a2'), undefined);
            assert.notStrictEqual(cache.getByCacheKey('b2'), undefined);
        });

        // "Done when" scenario: simulate 2 PROMPT_VERSION bumps over a small
        // fixture's worth of cached rows and confirm the row count behaves
        // as the chosen (narrow) policy predicts -- within-tuple duplicates
        // from content-hash regeneration collapse automatically, but
        // cross-tuple duplicates from a prompt_version bump do NOT, either
        // automatically or via the narrow manual sweep. That's the
        // documented limitation of "automatic narrow" the user chose, not a
        // bug -- broader (option b) cross-tuple cleanup was explicitly not
        // selected.
        it('simulates 2 PROMPT_VERSION bumps over 5 fixture functions: within-tuple dedup happens, cross-tuple orphans do not', () => {
            const fnIds = ['a.js::fn0::1', 'a.js::fn1::5', 'a.js::fn2::9', 'a.js::fn3::13', 'a.js::fn4::17'];
            const promptVersions = ['few-shot-v3', 'few-shot-v4', 'few-shot-v5'];
            let t = 0;

            for (const promptVersion of promptVersions) {
                // Each function is generated once, then regenerated once
                // (a genuine content change) under the SAME prompt_version
                // -- this is the within-tuple case auto-evict should collapse.
                for (const fnId of fnIds) {
                    cache.write(
                        makeRow({
                            cache_key: `${fnId}-${promptVersion}-gen1`,
                            fn_id: fnId,
                            fn_hash: 'gen1',
                            prompt_version: promptVersion,
                            generated_at: new Date(2026, 7, 1, 0, 0, t++).toISOString(),
                        })
                    );
                    cache.write(
                        makeRow({
                            cache_key: `${fnId}-${promptVersion}-gen2`,
                            fn_id: fnId,
                            fn_hash: 'gen2',
                            prompt_version: promptVersion,
                            generated_at: new Date(2026, 7, 1, 0, 0, t++).toISOString(),
                        })
                    );
                }
            }

            // Within each of the 3 prompt-version tuples, auto-evict already
            // collapsed gen1 -> gen2 per function: every gen1 key is gone,
            // every gen2 key survives, for all 3 prompt versions -- 5 live
            // rows per tuple, 3 tuples * 5 functions = 15 live rows total,
            // not 5 (which would mean cross-tuple collapsing happened) and
            // not 30 (which would mean no eviction happened at all).
            for (const promptVersion of promptVersions) {
                for (const fnId of fnIds) {
                    assert.strictEqual(cache.getByCacheKey(`${fnId}-${promptVersion}-gen1`), undefined);
                    assert.notStrictEqual(cache.getByCacheKey(`${fnId}-${promptVersion}-gen2`), undefined);
                }
            }

            // The narrow manual sweep changes nothing here: every surviving
            // row is already the sole/most-recent row for its own tuple, so
            // there is nothing left for it to collapse -- confirming the two
            // older prompt-version generations are "not yet cleaned up" by
            // design, not silently lost by a bug.
            const purged = cache.purgeSupersededRows();
            assert.strictEqual(purged, 0);
            for (const promptVersion of promptVersions) {
                for (const fnId of fnIds) {
                    assert.notStrictEqual(cache.getByCacheKey(`${fnId}-${promptVersion}-gen2`), undefined);
                }
            }
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
