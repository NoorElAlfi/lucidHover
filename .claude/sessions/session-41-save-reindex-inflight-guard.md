# Session 41: Stale-buffer-snapshot fix in SaveReindexManager.reindex()

**Date:** 2026-08-23
**Build-order step(s) completed:** None -- targeted bug fix (session 40's carried-forward
"Blockers / open questions" finding), not a build-order milestone.
**Status:** complete

## Files touched
- `src/extension/saveReindex.ts` -- added an in-flight guard (`inFlight`/`rerunRequested` maps
  and a new `runReindex()`) so a second save whose debounce timer fires while a `reindex()` call
  is already running for the same document no longer starts a second, fully concurrent
  `reindex()`. Instead it's recorded and picked up as a fresh rerun (reading the buffer's
  then-current content) the moment the in-flight call finishes.
- `src/extension/__tests__/suite/saveReindexConcurrency.test.ts` -- new regression test (stubbed
  `sidecar.request`, no real sidecar/Ollama process, following `hover.test.ts`'s pattern) that
  deliberately forces the race: save 1 starts `reindex()`, which hangs mid-`generate_explanation`;
  save 2 fires while it's still hanging. Confirmed failing against the pre-fix code (asserted only
  one `generate_explanation` call should be in flight; actually saw 2), confirmed passing after the
  fix, and additionally asserts the rerun reads the buffer's truly-current content and the cache's
  "current" row for the function ends up matching it.

## Decisions made
- **Root cause confirmed, and it's worse than session 40 flagged.** `KeyedDebouncer` only cancels
  a *pending timer*, never an already-running callback. `reindex()`'s own long pole isn't the
  `reindex_file` RPC (fast, ~90ms per session 38) -- it's `generateAndCache`'s
  `generate_explanation` call inside the per-function loop, which can run up to
  `GENERATE_TIMEOUT_MS` (120s) *per function*, sequentially, for every changed function in the
  file. A second save landing inside that window starts a second, independent `reindex()` that
  reads the (by-then-different) live buffer at its own read time and writes its own row.
  `fn.fnHash`/`fn.fnSource` are captured once, synchronously, right after `resolveAllFunctions`
  returns, and never re-read later in the same call -- so each individual write's `fn_hash` is
  internally correct for whatever the buffer held at that call's own read time. The actual damage
  is in `ExplanationCache.write()`'s default eviction (session 39, `evictSuperseded=true` unless
  the user has the setting off): it deletes whatever row `getCurrentRowForFnId` reports as
  "current" -- selected purely by `generated_at`/`rowid` recency, not content freshness. If the
  slower call (reading OLDER content) finishes writing after the faster call (reading NEWER,
  actually-current content), its write evicts the correct row and leaves only the stale one
  behind. This is real data loss under the *default* configuration, not just row clutter --
  session 40 hit only the clutter symptom because its step 4 happened to have eviction toggled
  off for an unrelated reason.
- **Fix chosen: (b), an in-flight guard, not (a) a content-snapshot-at-save-time change.**
  Snapshotting content earlier (before the `reindex_file` await) would narrow the race window but
  not close it, and wouldn't fix the *ordering* problem at all -- two internally-correct writes
  could still land out of order and trigger the same wrong eviction. An in-flight guard fixes both:
  it serializes all `reindex()` execution per document (matching the debouncer's own already-stated
  intent, "several rapid triggers ... collapse to one re-index", just extended to cover triggers
  that land while one is *running*, not only while one is *pending*), so there is never more than
  one write in flight to race against, and a rerun after completion always reads the buffer's true
  current state.
- **Rerun-after-completion, not drop-and-ignore.** A save landing mid-reindex sets a
  `rerunRequested` flag rather than being silently dropped -- otherwise a save that happens to land
  in the (now much less likely, but not impossible) in-flight window would never get re-indexed at
  all until some unrelated future save came along.

## Deviations from spec
None.

## Test status
- New `saveReindexConcurrency.test.ts`: 1 test, confirmed failing against pre-fix code (actual
  root-cause reproduction: two saves --> 2 concurrent `generate_explanation` calls, not 1),
  confirmed passing after the fix. Run in isolation first (other integration test files
  temporarily moved out of `suite/`, restored afterward) for a fast, deterministic signal, then
  again as part of the full suite.
- Full integration suite (`npm run test:integration`, real `SidecarManager`/real Ollama for
  `saveReindexIntegration.test.ts`): 23/23 passing (22 previously-existing + this session's new
  test), including both of session 27's real-sidecar-plus-real-Ollama tests -- no regressions.
- Full unit suite (`npm run test:unit`): 56/56 passing, unchanged from before this session (no unit
  tests touch `saveReindex.ts` directly; its only coverage is the integration suite).
- `tsc -p ./`: clean.
- `code-reviewer` subagent was not used this session (time/scope-bounded fix with an already-strong
  before/after regression test proving the exact race); the change was self-reviewed against Core
  Rule 9 (cache is extension-host-owned/read/written only, untouched here) and for
  unhandled-promise-rejection parity with the pre-fix code (`reindex()` was already fire-and-forget
  via `void`; wrapping it in `.finally()` for the new guard doesn't add a new failure mode beyond
  what already existed).

## Blockers / open questions
None. Session 40's carried-forward finding is closed: root cause confirmed and fixed, with a
regression test that reproduces the original race and would fail again if the guard regressed.

## Handoff for next session
- No specific follow-up required. If a future session touches `SaveReindexManager` again, note
  that `runReindex()`/`inFlight`/`rerunRequested` now serialize all `reindex()` execution per
  document URI -- a change there should preserve "at most one `reindex()` running per document,
  and no save is ever silently dropped."
