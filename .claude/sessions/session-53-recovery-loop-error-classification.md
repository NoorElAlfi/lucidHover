# Session 53: Sidecar recovery-loop error classification

**Date:** 2026-08-25
**Build-order step(s) completed:** None (targeted fix, not a build-order milestone)
**Status:** complete

## Files touched
- `src/extension/sidecar/sidecarManager.ts` — new `RecoveryFailureCause` type (`'spawn-failed' | 'process-crashed' | 'slow-first-index' | 'unknown'`); new `classifyStartFailure()`/`failureCauseDescription()` methods; a new `child.on('error', ...)` listener in `start()` (previously unhandled — also closes a latent unhandled-`'error'`-event crash risk), guarded against a stale/superseded child the same way the pre-existing `exit` handler already is; `updateStatusBar()`'s tooltip and `notifyGaveUp()`'s toast now include the classified cause instead of a single generic message.
- `src/extension/__tests__/suite/sidecarManager.test.ts` — new `suite('recovery failure classification', ...)` with 3 focused tests (spawn-failed, process-crashed, slow-first-index) that drive each child-process state directly rather than through a full multi-attempt backoff cycle; 1 new end-to-end test confirming the give-up toast and status bar tooltip actually carry the specific message, not the generic one.
- `src/extension/__tests__/suite/fakes.ts` — added `signalCode: string | null` to `FakeChildProcess` (initialized `null`), matching real `ChildProcess`'s shape, needed for `classifyStartFailure()`'s exit-state check to behave correctly against the fake.

## Decisions made
- **Dropped the session brief's category (a)** ("connection-refused-shaped errors talking to Ollama") after tracing the actual architecture: `sidecar/rpc_server.py`'s `main()` runs `RepoMap.index()` (zero Ollama dependency — confirmed no `ollama` references anywhere in `sidecar/repomap/`) and only then opens the socket/pipe; the Ollama embedding pass (`_embed_repo_in_background`) runs on a daemon thread *started before* the socket opens and explicitly swallows `OllamaError` internally ("must never crash the sidecar or block generation"). There is no path from an unreachable Ollama into a `start()` rejection at all. Put to the user via `AskUserQuestion`; chose "drop (a), ship the real 2-way split" over inventing a heuristic for a cause that can't occur.
- **Classification reads child-process state, not the connect error.** `connectWithRetry`'s rejection is identical (repeated `ENOENT`) whether the child never spawned, crashed before listening, or is alive and just slow — the error's message/code can't distinguish these. `classifyStartFailure()` instead checks, in order: `lastSpawnError` (set by the new `'error'` listener) → `'spawn-failed'`; else `exitCode`/`signalCode`/`killed` non-null → `'process-crashed'`; else → `'slow-first-index'` (matches the real session-51 incident: a large repo whose synchronous first index outran the old connect-retry budget, not a crash).
- code-reviewer found one real bug before this was considered done: the new `'error'` listener had no identity guard against a stale/superseded child's straggler event silently overwriting `lastSpawnError` for whatever attempt was actually in flight — fixed with the same `this.childProcess !== child` check the pre-existing `exit` handler already uses two lines below it.

## Deviations from spec
- The brief's literal 3-way a/b/c split became a different 3-way split (`spawn-failed` / `process-crashed` / `slow-first-index`, plus a defensive `'unknown'` fallback) once (a) was confirmed architecturally impossible — see Decisions above.

## Test status
- Full suite green: 56 TS unit + 41 TS integration (was 37, +4) + 145 Python pytest.
- First test-runner pass caught 3 of the 4 new tests failing — a test-only bug (`failureCauseDescription()` reads the cached `lastFailureCause` field, which production only assigns inside `runRecoveryLoop`'s catch block; the new tests called `start()` directly and never assigned it). Fixed with a `classifyAndDescribe()` test helper that reproduces production's real sequencing. Re-verified green on a second full-suite pass.
- code-reviewer pass (separate from test-runner) independently traced the Ollama-impossibility claim against the real sidecar code and confirmed it; found the stale-listener bug described above, which was fixed and re-verified.

## Blockers / open questions
- None.

## Handoff for next session
- None specific. The `'unknown'` fallback in `classifyStartFailure()` is defensive and not currently exercised by any test (it requires `this.childProcess` to be null at classification time, which the code-reviewer traced as unreachable in practice — a disposed-race classification is computed but never surfaced). Not worth manufacturing a test for; noted here only so a future session doesn't mistake the gap for an oversight.
