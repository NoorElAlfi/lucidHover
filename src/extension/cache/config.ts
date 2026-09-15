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
 *
 * `few-shot-v6` (was `few-shot-v5`, Session 96): closes two hallucination
 * classes session 92's Python validation pass surfaced (one new, one a
 * carried-forward residual of session 42's own fix): (1) a new general field
 * rule -- "never infer what a function does from its own name alone,
 * scoped to only apply when nothing in the body/callees confirms the named
 * behavior" -- for the base-model naming-bias finding (Python fixture's
 * `traced`, a no-op pass-through decorator, hallucinated as "adds logging"
 * purely from its name, confirmed via `grep -i "decorat" prompt.py` to not
 * be a few-shot leak); (2) a reworded `side_effects` rule addendum -- a
 * function whose only verified effect is a plain logging/printing call has
 * exactly one side effect, a logged/printed message, not file I/O or
 * messaging -- for the residual verbatim-category-copy case where a
 * function has exactly one real, grounded effect (a log call) but the model
 * still padded in unrelated categories from the field rule's own example
 * list (Python fixture's `find_user_by_email`). One new few-shot example
 * (`_EXAMPLE_6`, an isolated no-op decorator literally named "traced",
 * chosen over a synonym after live testing showed the model's naming bias
 * is tied to that specific word) demonstrates the naming-bias pattern.
 *
 * Two live-tested false starts, discarded before landing on the above:
 * a second candidate example (a single-log-effect case with a fictional
 * caller "resolveSetting") fixed `find_user_by_email` but caused a worse
 * regression -- the model echoed its fictional caller name and "caching"
 * framing verbatim into `traced`'s own (correctly caller-less) explanation
 * -- so it was dropped once the field-rule wording alone proved sufficient
 * for `find_user_by_email`. Separately, the side_effects addendum's first
 * draft repeated the exact illustrative phrases ("reading/writing a file",
 * "sending a message/notification") from the rule above it, even though
 * negated ("do not also list it as X") -- this made those exact phrases
 * appear twice in the prompt and measurably caused *new* verbatim-copy
 * hallucinations on functions that never triggered it before (JS fixture's
 * `handleLoginRoute`, Python fixture's `validate_email`) -- fixed by
 * rewording the addendum to never repeat those phrases at all.
 *
 * Also discovered, live-tested (git-stash A/B), and deliberately NOT fixed
 * here (flagged as a separate follow-up, out of scope for a prompt-wording
 * session): a pre-existing Ollama resource-exhaustion bug where enough
 * sustained back-to-back `generate_explanation` calls against the same
 * loaded model instance eventually stall until the client's 120s timeout.
 * This session's longer prompt measurably brings the failure point sooner
 * (baseline survives a real 28-function/56-request run with no stall;
 * field-rule-wording-only fails at function 23; the full fix above fails at
 * function 12) -- confirmed via `keep_alive: 0` unload resetting whatever
 * accumulates, so a periodic model unload is a viable workaround if this
 * later proves to affect real `BackgroundIndexManager` runs.
 *
 * `few-shot-v7` (was `few-shot-v6`): fixes a real, 100%-reproducible bug
 * found live via the docked panel's `LucidHover: Explanation` command on
 * `fixtures/python/repomap/handlers.py`'s `handle_signup_route`: with the
 * retrieval tier populated (Session 11's `retrieved_chunks`, built from a
 * real embedded `VectorStore`, not the empty-list call-graph-only path),
 * `why_it_exists`/`side_effects` fabricated a caller claim (including
 * self-reference: the function named as its own caller) and misattributed
 * sibling route handlers' and a real callee's own bodies as this function's
 * behavior -- root cause: `_format_retrieved_section`'s header was a bare
 * `"Retrieved context (N):"` with no explanation of what the section *is*,
 * and none of the (then six) few-shot examples ever included a "Retrieved
 * context" section at all, so the model had zero grounding for what to do
 * with it and treated the chunks as caller/callee/behavior evidence.
 *
 * Fix: reworded the header alone (in `_format_retrieved_section`) to state
 * inline that the section is "background only, NOT this function's
 * callers/callees, never evidence of its own behavior" -- no `SYSTEM_
 * INSTRUCTION` field-rule addition, no new few-shot example. This was a
 * deliberate result of live A/B testing, not the first design tried: a
 * fuller fix (a new `SYSTEM_INSTRUCTION` field-rule paragraph explaining
 * the retrieval tier, plus a seventh few-shot example demonstrating the
 * zero-callers-plus-retrieved-context shape) also fixed the original bug,
 * but a live cross-function regression pass caught it introducing a *new*
 * failure on a different function (`handle_render_route`): the reasoning
 * stage collapsed into a near-verbatim copy of `_EXAMPLE_6`'s (`traced`)
 * reasoning text -- "No callers or callees are given for this function"
 * -- even though 2 real callees were given, and `calls` correspondingly
 * dropped a real callee. A leaner variant (the field-rule paragraph alone,
 * no new example) reduced but did not eliminate that same collapse. The
 * one-line header-only version was the first that showed zero regressions
 * across every re-tested function while still fixing the original bug.
 *
 * Verified (live, real Ollama `qwen2.5-coder:1.5b`, `temperature=0`, model
 * unloaded via `keep_alive: 0` before each batch per the resource-
 * exhaustion note above) against all three fixtures, with retrieval:
 * `handle_signup_route`/`handleSignupRoute` (Python/JS/TS): before, a
 * sprawling fabricated `why_it_exists`/`side_effects` (in the worst
 * reproduction, a 13-item `side_effects` list built from unrelated sibling
 * functions' bodies); after, `side_effects` consistently correct (just the
 * one real `log_event` effect), `used_by`/`calls` correct in every trial.
 * `handle_render_route`, `handle_login_route`, `handle_update_route`
 * (Python), `handleDeleteRoute`/`validateAndPersistSignup` (TS/JS), and
 * `validate_and_persist_signup` (a real-callers case, Python) all came back
 * with `used_by`/`calls` exactly matching the real call graph, no dropped
 * or invented names, both before and after -- no regression.
 *
 * Residual, NOT fixed here, confirmed pre-existing (reproduces on baseline
 * `few-shot-v6` too, independent of retrieval): a zero-caller function can
 * still hallucinate a phantom caller in `why_it_exists` -- sometimes the
 * function's own name (self-reference), sometimes an invented name
 * (`handle_render_route` baseline: `"handle_request"`; `handle_delete_route`
 * baseline: a fabricated REST route string). This is the zero-caller analog
 * of sessions 25/42/92/96's own repeatedly-documented "measured reduction,
 * not full elimination" pattern for this 1.5B model and was out of scope
 * for this retrieval-specific fix -- left for a future session.
 */
export const PROMPT_VERSION = 'few-shot-v7';

/**
 * Session 66: default background-indexing scope. A full-repo pass
 * (`BackgroundIndexManager.run()`'s original Session 9 behavior) projected
 * ~16 hours on a real 6,633-function repo (pokerogue) -- Core Rule 4's
 * cache-miss hover fallback exists precisely so this exhaustiveness isn't
 * required for correctness, so `'topN'` (the highest-importance functions
 * only, per `resolveBackgroundIndexTopN()`) is the new default. `'fullRepo'`
 * keeps the old behavior available as an explicit opt-in, per the user's own
 * choice when this was put to them via `AskUserQuestion` rather than decided
 * unilaterally. An unrecognized value falls back to `'topN'`, same
 * unset-falls-back-to-default pattern as `resolveModelId()` above.
 */
export type BackgroundIndexScope = 'topN' | 'fullRepo';

export function resolveBackgroundIndexScope(): BackgroundIndexScope {
    const configured = vscode.workspace.getConfiguration('lucidHover').get<string>('backgroundIndexScope');
    return configured === 'fullRepo' ? 'fullRepo' : 'topN';
}

/**
 * Session 66: how many of the ranked functions a `'topN'`-scoped pass covers.
 * `list_ranked_functions` already returns its result sorted by importance
 * descending (`rpc_server.py`'s `_handle_list_ranked_functions`), so this is
 * a plain client-side slice of that list -- no new RPC, no sidecar change.
 * 200 was chosen as a default that finishes in on the order of tens of
 * minutes rather than hours at pokerogue's measured per-function generation
 * pace, while still covering the functions most likely to be hovered first.
 * Only consulted when `resolveBackgroundIndexScope()` is `'topN'`.
 */
export function resolveBackgroundIndexTopN(): number {
    const configured = vscode.workspace.getConfiguration('lucidHover').get<number>('backgroundIndexTopN');
    return typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
        ? Math.floor(configured)
        : 200;
}

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

/**
 * Session 68 (call-graph-clustered rollup summary): prompt version for the
 * new per-cluster purpose-paragraph synthesis call
 * (sidecar/generation/prompt.py's `build_cluster_summary_prompt` /
 * `CLUSTER_SUMMARY_SYSTEM_INSTRUCTION`) -- its own constant, deliberately
 * separate from both `PROMPT_VERSION` (the per-function explanation prompt)
 * and `SUMMARY_DOC_PROMPT_VERSION` (the per-file purpose-paragraph prompt),
 * same "a wholly different prompt gets its own version" reasoning
 * `SUMMARY_DOC_PROMPT_VERSION`'s own doc comment already gives -- a bump to
 * either of the other two shouldn't force every cached cluster-summary row
 * to regenerate, and vice versa.
 */
export const CLUSTER_SUMMARY_PROMPT_VERSION = 'cluster-summary-v1';
