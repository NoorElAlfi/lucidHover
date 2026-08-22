# Session 32: Sidecar request-contention fix

**Date:** 2026-08-22
**Build-order step(s) completed:** None -- targeted bug fix (session 26's Handoff item 4 / session 29's re-confirmation), not a Core Build Order step.
**Status:** complete

## Files touched
- [src/extension/sidecar/sidecarManager.ts](../../src/extension/sidecar/sidecarManager.ts) --
  added `RequestPriority` (`'interactive' | 'background'`), threaded through `request()`
  (defaults to `'interactive'`, so every pre-existing call site is unaffected). Pending requests
  now track their priority. Added `hasInteractivePending()`, `notifyIfIdle()` (called from every
  code path that removes an entry from `pendingRequests`: `handleMessage`, the request-timeout
  callback, the socket-write-error callback, and `teardown()`'s reject-all), and a new public
  `waitForInteractiveIdle()` -- resolves once no interactive request is pending and a 300ms
  settle window (`INTERACTIVE_GRACE_MS`) has also passed clean, re-looping if something
  interactive arrives during the settle window. Purely local/in-memory bookkeeping; issues no
  RPC of its own.
- [src/extension/generation.ts](../../src/extension/generation.ts) -- `generateAndCache()` takes
  an optional `priority: RequestPriority = 'interactive'` param, threaded through to
  `sidecar.request(...)`.
- [src/extension/backgroundIndex.ts](../../src/extension/backgroundIndex.ts) --
  `BackgroundIndexManager`'s per-function loop now awaits `sidecar.waitForInteractiveIdle()`
  (raced against the loop's own cancellation token via a new `raceAgainstCancellation()` helper)
  immediately before each `generateAndCache(sidecar, cache, resolved, 'background')` call, and
  re-checks `token.isCancellationRequested` right after.

No sidecar (Python) files touched; no prompt/schema/cache-key changes; no protocol change --
`sidecar/rpc_server.py`'s dispatch loop is byte-for-byte unmodified.

## Decisions made

### Dispatch mechanics, confirmed by reading, not assumed
`rpc_server.py`'s `_process_lines` dispatches one buffered line fully (`_dispatch` -> handler ->
`send_line`) before ever reading more bytes off the pipe/socket -- pure arrival-order FIFO at the
byte-stream level, no batching. An interactive request queued behind a background one waits for
exactly **one** in-flight `generate_explanation` call to finish (case (a) from the session brief),
not a whole batch -- confirmed against session 29's own numbers: request B resolved exactly
8,695ms after request A finished, and B's own processing duration (36,380 - 27,685 = 8,695ms)
accounts for that gap precisely, with no extra unexplained delay. `SidecarManager.request()` had
zero client-side queueing -- every caller wrote straight to the socket the moment it was called.

**The startup embedding pass (session 11/31) is not an RPC-dispatch contention source at all** --
`_embed_repo_in_background` (rpc_server.py `main()`) runs on its own Python thread, calling Ollama
directly via HTTP, entirely outside the `_process_lines` request loop. This was worth confirming
explicitly since the session brief named it alongside background indexing as a suspect; it isn't
one. The only real contention source is `BackgroundIndexManager`'s own `generate_explanation`
loop (and, unaddressed this session, `BackgroundFlushManager`/`gitHookReindex.ts` -- see Handoff).

### Chosen fix: client-side priority gate before each background request, not preemption
Per the session's hard constraint, no change to make dispatch concurrent was considered. Of
session 26's three sketched options, this is a version of option 1+2 combined: a background
caller checks (and, unlike either option alone, actively *waits on*) interactive activity
immediately before sending its next request, rather than firing on a fixed timer regardless.
This **cannot** prevent the exact collision session 29 measured (interactive B arriving 250ms
after background A was already sent and being processed server-side -- once sent, a request
cannot be preempted, per Core Rule 11). What it prevents is a background loop compounding that
collision by continuing to fire new requests every ~1s with zero regard for interactive activity
still in flight -- verified this was a real, live behavior, not a hypothetical (see Verification).

A 300ms settle window after interactive activity clears (`INTERACTIVE_GRACE_MS`) was added on top
of the bare idle check: without it, a background request could start in the same instant an
interactive request is about to be issued (e.g. dispatched from VS Code a few ms before the check
ran), recreating the exact near-simultaneous-arrival shape session 29 measured. 300ms was chosen
to match the magnitude of `roleGutterDecorations.ts`'s existing `CHANGE_REFRESH_DEBOUNCE_MS`
precedent (session 26) -- a "just settled" window, not a scientifically derived value; it's cheap
relative to a ~10-20s generation cycle either way.

### Scope: `BackgroundIndexManager` only, not `BackgroundFlushManager`/`gitHookReindex.ts`
Both of the latter share an identically-shaped `DELAY_BETWEEN_GENERATIONS_MS` loop with the same
guarding comment already citing this exact contention risk. They were deliberately left
ungated this session: the session brief's own investigation list named `sidecarManager.ts`, the
hover cache-miss path, `BackgroundIndexManager`, `SaveReindexManager`, and the startup embedding
pass specifically, and Core Rule 8 says not to pull forward adjacent work not asked for. Flagged
as a concretely-scoped follow-up in Handoff rather than bundled in here, since it's the same
mechanism and would be a same-shape, low-risk addition for a future session.

### Two code-reviewer findings fixed mid-session
1. **Shared-timer race (real bug, not a rule violation):** the first implementation had
   `waitForInteractiveIdle()`'s 300ms grace wait reuse the private `sleep()` helper, which stores
   its timer/resolve callback in the single-slot `restartRetryTimer`/`restartRetrySignal` fields
   built for `runRecoveryLoop`'s backoff wait. Since a crash-triggered restart backoff and a
   background-indexing grace wait can legitimately be in flight at the same time, whichever called
   `sleep()` second would silently steal the other's timer slot out from under
   `cancelPendingRetry()` -- e.g. a manual "Restart Sidecar" meant to skip an in-progress backoff
   could instead just wake an unrelated grace window early while the real backoff ran its full
   course. Fixed by giving the grace wait its own independent `setTimeout`/`Promise`, touching
   none of the restart-backoff state.
2. **Non-cancellable wait (real responsiveness regression):** `BackgroundIndexManager`'s new
   `await sidecar.waitForInteractiveIdle()` had no way to be interrupted by the loop's own
   cancellation token, unlike the existing `delay()` helper two lines below it in the same file.
   Under a steady stream of interactive activity -- exactly the scenario this session targets --
   the wait could block for an extended, unbounded stretch during which "Cancel Background
   Indexing" would silently do nothing. Fixed with a new `raceAgainstCancellation()` helper
   (same "resolve early on cancel" shape as `delay()`, for a caller-supplied promise instead of a
   fixed timer) and the loop now awaits that instead of the bare promise.

Both fixes were re-verified: `tsc --noEmit` clean, `test:unit` 45/45, and the real-repo
measurement (below) re-run against the fixed code with materially identical results.

## Deviations from spec
None. `priority` is a purely client-side scheduling hint -- never sent to the sidecar, never part
of the cache key or generated output (no Core Rule 4/5/10 concern).

## Test status
- `npx tsc -p . --noEmit`: clean.
- `python -m pytest sidecar/tests/ -q`: 107/107 passing (no sidecar files touched this session).
- `npm run test:unit`: 45/45 passing.
- `npm run test:integration`: 19 passing, 1 failing. The one failure
  (`roleCodeLensAutoRefresh.test.ts`, "adding a function is reflected by
  `vscode.executeCodeLensProvider` with no `provider.refresh()` call" -- expects 1 lens for
  `alpha()`, gets 2) is the **same pre-existing, unrelated failure session 29's own artifact
  already documented** (first seen there, not introduced by this session -- confirmed again here
  since this session's changes touch none of the CodeLens files).
- `test-runner` pass: confirms all of the above; no new failures introduced.
- `code-reviewer` pass: no Core Rule violations (confirmed `rpc_server.py`, `backgroundFlush.ts`,
  `gitHookReindex.ts` all byte-for-byte untouched). Two real bugs found and fixed (see "Decisions
  made"); async-waiter mechanism otherwise confirmed correct (no missed-wakeup races, `dispose()`
  correctly unblocks any parked `waitForInteractiveIdle()` caller rather than hanging).

### Real-repo verification (live, against pokerogue + real Ollama, run twice)
Session 29 couldn't drive the real `SidecarManager`/`BackgroundIndexManager` TS classes outside
VS Code (they import `vscode`) and fell back to a standalone protocol-level script. This session
found a lighter option: a minimal `vscode.js` shim (implements only what `SidecarManager` actually
touches -- `window.createStatusBarItem`/`showErrorMessage`, `StatusBarAlignment`, `ThemeColor`,
`commands`) loaded via `NODE_PATH`, letting the **real compiled** `out/extension/sidecar/
sidecarManager.js` (this session's actual fix) run under plain Node against a real sidecar process
and real pokerogue, with a driver script reproducing `BackgroundIndexManager`'s exact loop shape
(script and shim kept in the session scratchpad, not committed, same precedent as session 29's own
script).

Two back-to-back scenarios, same live sidecar connection, six distinct real functions from
pokerogue's `src/utils/color-utils.ts` (one per request, so no two calls share context):

- **OLD-shaped** (no gating -- reproduces pre-session-32 behavior): background request A1 sent,
  interactive request B sent 250ms later (session 29's exact shape), then a second background
  request A2 fired unconditionally ~1s after A1 resolved, with zero regard for B.
- **NEW-shaped** (this session's fix): identical shape, but the second background request A2'
  is preceded by a real `await sidecar.waitForInteractiveIdle()` call.

Run 1 (pre-code-review-fixes) and run 2 (post-fixes, after `npm run compile`) both against real
pokerogue (6,633 functions indexed, ~4-6s), real `qwen2.5-coder:1.5b` generation calls
(~8-24s each):

| | Run 1 | Run 2 |
|---|---|---|
| OLD: A2 sent relative to B's resolution | **-9,004ms** (sent while B still pending) | **-9,053ms** (sent while B still pending) |
| NEW: A2' sent relative to B''s resolution | **+308ms** (sent only after B' resolved) | **+303ms** (sent only after B' resolved) |

Both runs land within a few ms of each other and match the design exactly: NEW's gap is always
~300ms (the grace window) after interactive resolution, never negative. This is a direct, live
demonstration that the previously-uncoordinated background loop (OLD) really did fire a new
request nine full seconds before a pending interactive request had even resolved -- and that the
fix (NEW) reliably holds the next background request back until interactive work has fully
drained. Background indexing itself was unaffected in both runs: pokerogue indexed correctly
(6,633 functions, matching session 29's count) and the startup embedding-pass thread started
normally in both runs.

**What this does not, and cannot, change** (architectural, not a gap in this session's work): the
very first collision -- an interactive request arriving while a background request is *already*
in flight -- is unchanged, because nothing can preempt a request the sidecar has already started
processing (Core Rule 11). The fix narrows *how often* that collision's effects compound (a
background loop can no longer pile a second, third, etc. request on top while interactive work is
draining), not the floor duration of a single unlucky first collision.

## Blockers / open questions
None.

## Handoff for next session
- **`BackgroundFlushManager` (backgroundFlush.ts) and `gitHookReindex.ts`** have the identical
  `DELAY_BETWEEN_GENERATIONS_MS` loop shape and the same contention exposure as
  `BackgroundIndexManager` had before this session, but were left ungated (out of this session's
  named scope). Applying the same `sidecar.waitForInteractiveIdle()` gate (with the same
  cancellation-race pattern this session added) to both would be a small, low-risk, same-shape
  follow-up.
- **The indexing/caching algorithmic-efficiency audit** (deferred from before this session per
  explicit sequencing) is next up.
