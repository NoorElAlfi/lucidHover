# Session 20: Language-surface audit and manifest design

**Date:** 2026-08-20
**Build-order step(s) completed:** None — audit session per explicit task scope ("Write NO
production code"), preparing the ground for sessions 21-22's adapter work. Not a Build Order
milestone step.
**Status:** complete

## Files touched
- [docs/language-surface-audit.md](../../docs/language-surface-audit.md) — new. Full inventory of
  every hardcoded/assumed-language site across the sidecar and extension host, a proposed
  `languages.json` manifest schema (Q2), the minimum variable-capture accommodation (Q1), evidence
  on `functionResolution.ts`'s symbol-provider dependency (Q3, no recommendation), and confirmation
  of two planning-doc claims against `.claude/sessions/` (Q4).
- [CLAUDE.md](../../CLAUDE.md) — session log table: added `Kind` and `Track` columns, backfilled
  all 19 existing rows plus this session's own row (20), and added a short explanatory note above
  the table for both new columns (Q5).

## Decisions made
- **`Kind` classification scheme**: `milestone` (ordinary build-order step) / `fix` (18, 19, per
  the task's explicit instruction) / `audit` (this session) / `gate` (session 8 only — its own
  title parenthetical, "(v0 completion gate)", is the only session that explicitly names itself as
  a Definition-of-Done checkpoint rather than incremental build-order progress). No other session
  title makes that same claim, so `gate` wasn't applied elsewhere even where a session felt
  significant (e.g. 17's "packaging dry-run").
- **`Track` values**: every row (1-20) gets `Core` — there has only ever been one workstream (the
  JS-only pipeline). Documented in CLAUDE.md itself that `Core` is the deliberate baseline value
  for a column that becomes meaningful once sessions 21+ add parallel per-language adapter tracks,
  not a placeholder name to be replaced later.
- **Manifest schema fields derived only from real hardcoded sites**, not speculative language
  needs — every field in the `languages.json` proposal traces back to a specific file/line found
  in the audit (Section 2's table states the mapping explicitly). Two fields
  (`resolutionStrategy`, `captureKindMap`) are new (not derived from an existing single hardcoded
  constant) because they answer Q1/Q3's forward-looking questions rather than replacing something
  that already exists as a literal.
- **Q1 (variable capture) answered as a two-field addition, not a redesign**: `Tag.capture_kind`
  (sidecar) preserves the capture-name suffix `extract_tags()` currently discards, and
  `captureKindMap` (manifest) declares which capture names exist per language and what kind they
  represent. Both are additive — no existing consumer (`graph.py`, `context.py`,
  `isFunctionLike()`) needs to change for this session's proposal to be accurate, since nothing
  reads either new field yet.
- **Q3 answered as evidence only, explicitly declining to recommend an LSP-wrapping decision** —
  per the task's own framing ("This decision is deferred to the Python adapter and is explicitly
  NOT being made now"). Documented the concrete mechanism (`executeDocumentSymbolProvider` /
  `executeWorkspaceSymbolProvider`, both VS-Code-built-in-symbol-provider-dependent) and the
  specific gap (`resolve_function`'s existence proves even JS, with a built-in language service,
  had a real symbol-provider gap the sidecar's own tree-sitter index had to backstop) without
  choosing `resolutionStrategy` values for any future language.

## Deviations from spec
- None. This session's own scope (audit + manifest proposal, no code) was followed exactly as
  given; the four numbered "Decided" items and the CLAUDE.md table update were all completed as
  specified, none skipped or descoped.

## Test status
- N/A — no production code changed this session (per the task's explicit "Write NO production
  code" instruction). No test suite run.
- Verified factual claims directly against source rather than taking the task prompt's framing on
  faith: every file/line cited in `docs/language-surface-audit.md` was read directly this session
  (not inferred from grep hits alone) before being included in the table. The two planning-doc
  claims (Section 5, Q4) were checked against `session-03-repomap-port.md`'s actual "Test status"
  section text, not assumed true because the task prompt asserted them.

## Blockers / open questions
- None from this session's own scope. Two things intentionally left open **by design**, per the
  task's own instructions, for future sessions to resolve:
  - Which `resolutionStrategy` value (`tree-sitter-only` vs. `lsp-wrapped`) a Python/Rust/Go
    adapter should use, and whether `functionResolution.ts` needs a real fallback/degrade path
    when no `DocumentSymbolProvider` is registered for a language (Section 4 of the audit) — Q3
    was scoped as evidence-only, not a decision.
  - Whether `languages.json` actually gets built as proposed, or the schema gets revised once
    session 21 (presumably the first real adapter) tries to use it against a second language for
    real — this session's proposal is a design based on the JS-only surface as it exists today; a
    second real implementation may surface a field this audit couldn't anticipate from one
    language's evidence alone.

## Handoff for next session
- `docs/language-surface-audit.md` is the reference for sessions 21-22's adapter work — read it
  before starting either. In particular:
  - Section "Summary for sessions 21-22" flags that JS-only file-extension filtering is
    **duplicated in three independently-drifted places** (`sidecar/repomap/extraction.py`'s
    `_JS_EXTENSIONS`, `src/extension/gitHookReindex.ts`'s `.endsWith('.js')`, and
    `src/extension/gitHookInstaller.ts`'s generated shell script's `'*.js'` pathspec) — the latter
    two are missing `.jsx` that the first includes. Worth fixing as part of (not before) whichever
    session first consumes the `languages.json` manifest, since single-sourcing `extensions` from
    the manifest is the natural fix and doing it standalone first would just be thrown away.
  - The manifest schema in Section 2 is a **proposal**, not yet implemented anywhere — no
    `languages.json` file exists in the repo yet. The next session that touches this should decide
    whether to build the loader (sidecar + extension host both reading it) as its own step before
    or alongside the first real second-language adapter.
  - Section 4 (Q3 evidence) is required reading before any decision about how a Python/Rust/Go
    adapter resolves symbols — the gap it documents (no built-in VS Code symbol provider for those
    languages, and no existing fallback/degrade path in `functionResolution.ts`) is real and
    unaddressed, not hypothetical.
- Per Core Rule 8, this audit does not itself start Build Order work or the adapter track — the
  next session should pick up language-adapter work explicitly, informed by this audit, rather than
  treating this session as having already begun it.
