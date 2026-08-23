import * as vscode from 'vscode';
import { DEFAULT_OLLAMA_ENDPOINT, ResolvedOllamaEndpoint, resolveOllamaEndpointFromValue } from './ollamaEndpoint';

export { DEFAULT_OLLAMA_ENDPOINT, ResolvedOllamaEndpoint, resolveOllamaEndpointFromValue };

/**
 * v0 cache-key identity values. These are config the extension host already
 * owns per Core Design Decision #2's cache key formula.
 *
 * MODEL_ID: resolved to the spec's actual intended v0 bundled default,
 * `qwen2.5-coder:1.5b`, after the benchmark the spec called for ("benchmark
 * `3b` against the fixture repo before deciding") finally happened --
 * `1.5b` and `3b` were both pulled and run through the acceptance test
 * against a real repo (`qwen2.5-coder:7b` had been a Session 6 stand-in
 * the whole time, since neither `1.5b` nor `3b` was pulled locally until
 * now). `1.5b` and `3b` scored identically on the automated filter
 * (14/15, the one shared miss on both being the same automated-filter
 * false positive, not a real quality gap); `1.5b` was chosen per explicit
 * user decision, favoring the smallest model that held up. See
 * session-08 artifact's follow-up conversation.
 *
 * This value is sent to the sidecar as a `generate_explanation` request
 * param (not hardcoded sidecar-side) so the extension host's cache-key
 * MODEL_ID and the model Ollama actually runs can never drift apart.
 */
export const MODEL_ID = 'qwen2.5-coder:1.5b';

/**
 * Build Order step 14 (custom local Ollama endpoint tier): `MODEL_ID` above
 * is still the bundled default, but every cache-key/generation call site
 * should resolve through this function instead of importing `MODEL_ID`
 * directly, so a user override (`lucidHover.modelId`) and the default agree
 * everywhere -- a cache-key `modelId` computed one way and a generation
 * request sent another would mean permanent cache misses. `model_id` is
 * already a per-`generate_explanation`-request param (not sidecar-owned),
 * so unlike the endpoint below, this needs no sidecar restart to take
 * effect -- the very next hover/save/refresh just sends the new value.
 * Empty/whitespace-only settings values fall back to the bundled default,
 * same as an unset setting.
 */
export function resolveModelId(): string {
    const configured = vscode.workspace.getConfiguration('lucidHover').get<string>('modelId');
    const trimmed = typeof configured === 'string' ? configured.trim() : '';
    return trimmed.length > 0 ? trimmed : MODEL_ID;
}

/**
 * Resolves `lucidHover.ollamaEndpoint`, falling back to
 * `DEFAULT_OLLAMA_ENDPOINT` when unset, unparsable, or non-local.
 *
 * Spawn-time only (Build Order step 14 design pass, question 3) -- like
 * `EMBEDDING_MODEL_ID`, the sidecar's startup embedding pass needs this
 * before any RPC request could otherwise deliver it, and per question 2,
 * generation and embeddings must hit the same Ollama daemon (two daemons
 * that may not have the same models pulled is a real correctness trap), so
 * this can't be split into a per-request generation-only override the way
 * `resolveModelId()` is. Changing the setting takes effect on the next
 * sidecar (re)start -- see `SidecarManager.applyOllamaEndpoint()` and the
 * "LucidHover: Restart Sidecar" command.
 */
export function resolveOllamaEndpoint(): ResolvedOllamaEndpoint {
    const configured = vscode.workspace.getConfiguration('lucidHover').get<string>('ollamaEndpoint');
    return resolveOllamaEndpointFromValue(configured);
}

/**
 * Session 39 (cache eviction policy): default true -- the "automatic
 * narrow" policy the user chose. Every write through `generateAndCache`/
 * `summaryDocGenerator` resolves this fresh (same pattern as
 * `resolveModelId`) and passes it to `ExplanationCache.write()`'s
 * `evictSuperseded` param, so toggling this in settings takes effect on the
 * very next write, no restart needed. Set to false to fall back to manual
 * cleanup only, via the "LucidHover: Purge Superseded Cache Rows" command
 * (`ExplanationCache.purgeSupersededRows()`) -- both the automatic path and
 * the manual command apply the identical narrow definition (same fn_id +
 * model_id + embedding_model_id + prompt_version tuple only), so this
 * setting controls *when* superseded rows get cleaned up, not *which* rows
 * count as superseded.
 */
export function resolveAutoEvictSupersededCache(): boolean {
    return vscode.workspace.getConfiguration('lucidHover').get<boolean>('autoEvictSupersededCache') ?? true;
}

/**
 * `all-minilm`: Session 11 (Build Order step 11) flips this from the fixed
 * `'none'` it held since Session 5 to a real Ollama embedding model -- the
 * same local backend `MODEL_ID`'s generation calls already use (Ollama's
 * `/api/embeddings`), per the decision against adding a second local-model
 * runtime just for embeddings. Unlike `MODEL_ID`, this value is NOT sent as
 * a per-`generate_explanation`-request param: the sidecar's one-time,
 * startup full-repo embedding pass has to use it before any RPC request
 * exists to carry it, so it's passed once at sidecar spawn instead (see
 * `SidecarManager.start()`) and reused for every later retrieval query --
 * single-sourcing it removes any risk of the corpus and a query ever being
 * embedded with two different models. It still flows into the cache-key
 * formula exactly like before (`generateAndCache()` already folded
 * `EMBEDDING_MODEL_ID` into `computeCacheKey()`), so this one-line value
 * change is what actually invalidates every existing cache row.
 */
export const EMBEDDING_MODEL_ID = 'all-minilm';
/**
 * `few-shot-v4` (was `few-shot-v3`): fixed an output-quality inconsistency
 * where `side_effects` was sometimes returned as several distinct array
 * elements and sometimes as a single comma-joined string containing all of
 * them -- both satisfy the JSON schema's "array of strings" shape, so this
 * was a prompt-adherence gap, not a schema bug. sidecar/generation/prompt.py's
 * `side_effects` field rule now explicitly forbids comma-joining multiple
 * effects into one element (with an inline WRONG/RIGHT example), and a
 * fourth few-shot example (`_EXAMPLE_4`) was added showing a function with
 * all five side-effect categories at once, each correctly split into its
 * own array element. Bumped per Core Design Decision #2 ("Any change to
 * context composition, model, or prompt template must be reflected in this
 * key"), so old rows generated under the previous prompt don't get served
 * as if they reflect the new one.
 *
 * `few-shot-v3` (was `few-shot-v2`): `build_context_bundle()` gained a
 * "Retrieved context" section (Session 11's retrieval tier). Bumped per
 * Core Design Decision #2 ("Any change to context composition... must be
 * reflected in this key") -- same reasoning as the `few-shot-v2` bump
 * below, now for the retrieval addition instead of the highlighting one.
 *
 * `few-shot-v2` (was `few-shot-v1`): sidecar/generation/prompt.py's
 * `why_it_exists` field rule, context bundle format (top-k "most
 * significant" caller/callee highlighting), and few-shot examples (added a
 * third, long-caller-list example) all changed -- bumped per Core Design
 * Decision #2 ("Any change to context composition, model, or prompt
 * template must be reflected in this key"), so old rows generated under
 * the previous prompt don't get served as if they reflect the new one.
 *
 * `few-shot-v5` (was `few-shot-v4`, Session 42): sidecar/generation/
 * prompt.py's `side_effects` field rule now explicitly says caller count /
 * importance has no bearing on whether a function has side effects, and a
 * fifth few-shot example (`_EXAMPLE_5`, `getActiveUsers`) was added showing
 * a pure getter with several real callers and an empty `side_effects` --
 * targets the verbatim-category-list hallucination sessions 25/28 both
 * observed on real pure/trivial functions with real callers (pokerogue's
 * `getPlayerParty`, the TS fixture's `isEmpty<T>`/`handleLoginRoute`), where
 * the model copied the field rule's own illustrative phrases ("reading or
 * writing a file", "sending a message or notification", "mutating a
 * parameter or global") into the answer instead of grounding effects in the
 * function's actual body.
 */
export const PROMPT_VERSION = 'few-shot-v5';

/**
 * Session 15 (Build Order step 15, secondary summary-doc generator,
 * post-MVP): prompt version for the new per-file/module purpose-paragraph
 * synthesis call (sidecar/generation/prompt.py's `build_file_summary_prompt`
 * / `FILE_SUMMARY_SYSTEM_INSTRUCTION`) -- deliberately separate from
 * `PROMPT_VERSION` above, which versions the per-function explanation
 * prompt only. This is a wholly different prompt (summarizes a file's
 * already-cached function summaries, not a function's own source), so it
 * gets its own version constant rather than sharing one whose bumps mean
 * something unrelated to this row's actual invalidation condition -- a
 * `PROMPT_VERSION` bump for the function-explanation prompt shouldn't force
 * every cached file-summary paragraph to regenerate too, and vice versa.
 */
export const SUMMARY_DOC_PROMPT_VERSION = 'summary-doc-v1';
