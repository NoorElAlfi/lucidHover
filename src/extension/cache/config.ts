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
 */
export const PROMPT_VERSION = 'few-shot-v3';
