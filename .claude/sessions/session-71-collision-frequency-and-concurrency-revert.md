# Session 71: Collision-frequency measurement and BACKGROUND_INDEX_CONCURRENCY revert

**Date:** 2026-08-28
**Build-order step(s) completed:** None -- a targeted measurement-then-fix session outside the
Build Order, closing session 70's own carried-forward "collision frequency, not severity" gap.
**Status:** complete

## Files touched
- [src/extension/backgroundIndex.ts](../../src/extension/backgroundIndex.ts) -- `BACKGROUND_INDEX_CONCURRENCY`
  reverted from `2` (session 67) back to `1`, with the doc comment above it rewritten to explain
  the revert and cite this session's measurement. `DELAY_BETWEEN_GENERATIONS_MS` (1000ms) left
  unchanged -- the delay-increase alternative was measured and found too weak to adopt (see
  Findings). The worker-pool machinery itself (`claimNext()`, `fileSymbolPromises`, the injectable
  `concurrency` constructor param, `workerCount = Math.max(1, this.concurrency)`) is untouched --
  still exercised at higher pool sizes by the existing "concurrent worker pool (Session 67)" test
  suite, available again if a future session's data supports raising this back up.

No sidecar (Python) files touched, no test files touched (no test asserts the constant's numeric
value -- the existing suite already pins its own manager instances to explicit `concurrency`
values for exactly this reason, per session 67's own test-file comment). No CHANGELOG/README
changes (same reasoning sessions 65/66/67 used: a default-behavior change to an existing,
still-unpublished feature). Measurement scripts (`collision_frequency.py`, `severity_check.py`
(written, not run -- see Deviations)) live in this session's scratchpad directory, not committed,
same throwaway-script precedent sessions 29/32/36/37/67/70 all used.

## Decisions made

- **Measured collision frequency via a real, continuous run of the actual shipped worker-pool
  schedule, not an analytical duty-cycle-squared estimate.** The session brief offered either
  approach; a direct measurement was chosen because it sidesteps the independence assumption a
  duty-cycle-squared calculation would require (workers aren't actually independent -- they share
  a near-identical cycle length and a small fixed stagger, so their busy-overlap is more
  correlated than independence predicts; the real measured both-busy fraction, 75.7%, came out
  meaningfully higher than a naive `0.875^2 ≈ 76.6%`... actually close in this case, but the
  delay=3000ms trial's real 60.4% was well above the naive `0.684^2 ≈ 46.8%` prediction, confirming
  the independence assumption would have been optimistic and misleading if used alone).
- **Used the queueing-theory fact that for any arrival process statistically independent of server
  state, the long-run fraction of arrivals finding the system in state X equals the long-run time
  fraction spent in state X**, to avoid needing to guess a real interactive-request arrival rate
  for the "given a pass is running" half of the question. This is a legitimate simplification, not
  an assumption smuggled in: a developer's hover/save timing has no way to be coordinated with
  when a background Ollama call happens to start or stop.
- **The other half of the frequency question -- what fraction of a whole coding session has an
  active background pass at all -- was not directly measurable in this environment** (no telemetry
  pipeline exists in this project, and simulating "realistic developer session length" would be
  pure guessing dressed up as measurement). Resolved instead with a real, code-grounded fact:
  `backgroundIndexManager?.start()` is called exactly once, at `startIndexing()` (see
  `extension.ts:140`), and never automatically re-triggered (`toggle()`'s `resume()` only reaches
  a `'paused'` pass, not a completed/`'idle'` one) -- so the active window is a real, one-time,
  ~12.6-measured-minute stretch per trusted-workspace-open, not a recurring or open-ended one. This
  was judged sufficient to inform the decision without needing to guess total session length: the
  absolute severe-collision exposure during that one real window doesn't depend on how long the
  rest of the session runs, and that window structurally overlaps a developer's first exploration
  of a workspace -- plausibly the single most hover-heavy stretch of any session, not an
  arbitrary/rare one.
- **A candidate `DELAY_BETWEEN_GENERATIONS_MS = 3000` was live-measured as a possible alternative
  to reverting concurrency**, per this session's own brief ("if you pursue this, measure the actual
  effect of a specific candidate value before proposing it"). Found real but weak: severe-state
  probability dropped from 75.7% to 60.4%, while the pass's own active window grew ~25% longer
  (12.6 -> 15.8 min) and throughput dropped proportionally -- tripling the delay bought less than
  a 16-point reduction in collision probability at a real, non-trivial throughput cost. Not adopted.
- **The frequency x severity finding, and the choice among leave-as-is / revert-to-1 / raise-delay
  / other, was put to the user via `AskUserQuestion`** with the real numbers from both this session
  and session 70, per this session's own explicit instruction (constant changes on shipped defaults
  go through the user, same precedent as sessions 39/44/67). User chose: revert
  `BACKGROUND_INDEX_CONCURRENCY` to `1`.

## Deviations from spec

None against the Build Order (this is a fix/measurement session outside it, per its own brief).

One deviation from this session's own plan: a `severity_check.py` script was written to re-confirm
session 70's same-day severity numbers (+0.6s at pool 1, +2.29s at pool 2) independently, but was
never run -- judged unnecessary once the frequency measurement's own real per-call timings (5.4s-
7.2s per generation, consistent with session 70's own numbers from earlier the same day, same
machine) made a redundant re-verification low-value relative to the time cost. Session 70's
same-day, same-machine severity numbers are cited directly rather than re-measured.

## Test status

- `npx tsc -p . --noEmit`: clean.
- `npm run test:unit`: **65 passing**, unchanged (no unit-level code touched).
- `npm run test:integration`: **90 passing**, unchanged from session 70's baseline -- including all
  5 "concurrent worker pool (Session 67)" tests, which construct their own manager instances with
  explicit `concurrency: 2`/`concurrency: 3` and so are unaffected by the production default
  changing (confirmed by inspection before running: no test in the suite asserts
  `BACKGROUND_INDEX_CONCURRENCY`'s numeric value directly).
- `python -m pytest sidecar/tests -q`: not re-run -- no sidecar files touched this session, and
  session 70 already confirmed the 152-passing baseline same-day.
- `code-reviewer` pass (scoped to the exact 1-file diff, `git diff --stat` confirmed clean of any
  other changes before requesting the review): **zero violations.** Independently confirmed
  `git diff --stat` shows exactly the one intended file/hunk; the worker-pool machinery
  (`claimNext()`, `fileSymbolPromises`, `workerCount = Math.max(1, this.concurrency)`,
  `Promise.all(Array.from({length: workerCount}, ...))`) is byte-identical to before and correctly
  degenerates to the pre-session-67 single-worker behavior at `concurrency=1`, with no code path
  anywhere assuming concurrency > 1 is the steady state; no other file in the codebase (tests,
  README, CHANGELOG) hardcodes or asserts the old value `2` in a now-stale way (the test suite's
  own default-setup instance already pinned `concurrency: 1` explicitly, independent of the
  production default, and every "concurrent worker pool" test constructs its own manager with its
  own explicit concurrency value); no contradictions between the new doc comment and
  `DELAY_BETWEEN_GENERATIONS_MS`'s/`ETA_WINDOW_SIZE`'s neighboring comments; no Core Rule 11
  concerns (no RPC dispatch-loop code touched, `waitForInteractiveIdle()` call sites unaffected,
  session 69's `'pausing'`-phase guard independent of the concurrency value).

## Findings (the actual point of this session)

All measurements below were run today (2026-08-28), against real Ollama (`qwen2.5-coder:1.5b`) and
real pokerogue (`B:/pokerogue/src/utils/common.ts`, 14 distinct real functions cycled through), on
this same machine session 70 used.

### Real measurement: busy-state time fractions at the shipped config (concurrency=2, delay=1000ms)

A direct in-process script reproduced the exact shipped worker-pool schedule (2 threads, each:
claim -> `generate_explanation` -> 1s delay -> claim next) continuously for 241.2 real seconds (64
real generations, no simulated timing):

| workers simultaneously busy | time fraction | wall-clock time |
|---|---|---|
| 0 (idle) | 1.85% | 4.5s |
| 1 | 22.47% | 54.2s |
| 2 (both busy -- the severe state) | 75.69% | 182.6s |

By the arrival-sees-time-average argument (see "Decisions made"), this is directly the probability
a real interactive request lands in each state, for any arrival cadence, given a pass is actively
running. Combined with session 70's own same-day severity numbers (+0.6s mean at 1 busy, well
under the <1s bar; +2.29s mean at 2 busy, well over it), **the large majority (75.7%) of any
interactive request landing while a background pass is running will hit the over-bar case, not the
under-bar one.** This closes session 70's own gap directly: collisions are not rare given an active
pass -- they are close to the default outcome, and mostly the severe kind.

Real measured throughput at this config: 0.2653 completions/sec (15.92/min) -> a default
`topN=200` pass takes an estimated ~754s (~12.6 min) wall-clock, consistent with session 66's own
"tens of minutes" design target.

### Real measurement: the same test at a candidate DELAY_BETWEEN_GENERATIONS_MS=3000

Same schedule, 3s delay instead of 1s, 180.7s real span (38 real generations):

| workers simultaneously busy | time fraction |
|---|---|
| 0 (idle) | 20.75% |
| 1 | 18.86% |
| 2 (severe) | 60.39% |

Throughput dropped to 0.2103/sec, projecting a ~951s (~15.8 min) pass -- about 25% longer than at
1000ms. Tripling the delay only reduced the severe-state probability by about 15 percentage points
(75.7% -> 60.4%) while extending the window the risk is present in by about a quarter and cutting
throughput by the same proportion. **A real but weak lever on its own** -- not adopted as the fix.

### Code-confirmed: the active window is a real, one-time ~12.6-minute stretch, not recurring

`backgroundIndexManager?.start()` is called exactly once, inside `startIndexing()`
(`extension.ts:140`), right after the sidecar/cache are ready for a trusted workspace. Nothing else
in `extension.ts` calls `.start()`/`.resume()` again -- a completed (`'idle'`) pass has no
automatic re-trigger; only a user's own `pause()`/`resume()` during an *already-running* pass can
extend it (`toggle()`'s `resume()` branch requires `phase === 'paused'`). Combined with the
throughput measurement above, this pins down the real, bounded shape of the exposure: roughly the
first ~12.6 minutes after a trusted workspace opens, once per that opening -- not an ongoing
background tax for the rest of a session, but also not a rare corner case, since that window
structurally coincides with a user's first exploration of files they just opened (plausibly the
single most hover-active stretch of a session).

### Decision

Presented to the user via `AskUserQuestion` with all of the above (both today's frequency numbers
and session 70's severity numbers, together, per that session's own explicit reasoning for
deferring): leave concurrency=2 as-is, revert to 1, raise the delay instead, or something else.
**User chose: revert `BACKGROUND_INDEX_CONCURRENCY` to `1`.** Implemented in
`backgroundIndex.ts` (see "Files touched"); full test suite reconfirmed green after the change
(see "Test status").

## Blockers / open questions

- None specific to this session's own scope -- the collision-frequency question sessions 67/69/70
  all carried forward is now closed with real data and an implemented decision.
- The worker-pool machinery (concurrency > 1 support) remains in the codebase, unused by the
  production default but still real and tested -- a future session with new data (a faster/local
  model, GPU-backed Ollama, or a different real-world collision-frequency picture) could revisit
  raising `BACKGROUND_INDEX_CONCURRENCY` again using the same measurement approach this session
  established (a real continuous busy-fraction run, not a duty-cycle-squared estimate).
- Everything else carried forward from session 70's own handoff and earlier (Group B/C's small QOL
  backlog, session 68's cluster-summary manual smoke test and TS validation pass, the
  full-pokerogue `RepoMap.index()` stall) remains untouched, out of this session's scope.

## Handoff for next session

1. No immediate follow-up required for background-indexing concurrency -- this closes the
   sessions-67/69/70 thread with a real, implemented decision, not another deferral.
2. If a future session wants to revisit raising concurrency above 1, the methodology this session
   used (a real continuous 2+-minute run of the actual production worker-pool schedule against real
   Ollama, measuring time-weighted busy-state fractions directly rather than assuming worker
   independence) is reusable and preferable to session 67's original duty-cycle-squared framing --
   the delay=3000ms trial above showed real worker behavior is more correlated (and therefore worse
   for the "both idle" case) than independence would predict.
3. Untouched, still open from session 70's own handoff: the full-pokerogue (6,633-function)
   `RepoMap.index()` stall (session 67's Attempt 1), not re-attempted this session either. Group
   B/C's small QOL backlog and session 68's two carried-forward items (cluster-summary manual smoke
   test, TS validation pass) are all still exactly where session 70's handoff left them.
