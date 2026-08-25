import Database from 'better-sqlite3';

/**
 * One row per generated explanation, keyed by `cache_key` (Core Design
 * Decision #2). Schema matches the spec's "Generation + cache" component
 * exactly: cache_key, fn_id, explanation_json, fn_hash, context_hash,
 * model_id, embedding_model_id, prompt_version, context_tier, generated_at.
 */
export interface CacheRow {
    cache_key: string;
    fn_id: string;
    explanation_json: string;
    fn_hash: string;
    context_hash: string;
    model_id: string;
    embedding_model_id: string;
    prompt_version: string;
    context_tier: string;
    generated_at: string;
}

export interface CacheLookupParams {
    fnId: string;
    fnHash: string;
    modelId: string;
    embeddingModelId: string;
    promptVersion: string;
}

/**
 * Owned by the extension host (TS), not the sidecar -- see session-05
 * artifact's "Cache ownership decision". The sidecar computes context_hash/
 * context_tier as part of its generate_explanation response but never
 * touches SQLite itself.
 */
export type CacheWriteListener = (row: CacheRow) => void;

export class ExplanationCache {
    private readonly db: Database.Database;

    private readonly lookupStmt;
    private readonly lookupByCacheKeyStmt;
    private readonly currentRowForFnIdStmt;
    private readonly writeStmt;
    private readonly deleteByCacheKeyStmt;
    private readonly purgeSupersededStmt;
    private readonly listCurrentRowsStmt;

    // No `vscode` dependency here (deliberate -- this class only needs
    // better-sqlite3, see the class doc comment), so this is a plain listener
    // set rather than a vscode.EventEmitter. Session 10: the single point
    // every write already funnels through (generateAndCache -> write()),
    // reused by CodeLens/gutter decorations to redraw an open editor when a
    // row appears out from under it, instead of each surface polling.
    private readonly writeListeners = new Set<CacheWriteListener>();

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS explanation_cache (
                cache_key           TEXT PRIMARY KEY,
                fn_id               TEXT NOT NULL,
                explanation_json    TEXT NOT NULL,
                fn_hash             TEXT NOT NULL,
                context_hash        TEXT NOT NULL,
                model_id            TEXT NOT NULL,
                embedding_model_id  TEXT NOT NULL,
                prompt_version      TEXT NOT NULL,
                context_tier        TEXT NOT NULL,
                generated_at        TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_explanation_cache_lookup
                ON explanation_cache (fn_id, fn_hash, model_id, embedding_model_id, prompt_version);
        `);

        // Pre-sidecar lookup: fn_id + fn_hash + the ids the extension host
        // already owns. Deliberately does NOT filter on context_hash -- that
        // value only exists after asking the sidecar, which is exactly the
        // round trip a cache hit needs to avoid (Core Rule 4).
        this.lookupStmt = this.db.prepare(`
            SELECT * FROM explanation_cache
            WHERE fn_id = ? AND fn_hash = ? AND model_id = ? AND embedding_model_id = ? AND prompt_version = ?
            LIMIT 1
        `);

        this.lookupByCacheKeyStmt = this.db.prepare(`
            SELECT * FROM explanation_cache WHERE cache_key = ? LIMIT 1
        `);

        // Session 13 (staleness detection): unlike `lookupStmt`, deliberately
        // does NOT filter on fn_hash -- this is how a trigger that's about to
        // regenerate a function (because the exact-hash lookup missed) finds
        // out whether that miss means "genuinely new function" (no row here)
        // or "confirmed content change" (a prior row exists, under a
        // different fn_hash). `cache_key` is the table's primary key, not
        // fn_id, so an old row survives under its old cache_key after a
        // regeneration writes a new row for the new fn_hash -- ordering by
        // generated_at picks the one that was most recently the "live" row
        // for this fn_id under the current model/embedding/prompt tuple.
        // `, rowid DESC` (Session 39 code-review finding) is a deliberate
        // tiebreaker: `generated_at` is a caller-supplied ISO string, not
        // guaranteed unique -- two rows for the same tuple could share it
        // (stacked rows from `evictSuperseded=false`, or same-millisecond
        // writes). Without an explicit tiebreaker this query and
        // `purgeSupersededStmt` below (a differently-shaped window-function
        // query over the same sort key) could resolve a tie differently,
        // letting the purge sweep delete the exact row this statement had
        // just reported as "current" -- rowid (monotonically assigned on
        // insert, and reassigned on an INSERT OR REPLACE's implicit
        // delete-then-reinsert of a same-cache_key row, so it always
        // reflects insertion recency) makes both statements agree on "most
        // recently inserted wins" instead.
        this.currentRowForFnIdStmt = this.db.prepare(`
            SELECT * FROM explanation_cache
            WHERE fn_id = ? AND model_id = ? AND embedding_model_id = ? AND prompt_version = ?
            ORDER BY generated_at DESC, rowid DESC LIMIT 1
        `);

        this.writeStmt = this.db.prepare(`
            INSERT OR REPLACE INTO explanation_cache
                (cache_key, fn_id, explanation_json, fn_hash, context_hash, model_id, embedding_model_id, prompt_version, context_tier, generated_at)
            VALUES (@cache_key, @fn_id, @explanation_json, @fn_hash, @context_hash, @model_id, @embedding_model_id, @prompt_version, @context_tier, @generated_at)
        `);

        this.deleteByCacheKeyStmt = this.db.prepare(`DELETE FROM explanation_cache WHERE cache_key = ?`);

        // Session 39 (cache eviction policy, "automatic narrow" per the
        // user's explicit choice): a full-table sweep using the SAME narrow
        // definition `write()`'s auto-evict uses -- per (fn_id, model_id,
        // embedding_model_id, prompt_version) tuple, keep only the row with
        // the greatest generated_at, drop every other row in that tuple.
        // Deliberately does NOT cross tuples: a row orphaned by a
        // model/embedding/prompt_version bump sits in its OWN tuple (it's
        // the only/most-recent row there), so this never touches it -- same
        // documented limitation as the auto-evict path, not a bug. Used by
        // both the manual purge command and (when a fn_id accumulated
        // multiple rows while auto-evict was toggled off) as the catch-up
        // sweep once it's toggled back on or run explicitly.
        // `, rowid DESC` -- the same tiebreaker `currentRowForFnIdStmt`
        // uses above, and for the same reason: without it, a
        // `generated_at` tie within a tuple could make this window
        // function pick a different row as rank-1 than
        // `currentRowForFnIdStmt` would report as "current", so this sweep
        // could delete the row a caller had just been told was live.
        this.purgeSupersededStmt = this.db.prepare(`
            DELETE FROM explanation_cache
            WHERE cache_key NOT IN (
                SELECT cache_key FROM (
                    SELECT cache_key,
                           ROW_NUMBER() OVER (
                               PARTITION BY fn_id, model_id, embedding_model_id, prompt_version
                               ORDER BY generated_at DESC, rowid DESC
                           ) AS rn
                    FROM explanation_cache
                )
                WHERE rn = 1
            )
        `);

        // Session 56 ("Search Explanations"): the whole-table analogue of
        // `currentRowForFnIdStmt` above -- same "current row" definition
        // (per fn_id, greatest `generated_at` then `rowid` as the tiebreaker,
        // both statements' reasons for existing), just returning every fn_id's
        // current row in one query instead of looking up a single known
        // fn_id. Filters to the live model/embedding/prompt tuple both in the
        // window function's own partition and in the outer WHERE, so a row
        // orphaned by e.g. a `PROMPT_VERSION` bump (which `currentRowForFnIdStmt`
        // already can't see past -- see that field's own doc comment) is
        // excluded entirely rather than surfacing as a stale search result.
        this.listCurrentRowsStmt = this.db.prepare(`
            SELECT * FROM explanation_cache
            WHERE model_id = ? AND embedding_model_id = ? AND prompt_version = ?
            AND cache_key IN (
                SELECT cache_key FROM (
                    SELECT cache_key,
                           ROW_NUMBER() OVER (
                               PARTITION BY fn_id
                               ORDER BY generated_at DESC, rowid DESC
                           ) AS rn
                    FROM explanation_cache
                    WHERE model_id = ? AND embedding_model_id = ? AND prompt_version = ?
                )
                WHERE rn = 1
            )
        `);
    }

    lookup(params: CacheLookupParams): CacheRow | undefined {
        const row = this.lookupStmt.get(
            params.fnId,
            params.fnHash,
            params.modelId,
            params.embeddingModelId,
            params.promptVersion
        ) as CacheRow | undefined;
        return row;
    }

    /**
     * Exact-key lookup, used by the "Show more" hover link (Session 7): the
     * row the hover just rendered is passed by `cache_key` so the panel shows
     * precisely that row, independent of wherever the cursor currently is.
     */
    getByCacheKey(cacheKey: string): CacheRow | undefined {
        return this.lookupByCacheKeyStmt.get(cacheKey) as CacheRow | undefined;
    }

    /**
     * The row that was most recently "live" for `fnId` under the given
     * model/embedding/prompt tuple, regardless of `fn_hash` -- used by
     * save/flush/git-hook re-indexing to tell a brand-new function apart
     * from a confirmed content change to a previously-cached one (Session
     * 13's staleness detection; see this class's doc comment above).
     */
    getCurrentRowForFnId(params: {
        fnId: string;
        modelId: string;
        embeddingModelId: string;
        promptVersion: string;
    }): CacheRow | undefined {
        return this.currentRowForFnIdStmt.get(
            params.fnId,
            params.modelId,
            params.embeddingModelId,
            params.promptVersion
        ) as CacheRow | undefined;
    }

    /**
     * `evictSuperseded` (Session 39, default true, gated by
     * `lucidHover.autoEvictSupersededCache`): the "automatic narrow"
     * eviction policy -- when this write regenerates a `fn_id` under the
     * SAME model/embedding/prompt tuple (a genuine content-hash change per
     * session 13's staleness detection, so `cache_key` differs from
     * whatever `getCurrentRowForFnId` currently returns for this tuple),
     * the OLD row is deleted right after the new one is durably written.
     * Looked up via `currentRowForFnIdStmt` -- the same statement session
     * 13's staleness detection uses to define "the current live row" -- so
     * a row is only ever deleted once it is provably no longer that row.
     * Deliberately narrow: does NOT reach across a model/embedding/prompt
     * tuple change (a `PROMPT_VERSION` bump, for example), since
     * `currentRowForFnIdStmt` filters on that exact tuple and simply finds
     * no `previous` row to delete when it changes -- see
     * `purgeSupersededStmt`'s doc comment for the same limitation applied
     * to the manual sweep.
     */
    write(row: CacheRow, evictSuperseded = true): void {
        const previous = evictSuperseded
            ? (this.currentRowForFnIdStmt.get(
                  row.fn_id,
                  row.model_id,
                  row.embedding_model_id,
                  row.prompt_version
              ) as CacheRow | undefined)
            : undefined;

        this.writeStmt.run(row);

        if (previous && previous.cache_key !== row.cache_key) {
            this.deleteByCacheKeyStmt.run(previous.cache_key);
        }

        for (const listener of this.writeListeners) {
            listener(row);
        }
    }

    /**
     * Manual sweep (Session 39, "LucidHover: Purge Superseded Cache Rows"):
     * applies `write()`'s same narrow per-tuple "keep only the newest row"
     * rule across the whole table in one pass, rather than only at the
     * moment of a regenerating write. Useful when
     * `lucidHover.autoEvictSupersededCache` is off (rows accumulate until
     * this is run explicitly) or to sweep rows that piled up before this
     * feature existed. Returns the number of rows deleted.
     */
    purgeSupersededRows(): number {
        return this.purgeSupersededStmt.run().changes as number;
    }

    /**
     * Every fn_id's current row (Session 56, "Search Explanations") under the
     * given model/embedding/prompt tuple -- see `listCurrentRowsStmt`'s doc
     * comment for the exact definition. Read-only; never touches rows.
     */
    listCurrentRows(params: { modelId: string; embeddingModelId: string; promptVersion: string }): CacheRow[] {
        return this.listCurrentRowsStmt.all(
            params.modelId,
            params.embeddingModelId,
            params.promptVersion,
            params.modelId,
            params.embeddingModelId,
            params.promptVersion
        ) as CacheRow[];
    }

    /** Fires after every write (regenerate or first-generate), whatever the caller. */
    onDidWrite(listener: CacheWriteListener): { dispose: () => void } {
        this.writeListeners.add(listener);
        return { dispose: () => this.writeListeners.delete(listener) };
    }

    dispose(): void {
        this.db.close();
    }
}
