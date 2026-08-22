# Session 29: Real-repo audit -- synthetic-fixture gaps + resource usage against pokerogue

**Date:** 2026-08-22
**Build-order step(s) completed:** None -- audit session (real-code confirmation of two prior fixes) plus a resource-usage measurement, per session-20's Track column conventions (not a Core Build Order step).
**Status:** complete

## Files touched
- [src/extension/__tests__/suite/functionResolutionRealWorld.test.ts](../../src/extension/__tests__/suite/functionResolutionRealWorld.test.ts) --
  new. Closes session 25's "only tested on synthetic shapes" gap for the
  `isFunctionLike` Field/Property fix. Fixture reproduces the real class/
  method names and document-symbol shapes of `MoveTouchControlsHandler`
  (found via `repo-researcher` search in `B:\pokerogue\src\ui\settings\move-touch-controls-handler.ts`,
  lines 27, 163, 170-172, 178-189, 194-196) but with hand-written bodies, not
  copied text -- see "Decisions made" for why. Asserts `stopDrag`,
  `startDrag`, `drag`, `isLeft` (a braced two-statement field, a
  parameterized braced field, a multi-statement braced field, and an
  expression-bodied field, respectively) all resolve as functions.
- [src/extension/__tests__/suite/roleGutterDecorationsRealWorld.test.ts](../../src/extension/__tests__/suite/roleGutterDecorationsRealWorld.test.ts) --
  new. Closes session 26's equivalent gap for the gutter-staleness fix.
  Reuses the same `MoveTouchControlsHandler`-shaped fixture (a smaller
  excerpt: `draggingElement`, `startDrag`, `stopDrag` only) and the sibling
  file's manager-instantiation + `refreshEditor` spy pattern, but deletes the
  real `stopDrag` class-field arrow method (not a plain `function`) and
  confirms its gutter decoration clears via the debounced re-render.

No sidecar files touched; no prompt/schema/cache-key changes; no
language-manifest changes; no production `src/` code outside the two new
test files.

## Decisions made

### Real-code target: `MoveTouchControlsHandler` in pokerogue
Delegated the search to `repo-researcher` (kept pokerogue's 615-file bulk out
of the main session) rather than grepping inline. It found three genuine
class-field arrow-function occurrences; `MoveTouchControlsHandler.stopDrag`
(and its sibling fields `startDrag`, `drag`, `isLeft`) was chosen as the
clearest, confirmed directly against the real file (`grep -n` on the actual
path/line numbers, not trusted from the subagent's report alone).

### AGPL-3.0 fixture rewrite (user-directed mid-session correction)
The first draft of both fixtures embedded pokerogue's real method bodies
verbatim as string literals, with only a file/line provenance comment. The
`code-reviewer` pass flagged this as a real licensing concern outside its own
13-rule checklist: pokerogue is AGPL-3.0-only licensed
(`B:\pokerogue\LICENSE`), and LucidHover has no LICENSE file of its own --
embedding literal AGPL-licensed source into this repo's checked-in test
suite is a copyright judgment call, not a technical one. Surfaced to the
user via `AskUserQuestion` rather than decided unilaterally; the user chose
"rewrite as non-verbatim." Both fixtures were rewritten to keep the real
class name, method names, and signatures (these determine the
`SymbolKind`/document-symbol shape the tests are actually about) but with
hand-written bodies -- no literal pokerogue source text remains in either
file. Re-verified both tests still pass after the rewrite (see "Test
status"). The `code-reviewer`'s other finding on the same pass -- the
original `drag` excerpt had silently dropped a real statement while claiming
"copied unmodified" -- is moot after the rewrite (no longer claims verbatim
copying at all).

### Resource measurement: direct sidecar spawn + manual RPC driver, not a full VS Code Extension Development Host
Session 26 couldn't reproduce anything live against pokerogue because no GUI
automation tool was available then. Rather than drive a full VS Code
Extension Development Host headlessly for 13+ minutes (possible via
`@vscode/test-electron`, same as the integration suite, but heavier and
riskier to keep alive unattended), a standalone Node.js script was written
(kept in the session's scratchpad, not committed) that: spawns the real
Python sidecar process against `B:\pokerogue` with the exact same command
shape `sidecarManager.ts` uses; speaks the real newline-delimited JSON-RPC
protocol over a Windows named pipe via plain `net.connect`; calls the real
`list_ranked_functions` RPC and walks its real PageRank-ordered result,
mirroring `BackgroundIndexManager`'s own loop shape (~1s gap between
generations); and writes real rows to a real `ExplanationCache` instance
(the compiled class has no `vscode` dependency, so it could be `require()`'d
directly and used standalone). `fn_source` was approximated by reading real
pokerogue source and brace-matching around each ranked line, rather than
using VS Code's real document-symbol resolution -- accuracy of the
*explanation output* doesn't matter for a resource/timing measurement, only
that real, substantial real-repo text drove each real Ollama call.

## Deviations from spec
None for the two new test files (standalone temp files, not `fixtures/`, per
session 25/26's own established precedent -- covered under "Decisions made"
in this same section for why). The resource-measurement script is
intentionally NOT the real `BackgroundIndexManager`/`SidecarManager` TS
classes running inside VS Code -- a deliberate scope choice (see above), not
an oversight; it reuses their real spawn command and real RPC protocol, but
drives the loop from a standalone script rather than the real extension
host.

## Test status
- `npx tsc -p ./ --noEmit`: clean.
- `npm run test:unit`: 45 passing (unchanged baseline).
- `npm run test:integration` (default `javascript` fixture): **19 passing,
  1 failing.** Both new real-world tests pass:
  - `functionResolution: real-world class-field arrow functions (Session 29)`
    -- 1/1 passing.
  - `codelens/RoleGutterDecorationManager: live refresh on real-world text
    edit (Session 29)` -- 1/1 passing.
  The one failure (`roleCodeLensAutoRefresh.test.ts`, "adding a function is
  reflected by vscode.executeCodeLensProvider with no provider.refresh()
  call" -- expected 1 lens for `alpha()`, got 2) is **confirmed pre-existing
  and unrelated to this session**, not just assumed: both new test files
  were physically moved out of the suite directory and the full integration
  suite rerun as a control -- the same failure reproduced identically with
  or without them present. This is session 26's own test file, untouched
  this session; needs its own diagnosis by whoever owns that area next
  (flagged in "Handoff").
- `python -m pytest sidecar/tests/ -q`: 93 passing (unaffected -- no sidecar
  files touched).
- `code-reviewer` pass (scoped to the two new files): no Core Rule
  violations. Two real findings, both resolved: (1) the `drag` fixture's
  "copied unmodified" claim was inaccurate (a real statement had been
  silently dropped) -- moot after the AGPL rewrite below. (2) the AGPL-3.0
  licensing concern -- resolved via the user-directed rewrite (see "Decisions
  made"). Confirmed both new tests genuinely depend on the fixes they claim
  to (traced `isFunctionLike`'s Field/Property branch and
  `RoleGutterDecorationManager`'s constructor listener list directly, not
  just by analogy to the sibling tests).

### Resource measurement against pokerogue (real numbers, 13.05-minute bounded window)
- **Throughput:** repo indexed 6,633 functions in ~19s at sidecar startup.
  65 functions successfully generated (1 real timeout failure) in the
  window, out of 6,633 ranked -- consistent with real per-function LLM
  generation latency (~10-20s median, one outlier at ~128s) dominating the
  loop, not the 1s inter-generation delay.
- **Sidecar process RSS:** start (post-connect, pre-generation) = 219.3MB.
  Rose to a peak of 226.5MB over the first ~13 generations (~4 min), then
  **dropped** to ~216.0MB around generation 13 and stayed flat there
  (216.0-216.1MB) for the remaining ~52 generations. End = 216.1MB. Net
  delta over the full window: **-3.29MB** -- stable, not leaking, across 65
  real LLM calls against a real 6,633-function repo.
- **`explanation-cache.sqlite` growth:** row count grew monotonically 0->65,
  exactly matching the 65 successful writes. Live file-size sampling via
  `fs.statSync` read a flat 4096 bytes throughout -- a WAL-mode artifact
  (writes land in the `-wal` file until checkpoint), not a real measurement;
  final size after clean shutdown (`cache.dispose()` checkpoints WAL) was
  **135,168 bytes for 65 rows, ~2.03 KB/row**.
- **Contention hypothesis (session 26 Handoff item 4): CONFIRMED live, with
  real timestamps**, not just diagnosed from code. Request A
  (background-like, `priority-queue.ts::push`) sent 09:48:16.273Z, resolved
  09:48:27.685Z (11,412ms). Request B (hover-like, a distinct trivial
  function, `field-helper.ts::getEnemyParty`) sent 09:48:16.525Z -- 250ms
  later, while A was still unresolved -- but did not resolve until
  09:48:36.380Z: a 19,855ms round trip, resolving **8,695ms after A had
  already completed**. B's response only arrived once A's had fully
  finished, matching the sidecar's confirmed strictly-serial, single-request
  dispatch. This is real corroboration of what session 26 could only infer
  from reading `rpc_server.py`/`sidecarManager.ts` -- not a new finding, but
  the first live one.
- **Errors handled gracefully, as designed:** one real `generate_explanation`
  timeout (~128s, `messages.ts::getPokemonNameWithAffix`) -- caught, logged,
  loop continued without crashing. Repeated non-fatal retrieval failures:
  `all-minilm`'s 512-token context window was too small for many real
  pokerogue chunks (`input length exceeds the context length`), degrading
  the retrieval tier to `call_graph_only` for most generations -- this is
  `_query_retrieved_chunks`'s designed degrade-not-fail path working as
  intended, but see "Handoff" for why the frequency is itself worth a look.

## Blockers / open questions
None blocking this session's own scope. See "Handoff" for follow-up items.

## Handoff for next session
- **`roleCodeLensAutoRefresh.test.ts`'s "adding a function..." assertion is
  now failing** (expected 1 lens for `alpha()`, got 2), confirmed
  reproducible independent of this session's changes (control rerun with
  the two new files removed). This is session 26's own test, last known
  passing when session 26 wrote its own artifact -- something changed its
  behavior since (possibly environmental: VS Code/extension-host version
  drift, or a real regression in `RoleCodeLensProvider` from an
  intervening session). Needs fresh diagnosis, not assumed to be the same
  pre-existing issue session 26's artifact already documented (that was a
  *different* test, the crash-recovery timeout).
- **Sidecar request-contention (session 26 Handoff item 4) is now
  confirmed live, not just diagnosed** -- an interactive request arriving
  ~250ms after a background one can wait 8-9+ real seconds behind it. This
  strengthens, not just repeats, the case for the dedicated scheduling
  session session 26 already recommended (client-side prioritization queue,
  or pausing background indexing while an interactive request is pending --
  see session 26's own three sketched options). Still not attempted here,
  per this session's explicit scope boundary.
- **`all-minilm`'s 512-token context window is frequently too small for real
  pokerogue chunks**, degrading the retrieval tier to `call_graph_only` far
  more often than the fixture repos would ever surface (fixtures are small,
  hand-written files). This wasn't previously measured against a real large
  repo. Worth a future session's attention: either a chunking-size fix
  (`sidecar/retrieval/`) or documenting this as an expected degrade-mode at
  real-repo scale rather than a bug -- not investigated further here (out
  of this session's scope, and not something steps 1-4 asked for).
- **Sidecar RSS and cache growth are both healthy at this scale** (216MB
  stable RSS, ~2KB/row cache growth) -- no action needed, but this is the
  first real numeric baseline for either, worth keeping as a reference point
  if a future session investigates memory or storage complaints.
- The two real-code confirmation tests added this session are scoped to
  `MoveTouchControlsHandler`'s shape only (class-field arrow properties).
  Other pending gaps from sessions 25/26's own handoffs (the JS-side
  `double`/`makeCounter` regression test; the `isFunctionLike` heuristic's
  still-not-manifest-driven per-symbol-kind growth; the `side_effects`
  verbatim-category hallucination) remain untouched, per this session's
  explicit out-of-scope boundary.
