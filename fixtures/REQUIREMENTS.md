# Fixture repo requirements

This document is the contract a language's fixture directory must satisfy so all three test
harnesses (the `sidecar/tests/` pytest suite, the `src/extension/__tests__/suite/`
`@vscode/test-electron` integration suite, and `scripts/acceptance_test.py`) can exercise it
through the same general mechanism instead of each harness carrying its own per-fixture
assumptions. Written in Session 23, alongside moving the JavaScript fixture from
`fixtures/sample-repo/` to `fixtures/javascript/` — the first instance of the layout below, not a
special case of it.

## Layout convention

```
fixtures/<language-id>/            -- <language-id> matches a key in the repo-root languages.json
  <a simple single-file source>    -- e.g. sample.js: opened directly by the TS integration
                                       suite (hover/CodeLens/functionResolution tests) and by
                                       @vscode/test-electron as the workspace root
  repomap/                         -- the call-graph corpus: multiple files with deliberate
                                       cross-file structure (see "Structural requirements" below).
                                       This is what sidecar/tests/*.py and
                                       scripts/acceptance_test.py index, via
                                       sidecar/tests/fixture_paths.fixture_repomap_root(language)
                                       or a direct `fixtures/<language>/repomap` CLI arg.
```

`docs/wiki/` under a fixture directory (present under `fixtures/javascript/`) is generated example
*output* from the summary-doc generator (session 15), kept for reference. No test reads it — it is
not part of this contract.

A fixture directory may also contain files in a language deliberately **not** in `languages.json`
(e.g. `fixtures/javascript/sample.py`, and — since session 24 made `languageGating.test.ts` run
against whichever fixture workspace `LUCIDHOVER_FIXTURE_LANGUAGE` selects — `fixtures/typescript/sample.py`
too), used only to prove that unsupported-language files get excluded (session 22's
`languageGating.test.ts`). That is a property of the exclusion test, not a second language fixture —
do not read a stray non-adapter file in a fixture directory as the start of that language's own
fixture. Convention as of session 24: every fixture directory carries its own `sample.py` probe
file (same content, copied not shared) rather than one fixture's probe being reused across
languages — `@vscode/test-electron` only has one workspace root open at a time, so the probe file
needs to exist in whichever fixture is currently the workspace.

## Tier 1: automated, runs on every change

No human in the loop. Every language fixture must support all of these:

- **Parse correctness** — the adapter correctly discovers and counts every function-like
  definition in `repomap/`, with no silent misses or double-counts.
- **Ranked call-graph structure** — importance ranking reflects real caller counts, and
  cross-file call edges resolve correctly (a call in one file to a function defined in another
  file in `repomap/` is found).
- **fnId stability across line-shifting edits** — editing inside one function must not change
  the identity (fnId) of a different function elsewhere in the same file whose only change is
  its line number. See "Structural requirements" below for what this needs from the fixture
  itself.
- **>15-caller truncation behavior** — `CALLER_CALLEE_CAP = 15` (context.py) truncates and
  reports an omitted count correctly.

## Tier 2: human acceptance pass

Runs at that language's own validation session, and again at major prompt changes — **not** at
every `PROMPT_VERSION` bump (Core Rule 10 already requires a bump on any prompt-text edit; this
tier does not run that often). Pass bar (per the spec's v0 Definition of Done): sample 10-15
functions, hover each, at least 8 must be correct and non-obvious. `scripts/acceptance_test.py`
runs the mechanical part (schema/placeholder checks) and produces the report; the actual
correct/non-obvious judgment is a human reading that report. The scarce resource this tier spends
is a human's attention, not CPU — that is why it does not run on every change the way Tier 1 does.

## Structural requirements every language fixture must meet

Derived from what `fixtures/javascript/repomap` already relies on (confirmed directly, see
"JavaScript fixture: checked against this list" below):

1. **Deliberate cross-file call chains** — at least one function in one file calling a function
   defined in a different file, and at least one function called from multiple other files
   simultaneously.
2. **At least one function with no callers and no callees** — an isolated function, to prove the
   zero-callers/zero-callees case renders as empty rather than erroring.
3. **At least one function with more than 15 callers** — to exercise the truncation-with-omitted-
   count path (Tier 1's >15-caller requirement above), not just the cap boundary in the abstract.
4. **At least one function whose line number shifts when an earlier function in the same file is
   edited, with the shifted function's own source left byte-identical** — i.e., two or more
   functions in the same file where one sits below another. This is what Tier 1's fnId-stability
   requirement needs a fixture to exercise: editing the earlier function must shift the later
   one's line without changing its content, so a test can assert the later function's fnId (and
   fn_hash) are unchanged while the edited function's fnId stays the same but its fn_hash changes.
5. **A simple, single top-level file outside `repomap/`** (e.g. `sample.js`) for the TS
   integration suite's hover/CodeLens/functionResolution tests, which exercise one document at a
   time rather than the full call-graph corpus. Named `sample<first-manifest-extension>` by
   convention (`sample.js` for `javascript`, `sample.ts` for `typescript`) — `hover.test.ts`
   derives this filename from `LUCIDHOVER_FIXTURE_LANGUAGE` via the language manifest as of
   session 24, rather than hardcoding one language's filename, so a new fixture only needs to
   follow the naming convention, not edit the suite.

## Cap

At most **four** supported languages before fixture maintenance is revisited as its own decision
— more than that and per-language fixture upkeep (structural requirements above, times N
languages) becomes its own cost worth deciding about explicitly, not something to keep absorbing
one language at a time.

**Counting note (session 24):** TypeScript registers as *two* `languages.json` entries
(`typescript` for `.ts`, `typescriptreact` for `.tsx`) — real JSX needs the `tree-sitter-typescript`
package's `language_tsx()` grammar, while a plain `.ts` file needs `language_typescript()` (using
`language_typescript()` on JSX source silently drops call references inside the JSX, confirmed
directly before splitting the entry — see `sidecar/repomap/queries/typescript_tags.scm`'s header
and the session-24 artifact). Both entries share one `fixtures/typescript/` directory and one
`typescript_tags.scm` query file. For the purposes of this cap, that is **one** language, not two
— count fixture *directories*, not `languages.json` entries, when weighing the cap.

## JavaScript fixture: checked against this list (Session 23)

- Cross-file chains (requirement 1): confirmed — `db.js:insertUser` → `utils.js:validateEmail`;
  `email.js:sendWelcomeEmail` → `utils.js:formatDate`; `handlers.js:validateAndPersistSignup` →
  functions in `utils.js`, `db.js`, and `email.js` simultaneously. (Originally confirmed in
  session 3; reconfirmed by session 20's audit; unaffected by this session's directory move.)
- Zero-callers/callees case (requirement 2): confirmed — `isEmpty` in `utils.js`.
- \>15-caller case (requirement 3): confirmed — `logEvent` in `logging.js`, 17 total callers
  across all 5 files, truncates to 15 shown + "+2 more".
- Line-shift case (requirement 4): confirmed — `handlers.js` has `validateAndPersistSignup`
  immediately followed by `handleSignupRoute` and `retryQueueWorker`; editing inside
  `validateAndPersistSignup` shifts both without changing their content (this is exactly the
  scenario session 18's fnId fix was verified against, via an ad hoc, not-checked-in scratchpad
  script — see that session's artifact). The fixture already supports this; no checked-in
  automated Tier 1 test exercises it yet against the real fixture (flagged in this session's
  artifact, not fixed here — out of scope for a harness/fixture-parameterization session).
- Single top-level file (requirement 5): confirmed — `sample.js`.

**Result: no backfill needed.** Every structural requirement was already true of the fixture
before this session (session 20's audit had already confirmed requirements 1-3 directly); moving
the directory from `fixtures/sample-repo/` to `fixtures/javascript/` did not change file content,
so ranked call-graph output is identical before and after the move.

## TypeScript fixture: checked against this list (Session 24)

`fixtures/typescript/repomap/` — 8 files (`models.ts`, `logging.ts`, `utils.ts`, `db.ts`,
`email.ts`, `audit.ts`, `handlers.ts`, `dashboard.tsx`), 26 functions total, confirmed via
`python -m sidecar.repomap.cli fixtures/typescript/repomap` and checked into
`sidecar/tests/test_repomap_typescript.py`.

- Cross-file chains (requirement 1): confirmed — `db.ts:insertUser` → `utils.ts:validateEmail`;
  `handlers.ts:validateAndPersistSignup` → functions in `utils.ts`, `db.ts`, and `email.ts`
  simultaneously; `dashboard.tsx:Dashboard` (the fixture's one `.tsx` file, parsed via the
  `typescriptreact` entry's `language_tsx` grammar) → `db.ts:findUserByEmail`, proving the
  `.tsx`-backed entry resolves into plain `.ts` files in the same combined call graph, not a
  disconnected one.
- Zero-callers/callees case (requirement 2): confirmed — `isEmpty` in `utils.ts` (also generic,
  doubling as the fixture's generics construct).
- \>15-caller case (requirement 3): confirmed — `logEvent` in `logging.ts`, 21 total callers
  across 6 files, truncates to 15 shown + "+6 more".
- Line-shift case (requirement 4): confirmed — `handlers.ts` has `validateAndPersistSignup`
  immediately followed by `handleSignupRoute` and `retryQueueWorker`, same shape as
  `fixtures/javascript/repomap/handlers.js`'s sequence. Unlike the JS fixture (flagged in
  session 23's Handoff as never getting a checked-in Tier 1 test), this one has one:
  `test_reindex_file_leaves_line_shifted_functions_call_graph_intact` in
  `sidecar/tests/test_repomap_typescript.py`.
- Single top-level file (requirement 5): confirmed — `fixtures/typescript/sample.ts`, line-for-line
  identical structure to `sample.js` (same `add`/`greet`/`double`/`makeCounter` shapes, same line
  numbers) so `hover.test.ts`'s hardcoded `Position`s stay valid once it derives the filename
  itself (see requirement 5 above).
- TypeScript-specific constructs beyond what JS can exercise: interfaces (`models.ts`'s `User`,
  `handlers.ts`'s `SignupPayload`/`RouteContext`), generics (`isEmpty<T>`), a type alias and enum
  (`models.ts`), type-only imports (`import type` in `db.ts`/`email.ts`/`handlers.ts`), a decorator
  (`audit.ts`'s `@traced` on `AuditLogger.record`), and a function whose enclosing scope is a
  namespace (`audit.ts`'s `AuditNamespace.recordNamespaced`) — none of these needed a
  namespace/decorator-aware query pattern; tree-sitter queries match regardless of nesting, so the
  ordinary function/method patterns already catch them (confirmed directly, see
  `typescript_tags.scm`'s header).
- **Session 49 addition:** `audit.ts`'s `AuditLogger.record` (class method) now calls a new
  top-level arrow-const, `auditWrite`, which itself calls `logEvent` (free function) — a
  class-method -> arrow-const -> free-function chain the fixture didn't previously have, added
  specifically to give the graph-view features (`get_blast_radius`/`get_call_trace`, sessions
  45-48) a real multi-hop TS-shape chain to walk (session 49's cross-language validation pass).
  `record` no longer calls `logEvent` directly (it now calls `auditWrite`, which does), so
  `logEvent`'s total caller count is unchanged at 21 — only the function count moved, from 25 to
  26.
