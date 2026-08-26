# Session 70: Background-indexing measurement follow-up (items 1-4 from session 67/69's handoff)

**Date:** 2026-08-28
**Build-order step(s) completed:** None -- a targeted measurement session outside the Build Order,
closing out the 4-item carried-forward survey from session 67's artifact (re-confirmed still open by
session 69's own handoff).
**Status:** complete

## Files touched

None in the final state. Temporary diagnostic `print()` instrumentation was added to
`sidecar/retrieval/retrieve.py`, `sidecar/retrieval/vectorstore.py`, and `sidecar/rpc_server.py`
during item 2's investigation (timing markers around `embed()`/`store.query()`/
`generate_explanation()`/the repo_map read-lock acquire), used to drive the stall repro, then
reverted (`git checkout --`) once item 2 came back negative -- confirmed via `git status`
("nothing to commit, working tree clean") and a full `python -m pytest sidecar/tests -q` re-run
(152/152 passing, matching session 69's baseline) after the revert. No production code changed
this session; also merged session 69's own already-complete commit
(`87cc0f3`, `claude/strange-hofstadter-b61987`) into `master` via a clean fast-forward at the start
of this session, per the user's explicit choice -- that commit's own content (the `pausing`-phase
guard fix) is session 69's work, not this session's, and is not re-described here.

All measurement scripts (`repro_stall.py`, `test_a_rpc_latency.py`, `test_b_direct_inprocess.py`,
`test_c_throughput.py`, `test_d_pool2_collision.py`, `test_d2_pool2_multitrial.py`) live in this
session's scratchpad directory, not committed -- same throwaway-script precedent sessions 29/32/36/
37/67 all used.

## Decisions made

- **Merged session 69's commit into master via fast-forward before starting**, per the user's
  explicit choice (put via `AskUserQuestion`) after discovering it existed on an unmerged branch
  (`claude/strange-hofstadter-b61987`, one commit ahead of master, zero divergence) rather than on
  master itself, contrary to what this session's own brief assumed.
- **Item 2's investigation scope stayed narrow: the `pokerogue/src/utils` subtree via the full RPC
  stack, not full pokerogue.** This matches session 67's own suggested next step exactly (see
  Handoff below for why the full-repo case wasn't separately re-attempted).
- **Items 1/3/4 all used the direct in-process methodology (bypassing RPC/RepoMap/LanceDB) for
  their concurrent-call measurements**, matching session 67's own Attempt 2 -- chosen because it
  isolates Ollama-level contention as the variable under test without also depending on whichever
  RPC-stack state (indexing status, background-embed-pass timing) happens to be running at the
  moment, which item 2's own investigation showed can add real, unpredictable seconds of its own.
  Item 1's Test A additionally re-ran the full-RPC-stack methodology once, specifically to compare
  the two methodologies against each other -- see "Item 1" below.
- **The item-4 finding (production pool-size-2 collision costs ~2.29s mean, over the <1s bar) was
  put to the user via `AskUserQuestion` rather than acted on.** User chose "just document it, no
  code change" -- explicitly because this session measured collision *severity* (added latency once
  a collision occurs) but not collision *frequency* (how often one actually happens in a real
  indexing pass against real usage patterns), and severity alone isn't enough to decide whether to
  change `BACKGROUND_INDEX_CONCURRENCY`. Flagged as a dedicated follow-up in Handoff below, not
  guessed at here.

## Deviations from spec

None against the Build Order (this is a fix/measurement session outside it, per its own brief).

## Test status

- `python -m pytest sidecar/tests -q`: **152 passing**, unchanged from session 69's baseline
  (confirmed both before touching anything and again after reverting the diagnostic
  instrumentation).
- No TS-side tests run this session -- no TS files touched.
- No `code-reviewer` pass -- not needed per this session's own brief ("only run it if you actually
  change backgroundIndex.ts or sidecar generation/retrieval code"), and no production code changed.

## Findings (the actual point of this session)

All four measurements below were run back-to-back, in this session, against real Ollama
(`qwen2.5-coder:1.5b` for generation, `all-minilm` for embeddings) and real pokerogue
(`pokerogue/src/utils`, the same 21-file/112-function subtree sessions 37/67 both used), on this
same machine.

### Item 2 (priority): the un-root-caused RepoMap/retrieval/LanceDB stall -- did NOT reproduce today

Reproduced session 67's own suggested next step exactly: spawned a real sidecar over the real named-
pipe RPC transport against `pokerogue/src/utils`, with temporary timing instrumentation around every
step between a working `status`-equivalent round trip and a `generate_explanation` call (repo_map
read-lock acquire, `_query_retrieved_chunks`, `query_top_k`'s `embed()` call, `VectorStore.query()`'s
lock-wait and search, the final Ollama `generate_explanation` call itself). Ran the same
padInt-warmup / shiftCharCodes / randomString sequence sessions 37/67 both used, deliberately without
waiting for the background repo-embed pass to finish first (recreating the exact race session 67 hit).

Every step completed normally, no stall at any instrumented point:

| call | total round trip |
|---|---|
| padInt (warmup, raced the still-running background embed pass) | 18.543s |
| shiftCharCodes | 10.064s |
| randomString | 8.746s |

`embed()` for the query vector took 6.939s on the first (colliding-with-background-embed) call and
~2.0-2.1s on the later two; `VectorStore.query()` never waited on its lock at all (0.000s every time)
and returned instantly once the table existed. No 120+ second gap anywhere.

**Per this session's own brief: this is a plain negative result, not a fix.** The stall session 67
found was real (Ollama itself confirmed idle and responsive via direct curl calls during that
session's own stall, ruling out an Ollama-side cause) but did not recur under an identical repro
today. A flaky, not-always-reproducible stall in a code path this session's diff never touched is
itself worth recording, not quietly treated as resolved.

**Not re-attempted this session: the separate full-pokerogue (6,633-function) `RepoMap.index()`
stall** session 67's Attempt 1 also hit (the child process staying alive with near-flat CPU time
across several minutes). This is a distinct question from the retrieval-path stall the handoff
specifically asked this session to chase (indexing performance at full-repo scale, arguably session
33's own territory, not this session's four items) -- flagged for a future session if it recurs, not
chased here given this session's own priority ordering already pointed at the subtree case.

### Item 1: the ~10x added-latency gap (session 37's +227ms vs. session 67's +2.32s) -- resolved, does not reproduce today

Ran both sessions' original methodologies back-to-back, today, on the same machine and the same
functions, specifically to isolate methodology from environmental drift as the explanation:

**Test A (session 37's methodology: real RPC transport, real retrieval context, `pokerogue/src/utils`).**
Sent `randomString` (A), then `shiftCharCodes` (B) 250ms later, on the same pipe connection:

| measurement | value |
|---|---|
| baseline (B alone) | 9.361s |
| A's own round trip (concurrent) | 8.638s |
| B's own round trip (concurrent) | 9.955s |
| **added interactive latency (B concurrent − B baseline)** | **+0.594s** |

**Test B (session 67's methodology: direct in-process call, bypassing RPC/RepoMap/LanceDB, empty
`FunctionContext`/`retrieved_chunks=[]`).** Same two functions, `ThreadPoolExecutor`, 250ms stagger:

| measurement | value |
|---|---|
| baseline (B alone) | 5.534s |
| A's own round trip (concurrent) | 5.735s |
| B's own round trip (concurrent) | 6.134s |
| **added interactive latency (B concurrent − B baseline)** | **+0.600s** |

**The two methodologies agree with each other almost exactly today (+0.594s vs. +0.600s)** --
both comfortably under session 36's own <1s acceptance bar, and both much closer to session 37's
original +227ms than to session 67's own +2.32s. This resolves item 1: the ~10x gap between
sessions 37 and 67 does not reproduce today under either methodology, and the fact that both
methodologies converge on nearly the same number when run under the same real conditions rules out
"methodology difference" as the explanation session 67 itself floated. The much simpler remaining
explanation -- session-to-session environmental/Ollama-state noise between session 37's run and
session 67's run -- is the one this session's own evidence actually supports. **The single-worker
collision floor is confirmed, again, comfortably under the acceptance bar.**

### Item 3: single-trial-per-N throughput noise -- resolved, clean monotonic scaling with 3 trials/N

Re-ran session 67's own direct-in-process N=1/2/4/8 sweep with 3 trials per N instead of 1, cycling
through a pool of 8 distinct real pokerogue utility functions (`randInt`, `randSeedInt`,
`randSeedIntRange`, `randIntRange`, `randSeedFloat`, `randGauss`, `randSeedGauss`, `getFrameMs`) so
no two concurrent calls in a batch shared an identical prompt:

| N | mean wall time (3 trials) | speedup vs. N=1 serial-equivalent |
|---|---|---|
| 1 | 5.563s | 1.00x |
| 2 | 6.385s | 1.74x |
| 4 | 7.915s | 2.81x |
| 8 | 13.710s | 3.25x |

**Clean, monotonically increasing speedup this time -- no N=2-beats-N=4 anomaly.** Session 67's own
single-trial N=2 (2.60x) beating N=4 (1.15x) is confirmed as noise, not a real "concurrency past 2
actively hurts" effect. These averaged numbers land closer to (and at N=2/4 modestly exceed) the
strategy review's original cited figures (1.00x/1.57x/2.22x/2.78x) than session 67's own noisy
single-trial numbers did.

### Item 4: `DELAY_BETWEEN_GENERATIONS_MS` retuning -- a new finding surfaced, not a retuning verdict

Did not directly test varying the 1000ms constant itself (would require driving the real TS
`BackgroundIndexManager`/`SidecarManager` against a spawned sidecar, not attempted this session).
Instead measured the scenario the constant exists to make less likely: **a real collision at the
actual shipped `BACKGROUND_INDEX_CONCURRENCY = 2`** -- something session 67's own added-latency
table never directly measured (it tested background pool sizes 1, 3, and 4, never exactly 2, the
value that actually shipped).

2 background calls submitted, then 1 "interactive" call 250ms later, added latency = interactive's
own round trip minus the solo baseline (5.534s, from Test B above), 3 trials with distinct function
triples each time:

| trial | added latency |
|---|---|
| 1 | +1.588s |
| 2 | +2.106s |
| 3 | +3.176s |
| **mean** | **+2.290s** |

**Every trial exceeded session 36's own <1s acceptance bar, and the mean is roughly 3.8x the
single-worker collision floor (+0.6s) measured today in item 1.** This is new information: session
67 accepted `BACKGROUND_INDEX_CONCURRENCY = 2` partly on the reasoning that it would add "roughly
one increment" of latency cost beyond the pre-existing single-collision floor, not compounding
across the pool -- these numbers suggest the real cost at the actual shipped pool size is
considerably worse than "one increment," not better.

**This does not, by itself, mean `BACKGROUND_INDEX_CONCURRENCY` should change.** What this session
measured is collision *severity* (how bad it is when 2 background generations and 1 interactive
request genuinely overlap) -- not collision *frequency* (how often that overlap actually happens
during a real indexing pass against real usage). A rare-but-severe event and a common-but-severe
event call for different responses, and this session has no data on frequency. Put to the user via
`AskUserQuestion`: user chose to document this finding and leave it for a dedicated follow-up,
rather than either changing the constant now or spending more of this session estimating collision
frequency.

On `DELAY_BETWEEN_GENERATIONS_MS` specifically: its own doc comment frames it as opening a
"registration window" for `waitForInteractiveIdle`'s pending-request bookkeeping, reasoning that
predates session 37's concurrent-dispatch fix (when an in-flight background call would have
literally blocked an interactive one from even being read off the socket). Post-session-37, an
in-flight background call no longer blocks a new interactive request's dispatch at all -- so the
delay's real remaining effect is closer to throttling each worker's own Ollama duty cycle (time
spent actively calling Ollama vs. idle) than to any literal "registration" mechanism. At today's
measured real generation time (~5-9s per call) against a 1000ms delay, each worker's duty cycle is
roughly 85-90% busy -- meaning a genuinely idle window (zero background Ollama activity) is already
fairly rare per-worker, and rarer still with 2 independent workers running the same cycle. Raising
the delay substantially would mechanically reduce collision *frequency* (more idle time per worker)
without changing collision *severity* (unrelated to the delay -- severity is a function of how many
background calls are simultaneously contending for Ollama, i.e. pool size). This reasoning is
offered as context for whoever picks up the follow-up below, not as a recommendation acted on here.

## Blockers / open questions

- **The item-4 finding above (mean +2.29s added latency at the real shipped pool size, over the <1s
  bar) needs a dedicated follow-up session to decide whether/how to act on it.** That session should
  start by measuring collision *frequency* in a realistic scenario (e.g. instrumenting a real
  `BackgroundIndexManager` run against a repo with real interactive activity mixed in, or a
  statistical estimate from typical hover/save cadence vs. this session's measured ~85-90%
  per-worker Ollama duty cycle) before deciding among: leaving `BACKGROUND_INDEX_CONCURRENCY = 2` as
  is, reverting to 1, or raising `DELAY_BETWEEN_GENERATIONS_MS` to reduce collision frequency at
  pool size 2. Any of those changes needs its own `AskUserQuestion` before landing, per this
  project's established precedent (sessions 39/44/67 among others).
- **The full-pokerogue (6,633-function) `RepoMap.index()` stall session 67's Attempt 1 also hit** was
  not re-attempted this session (see "Item 2" above for why) -- still open if a future session wants
  to chase it, likely as its own dedicated session given indexing-performance-at-scale is closer to
  session 33's territory than this session's four items.
- Everything else carried forward from session 69's own handoff (Group B/C small QOL items, session
  68's cluster-summary manual smoke test and TS validation pass) remains untouched, out of this
  session's scope.

## Handoff for next session

1. **Collision-frequency follow-up (see "Blockers" above)** is the natural next step directly
   continuing this session's own item-4 finding -- highest-value pickup since it's what actually
   gates any decision about `BACKGROUND_INDEX_CONCURRENCY`/`DELAY_BETWEEN_GENERATIONS_MS`.
2. The full-pokerogue `RepoMap.index()` stall (distinct from the retrieval-path stall this session
   tested and could not reproduce) is still open if it recurs -- not urgent, no repro attempt made
   this session.
3. No other carried-forward items were touched this session, per its own narrow measurement-only
   scope: Group B/C (sessions 64/65/66's small QOL backlog) and session 68's two carried-forward
   items (cluster-summary manual smoke test, TS validation pass) are all still exactly where session
   69's handoff left them.
