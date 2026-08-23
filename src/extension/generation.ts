import { ExplanationCache, CacheRow } from './cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveAutoEvictSupersededCache, resolveModelId } from './cache/config';
import { computeCacheKey } from './cache/hash';
import { ResolvedFunction } from './functionResolution';
import { RequestPriority, SidecarManager } from './sidecar/sidecarManager';

// Real generation is two sequential Ollama calls (sidecar/generation/), which
// can comfortably exceed the 4s default RPC timeout meant for near-instant
// methods like `status`/`index_file` -- see session-06 artifact.
const GENERATE_TIMEOUT_MS = 120_000;

// Every caller already has a `ResolvedFunction` (from `functionResolution.ts`)
// on hand, so `generateAndCache` takes one directly rather than a bespoke
// param shape.
export type GenerationTarget = ResolvedFunction;

/**
 * Calls the sidecar's `generate_explanation` and writes the resulting row to
 * the cache. Shared by four callers that all need the identical
 * sidecar-call + cache-key + write sequence (Session 8): the hover
 * provider's cache-miss path, debounced-save re-indexing, the manual
 * refresh command, and (Session 9) `BackgroundIndexManager`'s pre-generation
 * walk. Previously this lived inline in the hover provider only
 * (Sessions 5-7); pulled out here rather than let Session 8's two new
 * callers duplicate it.
 *
 * `priority` (Session 32) defaults to `'interactive'`, matching every caller
 * except `BackgroundIndexManager`, which passes `'background'` so its
 * `generate_explanation` calls are visible to `SidecarManager.
 * waitForInteractiveIdle()` -- see sidecarManager.ts's `RequestPriority` doc.
 */
export async function generateAndCache(
    sidecar: SidecarManager,
    cache: ExplanationCache,
    target: GenerationTarget,
    priority: RequestPriority = 'interactive'
): Promise<CacheRow> {
    // Resolved once per call (not imported as a constant) so a user override
    // via `lucidHover.modelId` (Build Order step 14) takes effect on the very
    // next generation, and the sidecar request / cache-key / cache-row all
    // agree on the same value -- see cache/config.ts's `resolveModelId` doc.
    const modelId = resolveModelId();

    const result = await sidecar.request<{
        context_hash: string;
        context_tier: string;
        explanation: Record<string, unknown>;
    }>(
        'generate_explanation',
        {
            file_path: target.relFile,
            name: target.name,
            line: target.range.start.line,
            fn_source: target.fnSource,
            model_id: modelId,
        },
        GENERATE_TIMEOUT_MS,
        priority
    );

    const row: CacheRow = {
        cache_key: computeCacheKey({
            fnSource: target.fnSource,
            contextHash: result.context_hash,
            modelId,
            embeddingModelId: EMBEDDING_MODEL_ID,
            promptVersion: PROMPT_VERSION,
        }),
        fn_id: target.fnId,
        explanation_json: JSON.stringify(result.explanation),
        fn_hash: target.fnHash,
        context_hash: result.context_hash,
        model_id: modelId,
        embedding_model_id: EMBEDDING_MODEL_ID,
        prompt_version: PROMPT_VERSION,
        context_tier: result.context_tier,
        generated_at: new Date().toISOString(),
    };
    cache.write(row, resolveAutoEvictSupersededCache());
    return row;
}
