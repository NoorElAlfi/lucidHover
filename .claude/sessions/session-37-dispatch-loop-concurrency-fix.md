# Session 37: Sidecar RPC dispatch-loop redesign, part 2 (dispatch-loop-level fix)

**Date:** 2026-08-22/23
**Build-order step(s) completed:** None -- targeted fix continuing session 36's part 1 (client-side
priority gating), not a Core Build Order step.
**Status:** complete

## Files touched
- [sidecar/concurrency.py](../../sidecar/concurrency.py) (NEW) -- a hand-rolled readers-writer lock
  (`RWLock`), the classic first-readers-writers algorithm: any number of readers run concurrently,
  a writer excludes everyone. No stdlib RWLock exists and this repo has no reason to add a
  third-party dependency for one. Writer-starvation-prone by design; judged acceptable (see
  "Decisions made").
- [sidecar/repomap/context.py](../../sidecar/repomap/context.py) -- `RepoMap.__init__` now creates
  `self.lock = RWLock()` unconditionally (not a spawn-time-only attribute like `vector_store`/
  `embedding_model_id`, since every caller -- including direct unit tests -- now needs it to exist).
- [sidecar/rpc_server.py](../../sidecar/rpc_server.py) -- the actual fix, in two parts:
  1. **Concurrent dispatch.** Each request line is now submitted to a `ThreadPoolExecutor`
     (`_MAX_WORKERS=8`) via `_dispatch_worker` instead of being processed inline before the next
     line is even read. This is the mechanical fix for session 36's own measured bug: the old
     single-threaded loop didn't even *read* a newly-arrived request off the socket/pipe until the
     prior handler (e.g. a multi-second `generate_explanation` Ollama call) fully returned.
  2. **Single-I/O-thread poll loop**, replacing the naive "workers write their own responses"
     version this session tried first and had to abandon (see "Decisions made" -- this is the part
     worth reading before touching this file again). Workers never touch the pipe/socket; they only
     push a finished response onto a `queue.Queue`. `_serve_windows`/`_serve_posix`'s own single
     thread is the *only* thing that ever calls `ReadFile`/`WriteFile` (Windows) or `recv`/`sendall`
     (POSIX), alternating every `_POLL_INTERVAL_S` (20ms) between draining that queue and a
     non-blocking check for new input (`PeekNamedPipe` on Windows; a short `recv` timeout on POSIX).
  3. `_handle_index_file`, `_handle_generate_explanation`, `_handle_reindex_file`,
     `_handle_resolve_function`, `_handle_list_ranked_functions` each now wrap their `repo_map`
     access in `repo_map.lock.read_lock()` (four handlers) or `.write_lock()` (`reindex_file`, the
     only mutator) -- tightly scoped around just the repo_map read/write, released before any
     Ollama call, so a writer's wait is bounded by many short read-holds, not a few long ones.
  4. Module docstring rewritten with a full "Dispatch concurrency" section explaining the design
     and why the pipe/socket is single-threaded on purpose, not by oversight.
- [sidecar/tests/test_ollama_base_url_plumbing.py](../../sidecar/tests/test_ollama_base_url_plumbing.py)
  -- `_StubRepoMap` now gets a real `RWLock()` too, since `_handle_generate_explanation` acquires
  `repo_map.lock` for real now and the stub previously had no such attribute.
- [CLAUDE.md](../../CLAUDE.md) -- Core Rule 11 rewritten: the dispatch loop is no longer "strictly
  one request at a time"; states the new concurrency model, the lock, and that this narrows but
  doesn't eliminate the interactive-vs-background gap (Ollama's own concurrency still gates real
  throughput; multiple background loops can now genuinely race each other, not fixed, not confirmed
  costly -- see "Handoff").

No changes to the wire protocol, cache-key logic, prompt/schema, or anything the extension host
does -- `SidecarManager.handleMessage` (src/extension/sidecar/sidecarManager.ts) already matched
responses to requests by `id`, not arrival order, before this session (confirmed by reading it, not
assumed), so out-of-order responses -- now the normal case, not just a theoretical one -- needed no
client-side change at all.

## Decisions made

### The naive "workers write their own responses" design deadlocks the named pipe -- found live, not theorized
The first implementation had each worker thread call `send_line` directly (under a lock shared only
with other workers, not with the main thread's own read loop). This passed a quick manual smoke test
for a *single* request/response round trip, then hung indefinitely on a *second* request over the
same connection. Root-caused by adding temporary debug logging and an isolated minimal repro
(no sidecar code involved at all, just two threads and a bare named pipe): a worker thread's
`WriteFile` call, racing the main thread's blocking `ReadFile` call on the *same* pipe handle,
never returns -- confirmed reproducible every time, not an occasional race. This is apparently a
real constraint of synchronous (non-`FILE_FLAG_OVERLAPPED`) named-pipe handles under pywin32/Windows
in this environment, not a logic bug in the first design's locking. The fix: route *all* socket/pipe
I/O through exactly one thread per connection (the existing main loop), with workers only ever
pushing a finished response onto a `queue.Queue`. This is documented at length in `rpc_server.py`'s
own module docstring and inline comments specifically so a future session doesn't reintroduce the
same mistake while "simplifying" the design -- the two isolated repro scripts that found this are
not committed (scratchpad, matches sessions 29/32/36's own precedent for throwaway measurement
scripts), but the failure mode is fully described in the code.

### Why a poll loop (20ms) instead of overlapped/async I/O
A truly event-driven design (Windows overlapped I/O + `WaitForMultipleObjects`, or POSIX `select`)
would avoid the small worst-case read-latency this poll loop adds. Rejected for this session: the
20ms poll interval is already negligible next to both the multi-second Ollama calls this whole fix
is about and session 36's own +2,742ms measurement of the bug being fixed, so the added complexity
and platform-specific overlapped-I/O code (real, and risky to get right without dedicated review
time) buys correctness margin far past the point where it changes the actual measured outcome. If a
future session ever needs sub-millisecond dispatch latency, this is the place to revisit -- not
needed here.

### RepoMap gets a real, always-present lock, not a spawn-time-optional one
Unlike `vector_store`/`embedding_model_id`/`ollama_base_url` (session 11/14 pattern: attached
dynamically by `rpc_server.py`'s `main()`, defensively read via `getattr(..., None)` since tests
construct bare `RepoMap` instances), `RepoMap.lock` is created unconditionally in `__init__`. Every
handler that touches `tags_by_file`/`graph`/`importance` needs it to exist, including the direct
unit tests in `sidecar/tests/` that call handler functions against a real `RepoMap` fixture without
ever going through `rpc_server.main()`. The one place this didn't already hold was
`test_ollama_base_url_plumbing.py`'s own hand-rolled `_StubRepoMap` (not a real `RepoMap`), fixed by
giving it a real `RWLock()` too.

### Locking is at the rpc_server.py handler level, not inside RepoMap's own methods
`RepoMap.get_function_context`/`list_functions` don't acquire the lock themselves; `rpc_server.py`'s
handlers do, wrapping both the RepoMap-method calls *and* the handlers' own direct
`tags_by_file`/`importance` dict access (which several handlers do without going through a RepoMap
method at all). Centralizing this in the handful of `_handle_*` functions -- the only real callers
of RepoMap's mutable state -- keeps `RepoMap` itself lock-agnostic and easy to unit-test in
isolation, and avoids the read-then-write nesting that would deadlock this specific RWLock
implementation if a method ever tried to upgrade a read lock to a write lock internally (never
happens with this design, verified by inspection: `reindex_file` is only ever called from
`_handle_reindex_file`, always under `write_lock()`, never nested inside a `read_lock()` block).

### RWLock is writer-starvation-prone -- accepted, not fixed
The classic first-readers-writers algorithm favors readers: if reads arrive back-to-back with no
gap, a waiting writer can be delayed indefinitely. Accepted because `reindex_file` (the only writer)
is comparatively infrequent (save-triggered, background-flush-triggered) and every read-lock hold in
`rpc_server.py` is scoped tightly around just the repo_map access, not the Ollama call that follows
it -- so a writer's wait is bounded by many short holds, not a few long ones, in practice. A fairer
RWLock was judged unnecessary complexity for this codebase's actual access pattern.

### Vestigial factory-function closures removed after the redesign
An intermediate version (from the abandoned worker-writes-directly design) wrapped `send_line` in a
`_make_windows_sender`/`_make_posix_sender` factory specifically to freeze the `pipe`/`conn`
variable against a *future* connection's reassignment, guarding against a worker thread's late
response reaching the wrong connection. Once the design moved to single-threaded I/O, this reasoning
no longer applies: `send_line` is now only ever called by the same thread, within the same
outer-loop iteration, always before `pipe`/`conn` could be reassigned. Removed the factory
indirection and inlined `send_line` as a plain nested function (keeping a defensive
`_pipe=pipe`/`_conn=conn` default-argument binding as cheap insurance, with a comment explaining
why it's no longer strictly required) -- caught during this session's own final self-review, not by
the code-reviewer (see "Test status" for why that pass didn't happen).

## Deviations from spec
None against the two design directions session 36 sketched (checkpointed/preemptible dispatch, or
separate priority channels) -- this session's actual design (concurrent dispatch via a thread pool,
single-threaded I/O via a poll loop) is a third option neither artifact anticipated, arrived at
after live-testing showed the naive version of "just make dispatch concurrent" breaks the transport
outright. It achieves the same goal (interactive traffic no longer queues behind an already-started
background request) without either sketched option's larger cost (checkpointing generation calls
mid-flight, or duplicating the connection across two channels). `sidecar/rpc_server.py`'s wire
protocol is unchanged; `priority` still never reaches this module (confirmed by inspection -- it's
a purely client-side scheduling hint from sessions 32/36, unrelated to this session's fix, which is
priority-agnostic by design).

## Test status
- `python -m pytest sidecar/tests/ -q`: **113/113 passing**, including the real-transport test
  (`test_rpc_transport.py`) which exercises the actual dispatch loop this session rewrote over a
  real named pipe/socket -- this is the test that caught the abandoned design's deadlock in the
  first place (hung indefinitely; fixed design passes in ~2.5s).
- `npx tsc -p . --noEmit`: clean.
- `npm run test:unit`: 45/45 passing (no TS changes this session; confirms no regression from the
  pre-existing uncommitted session-36 TS changes still in the working tree).
- `npm run test:integration`: 22/22 passing, including two tests that spawn the **real compiled
  sidecar and real Ollama** (`SaveReindexManager`/`flagStaleDependents`, 16.4s and 10.1s
  respectively) -- end-to-end confirmation that this session's Python-only dispatch-loop rewrite
  works correctly through the actual extension-host client, not just in isolation.
- **`test-runner` and `code-reviewer` subagents both failed this session** (`Agent terminated early
  due to an API error: You've hit your monthly spend limit`) -- an account-level constraint, not a
  code problem. Substituted direct manual verification: ran all four test suites myself (above);
  did a manual line-by-line audit of every `repo_map.tags_by_file`/`.graph`/`.importance` access
  site in `rpc_server.py` (via targeted grep, not a full re-read) to confirm each sits inside the
  correct `read_lock()`/`write_lock()` scope, including verifying an early `return` from inside a
  `with repo_map.lock.read_lock():` block still releases correctly (`_handle_resolve_function`'s
  `{"found": False}` early-out) and that no handler holds a read lock across the point where it
  later needs a write lock (no nesting exists -- `reindex_file` is only ever called under
  `write_lock()`, never from inside a `read_lock()` block); this self-review is what caught the
  vestigial factory-function closures (see "Decisions made"). This is a real substitute for a second
  pair of eyes but not equivalent to one -- flagging honestly rather than skipping the caveat.
- **RWLock unit-verified in isolation** (ad hoc script, not committed): confirmed two readers
  overlap freely, and a reader correctly blocks until an in-flight writer releases.
- **Live pokerogue reproduction**, repeating session 36's own methodology as closely as a
  server-side-only fix allows (a direct protocol-level script against the real named pipe, rather
  than through the TS `SidecarManager`/`vscode.js`-shim technique sessions 32/36 used for their
  *client*-side fixes -- unnecessary here since this session's fix is entirely inside
  `rpc_server.py`, and the extension-host's own response-matching-by-id was already confirmed
  correct by inspection, not by re-testing it): real sidecar spawned against real pokerogue
  (6,633 functions indexed) + real Ollama (`qwen2.5-coder:1.5b`), three real functions from
  `src/utils/common.ts` (`padInt` as a cold-start model-load warmup, then `shiftCharCodes` and
  `randomString`), same connection throughout.

  | Measurement | Result |
  |---|---|
  | `shiftCharCodes` alone (baseline) | 9,042ms |
  | `randomString` (A) sent, `shiftCharCodes` (B) sent 250ms later -- A's round trip | 7,999ms |
  | Same run -- B's round trip (from B's own send) | 9,269ms |
  | B resolved relative to A resolved | +1,527ms |
  | **Added interactive latency (B concurrent − B baseline)** | **+227ms** |

  Session 36 itself defined "acceptable" *before measuring* as "under ~1 second of added interactive
  latency when a background RPC is already in-flight," using exactly this added-latency framing (its
  own pre-fix number, for comparison, was architecturally guaranteed far larger since the old loop
  didn't even read B's line until A's handler returned). This session's **+227ms is comfortably
  under that bar**, live-measured, not assumed. The 20ms poll interval this fix adds is not the
  dominant cost by two orders of magnitude; the rest of the +227ms is attributable to real
  contention on this machine's local Ollama instance running two `qwen2.5-coder:1.5b` generations
  concurrently (this machine's Ollama evidently supports enough real parallelism to let B's own
  Ollama calls make substantial concurrent progress rather than queueing fully behind A's --
  confirmed only for this machine/model/load; not a property this module controls or can guarantee
  elsewhere, consistent with session 36's own caveat that Ollama's concurrency is outside this
  module's control). No crash, no error, no deadlock across the whole run (`sidecar.log` inspected,
  clean).

## Blockers / open questions
None blocking. The one open item from session 36's handoff not addressed this session (see below)
is explicitly scoped as a measure-only follow-up, not a blocker.

## Handoff for next session
- **This session's own primary goal is done and confirmed**: the "already in-flight" collision floor
  session 36 measured is closed, live-verified against real pokerogue with added interactive latency
  (+227ms) well under the acceptance bar defined before measuring. No further dispatch-loop work is
  expected to be needed unless a future session's own measurement shows otherwise.
- **Background-vs-background thundering herd** (carried forward from session 36, still not measured):
  now slightly different in character than when session 36 flagged it, because dispatch is genuinely
  concurrent now -- two autonomous background loops (`BackgroundIndexManager`, `BackgroundFlushManager`,
  `GitHookReindexManager`) that clear their independent 300ms grace windows near-simultaneously could
  now actually run their RPCs concurrently against the sidecar, not just queue back-to-back as they
  would have under the old strictly-serial loop. For `reindex_file` calls this is still fully safe
  (mutual exclusion via `repo_map.lock.write_lock()`); for concurrent `generate_explanation` calls
  it's safe but means two background loops could both load Ollama at once with no interactive request
  anywhere in the picture. Not measured this session (out of scope, and this session's own budget
  went to the primary fix plus two real live-testing rounds); worth a real measurement if it ever
  turns out to matter in practice, per session 33's own "measure, don't assume" precedent -- same
  disposition session 36 already gave it.
- **Re-run `code-reviewer` on this session's diff once the account's monthly spend limit resets** --
  it was not possible to get a second pair of eyes on this session's concurrency/locking changes
  (see "Test status"); the manual self-review substituted for it was real but is not a replacement.
  Prioritize re-reviewing `sidecar/rpc_server.py` and `sidecar/concurrency.py` specifically.
