# Session 39: SQLite explanation-cache eviction policy

**Date:** 2026-08-23
**Build-order step(s) completed:** None -- fix session (session 33's carried-forward space-complexity
finding: the SQLite explanation cache had no eviction), not a Core Build Order step.
**Status:** complete

## Files touched
- [src/extension/cache/explanationCache.ts](../../src/extension/cache/explanationCache.ts) --
  `write(row, evictSuperseded = true)` now looks up the current row for the new row's
  `(fn_id, model_id, embedding_model_id, prompt_version)` tuple via the existing
  `currentRowForFnIdStmt` (session 13), writes the new row, then deletes the previous row only if
  it was found and its `cache_key` differs from the new row's. New `purgeSupersededRows()` method
  runs a full-table sweep (`ROW_NUMBER() OVER (PARTITION BY fn_id, model_id, embedding_model_id,
  prompt_version ORDER BY generated_at DESC, rowid DESC)`, keep rank 1, delete the rest) for the
  manual path. Both `currentRowForFnIdStmt` and the new sweep query use an explicit
  `, rowid DESC` tiebreaker (added after a code-review finding -- see "Decisions made").
- [src/extension/cache/config.ts](../../src/extension/cache/config.ts) -- new
  `resolveAutoEvictSupersededCache()`, reads `lucidHover.autoEvictSupersededCache` (default
  `true`), same resolve-fresh-per-call pattern as `resolveModelId()`.
- [src/extension/generation.ts](../../src/extension/generation.ts) --
  `generateAndCache`'s `cache.write(row)` call now passes `resolveAutoEvictSupersededCache()`.
- [src/extension/summaryDocGenerator.ts](../../src/extension/summaryDocGenerator.ts) -- same, for
  its independent `cache.write(row)` call site.
- [src/extension/purgeSupersededCacheCommand.ts](../../src/extension/purgeSupersededCacheCommand.ts)
  (new) -- `lucidhover.purgeSupersededCache` command, runs `purgeSupersededRows()`, reports the
  count via a status-bar message.
- [src/extension/extension.ts](../../src/extension/extension.ts) -- registers the new command.
- [package.json](../../package.json) -- new `contributes.commands` entry ("LucidHover: Purge
  Superseded Cache Rows") and `contributes.configuration` entry (`lucidHover.autoEvictSupersededCache`,
  boolean, default `true`).
- [src/extension/__tests__/unit/explanationCache.test.ts](../../src/extension/__tests__/unit/explanationCache.test.ts)
  -- 11 new tests: basic eviction, upsert-safety (never deletes the row `write()` itself just
  wrote), no cross-`fn_id` deletion, no cross-tuple deletion on a `prompt_version`/model/embedding
  bump, the `evictSuperseded=false` toggle, the never-delete-a-live-row invariant after an evicting
  write, `purgeSupersededRows` collapsing accumulated rows / no-op on a clean cache / correctness
  across interleaved `fn_id`s, the `generated_at`-tie/rowid-tiebreaker regression case, and the
  required 2-PROMPT_VERSION-bump simulation.

No sidecar (Python) files touched -- Core Rule 9 compliance confirmed both by design (eviction logic
lives entirely in `explanationCache.ts`) and by an independent `code-reviewer` pass (see "Test status").

## Decisions made

### Policy chosen: automatic narrow (session prompt's option (a)), plus a manual-only toggle
Put to the user via `AskUserQuestion` with four concrete options (narrow-automatic, broad-automatic,
manual-only, passive-cap-only) per the session prompt's explicit requirement not to guess. The first
answer came back as a dismissal ("wait for next instruction"); the user's actual answer, given
separately, was **"automatic narrow, but allow for manual deletion only toggle."** Interpreted and
built as: option (a)'s narrow definition of "superseded" (same `fn_id` + `model_id` +
`embedding_model_id` + `prompt_version` tuple, an old row provably replaced by a fresher one for that
exact identity) stays the *only* definition used anywhere in this feature -- both the automatic path
in `write()` and the manual `purgeSupersededRows()` sweep apply it identically. The toggle
(`lucidHover.autoEvictSupersededCache`) controls *when* that policy runs (on every regenerating write,
vs. only when the user explicitly runs "Purge Superseded Cache Rows"), not *which* rows count as
superseded -- deliberately not building option (b)'s broader cross-tuple cleanup, since the user asked
for narrow with a toggle, not narrow-vs-broad.

Direct consequence, documented in the setting's own description and in the purge command's doc
comment: a `PROMPT_VERSION`/model/embedding-model bump is **never** cleaned up by either the
automatic path or the manual command, on or off. This matches option (a)'s explicitly stated
limitation and is confirmed by the "2 PROMPT_VERSION bumps" test (see "Test status") -- it is the
policy working as chosen, not a gap accidentally left in.

### write() ordering: lookup-before-insert, delete-after-insert
`write()` looks up the tuple's current row *before* inserting the new one, but only deletes it
*after* the insert succeeds, and only if the looked-up row's `cache_key` differs from the new row's.
This means a row is only ever deleted once a successful replacement for it is already durably on
disk, and the same-`cache_key` upsert case (a hash-identical rewrite) is structurally incapable of
deleting the row that was just written. `code-reviewer` confirmed this ordering is race-free (better-
sqlite3 calls are synchronous, no interleaving window exists) and correctly scoped (no cross-`fn_id`,
no cross-tuple deletion).

### rowid tiebreaker added after a real code-review finding
`code-reviewer`'s pass (see "Test status") flagged that `currentRowForFnIdStmt`'s
`ORDER BY generated_at DESC LIMIT 1` and `purgeSupersededStmt`'s differently-shaped window-function
query both sort on `generated_at` -- a caller-supplied ISO string, not guaranteed unique -- with no
explicit tiebreaker. A tie (reachable via `evictSuperseded=false` stacking same-timestamp rows, or a
genuine same-millisecond race) could let the two statements disagree about which row is "current,"
so the purge sweep could in principle delete the exact row `getCurrentRowForFnId()` had just reported
as live. Fixed by adding `, rowid DESC` to both statements' `ORDER BY`, making "most recently
inserted wins" the shared, deterministic tiebreaker for both -- confirmed correct by a new regression
test (`agrees with purgeSupersededRows on which row is current even when generated_at ties`).

## Deviations from spec
None. This is a fix session addressing session 33's carried-forward finding, not spec-governed
build-order work.

## Test status
- `npx tsc -p ./ --noEmit`: clean.
- `npm run test:unit`: **56 passing** (was 45 at session start; +11 new tests in
  `explanationCache.test.ts`, 0 removed, 0 modified elsewhere).
- `code-reviewer` pass (scoped to this session's 7-file diff, explicit focus on Core Rule 9 and the
  "never delete a live row" property, per the session prompt's own instruction): **no Core Rule
  violations** -- confirmed no `sidecar/` files touched, all eviction logic extension-host-only.
  Confirmed `evictSuperseded` reaches both production `.write()` call sites (grepped all `.write(`
  sites project-wide) with no call site left un-gated. Confirmed `write()`'s ordering is race-free
  and correctly scoped. One real finding (the `generated_at`-tie/tiebreaker gap above) -- fixed this
  session, with a new regression test, not deferred.
- No sidecar/Python tests run or needed -- no `sidecar/` files touched this session.
- Not run this session: the VS Code integration test suite (`suite/`, requires a real sidecar +
  Ollama per session 37's precedent) -- the two production call sites' wiring
  (`generateAndCache`/`summaryDocGenerator`) is a one-line pass-through of
  `resolveAutoEvictSupersededCache()` into an already-unit-tested `write()`, matching the existing,
  also-integration-untested `resolveModelId()` call-site pattern -- judged sufficient coverage via
  unit tests plus the code-reviewer grep-confirmed completeness check, not worth spinning up a live
  sidecar for a single-line wiring change.

## Blockers / open questions
None.

## Handoff for next session
- The chosen policy (narrow, automatic-or-manual) by design never cleans up rows orphaned by a
  `PROMPT_VERSION`/model/embedding-model bump -- confirmed and documented, not a bug. If this
  actually becomes a real problem at some future point (this project has already had 4 real
  `PROMPT_VERSION` bumps across sessions 6-19), a follow-up session would need to go back to the
  user for a broader policy (option (b) from this session's own question, or a dedicated
  bump-triggered purge), not assume broader cleanup is now wanted.
- `lucidHover.autoEvictSupersededCache` and the "LucidHover: Purge Superseded Cache Rows" command are
  both new user-facing surface -- no manual smoke test of the command through the actual VS Code UI
  was performed this session (only unit-level `ExplanationCache` testing and a static code-review of
  the command/config wiring). If a future session touches this area again, a real manual run of the
  command from the Command Palette against a populated cache DB would close that gap.
