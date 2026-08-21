# LucidHover — Session Briefs 20–25

*Paste-ready Claude Code session prompts for the committed phase of the reconciled Build Order.
Each brief is one session. Sessions 27+ stay provisional until the dogfooding gate produces a
friction log — briefs for those get written after the gate, not now.*

**Revision note:** updated after the open-questions decision pass. All twelve questions from the
reconciliation memo are now closed; the briefs below assume those answers rather than raising them.
Where a decision changed a session's scope, it's flagged inline as **[Decided]**.

## Decisions now baked into these briefs

| # | Question | Decision | Effect on 20–25 |
|---|---|---|---|
| 1 | Variables | Stays a Non-Goal; interface accommodates it without building it | Session 20 gains a forward-looking audit question; session 21 designs for symbol kinds |
| 2 | Adapter boundary | Shared `languages.json` manifest + test enforcing `package.json` agrees | Session 20 proposes the schema; 21 and 22 both consume it |
| 3 | Symbol source | Deferred to the Python adapter (post-gate) | Session 20 reports evidence only; session 22 isolates fnId derivation |
| 4 | `PROMPT_VERSION` | Stays global | Session 25 can fix few-shot transfer in-session instead of escalating |
| 5 | Numbering | Global monotonic + `Kind` and `Track` columns | Session 20 adds the columns and backfills 18–19 |
| 7 | Gate scope | 20–25 pre-gate; everything from 27 on is gated | Sequence below is committed |
| 12 | Fixtures | Tiered by run frequency; cap at four languages | Session 23 encodes the tiering in `REQUIREMENTS.md` |

Questions 6, 8, 9, 10, and 11 don't touch sessions 20–25; their answers are recorded in the decision
brief and surface again after the gate.

## Before you start

**Apply the workflow-review changes first.** In particular the `code-reviewer` fix: sessions 22, 24,
and 25 all touch hover and provider code, and the current version of that agent will flag the
session-9 cache-miss fallback as a violation on each of them.

---

## Session 20 — Language-surface audit and manifest design

- **Kind:** audit · **Track:** language · **Status target:** complete
- **Owns:** `docs/` (new audit file), `.claude/sessions/`, `CLAUDE.md` (session log + columns)
- **Writes no production code.**
- **Subagents:** none required.

```text
Session 20 — Language-surface audit and manifest design.

Read only: .claude/sessions/session-19-side-effects-granularity-fix.md, and CLAUDE.md.

This is an audit session. Write NO production code. The output is a document plus a
manifest schema proposal.

Goal: enumerate every place in the codebase where a language is hardcoded or assumed,
across BOTH halves of the system, so the adapter work in sessions 21-22 is designed
against the real surface rather than the sidecar half of it.

Produce docs/language-surface-audit.md covering, for each site: file path, what is
hardcoded, and which half of the system owns it.

Sites to check at minimum — find others:
  - sidecar/repomap/extraction.py: the tree_sitter_javascript grammar binding and the
    tag-query file convention.
  - sidecar/retrieval/chunking.py: whether chunk boundaries are language-aware.
  - package.json: activationEvents, and any contributed language-scoped configuration.
  - src/extension/hover/functionHoverProvider.ts,
    src/extension/codelens/roleCodeLensProvider.ts, roleGutterDecorations.ts:
    the DocumentSelector each provider registers with. Report the literal selector.
  - src/extension/functionResolution.ts: how ResolvedFunction is produced, and whether
    the fnId qualified-name derivation (relFile::enclosingScopeQualifiedName, session 18)
    contains JavaScript-specific assumptions about scope nesting or naming.
  - scripts/acceptance_test.py and both test harnesses: how the fixture repo path and
    language are supplied.

Then produce four things:

  1. [Decided — Q2] A proposed schema for languages.json, a single manifest at repo root
     that is the source of truth for language support. It has been decided that this
     manifest exists; your job is to propose its exact shape based on what the audit
     found, not to argue for or against it. At minimum each entry declares: VS Code
     language id, file extensions, tree-sitter grammar, tag-query file path, exclusion
     patterns, and resolution strategy (tree-sitter-only | lsp-wrapped). Add fields the
     audit shows are needed. Say explicitly which consumer reads each field — sidecar,
     extension host, or both.

  2. [Decided — Q1] One forward-looking question answered in the document: what would
     variable-level symbol capture require of this manifest and of the adapter interface?
     Variables are NOT being built and remain a Non-Goal — the point is to make sure the
     interface can express "which captures map to which symbol kind" so that adding
     variables later is additive rather than a redesign. Propose the minimum
     accommodation, not the feature.

  3. [Decided — Q3] Evidence only, no recommendation requested: document how
     functionResolution.ts obtains symbols today, whether it depends on VS Code's
     document-symbol provider, and what that would imply for a language VS Code does not
     support in-box (Python, Rust, Go). This decision is deferred to the Python adapter
     and is explicitly NOT being made now. Record the facts so it can be made later.

  4. Confirm two claims from the planning docs against .claude/sessions/: (a) that the
     repomap port was session 3, and (b) that fixtures/sample-repo has deliberate
     cross-file call chains, an empty-callers/callees case, and a >15-caller case. If (b)
     is false, say so — the per-language fixture bar would then be higher than
     JavaScript's own baseline, and session 23 has to fix that.

Finally, [Decided — Q5] update CLAUDE.md's session log table: add a `Kind` column
(milestone | fix | audit | gate) and a `Track` column, backfill all 19 existing rows, and
mark 18 and 19 as Kind: fix. Numbering stays global and monotonic — do not introduce a
second scheme.

Write the session-20 artifact using the standard template.
```

---

## Session 21 — Sidecar-side Language Adapter interface and registry

- **Kind:** milestone · **Track:** language
- **Owns:** `sidecar/repomap/`, `sidecar/tests/`, `languages.json` (new), `CLAUDE.md` (core rules)
- **Pure refactor. No new language, no behavior change.**
- **Subagents:** `repo-researcher`, `test-runner`, `code-reviewer`

```text
Session 21 — Sidecar-side Language Adapter interface and registry.

Read only: the session-20 artifact and docs/language-surface-audit.md. Implement the
languages.json schema proposed there.

Goal: extract the JavaScript-specific parsing/extraction logic in sidecar/repomap/ behind
a Language Adapter interface, with JavaScript as the first adapter, driven by the shared
manifest. This is a pure refactor — behavior must be identical when done.

1. Create languages.json at repo root per the session-20 schema, with one entry:
   JavaScript. This file is the single source of truth for language support; nothing else
   may hardcode a grammar name, extension list, or query-file path.

2. Build the adapter interface and registry in sidecar/repomap/adapters/. The sidecar
   reads languages.json at startup and looks up "which adapter handles this file" by
   extension. Files with no registered adapter are skipped, not errored.

3. [Decided — Q1] Design the interface so an adapter can declare which query captures map
   to which symbol kind, rather than assuming every capture is a function. Only the
   function kind is populated and used. Do NOT build variable-level capture, extraction,
   schema, or UI — variables remain a Non-Goal. This is interface shape only, and it
   should cost you a field, not a feature.

4. [Decided — Q2] Add this as a new core rule in CLAUDE.md, and note in the artifact that
   codebase-explainer-vscode-extension.md needs the same amendment as core design
   decision 12:

     "Language support is declared once, in the language manifest. Language-specific data
      (extensions, grammar, query file, exclusion patterns, resolution strategy) lives in
      languages.json and per-language query files. Language-specific logic lives only in
      sidecar adapter implementations. The extension host reads the manifest and contains
      no per-language branching."

Before writing the interface, delegate to repo-researcher: "How does Aider structure its
per-language tag-query files — the .scm convention, where they live, how capture names map
to the tag types the ranker consumes, and how a grammar is bound to a file extension?"
Design the interface to fit that shape so future adapters are query-file drops rather than
code.

Explicitly out of scope — do not build any of it, note it in Handoff instead:
  - Any second language, including TypeScript.
  - Anything in src/extension/ or package.json. The extension host still says JavaScript
    everywhere; session 22 handles that.
  - Any LSP wrapping. lsp-wrapped is a declared enum value with no implementation behind
    it, which is correct for this session. [Decided — Q9] Note in Handoff that when it is
    implemented, LSP responses must be filtered to the workspace root to preserve the
    "no resolution into third-party library internals" non-goal.
  - Changes to ranking, bundling, caching, or the context-bundle format.
  - chunking.py, unless session 20 found it language-aware — in which case bring it under
    the manifest and say so in Deviations.

Done when: the full pytest suite passes unchanged, and the existing JS fixture produces
byte-identical ranked call-graph output to before the refactor. Prove the second claim
rather than asserting it — capture output before and after and diff it.

Run test-runner, then code-reviewer, then write the artifact.
```

---

## Session 22 — Extension-host language surface

- **Kind:** milestone · **Track:** language
- **Owns:** `src/extension/languages.ts` (new), `package.json`, `src/extension/hover/`,
  `src/extension/codelens/`, `src/extension/functionResolution.ts`, `src/extension/__tests__/`
- **Still JavaScript-only in effect.** No new language ships here.
- **Subagents:** `test-runner`, `code-reviewer`
- *This session exists in neither draft plan — it is the gap the reconciliation found.*

```text
Session 22 — Extension-host language surface.

Read only: the session-21 artifact and docs/language-surface-audit.md.

Goal: replace every hardcoded JavaScript binding in the extension host with the shared
manifest, so adding a language later is a one-place change on this side too. Behavior at
the end of this session is unchanged — JavaScript only. This is plumbing, not a feature.

1. Build src/extension/languages.ts. It reads languages.json (the manifest created in
   session 21) and exports the supported-language list and the DocumentSelector derived
   from it. It must contain no per-language branching — if you find yourself writing a
   conditional on a language id, the manifest is missing a field; add the field instead.

   Wire it into:
     - The hover provider's registration selector.
     - The CodeLens provider's registration selector.
     - The gutter decoration provider's language check.

2. [Decided — Q2] package.json's activationEvents cannot read the manifest at runtime —
   VS Code parses them before your code runs — so they stay duplicated. Close that gap
   with a test that fails when package.json's activationEvents disagree with
   languages.json. This test is required, not optional. It is the only thing standing
   between you and a silent drift whose failure mode is cached explanations that no UI
   surface ever displays.

3. [Decided — Q3] Isolate fnId derivation. functionResolution.ts currently obtains symbols
   from VS Code's document-symbol provider. Whether that stays is a deferred decision that
   binds at the Python adapter, not now. Refactor so that the symbol source enters through
   a single function with one clearly-typed input, and the fnId qualified-name derivation
   consumes that rather than reaching for vscode APIs itself. Do NOT change where symbols
   come from, and do NOT change the session-18 fnId scheme — this is about making a future
   swap contained, and any behavior change here is a regression.

4. Define and implement the no-adapter case: for a file whose language has no adapter,
   providers return nothing. Not an empty hover card, not a "not supported" message —
   nothing. Add a test.

Explicitly out of scope:
  - Adding TypeScript or any other language. The manifest has exactly one entry when this
    session ends.
  - Changing functionResolution.ts's symbol source (see 3 — isolate, don't move).
  - Any sidecar changes.

Done when: the Mocha unit suite and the @vscode/test-electron integration suite both pass,
including the new manifest-agreement test and the no-adapter test, and a manual check
confirms hover/CodeLens/gutter still work in the JS fixture repo exactly as before.

Run test-runner, then code-reviewer, then write the artifact.
```

---

## Session 23 — Test-harness and fixture parameterisation

- **Kind:** milestone · **Track:** language
- **Owns:** `sidecar/tests/`, `src/extension/__tests__/`, `scripts/`, `fixtures/`, `CLAUDE.md`
  (file-ownership table)
- **Subagents:** `test-runner`, `code-reviewer`

```text
Session 23 — Test-harness and fixture parameterisation.

Read only: the session-22 artifact.

Goal: make it possible to add a second fixture repo without editing three test harnesses.
Today fixtures/sample-repo is consumed by the pytest suite, the @vscode/test-electron
integration suite, and scripts/acceptance_test.py, each with its own assumptions.

1. Parameterise all three harnesses over (fixture path, language). Move
   fixtures/sample-repo to fixtures/javascript/ and make the JS fixture the first instance
   of a general mechanism rather than a special case. Update CLAUDE.md's file-ownership
   table row for fixtures.

2. [Decided — Q12] Write fixtures/REQUIREMENTS.md. It defines two tiers with different run
   frequencies — this split is the point of the document, not an implementation detail:

     Tier 1, automated, runs on every change: parse correctness, ranked call-graph
     structure, fnId stability across line-shifting edits, and >15-caller truncation
     behaviour. No human in the loop. Every language fixture must support all of these.

     Tier 2, human acceptance pass, runs at that language's validation session and at
     major prompt changes only — NOT at every PROMPT_VERSION bump. This is the 8/10-15
     correct-and-non-obvious bar, and the scarce resource it consumes is your attention,
     not CPU.

   Also record the structural requirements every language fixture must meet: deliberate
   cross-file call chains, at least one function with no callers and no callees, at least
   one function with >15 callers, plus anything else the JS fixture turns out to rely on.

   Record the cap: at most four supported languages before fixture maintenance is
   revisited as its own decision.

3. Check the JS fixture against that checklist. If session 20 found it doesn't meet the
   bar, backfill it here so the JavaScript baseline is real before TypeScript is measured
   against it. If backfilling changes ranked output, that is expected — record the
   before/after in the artifact.

Explicitly out of scope:
  - Creating the TypeScript fixture. That's session 24.
  - Changing what the acceptance test measures or its 8/10-15 bar.
  - Any src/extension/ or sidecar/ production code.

Done when: all three harnesses run green against the relocated JS fixture, invoked with an
explicit fixture parameter rather than a hardcoded path.

Run test-runner, then code-reviewer, then write the artifact.
```

---

## Session 24 — TypeScript adapter and fixture

- **Kind:** milestone · **Track:** language
- **Owns:** `sidecar/repomap/adapters/`, `languages.json`, `package.json`, `fixtures/typescript/`
- **Subagents:** `repo-researcher`, `test-runner`, `code-reviewer`
- *First session where a second language actually ships.*

```text
Session 24 — TypeScript adapter and fixture.

Read only: the session-23 artifact and fixtures/REQUIREMENTS.md.

Goal: TypeScript as the second supported language, end to end — manifest entry, sidecar
adapter, and a fixture repo. This is the first real test of whether the session 21/22
abstractions hold.

1. Manifest: add the TypeScript entry to languages.json — extensions (.ts/.tsx), grammar,
   tag-query file, exclusion patterns, resolution strategy tree-sitter-only.

2. Sidecar: the TypeScript adapter. Delegate to repo-researcher first: "What does Aider's
   TypeScript tag-query file capture, and how does it differ from the JavaScript one?"
   Reuse rather than rewrite where the two overlap.

3. Extension host: add the matching package.json activationEvents entry. Beyond that, the
   extension host should need NO changes — languages.ts reads the manifest. If it needs
   more than the manifest entry plus the activationEvents line, session 22's abstraction
   failed: stop, and say so in the artifact rather than working around it. That signal is
   worth more than a completed session.

4. Fixture: fixtures/typescript/, built to every requirement in fixtures/REQUIREMENTS.md,
   with TypeScript-specific constructs the JS fixture cannot exercise — interfaces,
   generics, type-only imports, decorators, and at least one function whose enclosing
   scope is a namespace.

Explicitly out of scope:
  - Running the Tier 2 acceptance pass and judging quality. That is session 25 — this
    session ships the capability, the next one validates it.
  - Any prompt or few-shot changes. If TS output looks wrong, note it in Handoff; session
    25 owns that.
  - Python, Rust, Go, or any LSP work.

Done when: the manifest-agreement test passes with two languages, the pytest and
integration suites pass against both fixtures, and the sidecar produces a ranked call
graph over the TS fixture with cross-file edges resolved.

Run test-runner, then code-reviewer, then write the artifact.
```

---

## Session 25 — TypeScript validation pass

- **Kind:** milestone · **Track:** language
- **Owns:** `fixtures/typescript/`, `sidecar/generation/`, `src/extension/cache/config.ts`,
  `src/extension/__tests__/`
- **Subagents:** `test-runner`, `code-reviewer`
- **Requires Ollama running with the model pulled.**

```text
Session 25 — TypeScript validation pass.

Read only: the session-24 artifact.

Goal: decide whether TypeScript support is actually good, not just wired up. Three checks,
in order.

1. Tier 2 acceptance pass: run scripts/acceptance_test.py against the TS fixture at the
   standard bar (8/10-15 hovers correct and non-obvious). Record the actual hovers and the
   per-hover judgment in the artifact — the number alone isn't reviewable.

2. fnId stability on TypeScript shapes. Session 18's
   relFile::enclosingScopeQualifiedName scheme was designed and tested on JavaScript; TS is
   the first thing that stresses it. Verify identity is stable across line-shifting edits
   for: overloaded function signatures, namespace-nested functions, class methods, arrow
   functions assigned to properties, and generic functions. Write these as unit tests, not
   a manual check — this is cache-correctness, and a silent regression here reproduces the
   exact bug session 18 fixed.

3. [Decided — Q4] Few-shot transfer. Check whether the model imitates JavaScript idioms or
   phrasing inappropriately on TS code — describing an interface as an object, say.

   If it does not: record that and change nothing.

   If it does: fix it in this session. Add one TypeScript-specific few-shot pair — one
   pair, not a prompt rewrite — and bump the global PROMPT_VERSION. PROMPT_VERSION stays
   global by decision; per-language versioning was considered and rejected, so do not
   propose it. Record the version transition in the artifact the way session 19 did, note
   that the bump invalidates every cached row across both languages, and re-run check 1
   after the change so the recorded acceptance result reflects the shipped prompt.

Explicitly out of scope: adding any third language; touching the adapter interface or the
manifest schema; any cache-key composition change (bumping PROMPT_VERSION's value is
expected — changing what goes into the key is not).

Done when: the acceptance result is recorded with per-hover judgments against the final
prompt, the fnId tests exist and pass, and the few-shot question is closed either way.

Run test-runner, then code-reviewer, then write the artifact.
```

---

## Session 26 — Dogfooding gate

- **Kind:** gate · **Track:** — · **No code.**

Give it a session number and a log row so it can't be skipped silently. Two weeks of real use on
the now-reachable JS/TS corpus. Friction log at `.claude/sessions/dogfooding-log.md`, one line per
friction point. No code changes except actual defects, which land as `Kind: fix` sessions — the
session 18/19 precedent — not as Build Order milestones.

Exit condition: the friction log, read against the provisional list in the reconciliation memo,
produces a re-ordering. Write briefs for what follows *after* that, in this file's format.

## Known post-gate work, already decided

Not scheduled — the gate reorders them — but these are settled enough that they don't need
re-litigating when they come up:

- **Cache GC** *(Q11)* — its own small session. On index completion, drop rows whose fnId isn't in
  the current symbol set or whose `prompt_version`/`model_id` don't match current config. Separate
  from the dashboard's user-facing "clear cache" button, which stays a blunt delete-all. Worth doing
  before the cache is large; the dashboard is what will make the monotonic growth visible.
- **Symbol source** *(Q3)* — decide at the Python adapter, with dogfooding behind you. Session 22
  left the swap contained.
- **Diff-aware explanations** *(Q6)* — if built, diff fields go in their own row keyed by
  `(fnId, prior_content_hash, new_content_hash)`, not folded into the explanation object. The
  explanation stays a pure function of content; a change summary is a function of a transition.
- **Lazy grammar loading** *(Q8)* — dropped. Reopens only if a `.vsix` measurement with real
  grammars comes near the 25 MB default.
- **LSP wrapping** *(Q9)* — filter responses to the workspace root.
- **Doc-comment export** *(Q10)* — out of scope through the gate. If it returns: visible disclaimer
  non-negotiable, plus a diff preview before writing, since it would be the first feature to modify
  files you authored.
