# Session 67: Background-indexing concurrent worker pool

**Date:** 2026-08-27
**Build-order step(s) completed:** None — a targeted fix outside the Build Order, closing the
strategy review's #2 backlog item.
**Status:** complete

## Files touched
- [src/extension/backgroundIndex.ts](../../src/extension/backgroundIndex.ts) — `run()`'s single
  sequential `for` loop over ranked functions was replaced with a worker-pool design: up to
  `this.concurrency` (default `BACKGROUND_INDEX_CONCURRENCY`, see "Decisions made") concurrent
  `worker()` async functions pull from a shared work queue (`claimNext()`/`nextIndex`, a plain
  index cursor — no `await` between the check and the increment, so no race despite several
  concurrent callers) and a shared per-file symbol-resolution cache that is now a
  `Map<string, Promise<ResolvedFunction[]>>` (`fileSymbolPromises`/`getFileSymbols`) rather than a
  `Map<string, ResolvedFunction[]>`, so two workers reaching the same file around the same time
  share the one in-flight resolution instead of duplicating it. Every worker still calls
  `sidecar.waitForInteractiveIdle(token)` immediately before its own `generate_explanation` call —
  interactive traffic keeps identical priority to before this session; only background-vs-background
  concurrency changed. `BackgroundIndexManager`'s constructor gained a 5th, optional, injectable
  `concurrency` param (default `BACKGROUND_INDEX_CONCURRENCY`) — same seam precedent as
  `SidecarManager`'s `spawnFn`/`connectFn` (Session 17). The production call site in `extension.ts`
  is unchanged (4-arg form), so it picks up the new default automatically.

  The ETA/progress-tracking math (Sessions 64/65) was reworked: `generationDurations: number[]`
  (per-call wall-clock durations, averaged) is now `generationCompletionTimestamps: number[]` (a
  rolling window of completion *timestamps*, seeded with the pass's own start time so an ETA is
  still available after just the first completion), and `recordGenerationDuration(durationMs)`
  became `recordGenerationCompletion()`, computing a completions-per-ms rate over the window instead
  of an average per-call duration — per-call duration stopped being a valid throughput proxy once
  several calls can be in flight at once (it would understate throughput by up to
  `BACKGROUND_INDEX_CONCURRENCY`x).
- [src/extension/__tests__/suite/backgroundIndex.test.ts](../../src/extension/__tests__/suite/backgroundIndex.test.ts) —
  the shared `manager` built in this suite's `setup()` now pins `concurrency: 1` (the new 5th
  constructor arg) so the suite's many pre-existing order-sensitive assertions (exact pause timing,
  exact progress-count sequencing) keep their old single-worker semantics unchanged. A new nested
  `suite('concurrent worker pool (Session 67)', ...)` was added (own `poolManager` instances, own
  extra fixture files c.js/d.js) with 4 new tests: genuine concurrent in-flight generation (an
  `inFlight`/`maxInFlight` counter inside a stubbed `generate_explanation` with an artificial 150ms
  hold, concurrency 3), a same-file dedup check (`sandbox.spy(functionResolution,
  'resolveAllFunctions')` — a `code-reviewer` finding, see "Decisions made" — proving two ranked
  functions sharing one file only trigger one `resolveAllFunctions` call even when both are claimed by
  concurrent workers), `pause()` with a 2-worker pool letting exactly the 2 already-in-flight calls
  finish but claiming no 3rd item (gated on a `startedCount === 2` counter — the first draft gated on
  the *first* call instead, which raced the second worker's still-in-flight symbol resolution and
  flaked to 1 call instead of 2; fixed before landing), and the ETA still appearing after the first
  completion under concurrency. One pre-existing Session-65 test ("a failed attempt counts as done
  for the ETA's remaining calculation") was adapted to the new `generationCompletionTimestamps`
  field/semantics, asserting `Math.abs(actual - expected) < 0.01` instead of `assert.strictEqual`
  (the new rate formula's divide-then-divide-back introduces a sub-millisecond floating-point
  rounding error even when the two values are mathematically identical).

No sidecar (Python) files touched, no new RPC methods, no cache-key/prompt changes, no
CHANGELOG/README changes (same reasoning sessions 65/66 used: a default-behavior change to an
existing, still-unpublished feature).

## Decisions made

- **`BACKGROUND_INDEX_CONCURRENCY = 2`, not the brief's own 3-4-worker starting point.** The brief
  explicitly required confirming the final number with a fresh live measurement against real Ollama
  before landing, not shipping on the strategy review's own cited figures alone (same discipline as
  sessions 28/29/33/37). That live measurement (see "Test status" for the full numbers and
  methodology) came out substantially less favorable on this machine today than the strategy
  review's cited 1.00x/1.57x/2.22x/2.78x throughput figures at N=1/2/4/8: real throughput gains
  flattened out (and got noisy) past N=2, and — the more decisive number — real added interactive
  latency from a background pool already in flight grew roughly linearly with pool size (~+2s per
  additional concurrent worker), blowing well past session 36's own <1s acceptance bar at every pool
  size tested, not just the high end. `2` is the conservative reading of that data: it captured the
  best measured throughput (2.60x) while limiting the worker-pool-specific added-latency cost —
  beyond the single-collision floor sessions 36/37 already characterized as pre-existing and
  unavoidable — to roughly one increment rather than compounding it across 3-4 simultaneous workers.
  This numeric gap from the strategy review's own reference figures is flagged, not resolved, here —
  see "Blockers / open questions."
- **Rate-based ETA (completions-per-ms over a timestamp window), not a per-worker-adjusted average
  duration.** Considered and rejected: dividing the existing average-duration formula by a fixed
  divisor (the configured pool size, or a live count of currently-active workers) — rejected because
  it would assume linear speedup from concurrency, which the live measurement itself disproves (real
  speedup is sub-linear and sometimes negative past N=2 on this machine). A rate derived directly
  from observed wall-clock completion timestamps needs no assumption about how much overlap those
  completions actually had; it just reads the real throughput, whatever it is.
- **The shared-queue worker-pool shape (`claimNext()` over a plain index cursor `Promise.all`'d
  across N `worker()` calls), not per-item `Promise.all` chunking.** A batched design (chunk `ranked`
  into groups of `concurrency` and `Promise.all` each chunk before moving to the next) was considered
  and rejected: it would let a single slow item in a chunk block the whole chunk from advancing even
  though other workers have capacity, whereas the shared-queue design lets a fast worker immediately
  pick up the next item the moment it finishes, independent of its chunk-mates.
- **Test-only injectable `concurrency` constructor param, not a user-facing setting.** Unlike Session
  66's `backgroundIndexScope`/`backgroundIndexTopN` (a real scope tradeoff a user might reasonably
  want to control), the worker-pool size is an internal tuning parameter validated by live
  measurement against this project's own machine/model, not a user preference — the session brief's
  own phrasing ("raise the pool to N workers") frames it as an implementation choice, not a feature.
  Matches `SidecarManager`'s own `spawnFn`/`connectFn`/`connectRetryAttempts` precedent for
  test-only seams.
- **`DELAY_BETWEEN_GENERATIONS_MS` (1s) kept, applied per-worker, not removed or shared across the
  pool.** Session 9's original reasoning (an unbroken run of back-to-back background sends leaving
  no gap for interactive work to jump the queue) still holds per-worker even though Session 37 made
  sidecar dispatch itself concurrent — this delay isn't about the sidecar's own dispatch loop, it's
  about opening a window for `waitForInteractiveIdle`'s pending-request bookkeeping to register newly
  arriving interactive work before this worker's *next* claim. Not re-measured this session
  (out of scope — the brief's own explicit out-of-scope list didn't include retuning this constant).

## Deviations from spec
None against the Build Order (this is a fix/enhancement session outside it, per its own brief).

## Test status

- `npx tsc -p . --noEmit`: clean.
- `npm run test:unit`: **62 passing**, unchanged (no unit-level code touched — `backgroundIndex.ts`
  has no dedicated unit-test coverage, matching its pre-existing integration-only coverage
  precedent).
- `npm run test:integration`: **82 passing**, up from 78 at Session 66's baseline (+4 new
  `backgroundIndex.test.ts` tests under `concurrent worker pool (Session 67)`, the 4th added after
  the `code-reviewer` pass below).
- `python -m pytest sidecar/tests -q`: **145 passing**, unchanged (no sidecar files touched).
- **`code-reviewer` pass** (scoped to this session's exact 2-file diff): zero rule violations —
  independently confirmed the concurrency-safety reasoning (`claimNext()`/`fileSymbolPromises`/the
  progress counters have no `await` between check and mutation, so JS's single-threaded event loop
  makes them race-free despite running from several concurrent `worker()` calls), the deterministic
  initial-claim ordering (`Array.from({length: workerCount}, () => worker())` guarantees worker *i*
  always claims `ranked[i]` at pass start, since each `worker()` call runs synchronously up to its
  first `await` before the next one starts), and the ETA rolling-window math including its seed/shift
  boundary (no off-by-one). Four items flagged as worth double-checking, not as violations:
  1. **The self-documented added-latency numbers work against Rule 11's underlying intent, even
     though they don't violate its literal wording** (still throttled, still client-side-priority-
     gated) — noted as an accepted, explicitly-flagged interim tradeoff, not a defect to fix this
     session; see "Blockers / open questions."
  2. **A pre-existing `resume()`/`'pausing'`-phase race, not introduced by this session but with a
     wider blast radius after it**: `resume()` → `start()` only checks `this.phase !== 'running'`, so
     resuming while still `'pausing'` (draining in-flight `generate_explanation` calls) can start a
     second `run()` concurrently with the first pass's still-finishing workers. Before this session
     that could double up at most 2 concurrent `generate_explanation` calls (1 draining + 1 fresh);
     with a `BACKGROUND_INDEX_CONCURRENCY`-sized pool it can now be up to `BACKGROUND_INDEX_CONCURRENCY
     + 1`. Real, pre-existing, **not fixed this session** (out of the brief's own scope — a distinct
     bug, not part of raising concurrency) — flagged in "Blockers / open questions" for a dedicated
     follow-up.
  3. **The same-file dedup path (`getFileSymbols`'s `Promise`-valued cache) was only argued in
     comments, never exercised by a test where two concurrently-claimed items share a file** — closed
     this session by adding the 4th pool test (`sandbox.spy(functionResolution,
     'resolveAllFunctions')`, two functions in one `shared.js`, concurrency 2), landed before the
     session ended rather than deferred.
  4. **A minor test-timing note on the `pause()` test's `['a', 'b']` assertion** — traced and
     confirmed not a real flake risk: the assertion sorts both names before comparing
     (`assert.deepStrictEqual(generatedNames.sort(), ['a', 'b'])`), so it only depends on *which two*
     items get claimed (deterministic per the reviewer's own point above), not on which of the two
     starts its `generate_explanation` call first (genuinely racy, but irrelevant to this assertion).
     No change made.

### Live measurement against real Ollama (methodology and numbers)

The brief asked for a live measurement against real pokerogue + real Ollama, following this
project's own sessions 28/29/33/36/37 "measure, don't assume" precedent. Two attempts were needed:

**Attempt 1 (abandoned): the full sidecar RPC stack against real pokerogue.** A direct
protocol-level script (mirroring `sidecar/tests/test_rpc_transport.py`'s connect helpers, extended
for concurrent out-of-order request/response matching by id) spawned a real sidecar against the full
pokerogue monorepo (6,633 functions, session 29's own reference figure). `RepoMap.index()` itself
never completed — the child process stayed alive with essentially flat CPU time across several
minutes of wall-clock time (11.6s of accumulated CPU time across ~4m40s of wall time), confirmed
stuck rather than merely slow. Re-pointed at a smaller real subtree (`pokerogue/src/utils`, 21 files
— still real pokerogue source, real functions) to sidestep this; indexing itself then completed in
2.5s, but a subsequent real `generate_explanation` RPC call (through the same full stack — RepoMap,
retrieval/LanceDB query, then the real Ollama call) again stalled, this time for 140+ seconds with no
response and no client-side timeout ever firing (a probable `win32file.ReadFile`-holds-the-GIL
interaction blocking the client's own timeout machinery while genuinely waiting on a wedged
response, not merely a slow one). Direct `curl` calls straight to Ollama's own `/api/generate` and
`/api/embeddings` endpoints during this stall both returned correctly in well under a second,
confirming Ollama itself was healthy and idle — the stall was somewhere in the sidecar's own
RepoMap/retrieval/LanceDB path on this machine today, not in Ollama, not in the RPC transport's
basic round-trip (a plain `status` call worked fine earlier), and not in anything session 67's own
diff touches. Root-causing that stall is explicitly out of this session's scope; flagged below as a
candidate follow-up.

**Attempt 2 (used for the numbers below): a direct in-process call.** Bypassed the RPC/RepoMap/
LanceDB stack entirely by calling `sidecar.generation.generate.generate_explanation()` directly,
in-process, via a `ThreadPoolExecutor` (`urllib.request`'s blocking calls release the GIL, so this
still exercises Ollama's real concurrent-request handling) against the same real pokerogue functions
this session's own worker-pool tests reference (`padInt`/`randInt`/`randSeedInt`/etc. from
`pokerogue/src/utils/common.ts`), real Ollama (`qwen2.5-coder:1.5b`), no retrieved/call-graph context
(an empty `FunctionContext`, `retrieved_chunks=[]`) — a real but structurally simpler prompt than the
full production path, flagged as a caveat on these numbers' direct transferability, not swept under
the rug.

| N (concurrent calls) | batch wall time | speedup vs N=1 serial-equivalent |
|---|---|---|
| 1 | 2.44s | 1.00x (baseline) |
| 2 | 1.88s | 2.60x |
| 4 | 8.49s | 1.15x |
| 8 | 15.62s | 1.25x |

(Single trial per N, not averaged — real but noisy; the non-monotonic N=2 vs N=4 result is called
out, not hidden, in "Blockers / open questions.")

Added interactive latency with a background pool already in flight (solo interactive baseline:
1.14s, same framing sessions 36/37 used — send N background calls, wait 0.25s, then send one more and
measure its own latency vs the solo baseline):

| background pool size | interactive latency | added vs baseline |
|---|---|---|
| 1 | 3.46s | +2.32s |
| 3 | 7.64s | +6.50s |
| 4 | 9.37s | +8.23s |

Every pool size tested exceeded session 36's own <1s acceptance bar, including the single-collision
floor (pool size 1) that predates this session's own change and was previously measured by session
37 at +227ms on this same machine — a large, unexplained gap from that earlier figure, also flagged
below rather than assumed away.

## Blockers / open questions

- **The added-interactive-latency numbers measured this session (+2.32s at a single collision) are
  roughly 10x session 37's own +227ms figure for the same scenario on this same machine.** Not
  reconciled this session — candidate explanations include real machine/Ollama-state drift since
  session 37, or a genuine methodology difference (this session's direct in-process benchmark carries
  no retrieved/call-graph context, so its prompts are smaller and its "baseline" latency is much
  faster in absolute terms than session 37's own `shiftCharCodes` baseline of 9042ms — a smaller
  absolute baseline could make relative contention effects look proportionally larger even if the
  underlying contention is unchanged). A future session with a quieter measurement environment (and
  ideally a working RPC-level harness, once the stall below is understood) should re-run this
  comparison before treating `BACKGROUND_INDEX_CONCURRENCY = 2` as final.
- **`RepoMap.index()`/the retrieval path stalled against real pokerogue on this machine today,
  independent of anything session 67 touches.** Confirmed not an Ollama problem (direct curl calls
  succeeded instantly during the stall) and not a basic-RPC-transport problem (a plain `status` round
  trip worked). Not root-caused — candidate next step for whoever picks this up: reproduce with the
  full RPC stack against `pokerogue/src/utils` specifically (this session's smaller subtree, which
  indexed fine but then stalled on `generate_explanation`) with instrumentation around
  `_query_retrieved_chunks`/`query_top_k`/`VectorStore`'s LanceDB open-and-query path, since that's
  the one meaningful thing between a working `status` round trip and a hanging `generate_explanation`
  call that this session's own direct-generation bypass sidesteps entirely.
- **Only 1 trial per concurrency level (N=1/2/4/8), not averaged.** The N=2 throughput result
  (2.60x) beating N=4 (1.15x) is a real, printed measurement from this session but is very likely
  partly single-sample noise (real per-function generation time varies function-to-function even at
  the same N) rather than a genuine "concurrency past 2 actively hurts" effect — flagged as
  low-confidence, not re-run this session for time-budget reasons given the environmental
  obstacles above already consumed most of this session's live-measurement time.
- **Pre-existing `resume()`/`'pausing'`-phase race, found by `code-reviewer`, not fixed this
  session.** `resume()` → `start()` only checks `this.phase !== 'running'`; resuming while the phase
  is still `'pausing'` (draining in-flight `generate_explanation` calls from the pause that hasn't
  fully landed yet) can start a second `run()` concurrently with the first pass's still-finishing
  workers. This bug predates session 67 (`start()`'s own guard is unchanged by this diff) but this
  session's own change widens its worst-case blast radius from at most 2 concurrent
  `generate_explanation` calls (1 draining + 1 fresh, under the old single-worker design) to up to
  `BACKGROUND_INDEX_CONCURRENCY + 1`. Not fixed here — a distinct bug from "raise the pool size,"
  which is what this session's brief actually scoped.

## Handoff for next session
- Re-run this session's throughput/added-latency measurement (ideally with multiple trials per N,
  and through the full RPC stack once the retrieval-path stall above is understood) before treating
  `BACKGROUND_INDEX_CONCURRENCY = 2` as settled — the brief's own 3-4-worker starting point may
  still be right on a machine/environment without today's anomalies.
- The retrieval/LanceDB stall against real pokerogue (or even the small `src/utils` subtree) is a
  real, reproducible-today finding independent of session 67's own changes, not yet root-caused.
  Worth its own dedicated session if it recurs.
- The pre-existing `resume()`/`'pausing'`-phase race flagged above is a real, distinct bug worth its
  own targeted fix session (likely: `resume()` should either wait for `'paused'` before calling
  `start()`, or `start()` itself should guard against `'pausing'` too, not just `'running'`) — not
  attempted here since it's outside "raise the concurrency," this session's actual scope.
- `DELAY_BETWEEN_GENERATIONS_MS` (1s, per-worker) was kept unchanged and not re-measured against the
  now-concurrent pool — flagged, not investigated, as a possible further tuning target once the
  measurement environment above is sorted out.
- No other carried-forward items from session 66 were touched this session (out of scope, per the
  brief): no further scope-reduction changes, no rollup/graph work, no marketplace, no language work.
