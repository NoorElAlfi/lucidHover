# Session 21: Sidecar-side Language Adapter interface and registry

**Date:** 2026-08-20
**Build-order step(s) completed:** None — this is language-adapter track work
(per session-20's Track column), not a Core Build Order step. First real
adapter-track implementation session, following session 20's audit.
**Status:** complete

## Files touched
- [languages.json](../../languages.json) — new. Repo-root manifest, one entry
  ("javascript"), matching session-20's Section 2 schema field-for-field.
- [sidecar/repomap/adapters/base.py](../../sidecar/repomap/adapters/base.py) — new.
  `Tag` dataclass (moved from `extraction.py`, gains an additive
  `capture_kind: str | None = None` field per [Decided — Q1]),
  `LanguageManifestEntry`/`TreeSitterSpec`/`Exclusions` dataclasses parsing
  `languages.json`, and the `LanguageAdapter` `Protocol`.
- [sidecar/repomap/adapters/tree_sitter.py](../../sidecar/repomap/adapters/tree_sitter.py) — new.
  `TreeSitterAdapter`: the generic, manifest-driven tree-sitter parsing loop
  (moved verbatim from `extraction.py`, generalized to read grammar
  package/function, query file, and exclusion sets from a
  `LanguageManifestEntry` instead of module-level JS constants). Carries the
  Aider-AI attribution comment that used to live in `extraction.py`, since
  this is where the ported `get_tags_raw()`-derived loop now actually lives.
- [sidecar/repomap/adapters/registry.py](../../sidecar/repomap/adapters/registry.py) — new.
  `LanguageRegistry` (loads `languages.json`, builds one `TreeSitterAdapter`
  per entry, dispatches "which adapter handles this file" by extension via
  `os.path.splitext`, skips unregistered extensions) and a process-wide
  `get_registry()` singleton.
- [sidecar/repomap/adapters/__init__.py](../../sidecar/repomap/adapters/__init__.py) — new. Re-exports.
- [sidecar/repomap/extraction.py](../../sidecar/repomap/extraction.py) — rewritten.
  `extract_tags`, `extract_tags_for_repo`, `find_js_files`, `EXCLUDED_DIRS`,
  and `Tag` keep identical names/signatures for every existing caller
  (`context.py`, `graph.py`, `retrieval/chunking.py`, tests) but now delegate
  entirely to the adapter registry — no JS-specific parsing logic remains in
  this file.
- [CLAUDE.md](../../CLAUDE.md) — added Core Rule 12 (language manifest single-sourcing,
  per [Decided — Q2]) and this session's session-log row.

## Decisions made
- **One generic adapter class, not a `JavaScriptAdapter` subclass.** Once
  grammar package/function, query-file path, and def/ref exclusion names all
  come from the manifest, nothing JS-specific remains in the parsing loop
  itself — `TreeSitterAdapter` is registered once per manifest entry
  regardless of language. Per repo-researcher's findings on Aider's own
  structure (`get_scm_fname(lang)` is a pure `f"{lang}-tags.scm"` lookup, and
  `get_tags_raw`'s capture dispatch has no per-language special-casing beyond
  the query file itself), this matches the shape Aider already uses: a
  second tree-sitter-based language should cost a manifest entry + `.scm`
  file, not a new Python class.
- **[Decided — Q1] `Tag.capture_kind`, `captureKindMap` implemented exactly
  as session-20 proposed.** `TreeSitterAdapter.extract_tags` looks up the raw
  capture name (e.g. `"definition.function"`, `"definition.method"`,
  `"reference.call"`) in the manifest's `captureKindMap` and stores the
  result in the new field. `Tag.kind` (`"def"`/`"ref"`) is unchanged and
  still the only field `graph.py`/`context.py` read. This cost one field, not
  a feature, per the session's own framing.
- **Extension-to-adapter dispatch uses `os.path.splitext`, not
  `str.endswith(tuple)`.** Chosen because a manifest-driven registry needs a
  language-agnostic lookup (`ext -> language_id` dict), not a
  per-language hardcoded tuple check. code-reviewer flagged one real, narrow
  discrepancy from the original `_JS_EXTENSIONS`/`endswith` check: a file
  whose *entire basename* is exactly `.js` or `.jsx` (no name before the
  dot) would have matched under `endswith` but does not under `splitext`
  (`os.path.splitext('.js')` returns `('.js', '')`, an empty extension).
  Judged inconsequential — no real source file is named exactly `.js`/`.jsx`
  — and left as-is rather than special-cased, to keep the dispatch mechanism
  uniform across future languages. Noted here rather than fixed silently.
- **Grammar/query loading moved from JS-module-import time to first
  `get_registry()` call.** The original `extraction.py` compiled `_QUERY` at
  module-import time (fail-fast on a broken grammar/query at import). The
  registry now does the equivalent eager compilation, but on first access
  rather than at `import sidecar.repomap.extraction`. Functionally
  equivalent for every current caller (`extraction.py`'s own module-level
  `EXCLUDED_DIRS = set(get_registry().excluded_dirs)` line still forces the
  registry to build at `extraction.py` import time, same as before) — flagged
  by code-reviewer as a timing change worth noting in case a future caller
  ever depends on import-time fail-fast without also importing
  `extraction.py` first.
- **Aider attribution comment relocated, not duplicated.** code-reviewer
  correctly flagged that the ported `get_tags_raw()`-derived loop moved to
  `tree_sitter.py` without its attribution comment following it (only
  `extraction.py`'s now-inaccurate docstring still named Aider). Fixed:
  `tree_sitter.py` now carries the Apache-2.0/Aider-AI attribution (since
  that's where the loop lives), and `extraction.py`'s docstring points
  readers there rather than re-describing ported code it no longer contains.

## Deviations from spec
- None from this session's own instructions. `chunking.py` was confirmed
  language-agnostic in its own logic (per session-20's audit, Section 1a) —
  it only reuses `find_js_files` for file discovery — so per the task's own
  conditional ("unless session 20 found it language-aware"), it was correctly
  left untouched.

## Test status
- `python -m pytest sidecar/tests/` — **79 passed**, unchanged from before
  the refactor (no test file was modified).
- Proved behavior-identity rather than asserting it, per the task's
  instruction: captured `python -m sidecar.repomap.cli
  fixtures/sample-repo/repomap` output before the refactor (via `git stash`
  to isolate the pre-refactor tree) and after, and `diff`'d them —
  **byte-identical**.
- Independently re-verified via the `test-runner` agent (79/79 passed) and
  `code-reviewer` agent (one real finding — the attribution-comment
  placement above, now fixed and re-verified with a second full pytest run
  + CLI diff after the fix, still 79/79 and byte-identical).

## Blockers / open questions
- None blocking. Two items intentionally deferred, per the task's own
  out-of-scope list:
  - `resolutionStrategy` (`"tree-sitter-only"` today) is parsed into
    `LanguageManifestEntry` but not consumed by anything yet — it's an
    extension-host concern (session 22) and a future LSP-wrapped-adapter
    concern (Core Rule 3). Per [Decided — Q9], when `lsp-wrapped` is
    implemented, LSP responses must be filtered to the workspace root to
    preserve the "no resolution into third-party library internals"
    non-goal — this is not implemented or enforced anywhere yet, since no
    `lsp-wrapped` adapter exists.
  - The `.js`/`.jsx`-as-whole-basename dispatch discrepancy noted above is a
    real, if vanishingly unlikely, edge case difference from the pre-refactor
    behavior. Not fixed this session (see Decisions).

## Handoff for next session
- **codebase-explainer-vscode-extension.md needs the same amendment as
  CLAUDE.md's new Core Rule 12** (per [Decided — Q2]) — add it as core design
  decision 12 in the spec doc itself. Not done this session since the task
  scoped the CLAUDE.md edit only and asked for this note instead.
- **Session 22 is the natural next step**: wire the extension host
  (`src/extension/`, `package.json`) to read `languages.json` instead of its
  five hardcoded `languageId === 'javascript'` checks and two literal
  `DocumentSelector`s (session-20's audit, Section 1b) — this session
  deliberately left all of `src/extension/` and `package.json` untouched.
- **`find_js_files`/`extract_tags_for_repo` are still JS-named**, not
  generalized to be language-agnostic (e.g. `find_files_for_repo`) — this
  was explicitly out of scope this session per the task's instruction to
  keep the refactor "pure" (identical names/signatures for every current
  caller). Whichever session adds a second sidecar-side language will need
  to decide whether `context.py`'s `RepoMap` should index every registered
  language's files or stay JS-only-by-name a while longer; today's
  `LanguageRegistry.discover_files` already returns a `dict[language_id,
  files]` shape ready for that, but nothing calls it with more than the
  `"javascript"` key yet.
- **`gitHookReindex.ts`'s `.endsWith('.js')` and `gitHookInstaller.ts`'s
  generated `'*.js'` shell pathspec are still hardcoded and still missing
  `.jsx`** (session-20's audit, Section 1b/Summary) — this session only
  single-sourced the sidecar side of the JS-extension duplication. The
  extension-host side of that fix is part of session 22's manifest-reading
  work, not this session's scope.
