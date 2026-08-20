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
    private readonly writeStmt;

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

        this.writeStmt = this.db.prepare(`
            INSERT OR REPLACE INTO explanation_cache
                (cache_key, fn_id, explanation_json, fn_hash, context_hash, model_id, embedding_model_id, prompt_version, context_tier, generated_at)
            VALUES (@cache_key, @fn_id, @explanation_json, @fn_hash, @context_hash, @model_id, @embedding_model_id, @prompt_version, @context_tier, @generated_at)
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

    write(row: CacheRow): void {
        this.writeStmt.run(row);
        for (const listener of this.writeListeners) {
            listener(row);
        }
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
