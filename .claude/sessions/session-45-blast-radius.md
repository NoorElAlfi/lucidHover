# Session 45: Blast radius

**Date:** 2026-08-23
**Build-order step(s) completed:** New scope, not a Build Order step (see `lucidhover-session-briefs-45-46-graph-features_1.md`) -- graph-only feature reusing sessions 37/38/44's call-graph machinery.
**Status:** complete

## Files touched
- `sidecar/repomap/context.py` — new `BlastRadiusNode`/`BlastRadiusEdge`/`BlastRadius` dataclasses, `BLAST_RADIUS_MAX_DEPTH = 3` constant, `RepoMap.get_blast_radius()`: a confident-edges-only, depth-capped, cycle-safe BFS over `self.graph` predecessors.
- `sidecar/rpc_server.py` — new `"get_blast_radius"` RPC handler (`_handle_get_blast_radius`, same `read_lock()` + `_find_def_tag` nearest-line-resolution shape as `_handle_resolve_function`/`_handle_generate_explanation`), registered in `_METHODS`; module docstring updated.
- `sidecar/tests/test_repomap.py` — 6 new tests: multi-hop convergent-node walk, depth-cap enforcement, no-callers case, unknown-node case, cyclic/mutual-recursion termination, and the confident-edge filter excluding an ambiguous caller.
- `sidecar/tests/test_rpc_server.py` — 2 new tests for `_handle_get_blast_radius` (real multi-hop chain against the fixture repo; unresolvable-function empty result).
- `src/extension/panel/explanationPanelProvider.ts` — new pinned graph-view render mode: `GraphViewNode`/`GraphViewEdge`/`GraphViewPayload` types (exported so `blastRadiusCommand.ts` and, per the brief, session 46 can reuse them without a circular import), `SHOW_BLAST_RADIUS_COMMAND_ID` constant, `pinned` state + `pendingGraph` fallback, `showGraph()`/`postGraph()`, webview message handling for `showBlastRadius`/`back`, a "See full blast radius →" trigger next to the existing `used_by` section, a depth-grouped-list renderer (`renderGraph`/`renderGraphNode`) plus CSS for it, and a "← Back" control.
- `src/extension/panel/blastRadiusCommand.ts` (new) — `showBlastRadius()` (the actual command logic) + `registerShowBlastRadiusCommand()` (a thin `vscode.commands.registerCommand` wrapper around it); calls `get_blast_radius`, enriches each bare node from `ExplanationCache` via `resolveFunctionsInFile` + nearest-line matching (same memoized-per-file pattern `staleTracking.ts`'s `flagStaleDependents`/`fnIdFor` already uses), leaves an uncached node's `roleTag`/`oneLiner` undefined rather than generating.
- `src/extension/extension.ts` — wires `registerShowBlastRadiusCommand`.
- `package.json` — new `lucidhover.showBlastRadius` command ("LucidHover: Show Blast Radius for Function Under Cursor").
- `src/extension/__tests__/suite/blastRadiusCommand.test.ts` (new) — live integration test against a real spawned sidecar (no Ollama needed) and a small synthetic 4-file temp-dir call graph (`target()` ← `callerA()`, `callerB()` at depth 1; `callerA()` ← `callerOfA()` at depth 2); seeds a cache row for `callerA` only and confirms `callerB`/`callerOfA` render bare with no `generate_explanation` call.

## Decisions made
- `showBlastRadius()` is exported as a standalone function separate from `registerShowBlastRadiusCommand()` (found necessary mid-session, not planned upfront): the integration test runs inside a real Extension Development Host where `extension.ts`'s own activation has already registered `lucidhover.showBlastRadius` for real, so a second `vscode.commands.registerCommand` call for the same id in the test threw `command 'lucidhover.showBlastRadius' already exists`. The test now calls `showBlastRadius(...)` directly, exercising the identical logic the real command invokes, without touching the global command registry a second time.
- `SHOW_BLAST_RADIUS_COMMAND_ID` and the `GraphViewNode`/`GraphViewEdge`/`GraphViewPayload` types live in `explanationPanelProvider.ts`, not `blastRadiusCommand.ts`, even though the brief lists `blastRadiusCommand.ts` as owning the command registration -- the panel's own webview message handler needs the command id (to fire `showBlastRadius` when the user clicks "See full blast radius →" from the cursor-synced view), and `blastRadiusCommand.ts` already needs to import the graph-view types from the panel module to build its payload. Defining them in the panel module and importing into `blastRadiusCommand.ts` avoids a circular import; `blastRadiusCommand.ts` still owns and exports the actual command-registration/logic functions.
- Blast radius nodes render clickable via the existing bare-name `navigate` message (same mechanism `used_by`/`calls` already use), not a new exact-location navigate path, even though each node carries an exact `rel_fname`/`line`. Kept simple and consistent with the panel's one existing navigation mechanism rather than adding a second one; accepts the same pre-existing ambiguous-name-resolution limitation `used_by`/`calls` already have.
- No per-level fan-out cap (unlike `get_function_context`'s `CALLER_CALLEE_CAP`) -- flagged by code-reviewer as worth a conscious note, not fixed this session (see Handoff below).

## Deviations from spec
- None from the session brief's own numbered steps. The `showBlastRadius`/`registerShowBlastRadiusCommand` split (see Decisions above) is an implementation detail the brief didn't specify either way.

## Test status
- Python: 125/125 pass (`python -m pytest sidecar/tests/ -q`), including all 8 new blast-radius tests.
- TS unit: 56/56 pass (`npm run test:unit`).
- TS integration: 24/24 pass (`npm run test:integration`), including the new `blastRadiusCommand.test.ts` against a real spawned sidecar process (no Ollama needed -- `get_blast_radius` issues no LLM call). First integration run caught the command-double-registration bug described above; fixed and re-verified green.
- `code-reviewer` pass: zero rule violations found (checked against every numbered Core Rule in CLAUDE.md, plus BFS correctness, the `confident`-edge filter, RPC handler shape/lock discipline, cache-enrichment-never-generates, and pinned-view state wiring specifically). No fixes were needed.
- `npx tsc --noEmit -p .`: clean throughout.
- Not separately smoke-tested by hand in a real Extension Development Host GUI beyond the automated integration test above (which does run inside a real one) -- no interactive VS Code GUI available in this environment, same documented gap as several prior sessions (e.g. session 43).

## Blockers / open questions
- None.

## Handoff for next session
- Session 46 (vertical slice / execution trace) is next per the brief; it explicitly reuses this session's `GraphViewNode`/`GraphViewEdge`/`GraphViewPayload` types and pinned-panel plumbing (`showGraph`/`postGraph`/`pinned`/`pendingGraph`/"← Back") rather than building a second renderer -- read this artifact plus the brief's session-46 section before starting.
- Not a bug, just flagged by code-reviewer for awareness: `get_blast_radius` has no per-level fan-out cap the way `get_function_context` has `CALLER_CALLEE_CAP` -- a high-fan-in real function (session 44's own motivating example, `setVisible`, had 9+ colliding callers) could in principle return a large node/edge list at some depth. Not observed as an actual problem against any real repo this session; not fixed, since nothing yet establishes it's needed (same "don't add a setting/cap preemptively" reasoning the brief already applied to depth). Worth a real measurement against a large repo (e.g. pokerogue, per sessions 28/29/33's precedent) if it ever surfaces as a real UI/performance complaint.
