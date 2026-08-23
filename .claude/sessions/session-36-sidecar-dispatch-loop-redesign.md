# Session 36: Sidecar RPC dispatch-loop redesign, part 1

**Date:** 2026-08-22
**Build-order step(s) completed:** None -- targeted fix continuing session 26/29/32's carried-forward contention item, not a Core Build Order step.
**Status:** partial (part 1 complete and verified; part 2 measured and scoped, not implemented -- see below)

## Files touched
- [src/extension/sidecar/sidecarManager.ts](../../src/extension/sidecar/sidecarManager.ts) --
  `waitForInteractiveIdle()` now takes an optional `vscode.CancellationToken`, resolving early on
  cancellation via a new private `raceWithCancellation` helper -- consolidates logic that
  previously lived only in `BackgroundIndexManager`'s own `raceAgainstCancellation` wrapper, since
  a second and third caller now need the identical behavior. `heartbeatTick()`'s `status` ping now
  passes `'background'` priority instead of the implicit `'interactive'` default (found by this
  session's own RPC-call-site audit -- see "Decisions made").
- [src/extension/backgroundIndex.ts](../../src/extension/backgroundIndex.ts) -- simplified its call
  site to the now-token-aware `waitForInteractiveIdle(token)`; removed its now-redundant private
  `raceAgainstCancellation` method. Added a gate + `'background'` priority to the one-shot
  `list_ranked_functions` call at the top of `run()` (previously ungated and mislabeled
  `'interactive'` -- the audit's second finding).
- [src/extension/backgroundFlush.ts](../../src/extension/backgroundFlush.ts) --
  `BackgroundFlushManager.tick()`'s per-file loop: added `await sidecar.waitForInteractiveIdle(token)`
  (with a cancellation check + `break` immediately after) before each of: the `reindex_file` RPC
  (now `'background'` priority), the per-function `generateAndCache` call (now `'background'`), and
  the `flagStaleDependents` call (now `'background'`). This is the part 1 "must-have" the session
  was scoped around.
- [src/extension/gitHookReindex.ts](../../src/extension/gitHookReindex.ts) -- identical treatment to
  `backgroundFlush.ts`, in `GitHookReindexManager.processMarker()`.
- [src/extension/staleTracking.ts](../../src/extension/staleTracking.ts) -- `flagStaleDependents()`
  gained an optional `priority: RequestPriority = 'interactive'` param, threaded to its own
  `sidecar.request('index_file', ...)` call. Default preserves `saveReindex.ts`'s one pre-existing
  caller (a real user-triggered save, correctly untouched and still ungated).

No sidecar (Python) files touched; no prompt/schema/cache-key changes; no protocol change --
`sidecar/rpc_server.py`'s dispatch loop is byte-for-byte unmodified (confirmed by `code-reviewer`).

## Decisions made

### The three named loops were not the exhaustive set -- confirmed by audit, not assumed
An `Explore` agent inventoried every `sidecar.request(...)` call site in `src/extension/` (all 7
RPC methods: `status`, `index_file`, `generate_explanation`, `reindex_file`, `resolve_function`,
`list_ranked_functions`, `generate_file_summary`) and classified each as synchronous-to-user vs.
autonomous-background. It confirmed the two named managers (`BackgroundFlushManager`,
`GitHookReindexManager`) both fire `reindex_file` and `generate_explanation` (via
`generateAndCache`) and `index_file` (via `flagStaleDependents`) at implicit `'interactive'`
priority with zero gating -- but also surfaced two gaps the session brief didn't name:
`SidecarManager.heartbeatTick()`'s own `setInterval`-driven `status` ping (every 7s, no user
action behind it), and `BackgroundIndexManager`'s own one-shot `list_ranked_functions` call at the
top of `run()`, sent *before* the per-function loop's gate is ever reached. Both were folded into
this session's fix rather than left for a future audit to re-find, since they're the identical
mechanical pattern this session was already extending (mislabeled priority + no gate) and were
cheap, low-risk, one-line-shaped fixes once found.

### Consolidated `raceAgainstCancellation` into `SidecarManager.waitForInteractiveIdle(token?)`
Rather than duplicate session 32's private race-against-cancellation wrapper into
`BackgroundFlushManager` and `GitHookReindexManager` as a third and fourth copy, the cancellation-
aware waiting was moved into `SidecarManager` itself as an optional second parameter on
`waitForInteractiveIdle`. `BackgroundIndexManager`'s call site simplified from
`this.raceAgainstCancellation(sidecar.waitForInteractiveIdle(), token)` to
`sidecar.waitForInteractiveIdle(token)`; its own now-unused `raceAgainstCancellation` method was
deleted rather than kept as a backwards-compatibility shim. All production call sites (four, across
three files) now pass their own token; no bare no-token call site remains in production code,
though the parameter stays optional since `code-reviewer` confirmed the no-token path still
provably terminates on its own (bounded by request timeouts and the 300ms settle timer).

### No borrowable pattern from Aider/Continue.dev/Serena (Core Rule 3 check, before extending further)
Per Core Rule 3 ("borrow, don't rebuild"), a `repo-researcher` pass checked whether any of the three
projects this codebase already borrows from has an established interactive-vs-background request
prioritization pattern worth adapting before continuing to build the client-side gate further.
Result: none does. Continue.dev has a `PauseToken`/`yieldUpdateAndPause()` primitive in its indexer,
but it's a manual, externally-toggled pause, not an automatic interactivity-aware scheduler --
adapting it would mean building the "when to pause" policy from scratch, not borrowing one. Aider
isn't a concurrent-server architecture (no persistent process fielding concurrent requests) and
Serena/the base LSP spec has no request-priority concept either (LSP servers that want this,
e.g. gopls, implement their own internal debouncing/cancellation, not something Serena's wrapper
provides). This confirms the client-side gate approach (already independently designed in session
32) isn't skipping over an established pattern, and that a future dispatch-loop redesign (part 2)
would also be designing from scratch, not adapting borrowed code -- worth knowing going in, since
Core Rule 3 would otherwise be a reason to pause and look harder first.

### Part 2 live measurement: gate confirmed generically correct, floor confirmed still real
A live reproduction against real pokerogue (6,633 functions indexed) + real Ollama
(`qwen2.5-coder:1.5b`), driven by the **real compiled** `out/extension/sidecar/sidecarManager.js`
(this session's actual fix) via the same `vscode.js`-shim-under-plain-Node technique sessions 29/32
used, ran one scenario against three distinct real functions from `src/utils/color-utils.ts`:
background request A sent, interactive request B sent 250ms later (session 29/32's exact shape),
then -- the instant B was sent, not waiting for either to resolve -- a call to the bare
`sidecar.waitForInteractiveIdle()` mechanism itself (the same call `BackgroundFlushManager`/
`GitHookReindexManager` now make), gating a second background request A2.

| Measurement | Result |
|---|---|
| B resolved relative to A resolved | **+2,742ms** (B's own 4,131ms round trip = ~1,389ms queued behind A server-side + B's own processing time) |
| A2 sent relative to B resolved | **+302ms** |

The **+302ms** result matches session 32's own **+300ms** finding almost exactly, despite testing
the mechanism generically (via a bare `waitForInteractiveIdle()` call, not through
`BackgroundIndexManager`'s specific loop) -- strong confirmation that the shared mechanism now
generalizes correctly to `BackgroundFlushManager`/`GitHookReindexManager`'s new call sites, not
just re-testing what session 32 already proved for one manager.

The **+2,742ms** result reconfirms, with a fresh live number against the fully-gated code, what
session 32's own artifact already stated architecturally: an interactive request arriving while a
background request is *already in flight* still queues behind it, because nothing client-side can
preempt a request the sidecar has already started processing (Core Rule 11). This run's magnitude
(~1.4s of pure added queueing delay) is smaller than sessions 29/32's own 8-9+ second examples only
because these three functions were small and this session's driver used a smaller/faster model
(`qwen2.5-coder:1.5b`) than some prior runs -- the mechanism, and its worst-case bound
(`GENERATE_TIMEOUT_MS` = 120s, per session 26's own constant), are unchanged. Defining "acceptable"
concretely *before* measuring (per the session brief): under ~1 second of added interactive latency
when a background RPC is already in-flight. This run's ~1.4s already exceeds that bar on a fast
case; the documented worst case (up to ~120s) is nowhere close. **Conclusion: client-side gating,
now comprehensive across all four autonomous background/housekeeping callers, is not sufficient on
its own -- a dispatch-loop-level fix is a real, still-open need**, not a hypothetical.

### Part 2 scope decision: measure and design, don't implement this session
Per Core Rule 8 and the session brief's own explicit allowance ("if part 1's measurement shows
[scope is large], it's fine to close this session with part 1 done and part 2 fully scoped as its
own follow-up"), a dispatch-loop-level fix was not attempted this session. `sidecar/rpc_server.py`'s
actual I/O architecture (sync vs. already-async, how `_process_lines` reads off the socket) needs
fresh, focused reading to design safely -- this session's own scope was already large (five files,
a full RPC-call-site audit, a cross-project pattern search, and a live measurement), and Core Rule
11 is load-bearing enough elsewhere in the codebase (the heartbeat-skip logic, every
`DELAY_BETWEEN_GENERATIONS_MS` comment) that changing the dispatch loop's actual concurrency model
deserves a dedicated session with room for careful design review and test coverage, not a rushed
addition at the end of an already-large one. See "Handoff" for the two concrete design directions
sketched for that session.

## Deviations from spec
None. `priority` remains a purely client-side scheduling hint (confirmed again by `code-reviewer`:
never appears inside any RPC's `params` object, never reaches `computeCacheKey` -- no Core Rule
5/9/10 concern). `sidecar/rpc_server.py` is byte-for-byte untouched.

## Test status
- `npx tsc -p . --noEmit`: clean.
- `npm run test:unit`: 45/45 passing.
- `npm run test:integration`: 22/22 passing (a `test-runner` pass noted the previously-documented
  `roleCodeLensAutoRefresh.test.ts` flake from sessions 29/32 did not reproduce this run --
  unrelated to this session's changes, not investigated further).
- `python -m pytest sidecar/tests/ -q`: 113/113 passing (no Python files touched).
- `code-reviewer` pass (scoped to the 5 changed files): **no Core Rule violations.** Confirmed
  `sidecar/rpc_server.py` untouched, no new RPC method added, every `break`/`continue` around the
  new gate calls breaks the correct loop (traced in both dual-loop files), `waitForInteractiveIdle`
  cannot hang or throw under a pre-canceled token, a racing `dispose()`, or (currently unexercised
  in production) no token at all, the `undefined`-timeoutMs pattern correctly falls through to
  `REQUEST_TIMEOUT_MS`, and priority never leaks into the cache key or the RPC wire format. One
  **ambiguous, not a violation** note: the three autonomous background loops are now each gated
  against interactive traffic but not against *each other* -- two of them could both clear their
  independent 300ms grace windows at nearly the same moment (with no interactive request pending)
  and then fire their own RPCs back-to-back. Confirmed pre-existing in shape (`BackgroundIndexManager`
  and `BackgroundFlushManager` could already race this way before this session, since neither
  gated against the other), not a regression this session introduced, and not a Core Rule 11
  concern (the rule protects interactive traffic specifically, which this still does correctly) --
  flagged as a background-vs-background efficiency question, not correctness. Not fixed this
  session; see "Handoff".
- Live pokerogue reproduction: see "Decisions made" above for the full methodology and numbers.

## Blockers / open questions
None blocking this session's own scope (part 1). Part 2's scope is real and open -- see "Handoff".

## Handoff for next session
- **Part 2: design and implement a dispatch-loop-level fix in `sidecar/rpc_server.py`.** This
  session's live measurement confirmed client-side gating (now comprehensive) cannot fix the
  "already in-flight" collision floor. Two directions were sketched, neither implemented or
  further researched this session (no borrowable pattern exists per this session's own
  Aider/Continue.dev/Serena check -- this would be designed from scratch):
  1. **Checkpointed/preemptible dispatch**: restructure `_process_lines`/the `generate_explanation`
     handler to check, between natural sub-steps (e.g. between the two sequential Ollama calls
     `sidecar/generation/` makes, or between streamed-token chunks if Ollama's streaming API is
     used), whether an interactive-priority request has arrived on the socket, and interleave it
     ahead of continuing the in-flight background work. Needs fresh reading of `rpc_server.py`'s
     actual I/O loop (sync socket read vs. already-async) to know how invasive this is -- not
     determined this session.
  2. **Separate priority channels**: two socket connections (or two accepted connections) between
     the extension host and the sidecar, one for interactive traffic and one for background, with
     the sidecar's dispatch loop gaining genuine (likely `asyncio`-based) concurrency to service
     both. Larger change -- would need to also confirm Ollama itself can usefully serve two
     concurrent generation calls on typical dev hardware rather than just serializing at that
     layer anyway (not measured this session).
  Recommend starting with a fresh read of `sidecar/rpc_server.py`'s actual current I/O architecture
  before choosing between these, since that determines how invasive option 1 really is.
- **Background-vs-background thundering-herd** (code-reviewer's ambiguous note): the three
  autonomous loops (`BackgroundIndexManager`, `BackgroundFlushManager`, `GitHookReindexManager`)
  now each defer correctly to interactive traffic but not to each other -- confirmed pre-existing
  in shape, not a regression, and not a Core Rule 11 violation (interactive traffic is still
  correctly protected), but worth a future session's measurement if background-on-background
  queuing latency ever turns out to matter in practice (per session 33's own "measure, don't
  assume" precedent). Not investigated further here.
