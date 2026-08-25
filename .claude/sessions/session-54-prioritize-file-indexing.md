# Session 54: Prioritize a file's indexing on demand

**Date:** 2026-08-25
**Build-order step(s) completed:** None (targeted feature, not a build-order milestone)
**Status:** complete

## Files touched
- `src/extension/prioritizeFileIndexingCommand.ts` (new) — exports `prioritizeFileIndexing()` (the logic) and `registerPrioritizeFileIndexingCommand()` (thin `registerCommand` wrapper, mirroring `blastRadiusCommand.ts`'s split), command id `lucidhover.prioritizeFileIndexing`. Resolves the target document's functions via `resolveAllFunctions`, filters to only those `cache.lookup()` misses on (skip-if-cached, same pattern `BackgroundIndexManager`'s own loop uses), and calls `generateAndCache(..., 'background')` for each, waiting on `sidecar.waitForInteractiveIdle()` before every call.
- `src/extension/__tests__/suite/prioritizeFileIndexingCommand.test.ts` (new) — 4 integration tests against a real (never-`.start()`ed) `SidecarManager` with stubbed `request`/`waitForInteractiveIdle` (same "stub the instance, don't spawn a process" approach `backgroundIndex.test.ts` uses): only-uncached-functions-generated, no-op when everything's cached, no-op when indexing isn't ready, no-op for an unsupported language.
- `src/extension/extension.ts` — imports and registers the new command in `activate()`, right after `registerToggleBackgroundIndexingCommand`.
- `package.json` — new `lucidhover.prioritizeFileIndexing` command entry, and a new `contributes.menus["editor/context"]` section (the first one in this project) gated by `resourceLangId == javascript || typescript || typescriptreact`.
- `src/extension/__tests__/unit/languages.test.ts` — new drift test ("package.json 'Prioritize Indexing' context-menu when-clause agreement") mirroring the existing `activationEvents` drift test, keeping the new menu's `when` clause in sync with `languages.json`.

## Decisions made
- **Standalone command file, not a `BackgroundIndexManager` method.** The session brief offered either shape. This pass needs none of `BackgroundIndexManager`'s state (phase machine, cancellation token, status-bar item) — it's a short, bounded, one-shot loop — so a separate file matches the project's existing convention for this exact shape (`refreshExplanationCommand.ts`, `purgeSupersededCacheCommand.ts`, `blastRadiusCommand.ts`/`callTraceCommand.ts`: an exported logic function plus a thin `registerCommand` wrapper, so tests can call the logic directly without hitting the "command already registered by real activation" problem those files' own comments describe).
- **No `reindex_file` call.** Unlike `SaveReindexManager.reindex()`, there's no changed source to re-parse into the call graph here — only already-current functions the background pass hasn't reached yet. Calling `reindex_file` would have been unnecessary work and out of scope.
- **`'background'` priority on `generateAndCache`, not `'interactive'`.** This is reprioritized *indexing* work the user triggered, not a single-function interactive action like "Refresh Explanation" — matches `BackgroundIndexManager`'s own priority choice and its rationale in `generation.ts`'s doc comment.
- **No inter-generation delay** (unlike `BackgroundIndexManager`'s `DELAY_BETWEEN_GENERATIONS_MS`). Not called for by the brief; each generation still waits on `waitForInteractiveIdle()` first, so interactive traffic is still deferred to. A file-scoped pass is typically a handful of functions, not a whole repo, so the throughput reasoning behind the background manager's delay doesn't obviously transfer — left out rather than copied reflexively.
- **Menu `when` clause gated by `resourceLangId`, matching `activationEvents`' existing precedent, not left ungated.** First draft left the `editor/context` menu entry ungated (`"when": "editorTextFocus"`), reasoning that Core Rule 12 ("language support declared once, in the manifest") argued against hardcoding language ids a second time in package.json. `code-reviewer` correctly pushed back: `package.json`'s own `activationEvents` already hardcodes the three language ids for the identical reason (VS Code parses menu/activation declarations before extension code runs, so they can't read `languages.json` at contribution-registration time) and already accepts that duplication behind a drift test (`languages.test.ts`'s "package.json activationEvents agreement", Session 21's Decided Q2). Leaving the menu ungated would have shown "Prioritize Indexing for This File" in the context menu for every file type (`.md`, `.json`, `.py`, ...), a real UX inconsistency with the rest of the extension, not just a style choice. Fixed to match the established pattern: `resourceLangId`-gated `when` clause plus a new mirroring drift test. The command's own `isSupportedLanguageId` runtime check stays regardless — Command Palette invocation has no `when` clause to filter on, so it's the only gate that path gets.

## Deviations from spec
- None.

## Test status
- Full suite green: 57 TS unit (was 56, +1 — the new menu drift test) + 45 TS integration (was 41, +4 — this session's own suite) + 145 Python pytest (untouched, Python wasn't in scope this session).
- `code-reviewer` pass found zero violations in the new feature code itself (explicitly confirmed Core Rules 4/5/6/7/10, cache-key/filter correctness against `ExplanationCache.lookup()`'s real signature, and per-function error isolation in the generate loop); one real inconsistency flagged (the menu `when` clause, described above) and fixed before this session was considered done. It also flagged, out of scope, that `sidecarManager.ts`/`fakes.ts`/`sidecarManager.test.ts`/`CLAUDE.md`'s session-log line are uncommitted changes matching the already-completed Session 53 — pre-existing, unrelated to this session, not touched here.

## Blockers / open questions
- None.

## Handoff for next session
- None specific. The redundant-generation race between this command and `BackgroundIndexManager`'s own pass (both `'background'` priority, so `waitForInteractiveIdle()` doesn't serialize them against each other) is accepted and documented in `prioritizeFileIndexingCommand.ts`'s own doc comment, per this session's brief — not something a future session needs to revisit unless it's observed to actually matter in practice.
