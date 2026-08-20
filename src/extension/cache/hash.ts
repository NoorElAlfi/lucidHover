import * as crypto from 'crypto';

function sha256(input: string): string {
    return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Stable identity for a function across hovers -- not part of the hash, just the lookup row key. */
export function computeFnId(relFname: string, name: string, line: number): string {
    return `${relFname}::${name}::${line}`;
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
