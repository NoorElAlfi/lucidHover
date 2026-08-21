# Session 25: TypeScript validation pass

**Date:** 2026-08-21
**Build-order step(s) completed:** None — language-adapter track validation work (per session-20's
Track column), not a Core Build Order step.
**Status:** complete

## Files touched
- [src/extension/functionResolution.ts](../../src/extension/functionResolution.ts) — `isFunctionLike`
  now also treats `SymbolKind.Field`/`SymbolKind.Property` as function-like (previously only
  `SymbolKind.Variable`), and falls back to `document.getText(symbol.range)` when `symbol.detail`
  is empty. Required threading a `document: vscode.TextDocument` parameter through
  `isFunctionLike`, `findEnclosingFunctionSymbol`, and `flattenWithQualifiedNames`; all in-file call
  sites updated. See "Decisions made" — this is a real bug fix found by check 2, not a TS-only
  change.
- [src/extension/__tests__/suite/functionResolutionTypeScript.test.ts](../../src/extension/__tests__/suite/functionResolutionTypeScript.test.ts) —
  new. Integration test (real VS Code via `@vscode/test-electron`) against a standalone temp `.ts`
  file (not `fixtures/typescript/`) covering five TS document-symbol shapes: overloaded function
  signatures, a namespace-nested function, a class method, an arrow function assigned to a class
  property, and a generic function. Two tests: (1) every shape resolves as a function at all, (2)
  fnId/fnHash are stable across an in-place content edit (`vscode.workspace.applyEdit`) that shifts
  lines for some shapes but not others.

No sidecar files touched; no prompt/schema changes; no fixture files touched (see "Decisions made"
for why the new test doesn't live under `fixtures/`).

## Decisions made

### Check 1: Tier 2 acceptance pass
- Ran `scripts/acceptance_test.py fixtures/typescript/repomap --model qwen2.5-coder:1.5b --limit
  15` (the standard importance-ranked sample) plus a second, targeted `--functions
  isEmpty,Dashboard,handleSignupRoute,handleLoginRoute` run to specifically exercise constructs the
  ranked-15 sample happened to skip (generics, `.tsx`, interface-typed params) — both against the
  real local Ollama instance. See "Test status" for the full per-hover table.
- **Result: 13/15 correct & non-obvious on the primary ranked sample** (bar is 8/15) — clear pass.
  Two real failures found and recorded (not silently passed): `findUserByEmail` (fabricated
  side-effects with zero basis in the source) and `recordNamespaced` (a self-contradictory
  `why_it_exists`: claims "no callees" in the same sentence it names `logEvent` as a callee). Both
  are pre-existing model/prompt hallucination classes, not something introduced by TS support
  itself — see check 3 below for why this wasn't treated as a TS-transfer issue.

### Check 2: fnId stability on TypeScript shapes
- **Chose real VS Code (integration suite, `suite/`) over a hand-rolled `vscode`-module mock for
  the "unit test."** The session brief's own contrast was with a "manual check" (a human clicking
  through VS Code, session 18's original verification method), not literally the `unit/`
  mocha-plain-node directory. `functionResolution.ts` does `import * as vscode from 'vscode'` as a
  runtime value (calls `vscode.commands.executeCommand`, `vscode.workspace.openTextDocument`, etc.)
  — confirmed directly (`node -e "require('vscode')"` outside the Electron extension host throws
  `MODULE_NOT_FOUND`; no `vscode` shim package exists in `node_modules`) that the real exported
  functions cannot load under the plain-node `unit/` mocha instance at all. A hand-built `vscode`
  mock would have meant guessing what TS document-symbol shapes actually look like — and that guess
  would itself have been the risk this check exists to catch (see the `isFunctionLike` bug below,
  found only because the *real* TS language service's symbols were inspected directly). Running
  against real VS Code + the real built-in TS language service is automated, checked-in, and
  deterministic (no flakiness observed across repeated runs) — it satisfies "not a manual check"
  without trading away realism for speed.
- **New test file lives outside `fixtures/typescript/`, using its own temp `.ts` file instead.**
  This check only needs the real TS language service's document-symbol shapes for five constructs —
  it doesn't need repomap/call-graph/embeddings correctness, so it doesn't need to satisfy (or
  perturb the counts asserted by) `fixtures/REQUIREMENTS.md`'s structural requirements or
  `sidecar/tests/test_repomap_typescript.py`'s exact-count assertions (25 functions, etc.). Adding
  constructs to the governed fixture would have meant updating those counts for no benefit to what
  this check is actually verifying.
- **Found and fixed a real, pre-existing "silent miss" bug, not specific to TS:** confirmed directly
  (via an instrumented run of the new test, before the fix) that `isFunctionLike` returned `false`
  for `Widget.handler = (): void => { ... }` (a class-field arrow property) — its `SymbolKind` is
  `Field`/`Property` (7/6), never checked at all previously (only `Variable` was). Also confirmed —
  by dumping the *real* fixture's own `sample.ts`'s symbols — that `double`/`makeCounter` (plain
  top-level `const x = () => {...}` arrow functions, the exact case `isFunctionLike`'s
  `Variable`-kind branch was originally written for) have an **empty** `symbol.detail` in the
  bundled VS Code 1.134.0 test instance, meaning the pre-existing `detail`-regex check was already
  silently failing for ordinary arrow-const functions in general — this predates TypeScript support
  entirely and would affect the JavaScript fixture identically (not re-verified against a JS
  integration test in this session, since fixing it made the point moot going forward; see
  "Deviations from spec"). Fixed by falling back to `document.getText(symbol.range)` (the symbol's
  own source text) when `detail` is empty, and by adding `Field`/`Property` to the kind check.
  Confirmed via the new test (both failing before the fix, both passing after) and via the
  `code-reviewer` pass (no other caller of the changed functions exists in the repo).
- **This fix is language-agnostic, not TS-specific logic.** `isFunctionLike` operates purely on
  `vscode.SymbolKind` values and document text — no `languageId`/`vscodeLanguageId` branching, no
  per-language config read. Confirmed by the `code-reviewer` pass: no Core Rule 12 violation. The
  code-reviewer did flag (as "ambiguous, not a violation") that this extends an already-acknowledged
  piece of tech debt — `docs/language-surface-audit.md`'s Section 4 already names
  `functionResolution.ts`'s `isFunctionLike` as "a real per-language heuristic embedded directly in
  resolution logic" pending a future manifest-driven generalization (deferred explicitly since
  session 22). This session grows that heuristic (adds `Field`/`Property`, adds a text-fallback)
  rather than moving it into the manifest — a deliberate choice: generalizing `isFunctionLike` into
  manifest-driven config is out of scope for a bug-fix-scoped validation session (and isn't listed
  in this session's own scope), but the bug itself directly threatened this check's own pass/fail
  determination, so leaving it unfixed wasn't an option either. Flagged again in "Handoff" so the
  eventual manifest-driven refactor doesn't miss this session's addition.
- **No new false-positive class introduced.** The `document.getText`-fallback regex
  (`/=>|\bfunction\b/`) is the same regex the pre-existing `detail`-only check already used, just
  applied to source text instead of (empty) detail text when detail is absent — same class of
  heuristic risk (a Field whose value literally contains the substring `function` or `=>` in a
  string), not a new one, and no such false positive occurred anywhere across the acceptance test's
  25-function fixture or the new test's 5 shapes.

### Check 3: Few-shot transfer
- **Closed: no JS-idiom-on-TS transfer detected. Prompt unchanged, `PROMPT_VERSION` unchanged.**
  Specifically checked TS-specific vocabulary handling across all 19 explanations generated this
  session (15 ranked + 4 targeted): the `@traced` decorator function was correctly identified as *"a
  utility decorator that logs the name of each method it decorates"* (not described as a plain
  function or method); `AuditNamespace.recordNamespaced` was correctly described as producing *"a
  namespaced audit event"*; the generic `isEmpty<T>` function's actual behavior (null/undefined/
  empty-string check) was described correctly despite the generic signature and the `as unknown`
  cast in its body; interface-typed parameters (`SignupPayload`, `RouteContext`) were never
  mischaracterized (they also just weren't discussed at the type level in either direction — no
  "it's an object" language, no type-system commentary at all, correct or otherwise). No instance of
  JS-flavored phrasing bleeding onto a TS-specific construct was found in any of the 19 samples.
- **A separate, pre-existing, cross-language hallucination pattern was found and is explicitly NOT
  fixed here**, per the check's own binary branching ("if it does not [imitate JS idioms]: record
  that and change nothing" — a different defect class doesn't reopen that branch). `isEmpty<T>`
  (TS) and `handleLoginRoute` (TS) both produced a `side_effects` array that is a near-verbatim copy
  of the prompt's own illustrative category list (`prompt.py`'s field rule: *"a database write, a
  network/API call, reading or writing a file, sending a message or notification, or mutating a
  parameter or global"* — the model output *"reading or writing a file"*, *"sending a message or
  notification"*, *"mutating a parameter or global"* verbatim for BOTH, despite neither function
  doing any of those three things). This is the same failure class session 19 diagnosed and fixed
  for JS (the bracketed-example version's verbatim-copy hallucination) — **but confirmed NOT to be
  TS-specific**: ran the JS fixture's own `isEmpty` (utils.js, non-generic, otherwise identical
  logic) through the same acceptance script and got a *different* hallucination (a fabricated caller
  claim plus return-value-described-as-side-effect), not the verbatim-category-copy pattern — i.e.
  both languages show hallucination on this same zero-callers/zero-callees "pure predicate" function
  shape, just manifesting differently, which points to general model-flakiness-on-trivial-functions
  rather than a TS-triggered regression. Recorded in "Handoff" for a future session, matching how
  session 19 itself left a related quality issue ("return value described as side effect") open as
  an explicitly out-of-scope observation.

## Deviations from spec
- **The `isFunctionLike` fix is broader than TypeScript validation strictly required.** Session 25's
  brief named "arrow functions assigned to properties" as one of five TS shapes to verify stability
  for — it didn't ask for a fix if one was needed, and didn't scope the fix to TS-only. Fixed anyway
  because: (a) the bug is a silent, total exclusion (not a wrong-but-present fnId), which is a
  correctness class this project treats as always worth fixing on discovery (same severity class as
  session 18's original fnId bug); (b) the bug is provably not TS-specific (confirmed via
  `sample.ts`'s own `double`/`makeCounter`), so a TS-scoped patch would have been the wrong shape of
  fix for the actual defect; (c) leaving it unfixed would have made check 2's own "fnId tests exist
  and pass" done-criterion false for a construct explicitly named in this session's brief.
- **The JS fixture side of this fix was not re-verified with an integration test.** Confirmed via
  the sidecar-independent `sample.ts`-symbol-dump evidence that `double`/`makeCounter` were affected
  before the fix, and confirmed via `npm run test:integration` (default JS fixture, no
  `LUCIDHOVER_FIXTURE_LANGUAGE` override) that the full existing JS suite still passes after the
  fix — but no new assertion was added proving `double`/`makeCounter` themselves now resolve
  correctly on the JS fixture specifically (the new test file only opens a temp TS file). Flagged in
  "Handoff."

## Test status
- `npx tsc -p ./ --noEmit`: clean (confirmed via test-runner agent).
- `npm run test:unit`: **45 passing** (unchanged from session 24's baseline; confirmed via
  test-runner agent).
- `npm run test:integration` (default, `javascript` fixture): **13 passing** (~56s; confirmed via
  test-runner agent — unaffected by the `functionResolution.ts` change).
- `LUCIDHOVER_FIXTURE_LANGUAGE=typescript npm run test:integration`: **13 passing** (~56s;
  confirmed via test-runner agent) — up from session 24's 11, the +2 being the new
  `functionResolutionTypeScript.test.ts` file's two tests. Both failed before the `isFunctionLike`
  fix (confirmed directly, not just inferred) and both pass after.
- `python -m pytest sidecar/tests/ -q`: **87 passed** (unchanged from session 24's baseline;
  confirmed via test-runner agent — this session touched no sidecar files).
- `code-reviewer` pass: **no violations found.** One "ambiguous, worth double-checking" note (the
  `isFunctionLike` heuristic-growth point, addressed above under "Decisions made"); confirmed the
  `document` parameter threading is complete and consistent, confirmed no other caller of the three
  changed functions exists anywhere in the repo, confirmed the new test's `before`/`after` fixture
  strings actually differ and the line-shift assertions aren't trivially true (explicitly checks
  that `area()`'s line increased AND that `Widget.render`'s line did not), confirmed only stable VS
  Code APIs are used throughout.
- Tier 2 acceptance pass, full per-hover table (primary ranked-15 sample,
  `fixtures/typescript/repomap`, `qwen2.5-coder:1.5b`, all 15/15 passed the automated schema filter
  with 0 issues):

  | # | Function | Verdict | Why |
  |---|---|---|---|
  | 1 | `logEvent` (logging.ts) | PASS | Correctly describes shared console-logging utility and its real caller list. |
  | 2 | `validateEmail` (utils.ts) | PASS | Correctly describes the regex-based email check and its role. |
  | 3 | `validateAndPersistSignup` (handlers.ts) | PASS | Correctly describes the orchestration and both real callers; `side_effects: []` is a minor field-level miss (narrative says "no side effects... worth flagging" despite the function clearly persisting/emailing/logging) but doesn't affect the overall correctness of the explanation. |
  | 4 | `findUserByEmail` (db.ts) | **FAIL** | `side_effects` fabricates `"Reading or writing a file"` / `"Sending a message or notification"` — neither happens anywhere in this function (it logs and returns `null`, full stop). No basis in the given source. |
  | 5 | `hashPassword` (utils.ts) | PASS | Accurately describes the actual (deliberately fake) reverse+suffix "hash." Misses an opportunity to flag `risk_note` for the obviously-insecure scheme, but doesn't state anything false. |
  | 6 | `formatDate` (utils.ts) | PASS | Correct, accurate ISO-8601-slice description. |
  | 7 | `updateUser` (db.ts) | PASS | Correct spread-merge description, correct real caller. |
  | 8 | `deleteUser` (db.ts) | PASS | Correct, faithful to the stub body. |
  | 9 | `sendPasswordReset` (email.ts) | PASS | Correct, faithful — doesn't overclaim an actual network send beyond what the stub does. |
  | 10 | `renderTemplate` (email.ts) | PASS | Correct description of the template-string construction. |
  | 11 | `insertUser` (db.ts) | PASS | `side_effects: ["Writes to the database"]` is an inference beyond the literal stub body (which just returns a spread object) but is a defensible, name/role-grounded inference, same class of judgment call session 19's artifact already accepted as a known limitation. |
  | 12 | `sendWelcomeEmail` (email.ts) | PASS | Correct, faithful. |
  | 13 | `traced` (audit.ts, a TS decorator function) | PASS | Correctly identifies it as *"a utility decorator"* — genuine TS-construct awareness, not JS-flavored mischaracterization. |
  | 14 | `record` (audit.ts, `AuditLogger.record`, a decorated class method) | PASS | Correct description; doesn't need to mention the class/decorator context, consistent with session 24's decided "v0 explains functions, not classes" scope. |
  | 15 | `recordNamespaced` (audit.ts, `AuditNamespace.recordNamespaced`) | **FAIL** | Self-contradictory: `why_it_exists` states *"logs it using the `logEvent` function... does not have any callers or callees"* in the same sentence — but `calls: ["logEvent"]` is correctly populated, i.e. the narrative text directly contradicts the function's own `calls` field. |

  **Result: 13/15 correct & non-obvious — comfortably clears the 8/15 bar.**

  Supplementary targeted sample (`--functions isEmpty,Dashboard,handleSignupRoute,handleLoginRoute`,
  not part of the official 15-count, used only to probe generics/`.tsx`/interface-typed-param
  handling for check 3): `handleSignupRoute` and `Dashboard` (the fixture's one `.tsx` function) were
  both correct and non-obvious; `handleLoginRoute` and `isEmpty<T>` both hit the verbatim-category
  hallucination described under check 3 above (counted toward check 3's finding, not toward the
  official Tier 2 pass rate above).

## Blockers / open questions
- None blocking.

## Handoff for next session
- **The `side_effects` verbatim-category-list hallucination (check 3's non-blocking finding) is
  open and cross-language** — confirmed present on both `fixtures/typescript/repomap` (`isEmpty<T>`,
  `handleLoginRoute`) and `fixtures/javascript/repomap` (`isEmpty`, different manifestation: a
  fabricated caller claim). Most visible on zero-callers/zero-callees "pure predicate" functions.
  Worth a future prompt-quality session's attention (same category of work as session 19, but a
  different specific defect) — not a TypeScript-support gap, so not blocking for this validation
  pass, and explicitly not fixed here per check 3's own scope.
- **`isFunctionLike`'s per-symbol-kind heuristic (`functionResolution.ts`) grew again this
  session** (added `Field`/`Property`, added a source-text fallback) without being folded into the
  manifest-driven generalization `docs/language-surface-audit.md` Section 4 already flagged as
  future work (deferred since session 22). Still not done; this session made the case for it
  slightly stronger (two additions to the same acknowledged-debt spot in two sessions) but did not
  attempt it — out of scope for a bug-fix-scoped validation session.
- **`double`/`makeCounter` (`fixtures/javascript/sample.js`'s own arrow-const functions) were never
  given a dedicated regression test proving they resolve correctly** post-fix, even though they were
  the concrete evidence that motivated the fix's scope (not TS-only). The existing JS integration
  suite passing is reassuring but not a direct assertion. A cheap addition for whichever session
  next touches `hover.test.ts` or adds a JS-side `functionResolution` test.
- **`codebase-explainer-vscode-extension.md`'s Core Rule 12 amendment is still outstanding**, carried
  forward unchanged from sessions 21-24's own handoffs — still not touched this session either (not
  in scope; this session's `isFunctionLike` change doesn't touch language-manifest logic).
- Python/Rust/Go, or any LSP-wrapped `resolutionStrategy` work, and the 4-language-cap fixture
  question — untouched, per this session's explicit out-of-scope boundary (no third language added).
