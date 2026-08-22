# Session 26: Gutter decoration staleness fix + push-UI refresh audit

**Date:** 2026-08-21
**Build-order step(s) completed:** None — targeted bug fix + audit, not a Core Build Order step.
**Status:** complete

## Files touched
- [src/extension/codelens/roleGutterDecorations.ts](../../src/extension/codelens/roleGutterDecorations.ts) —
  added a debounced `vscode.workspace.onDidChangeTextDocument` listener (`onDocumentChanged`, wired
  in the constructor) that schedules a `refreshEditor()` pass for every visible editor showing the
  changed document, 300ms after the last edit to that document (`CHANGE_REFRESH_DEBOUNCE_MS`, via a
  new `KeyedDebouncer<string>` instance keyed by `document.uri.toString()`). `dispose()` now also
  disposes the new debouncer. Class doc comment rewritten to explain the root cause and the fix.
  This is the actual production fix for both reported symptoms.
- [src/extension/__tests__/suite/roleGutterDecorations.test.ts](../../src/extension/__tests__/suite/roleGutterDecorations.test.ts) —
  new integration test (real VS Code via `@vscode/test-electron`). Proves a bare text edit — no
  save, no cache write, no editor-visibility change — triggers exactly one debounced re-render, and
  that deleting a function actually clears its decoration (not just "some redraw happened"). See
  "Decisions made" for why it spies on the manager's own `refreshEditor` method rather than
  `editor.setDecorations`.
- [src/extension/__tests__/suite/roleCodeLensAutoRefresh.test.ts](../../src/extension/__tests__/suite/roleCodeLensAutoRefresh.test.ts) —
  new integration test, part of the push-UI audit (item 3 below). Empirically confirms, rather than
  assumes, that `RoleCodeLensProvider` does *not* need the same fix.

No sidecar files touched; no prompt/schema/cache-key changes; no language-manifest changes.

## Decisions made

### Root cause (confirmed, not just hypothesized)
`RoleGutterDecorationManager` only ever redrew on two triggers: `ExplanationCache.onDidWrite` and
editor-visibility changes (`extension.ts` ~120-127, ~224-230). Unlike `RoleCodeLensProvider`, which
VS Code's own CodeLens feature re-invokes (`provideCodeLenses`) automatically after a document edit
(confirmed empirically this session — see item 3), `TextEditorDecorationType` has no such analog:
once `editor.setDecorations()` is called, VS Code's own range-tracking keeps each decoration's
*position* in sync with edits (the usual "marker" behavior — insert a line above and it shifts
down), but the *content* is never recomputed against the current source unless something calls
`setDecorations()` again. With no `onDidChangeTextDocument` listener, nothing ever did.

This single mechanism explains both reported symptoms:
- **Stale after deletion:** delete a function, and its dot has nothing to reset it — it just sits
  parked wherever VS Code's range-tracking carried it to.
- **"Increasing in number" on Enter:** the user-supplied screenshot (gray "pending" dots stacked on
  several *blank* lines, 41-48, with the real function correctly dotted at line 50) is exactly what
  this produces — decorations set at some earlier point, for functions that have since moved or been
  removed, silently drifting to wherever their tracked position ends up as later edits shift
  everything around them, with no later call ever replacing the stale set. Confirmed directly against
  this screenshot, not just inferred from code reading.

### The fix: debounced `onDidChangeTextDocument`, reusing existing precedent
Wired a listener identical in shape to `DirtyTracker`'s own `onDidChangeTextDocument` subscription
(`dirtyTracking.ts:32,46-79`) — same `isSupportedLanguageId` + `e.contentChanges.length === 0`
filtering — and debounced via the project's existing `KeyedDebouncer` (`debounce.ts`, already used by
`SaveReindexManager`), keyed per document URI so unrelated files debounce independently and rapid
edits to the same file collapse to one re-render.

**Debounce value: 300ms, deliberately shorter than `SaveReindexManager`'s 750ms.** That 750ms gates a
real `generate_explanation`/`reindex_file` sidecar RPC; this listener only re-runs
`resolveAllFunctions` (local, LSP-based) + `ExplanationCache.lookup` (local SQLite) — no sidecar call
at all, confirmed by the code-reviewer pass (see "Test status"). Core Rule 11 (sidecar is strictly
one-request-at-a-time) does not apply to this listener for that reason.

### Test approach: spy on `refreshEditor`, not `editor.setDecorations`
First attempt spied on `editor.setDecorations` directly (via `sandbox.spy(editor, 'setDecorations')`)
and failed with `TypeError: Cannot redefine property: setDecorations` — VS Code's real `TextEditor` is
a proxy-backed object with non-configurable property descriptors, the same class of platform
limitation `fakes.ts`'s own doc comment already documents for `child_process`/`net` (Session 17).
Rewrote the test to spy on the manager's own private `refreshEditor` method instead (a plain class
method, no such restriction), cast through a local `ManagerInternals` type. `sandbox.spy` (not
`stub`) calls through to the real implementation, so the actual decoration recompute still runs for
real — the spy only adds an observation point. Confirmed via the test-runner pass that this
approach works and the test passes.

### Push-UI audit (item 3): confirmed, not assumed
- **`RoleGutterDecorationManager`: was buggy, now fixed** (above).
- **`RoleCodeLensProvider`: exempt, confirmed empirically.** `roleCodeLensAutoRefresh.test.ts` proves
  VS Code's own CodeLens feature re-fetches lenses via `vscode.executeCodeLensProvider` after a bare
  document edit, with the provider's `refresh()`/`onDidChangeCodeLenses` never called — this is VS
  Code's own built-in CodeLens invalidation, not something this codebase implements, and it doesn't
  need the same fix.
- **`ExplanationPanelProvider` (docked webview, levels 1-2): exempt, but for a different reason than
  CodeLens.** It refreshes on `onSelectionChanged` (`extension.ts:205`,
  `explanationPanelProvider.ts:110-118`), which is nominally cursor-driven, not edit-driven — but
  typing text *moves the cursor* (the selection advances with every character typed), so
  `onDidChangeTextEditorSelection` fires on effectively every keystroke as a side effect of typing
  itself. This gives the panel a de facto continuous refresh trigger it didn't need to be built with
  on purpose. Confirmed by reading `onSelectionChanged`'s actual trigger condition
  (`editor === vscode.window.activeTextEditor`, no debounce) — it recomputes
  `resolveEnclosingFunction` + cache lookup fresh on every call, so a bare edit is covered by
  construction. Not re-verified with a new automated test this session (the mechanism is inherent to
  VS Code's cursor-tracks-typed-text behavior, not custom logic in this codebase to regress).
- **`StaleTracker`'s UI surface (the freshness badge, Session 13): exempt, confirmed via grep.** Its
  only consumer anywhere in `src/extension/` is `functionHoverProvider.ts:118`
  (`this.getStaleTracker()?.isStale(...)`), rendered into hover markdown text, which VS Code already
  calls `provideHover` fresh for on every hover — pull-based by construction, same as CodeLens's
  underlying VS Code mechanism (just via a different VS Code API). No decoration, no CodeLens, no
  panel use of `StaleTracker` exists to audit.

### Item 4: "long time to generate for a simple sum function" — confirmed mechanism, not fixed
**Could not reproduce live against pokerogue** (no GUI/desktop automation tool available in this
session, same limitation every prior session's artifact already notes for manual VS Code
verification). Investigated via code reading instead, and the mechanism is directly confirmed, not
just hypothesized:

- `SidecarManager.request()` (`sidecarManager.ts:230-264`) writes every request straight to the
  socket with no client-side queue — nothing on the extension-host side serializes hover's
  cache-miss `generate_explanation` call against `BackgroundIndexManager`'s own
  `generate_explanation` calls.
- `sidecar/rpc_server.py`'s `_process_lines` (confirmed by reading `rpc_server.py:302-363`) dispatches
  one message at a time, synchronously, with no concurrency — this is not a guess, it's the same
  fact the codebase's own comments already rely on (`sidecarManager.ts:328-338`'s heartbeat-skip
  logic, and `backgroundIndex.ts:11-17`'s `DELAY_BETWEEN_GENERATIONS_MS` comment, both citing this
  exact one-at-a-time dispatch as settled, previously-diagnosed fact from "Session 6's
  heartbeat-starvation bug").
- `generateAndCache`'s `generate_explanation` call uses a 120-second client-side timeout
  (`GENERATE_TIMEOUT_MS`, `generation.ts:10`) — real LLM generation is genuinely slow.
- **Conclusion:** if `BackgroundIndexManager` has already sent a `generate_explanation` request for
  some unrelated, low-importance function and it's mid-flight when the user hovers a *different*,
  trivial function that happens to be a cache miss, the hover's own `generate_explanation` request
  sits in the socket buffer until the sidecar finishes processing the background one first — which
  can legitimately take up to the full 120s timeout budget, regardless of how trivial the hovered
  function actually is. `BackgroundIndexManager`'s own `DELAY_BETWEEN_GENERATIONS_MS` (1000ms) gap
  between its own generations exists precisely to open a window for exactly this kind of interactive
  request to get its socket write in *first* — but it can't help if the interactive request arrives
  while a background generation is already in flight, since nothing can cancel or reprioritize a
  request the Python side has already started processing.
- **How to confirm this live in a future session:** watch the LucidHover output channel for a
  `cache miss for <fnId> -- requesting generate_explanation` line (from
  `functionHoverProvider.ts:113`) that doesn't resolve for a long stretch, with a
  `background-index: generated <other-fnId>` line (from `backgroundIndex.ts:145`) completing shortly
  after — that ordering is the smoking gun.
- **Not implemented this session, per its own explicit scope.** This is a scheduling/prioritization
  problem, a different shape of work from the UI staleness bug fixed above, and the brief explicitly
  asked for options rather than an in-session fix unless something "small and low-risk" existed — it
  doesn't; every real option touches shared sidecar-request-lifecycle code:
  1. **Client-side request prioritization queue** in `SidecarManager`: hold background-index
     requests back (don't write them to the socket) whenever an interactive request
     (hover-miss/save-reindex/manual-refresh) is pending, and/or let an interactive request jump the
     socket-write order ahead of a queued-but-not-yet-sent background one. Doesn't help a request
     already being processed server-side.
  2. **Pause background indexing while any interactive request is in flight:** `BackgroundIndexManager`
     already awaits each `generateAndCache` fully before its own pacing delay
     (`backgroundIndex.ts:142-152`) — that loop already has a natural insertion point to check "is
     something interactive pending?" before starting its *next* generation, via a small shared flag
     `SidecarManager` could expose (e.g. from `pendingRequests` composition). Doesn't help mid-flight
     contention either, but shrinks the window it can occur in.
  3. A genuine fix for the mid-flight case needs either a server-side priority/preemption protocol
     (real socket-protocol change) or splitting interactive and background traffic onto separate
     sidecar connections/processes — both are meaningfully larger changes than this session's scope.
  Recommend a dedicated future session scoped specifically to sidecar request scheduling.

## Deviations from spec
None. Both new test files use standalone temp files rather than `fixtures/`, consistent with
Session 25's precedent (`functionResolutionTypeScript.test.ts`'s own stated rationale) — neither
needs repomap/call-graph correctness or to satisfy `fixtures/REQUIREMENTS.md`'s structural counts.

## Test status
- `npx tsc -p . --noEmit`: clean.
- `npm run test:unit`: 45 passing (unchanged).
- `npm run test:integration` (default javascript fixture): **15/16 passing.** The one failure
  (`sidecar/SidecarManager (crash recovery) > gives up after MAX_RESTART_ATTEMPTS...`, a 90s timeout)
  is **pre-existing and unrelated to this session** — confirmed via `git status`/`git diff` that
  `src/extension/sidecar/sidecarManager.ts` (a `CONNECT_RETRY_ATTEMPTS` 20→120 fix, with its own
  detailed doc comment about a real 615-file-repo indexing-time issue) was already modified,
  uncommitted, in the working tree *before this session started* — this session never opened or
  edited that file. Both new test files this session added
  (`roleGutterDecorations.test.ts`, `roleCodeLensAutoRefresh.test.ts`) pass in full — 3/3 tests
  across the two files, confirmed on a second full run after fixing the sinon-spy issue described
  above.
- `python -m pytest sidecar/tests/ -q`: **86/87 passing.** The one failure
  (`test_resolves_the_exact_reported_case`, `test_rpc_server.py:35`, expects line 59 but gets 60) is
  **also pre-existing and unrelated** — `fixtures/javascript/repomap/handlers.js` already had an
  uncommitted one-line addition to `handleLoginRoute` before this session started, shifting every
  later function down one line; this session never touched that file either.
- `code-reviewer` pass (scoped to this session's 3 changed/new files only, explicitly told to ignore
  the two pre-existing unrelated files): **no violations.** One "ambiguous, worth a second look, not
  a clear violation" note: `refreshEditor` has no cancellation/version guard against overlapping
  concurrent invocations (e.g. the new edit-triggered call racing a cache-write-triggered
  `refreshAll()` call for the same editor) — confirmed this pattern **predates this session**
  (the same unguarded concurrency already existed between `refreshAll()` and the
  visibility/active-editor listeners before this session's change), but the new listener increases
  how often two passes can actually overlap in practice. Not fixed this session (pre-existing, not a
  regression introduced here) — flagged in "Handoff" below.

## Blockers / open questions
- **Two unrelated, pre-existing uncommitted changes already in the working tree block full green
  test runs**, independent of anything in this session:
  1. `src/extension/sidecar/sidecarManager.ts`'s `CONNECT_RETRY_ATTEMPTS` 20→120 change causes
     `sidecarManager.test.ts`'s crash-recovery timeout test to exceed its 90s Mocha timeout (the test
     itself likely needs its own timeout/stub-timing adjusted to match the new retry budget — not
     investigated further, out of scope for this session).
  2. `fixtures/javascript/repomap/handlers.js`'s added `logEvent('handling login route');` line
     shifts `handleRenderRoute` from line 59 to line 60, breaking `test_rpc_server.py`'s hardcoded
     line assertion.
  Neither was touched this session. Whoever owns that in-progress work (visible in git status at the
  start of this session) needs to either finish it (updating the now-stale test expectations) or
  decide it should be reverted — flagging here so it isn't mistaken for something this session broke.

## Handoff for next session
- **Item 4 (sidecar request scheduling/prioritization) needs its own dedicated session** — see the
  three options sketched above under "Decisions made." Not attempted here per this session's explicit
  scope boundary.
- **The pre-existing `sidecarManager.test.ts`/`test_rpc_server.py` failures** (see "Blockers") need
  resolution by whoever owns that connect-retry-budget work before the suite is fully green again.
- **`refreshEditor`'s lack of a cancellation/version guard against overlapping concurrent calls**
  (code-reviewer's ambiguous note) — pre-existing, not introduced this session, but worth a future
  session's attention now that the new edit-triggered listener makes overlap more likely in normal
  use (e.g. typing while a cache-write-triggered `refreshAll()` from an unrelated file's
  save-reindex is still in flight). A per-document version counter that drops a stale pass's
  `setDecorations()` call on completion would close it.
