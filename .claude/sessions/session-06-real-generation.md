# Session 6: Real generation

**Date:** 2026-08-19
**Build-order step(s) completed:** 6
**Status:** partial

## Files touched
- [src/extension/cache/config.ts](../../src/extension/cache/config.ts) — `MODEL_ID` swapped from `stub-v0` to `qwen2.5-coder:7b` (temporary, see "Deviations from spec"); `PROMPT_VERSION` swapped to `few-shot-v1`.
- [src/extension/hover/functionHoverProvider.ts](../../src/extension/hover/functionHoverProvider.ts) — `generate_explanation` request now sends `fn_source` and `model_id`; request timeout for this call raised to 120s (was the 4s default meant for near-instant methods).
- [src/extension/sidecar/sidecarManager.ts](../../src/extension/sidecar/sidecarManager.ts) — `heartbeatTick` now skips sending a `status` ping while a request is already pending. See "Heartbeat/generation-latency bug" below — this is a correctness fix this session's change exposed, not scope creep.
- [sidecar/rpc_server.py](../../sidecar/rpc_server.py) — `_handle_generate_explanation` now requires `fn_source`/`model_id` params and calls real generation via `sidecar/generation/`; `OllamaError` is re-raised as a JSON-RPC error (no silent stub/fallback).
- [sidecar/generation/schema.py](../../sidecar/generation/schema.py) — new; the Output Schema JSON object, used as Ollama's `format` param.
- [sidecar/generation/prompt.py](../../sidecar/generation/prompt.py) — new; system instruction (field rules), 2 hand-written few-shot examples, context-bundle formatting, and the two prompt builders (reasoning-stage, JSON-stage).
- [sidecar/generation/ollama_client.py](../../sidecar/generation/ollama_client.py) — new; stdlib-`urllib`-based Ollama HTTP client (`generate_text`, `generate_structured`), clear `OllamaError` messages for unreachable/missing-model cases.
- [sidecar/generation/generate.py](../../sidecar/generation/generate.py) — new; orchestrates the two-stage call (see "Two-stage generation" below).
- [sidecar/generation/__init__.py](../../sidecar/generation/__init__.py) — new; empty, makes `sidecar.generation` a package.
- [scripts/acceptance_test.py](../../scripts/acceptance_test.py) — new; the v0 acceptance test script (see "Acceptance test" below).

## Decisions made

### Ollama-as-interface (the ambiguity this session was asked to resolve)
Used Ollama's local HTTP API (`localhost:11434`) for the bundled model, not raw llama.cpp/GGUF bindings. `sidecar/generation/ollama_client.py` implements `generate(prompt, temperature=0) -> text`-shaped calls via stdlib `urllib` (no new dependency for one local POST). This makes the bundled and future custom-endpoint tiers (Build Order step 13) literally the same code path with only the model name param differing, matching the spec's explicit interface requirement, and avoids a second GGUF-loading implementation.

### Model gap: `qwen2.5-coder:7b` used instead of the spec's `qwen2.5-coder:1.5b`
This environment's local Ollama does not have `qwen2.5-coder:1.5b` pulled (checked `localhost:11434/api/tags`: only `qwen2.5-coder:7b`, `qwen2.5:7b`, `llama3.1:8b`, `gemma4:e4b`, `deepseek-r1:8b` are present). Per explicit user decision this session (asked directly, not assumed), `MODEL_ID` is set to `qwen2.5-coder:7b` temporarily so real generation could be built and tested end-to-end today. **This is not the spec's intended v0 bundled default.** `config.ts` documents this inline. The actual `1.5b` vs `3b` benchmark decision the spec calls for is still open — see "Blockers" below.

### Two-stage generation (reconciling "Reasoning: step" with schema-enforced output)
The spec asks for both (a) a few-shot prompt where each example shows a free-text `Reasoning:` step before the JSON, ending the real prompt in `Reasoning:` as a completion continuation, and (b) using Ollama's structured-output `format` mode rather than prose-instructed formatting. These are in tension: Ollama's `format` param (grammar-constrained decoding) forces the *entire* response to match the JSON schema from the first token — it cannot emit free prose followed by a JSON object in one call.

Resolved by splitting generation into two Ollama calls:
1. **Stage A (reasoning):** unconstrained text completion, few-shot examples + real input slot ending in `Reasoning:`, `stop=["{"]` so it stops right where JSON would start. Produces genuine free-text chain-of-thought, temperature=0.
2. **Stage B (JSON):** same input slot, now with Stage A's reasoning text appended, called *with* `format=EXPLANATION_SCHEMA`. Produces the final schema-validated JSON, grounded in the reasoning text from Stage A.

This keeps both requirements literally true — a real free-text reasoning continuation, and JSON that is genuinely schema-enforced, not prose-instructed — at the cost of two model calls per function (roughly doubles latency vs. a single call; acceptable for v0, since indexing is background/pre-generated, never on the hover path). The raw Stage A reasoning text is not stored anywhere; only Stage B's schema-conformant JSON becomes the cached explanation.

### `model_id`/`fn_source` are RPC request params, not sidecar-owned constants
The extension host (`config.ts`) is the single source of truth for `MODEL_ID` (it owns the cache-key formula). The sidecar receives `model_id` as a `generate_explanation` param and calls Ollama with exactly that value, rather than having its own hardcoded model constant — this makes it structurally impossible for the cache key's `model_id` and the model Ollama actually ran to drift apart. Same reasoning for `fn_source`: the extension host already has the live document text from its symbol resolution (Session 5), so it's cheaper and more consistent to send it than to have the sidecar re-derive it from disk (which could race with unsaved edits).

### Heartbeat/generation-latency bug (found and fixed this session)
Discovered while re-verifying Session 5's cache tests: `sidecar/rpc_server.py`'s request loop is strictly one-at-a-time per connection (`_process_lines` reads, dispatches, and responds to one line before reading more). Real generation calls routinely take 7-30s (two sequential Ollama calls). The extension host's heartbeat (`sidecarManager.ts`, Session 4) sends a `status` ping every 7s with a 4s timeout and restarts the sidecar after 3 consecutive failures (~21s) — so any `generate_explanation` call slower than ~21s got its `status` ping queued behind it, timed out, and triggered a restart that killed the in-flight, perfectly healthy request. Reproduced directly: the model-swap test step below failed with exactly this symptom (cold-loading a second model pushed one call over ~21s).

Fixed by skipping the heartbeat tick entirely while any request is already pending (`sidecarManager.ts`'s `heartbeatTick`) — the outstanding request's own eventual resolution/rejection is already a liveness signal, so a redundant `status` ping during that window only produces false positives given the strictly-serial request loop. This is a correctness fix for a bug this session's change (introducing multi-second generation calls) exposed, not "sidecar crash-recovery hardening" (Build Order step 15, post-MVP) — it doesn't add retry/backoff/resilience polish, just stops a healthy sidecar from being killed under expected v0 usage.

### Acceptance test script design
`scripts/acceptance_test.py`: indexes a target repo directly (no sidecar/socket involved — same-process import of `sidecar.repomap`/`sidecar.generation`), selects up to `--limit` functions (default 15) by descending call-graph importance (or an explicit `--functions` list), generates real explanations, and writes a Markdown report with each function's source, known callers/callees, generated JSON, and a `[ ] correct & non-obvious` checkbox for the reviewer. An automated first-pass filter (`_check_schema`) flags: missing/malformed fields, `one_liner` that looks like more than one sentence, placeholder-ish text (`n/a`, `tbd`, `and more`, etc.), and — the most substantive check — `why_it_exists` that doesn't mention any of the given caller/callee names at all (a direct check of the spec's "must reference actual given callers/callees" prompt rule). This is explicitly a mechanical filter, not a correctness judgment; the report's header says so and the actual pass bar (8/10-15 correct & non-obvious) stays human-in-the-loop, per the spec.

On an `OllamaError` (unreachable / model not found), the script fails loudly and stops immediately rather than logging a per-function failure and continuing — a connectivity/model problem affects every remaining function identically, so grinding through the rest would just produce a report full of the same error.

## Deviations from spec
- **Bundled model is `qwen2.5-coder:7b`, not the spec's `qwen2.5-coder:1.5b`** — see "Model gap" above. Temporary, explicit user decision, flagged as a blocker below.
- The two-stage generation call (vs. a single call) is an interpretation of how to reconcile two requirements that conflict as literally written (see "Two-stage generation" above), not a deviation from either requirement individually.

## Test status
- **`python -m pytest sidecar/tests -q`:** 6/6 pass (Session 3's repomap tests, unaffected).
- **`npx tsc -p . --noEmit`:** clean.
- **Direct generation smoke test:** `generate_explanation('qwen2.5-coder:7b', ...)` against the fixture repo's `validateAndPersistSignup` — real, grounded output (correct callers/callees, plausible side effects, `risk_note: null` — a fair answer since the "no rate limiting" context lives only in a file comment, not in `fn_source`/context bundle, so a null risk note is correct behavior, not a miss). ~31s for the two-stage call.
- **Cache-wiring re-verification (Node harness, `cache_wiring_test_session6.js`, scratch, not part of the repo):** re-ran Session 5's exact hover-twice/edit/regenerate/revert sequence with real generation instead of the stub, plus a new step verifying a `model_id`-only change (unchanged `fn_hash`/`context_hash`) forces a cache miss and that the original model's cached row survives a different model's write. All 6 steps passed on the second run (first run hit the heartbeat bug above; passed cleanly after the fix).
- **Acceptance test script, run against the Session 3 fixture repo** (`python scripts/acceptance_test.py fixtures/sample-repo/repomap --model qwen2.5-coder:7b --limit 15`): completed successfully, generated a full report, 11/15 passed the automated filter with no issues. The 4 flagged were legitimate catches (top-level route handlers with no callers, where `why_it_exists` fell back to generic phrasing instead of naming the callees it does have) — confirms the automated filter fires on real problems, not false positives. Report delivered to the user for the actual human review pass.
- **Not tested:** the real repo run (PokeRogue bot / Showdown bot) — this is the actual v0 completion gate and is explicitly left to the human, per the session instructions. Also not tested: interactive VS Code Extension Development Host (same environment limitation noted in Sessions 4-5).

## Blockers / open questions
- **`qwen2.5-coder:1.5b` still needs to be pulled** (`ollama pull qwen2.5-coder:1.5b`) so the spec's actual `1.5b` vs `3b` bundled-model benchmark can happen — right now `MODEL_ID` points at `7b`, which was never one of the models the spec's LLM Backend Strategy section considered. Once pulled: swap `MODEL_ID` in [config.ts](../../src/extension/cache/config.ts), rerun the cache-wiring model-swap check, and rerun the acceptance test against both `1.5b` and `3b` to make the actual size decision.
- **The acceptance test still needs to run against a real repo** (PokeRogue bot / Showdown bot) — this is the v0 Definition of Done's actual pass/fail gate (8/10-15 correct & non-obvious) and is deliberately left for the human, not rubber-stamped here.
- Two-stage generation roughly doubles per-function latency. Not a problem for v0 (background indexing, never on the hover path per Core Rule 4), but worth knowing before extending this pattern to a larger custom-endpoint model (Build Order step 13) where latency compounds with model size.
- `sidecar/generation/` is a new subdirectory without its own row in [CLAUDE.md](../../CLAUDE.md)'s file-ownership table; it reasonably falls under the existing "Sidecar (Python)" → `sidecar/` row, but flagging in case a human wants an explicit row (mirroring how `sidecar/repomap/` and `sidecar/cache/` each got one).
- Carried from Session 5, still unresolved: CLAUDE.md's "Cache layer" ownership row still says `sidecar/cache/`, stale since Session 5's actual SQLite code lives in `src/extension/cache/`.

## Handoff for next session
- Session 7 per Build Order step 7: two-surface UI (level 0 hover + docked `WebviewViewProvider` for levels 1-2), both rendering from the one cached JSON object. The hover currently still renders Session 5's plain unstyled `MarkdownString` field dump (`functionHoverProvider.ts`'s `renderMarkdown`) — untouched this session, that's explicitly Session 7 scope per the spec's Hover UX section (role_tag + one_liner only at level 0; why_it_exists/used_by/calls/side_effects/risk_note move to the docked panel).
- Before Session 7 starts, a human should: pull `qwen2.5-coder:1.5b`, swap `MODEL_ID`, and run `python scripts/acceptance_test.py <a real repo> --model qwen2.5-coder:1.5b --limit 15` (and ideally the `3b` variant too) to make the actual v0 pass/fail call. If it fails the 8/10-15 bar, the spec says the fix is prompt/schema iteration or model-size reconsideration (sessions 6-7), not pulling scope forward from post-MVP.
- If the acceptance test surfaces wrong-context explanations that trace back to `_find_def_tag`'s nearest-line-by-name matching rather than a prompt/model quality issue (flagged as a risk in Session 5's handoff), that's worth distinguishing before concluding the model/prompt needs work.
