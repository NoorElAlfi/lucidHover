import * as crypto from 'crypto';

function sha256(input: string): string {
    return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Stable identity for a function across hovers -- not part of the hash, just
 * the lookup row key. `qualifiedName` is built by functionResolution.ts from
 * the symbol's enclosing-scope path (e.g. "ClassName.methodName"), not an
 * absolute line number: a line number shifts for every function below an
 * unrelated edit earlier in the same file, which would otherwise turn a
 * byte-for-byte-unchanged function into a spurious cache miss (and orphan
 * its old row) on every edit that changes the file's line count.
 */
export function computeFnId(relFname: string, qualifiedName: string): string {
    return `${relFname}::${qualifiedName}`;
}

/**
 * fn_hash is computed here (extension host), not by the sidecar, even though
 * context_hash is sidecar-owned (see session-05 artifact "Cache ownership
 * decision"). Reason: the pre-sidecar cache lookup (fn_id + fn_hash + model/
 * embedding/prompt ids) must be computable without contacting the sidecar at
 * all -- that's what lets a cache hit skip the sidecar entirely (Core Rule 4).
 * The extension host already has the live function source text from the
 * hover provider's document-symbol resolution, so hashing it here requires
 * no round trip.
 */
export function computeFnHash(fnSource: string): string {
    return sha256(fnSource);
}

/**
 * Core Design Decision #2: cache_key = hash(fn_source + context_hashes +
 * model_id + embedding_model_id + prompt_version). "context_hashes" (plural,
 * per-chunk) is collapsed into the single `context_hash` the sidecar returns
 * (itself a hash of the sorted per-chunk hashes -- see
 * sidecar/rpc_server.py's _compute_context_hash) before reaching this
 * function, so the concatenation here is fn_source + context_hash + ids.
 */
export function computeCacheKey(params: {
    fnSource: string;
    contextHash: string;
    modelId: string;
    embeddingModelId: string;
    promptVersion: string;
}): string {
    const { fnSource, contextHash, modelId, embeddingModelId, promptVersion } = params;
    return sha256(fnSource + contextHash + modelId + embeddingModelId + promptVersion);
}

/**
 * Surrogate fn_hash for a file's synthetic `__file_summary__` cache row
 * (Session 15's per-file purpose paragraph, Build Order step 15) -- there's
 * no single function source to hash for a whole file, so this hashes the
 * sorted set of that file's own functions' real `fn_hash` values instead.
 * It changes exactly when the set of cached function hashes for the file
 * changes (a function's content changed, or one was added/removed), which
 * is exactly the condition under which the purpose paragraph could
 * plausibly be stale -- same "confirmed content change" semantics fn_hash
 * already has for a real function, just computed over a set instead of one
 * source string. Sorted so hash order (an implementation detail of however
 * the caller enumerated the file's functions) never itself changes the
 * result.
 */
export function computeFileSummaryFnHash(fnHashes: readonly string[]): string {
    return sha256([...fnHashes].sort().join(','));
}
