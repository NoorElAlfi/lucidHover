# Language-surface audit (Session 20)

**Scope:** read-only audit. No production code changed. Goal: enumerate every place in the
codebase where a language is hardcoded or assumed, across both halves of the system (sidecar +
extension host), so sessions 21-22's adapter work is designed against the real surface. Per Core
Rule 7/8, this session builds nothing — findings and a manifest proposal only.

---

## 1. Inventory of hardcoded/assumed-language sites

### 1a. Sidecar (Python) — grammar, extraction, retrieval

| File | What's hardcoded |
|---|---|
| [sidecar/repomap/extraction.py:24,26](../sidecar/repomap/extraction.py#L24) | `import tree_sitter_javascript as tsjs`; `_JS_LANGUAGE = Language(tsjs.language())` — one grammar binding, module-level singleton, no per-language dispatch. |
| [sidecar/repomap/extraction.py:27-29](../sidecar/repomap/extraction.py#L27) | `_QUERY_PATH` hardcoded to `queries/javascript_tags.scm`; one `_QUERY` object compiled at import time. |
| [sidecar/repomap/extraction.py:33-34](../sidecar/repomap/extraction.py#L33) | `_EXCLUDED_DEF_NAMES = {"constructor"}`, `_EXCLUDED_REF_NAMES = {"require"}` — a JS-specific correctness workaround (session-03: this tree-sitter binding doesn't evaluate `#not-eq?`/`#not-match?` query predicates, so the exclusion was moved into Python instead of the `.scm` file). Hardcoded as two flat module-level sets, not derived from any per-language config. |
| [sidecar/repomap/extraction.py:100](../sidecar/repomap/extraction.py#L100) | `_JS_EXTENSIONS = (".js", ".jsx")` |
| [sidecar/repomap/extraction.py:103-122](../sidecar/repomap/extraction.py#L103) | `find_js_files()` — walks the repo filtering on `_JS_EXTENSIONS`. This is the **only** file-discovery entry point for both the call-graph indexer (`extract_tags_for_repo`) and, transitively, the retrieval chunker (below). |
| [sidecar/repomap/extraction.py:36](../sidecar/repomap/extraction.py#L36) | `EXCLUDED_DIRS = {"node_modules", ".git", "out", "dist", "build"}` — an ecosystem-specific dir-exclusion list (npm/JS build artifacts), flat and shared by every consumer; not per-language today. |
| [sidecar/repomap/queries/javascript_tags.scm](../sidecar/repomap/queries/javascript_tags.scm) | The tag-query file itself. `sidecar/repomap/__init__.py`'s docstring documents the *convention* ("per-language `.scm` query file") but only one file exists — the convention has never actually been exercised by a second language. |
| [sidecar/retrieval/chunking.py:38,76](../sidecar/retrieval/chunking.py#L38) | `from ..repomap.extraction import find_js_files` — the retrieval tier's file discovery is not independent; it's the same JS-only walk. **Chunk boundaries themselves are not language-aware at all** — `_chunk_file_text` (line 61) is a fixed-size, no-overlap line-window (`CHUNK_LINES = 12`), with no AST/tree-sitter boundary logic for any language. This is a distinct finding from the JS-only file walk: even after a language is added to `find_js_files`'s equivalent, chunking would need no per-language change, because it never looks at syntax at all today. |

### 1b. Extension host (TS) — activation, registration, resolution

| File | What's hardcoded |
|---|---|
| [package.json:19-21](../package.json#L19) | `"activationEvents": ["onLanguage:javascript"]` — the extension does not activate at all for any other language id. No `contributes.languages` grammar/config contribution exists (confirmed: no such key in `contributes`), so there's no other language-scoped `package.json` surface to find. |
| [src/extension/extension.ts:162](../src/extension/extension.ts#L162) | `vscode.languages.registerHoverProvider({ language: 'javascript' }, ...)` — literal `DocumentSelector`. |
| [src/extension/extension.ts:220](../src/extension/extension.ts#L220) | `vscode.languages.registerCodeLensProvider({ language: 'javascript' }, ...)` — literal `DocumentSelector`. |
| [src/extension/dirtyTracking.ts:46](../src/extension/dirtyTracking.ts#L46) | `e.document.languageId !== 'javascript'` guard in `onChange` (on-type dirty tracking). |
| [src/extension/dirtyTracking.ts:83](../src/extension/dirtyTracking.ts#L83) | `document.languageId !== 'javascript'` guard in `onSave`. |
| [src/extension/saveReindex.ts:46](../src/extension/saveReindex.ts#L46) | `document.languageId !== 'javascript'` guard before debounced-save re-index. |
| [src/extension/codelens/roleGutterDecorations.ts:68](../src/extension/codelens/roleGutterDecorations.ts#L68) | `editor.document.languageId !== 'javascript'` guard before gutter-icon redraw. |
| [src/extension/panel/explanationPanelProvider.ts:126](../src/extension/panel/explanationPanelProvider.ts#L126) | `editor.document.languageId !== 'javascript'` guard before the docked panel refreshes for cursor-sync. |
| [src/extension/gitHookReindex.ts:161](../src/extension/gitHookReindex.ts#L161) | `.filter((line) => line.endsWith('.js'))` — filters the git-hook marker file's changed-file list down to `.js` only (drops `.jsx` too — a narrower filter than `extraction.py`'s own `_JS_EXTENSIONS`, an inconsistency worth noting on its own). |
| [src/extension/gitHookInstaller.ts:26-34](../src/extension/gitHookInstaller.ts#L26) | `SHARED_SCRIPT_CONTENT`, the generated `.sh` hook script, hardcodes `git diff --name-only "$old" "$new" -- '*.js'` — a shell pathspec literal, a *third* independent place file-extension filtering is duplicated (alongside `extraction.py`'s `_JS_EXTENSIONS` and `gitHookReindex.ts`'s own `.endsWith('.js')`), and the narrowest of the three (no `.jsx`). |
| [src/extension/functionResolution.ts:22-23](../src/extension/functionResolution.ts#L22) | `isFunctionLike()`'s fallback branch: `symbol.kind === vscode.SymbolKind.Variable && /=>|\bfunction\b/.test(symbol.detail)` — a regex tuned specifically to how VS Code's *built-in JS/TS language service* renders an arrow-function-typed `const` binding's `detail` string. This is a real per-language heuristic embedded directly in resolution logic, not just a selector string. |
| [src/extension/panel/explanationPanelProvider.ts:395-398](../src/extension/panel/explanationPanelProvider.ts#L395) | The workspace-symbol-search navigation fallback strips a trailing `"(...)"` from matched symbol names — "The built-in JS/TS workspace symbol provider names function-like symbols with a trailing `(...)`" (comment, verbatim). Another VS-Code-built-in-JS/TS-service-shaped assumption. |

### 1c. Not hardcoded (confirmed language-agnostic — worth stating explicitly so sessions 21-22 don't waste time re-auditing these)

- `src/extension/cache/config.ts`, `src/extension/cache/hash.ts` — cache-key formula, `fn_id`/`fn_hash` computation are pure string/hash operations over whatever source text and identity string they're given. No language branching.
- `sidecar/cache/hashing.py` — same; hashes context chunks generically.
- `sidecar/generation/prompt.py`'s `SYSTEM_INSTRUCTION` — written in language-neutral prose ("function", "codebase", "caller/callee names"); it never says "JavaScript". The **few-shot examples** (`_EXAMPLE_1`-`_EXAMPLE_4`) are JS-syntax bodies with `.js`-named fictional call sites, which is a soft/implicit stylistic bias (a model asked to explain, say, a Python function is being shown 100% JS-shaped examples) but not a hardcoded branch — flagged for awareness, not listed as a structural site.
- `src/extension/backgroundIndex.ts`, `src/extension/summaryDocGenerator.ts`, `src/extension/backgroundFlush.ts` — no direct language checks; they consume `resolveAllFunctions`/`resolveFunctionsInFile` and the sidecar's `list_ranked_functions`, so they inherit JS-only scope *indirectly* through those two layers rather than hardcoding it themselves.

### 1d. Test harnesses / fixtures

| File | How the fixture repo path and language are supplied |
|---|---|
| [scripts/acceptance_test.py](../scripts/acceptance_test.py) | Takes a `repo_path` positional CLI arg (any directory) and a `--model` flag — no `--language` option. `RepoMap(repo_path)` internally always calls `extract_tags_for_repo`, which is JS-only per 1a above, regardless of what's actually in `repo_path`. Pointing this script at a non-JS repo today silently indexes zero functions rather than erroring. |
| [sidecar/tests/test_repomap.py](../sidecar/tests/test_repomap.py) | Fixtures are inline JS source strings written to `tmp_path`; `test_find_js_files_includes_jsx_excludes_ts` explicitly asserts `.ts` is excluded — i.e., the test suite already encodes "one language, JS/JSX only" as a passing assertion, not just an implementation default. |
| [sidecar/tests/test_rpc_server.py](../sidecar/tests/test_rpc_server.py) | `repo_map` fixture points at the real `fixtures/sample-repo/repomap` directory (JS-only). Per session-19's artifact, `test_resolves_the_exact_reported_case` has a pre-existing unrelated failure (stale line-number assertion) against `handlers.js` — direct coupling to the JS fixture's exact line numbers, not parameterized. |
| [src/extension/__tests__/suite/hover.test.ts](../src/extension/__tests__/suite/hover.test.ts) | Opens `sample.js` by literal filename (`fixtures/sample-repo/sample.js`) and asserts on it directly. |
| `fixtures/sample-repo/` | Entirely JS (`sample.js`, `SearchForm.js`, `repomap/*.js`). No non-JS fixture subdirectory exists anywhere in the repo today. |

---

## 2. [Decided — Q2] Proposed `languages.json` manifest schema

Location: repo root, `languages.json`. One entry per supported language, keyed by a canonical id.
Shape below is derived directly from the sites in Section 1 — every field maps to a real thing
some file above currently hardcodes.

```jsonc
{
  "javascript": {
    "displayName": "JavaScript",
    "vscodeLanguageId": "javascript",
    "extensions": [".js", ".jsx"],
    "treeSitter": {
      "grammarPackage": "tree_sitter_javascript",
      "grammarFunction": "language"
    },
    "tagQueryFile": "javascript_tags.scm",
    "exclusions": {
      "dirs": ["node_modules", "out", "dist", "build"],
      "defNames": ["constructor"],
      "refNames": ["require"]
    },
    "resolutionStrategy": "tree-sitter-only",
    "captureKindMap": {
      "definition.function": "function",
      "definition.method": "function",
      "reference.call": "call"
    }
  }
}
```

Field-by-field, with the consumer(s) established from Section 1 (not guessed):

| Field | Consumer | Replaces / derived from |
|---|---|---|
| `displayName` | both | new — used in UI/error strings, e.g. `functionResolution.ts` error messages, output-channel logs. |
| `vscodeLanguageId` | extension host | `package.json`'s `activationEvents: ["onLanguage:javascript"]`, every `{ language: 'javascript' }` `DocumentSelector` (extension.ts x2), every `document.languageId !== 'javascript'` guard (dirtyTracking.ts x2, saveReindex.ts, roleGutterDecorations.ts, explanationPanelProvider.ts). All six of these become "is this id in the manifest's set of `vscodeLanguageId`s" instead of a literal string compare. |
| `extensions` | both | `sidecar/repomap/extraction.py`'s `_JS_EXTENSIONS`/`find_js_files`; `gitHookReindex.ts`'s `.endsWith('.js')`; `gitHookInstaller.ts`'s `'*.js'` shell pathspec (generated from this list, closing the "three independent copies of the same filter" gap Section 1b flags). Single-sourcing this field is the most direct fix for that inconsistency (today `gitHookReindex.ts`/`gitHookInstaller.ts` are missing `.jsx` that `extraction.py` includes). |
| `treeSitter.grammarPackage` / `.grammarFunction` | sidecar only | `extraction.py`'s `import tree_sitter_javascript as tsjs` / `Language(tsjs.language())` — becomes a dynamic `importlib.import_module(manifest_entry.grammarPackage)` + `getattr(mod, grammarFunction)()` per language, replacing the module-level `_JS_LANGUAGE` singleton with a per-language cache. |
| `tagQueryFile` | sidecar only | `extraction.py`'s hardcoded `_QUERY_PATH`. Path is relative to `sidecar/repomap/queries/`, matching the existing convention documented (but not yet exercised) in `repomap/__init__.py`. |
| `exclusions.dirs` | sidecar only | `EXCLUDED_DIRS` — kept per-language rather than global, since a Python adapter needs `__pycache__`/`.venv`/`venv` and a Rust adapter needs `target/`, none of which are JS-relevant. Manifest loading should still union with a small always-excluded set (`.git`) shared across every language, since that one really is universal. |
| `exclusions.defNames` / `.refNames` | sidecar only | `_EXCLUDED_DEF_NAMES` / `_EXCLUDED_REF_NAMES` — the query-predicate workaround from session 3. Kept per-language because the underlying cause (this project's tree-sitter binding not evaluating `#not-eq?`/`#not-match?`) is binding-version-wide, not JS-specific — a future language's `.scm` file will hit the identical problem the moment it uses those predicates, and will need its own exclusion list for whatever its equivalent of `constructor`/`require` is. |
| `resolutionStrategy` | extension host (decides *how* `functionResolution.ts` should behave), informs sidecar too | New field, not derived from an existing hardcoded value — it's the manifest-level hook for the Core Rule 3 distinction ("Cross-file resolution (post-MVP) wraps existing LSP servers"). `"tree-sitter-only"` means today's path (`vscode.executeDocumentSymbolProvider`/`executeWorkspaceSymbolProvider`, i.e. whatever VS Code's built-in or an installed extension's language service provides) is trusted as-is; `"lsp-wrapped"` is the flag a Python/Rust/Go adapter would set once session 21+ decides to wrap a real LSP server per Core Rule 3, rather than relying on symbol-provider availability that may not exist. **This session does not decide which languages need which value — see Section 3.** |
| `captureKindMap` | sidecar (which captures to extract) + extension host (how to interpret `symbol.detail`/`SymbolKind` per language) | New field — see Section 3 (Q2) below; not derived from an existing single hardcoded site, but from the fact that `isFunctionLike()`'s JS-specific `detail` regex (functionResolution.ts:23) and `extraction.py`'s capture-name-prefix dispatch (`"definition."`/`"reference."`, extraction.py:69-74) are two different, currently-hardcoded halves of the same "which raw signal means 'this is a function'" question. |

Loading: both halves read the same `languages.json` at startup (sidecar at process start alongside its existing config; extension host at `activate()`), keyed by file extension → language id for file-driven lookups (sidecar) and by `vscodeLanguageId` for document-driven lookups (extension host). No schema field above requires the two halves to agree on anything beyond what they already implicitly share today (the extension mapping and language id).

---

## 3. [Decided — Q1] Variable-level capture: minimum manifest/interface accommodation

**Variables remain a Non-Goal.** This section proposes the smallest addition that keeps the door
open, not the feature itself.

Today, "this capture means a function" is decided in two hardcoded places that don't talk to each
other:

- **Sidecar side** (`extraction.py:67-74`): a capture name is dispatched purely by string prefix
  — anything starting with `"definition."` becomes `kind="def"`, `"reference."` becomes
  `kind="ref"`. The `.scm` file's capture names (e.g. `name.definition.function`) already carry
  finer-grained information (`function` vs., in principle, `variable`, `class`, etc.) that
  `extract_tags()` currently throws away — it only keeps the `def`/`ref` prefix, not the suffix.
- **Extension-host side** (`functionResolution.ts:13-27`, `isFunctionLike()`): symbol-kind
  membership is decided by a hardcoded `vscode.SymbolKind` allowlist (`Function`/`Method`/
  `Constructor`) plus one JS-specific regex fallback for `SymbolKind.Variable` symbols whose
  `detail` looks like a function type.

Both are binary today (function-or-not) because that's all v0 needs. The accommodation:

1. **Sidecar**: don't throw away the capture-name suffix. `Tag` (extraction.py:39-48) gains a
   `capture_kind: str` field populated from the part of the capture name after `"definition."`/
   `"reference."` (e.g. `"function"`, `"method"` — whatever the `.scm` file's capture names
   already say), instead of collapsing everything to the current `kind: "def" | "ref"`. This is a
   field addition, not a behavior change — `kind` stays as-is for every existing consumer
   (`graph.py`, `context.py`), and nothing currently reads `capture_kind`.
2. **Manifest**: `captureKindMap` (Section 2) is the per-language declaration of which raw capture
   names exist and what symbol kind each one represents (`"definition.function": "function"`,
   and later, additively, `"definition.variable": "variable"`) — this is what lets a future
   variable-capture feature ask "does this language's `.scm` file even have a
   `name.definition.variable` capture, and if so what should I call it" without hardcoding a
   second `_JS_LANGUAGE`-shaped constant the way `_EXCLUDED_DEF_NAMES` is today.
3. **Extension host**: `isFunctionLike()`'s two current signals (a `SymbolKind` allowlist, and a
   per-language `detail` regex) both need to become manifest-driven rather than hardcoded, but the
   *shape* of that generalization is exactly the same shape needed for capture-kind filtering: "is
   this VS Code symbol kind, or does its `detail` string match this pattern, in the set this
   language's manifest entry says counts as `<kind>`." Building `isFunctionLike()` as a thin
   wrapper over "is this symbol kind X" (parameterized by kind, not hardcoded to "function") means
   adding a `isVariableLike()` later is a new manifest entry plus a new call site, not a rewrite of
   the matching logic itself.

None of this requires deciding *how* variables would actually be captured, cached, or rendered —
only that the capture pipeline (sidecar) and the symbol-matching pipeline (extension host) both
already have a natural seam to add a second `kind` value through, once that's a real feature.

---

## 4. [Decided — Q3] Evidence: how `functionResolution.ts` obtains symbols, and what that implies

**No recommendation. This decision is explicitly deferred to the Python adapter work.** Facts only.

- `resolveEnclosingFunction`/`resolveAllFunctions`
  ([functionResolution.ts:139-191](../src/extension/functionResolution.ts#L139)) call
  `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri)` — this is
  VS Code's built-in command that delegates to whichever `DocumentSymbolProvider` is currently
  registered for that document's language id. **It does not use tree-sitter, and it does not talk
  to the sidecar.** The sidecar's own tree-sitter-derived tags (`extraction.py`) are a completely
  separate symbol source, used only for the call-graph/ranking pipeline, never for hover/cursor
  resolution.
- For `javascript`, VS Code ships a built-in JS/TS language service in-box, so
  `executeDocumentSymbolProvider` always has *something* registered with zero user setup. This is
  why the extension has never needed to think about "what if no symbol provider exists" — for the
  one language it supports, one always does.
- `isFunctionLike()` additionally leans on a *specific* built-in-JS/TS-service behavior: it reads
  `symbol.detail` and regex-matches it for `const foo = () => {}`-style arrow-function bindings
  (Section 1b). This isn't just "VS Code has *a* symbol provider" — it's "VS Code's specific
  built-in JS/TS symbol provider formats `detail` this particular way." A different extension's
  symbol provider for the same language id could format `detail` differently and silently break
  this fallback branch.
- The navigation fallback in `explanationPanelProvider.ts:391-398` similarly depends on
  `vscode.executeWorkspaceSymbolProvider` and on that specific provider's convention of appending
  `"(...)"` to function-like symbol names.
- `sidecar/rpc_server.py`'s `resolve_function` handler (session-08 follow-up, documented at
  rpc_server.py:55-64) exists specifically **because** `executeWorkspaceSymbolProvider` has a real
  gap even for JS: it only knows about symbols in files VS Code's JS/TS service has already opened
  in-memory, not every file in the repo. The sidecar's own tree-sitter-based repomap, built by
  indexing every file directly from disk, doesn't have that gap — `explanationPanelProvider.ts`'s
  navigate command tries `resolve_function` first and falls back to
  `executeWorkspaceSymbolProvider` only on a miss or a disconnected sidecar.
- **VS Code does not ship built-in document/workspace symbol providers for Python, Rust, or Go.**
  Those require a separate installed extension (Python's Pylance, `rust-analyzer`, the Go
  extension) to register one. Confirmed as a fact about VS Code's own architecture, not
  re-derived from this codebase — LucidHover currently has no code path that checks whether such a
  provider is registered, waits for one, or degrades gracefully if none is.
- **Implication left for the Python adapter session to decide, not decided here:** if
  `resolveEnclosingFunction`/`resolveAllFunctions` keep depending on
  `executeDocumentSymbolProvider` for a language VS Code doesn't support in-box, hover/CodeLens/
  gutter/panel resolution for that language would silently return nothing on any workspace that
  doesn't happen to have the matching language extension installed and active — with no error, no
  fallback, and no way for LucidHover to distinguish "genuinely no function here" from "no symbol
  provider is registered for this document at all." Core Rule 3's "LSP-wrapped" post-MVP tier
  (Serena's pattern) is the option already named in the spec for this exact gap; whether to require
  it, degrade gracefully without it, or make it conditional per the `resolutionStrategy` manifest
  field (Section 2) is the open call for session 21+.

---

## 5. Confirming two planning-doc claims against `.claude/sessions/`

**(a) Repomap port was session 3.** Confirmed directly:
[session-03-repomap-port.md](../.claude/sessions/session-03-repomap-port.md) — "Build-order
step(s) completed: 3", files touched list `sidecar/repomap/*`, and its "Test status" section
documents the same fixture repo used today. True.

**(b) `fixtures/sample-repo` has deliberate cross-file call chains, an empty-callers/callees case,
and a >15-caller case.** Confirmed directly, also from session-03's own "Test status" section:

- Cross-file chains: "`db.js:insertUser` → `utils.js:validateEmail`; `email.js:sendWelcomeEmail` →
  `utils.js:formatDate`; `handlers.js:validateAndPersistSignup` → functions in `utils.js`,
  `db.js`, and `email.js` simultaneously."
- Empty case: "`isEmpty` (deliberately unused, calls nothing) shows 0 callers, 0 callees, 0
  omitted on both."
- \>15-caller case: "`logEvent` (17 total callers across all 5 files) ranks highest by importance
  ... and correctly truncates to 15 shown + '+2 more'." (`CALLER_CALLEE_CAP = 15`, per
  `context.py`.)

**Both (a) and (b) are true as stated.** No follow-up needed for session 23 on this specific point
— the JS fixture bar (cross-file chains, empty case, truncation case) is real and already met, so
a per-language fixture for a new adapter has a concrete existing bar to match, not a gap to first
discover. (Separately, per Section 1d: the JS-only *test-suite assertions* — e.g.
`test_find_js_files_includes_jsx_excludes_ts` explicitly asserting `.ts` exclusion — will need
updating alongside any adapter work, but that's an implementation detail of adding a language, not
a fixture-quality gap.)

---

## Summary for sessions 21-22

The JS-only assumption is not concentrated in one layer — it appears independently in **at least
four places that would need to change in lockstep for a second language to work at all**:
(1) `package.json` activation, (2) five separate `languageId`/`DocumentSelector` checks in the
extension host, (3) the sidecar's grammar/query binding, and (4) **three independently-hardcoded
copies** of the JS file-extension filter (`extraction.py`, `gitHookReindex.ts`,
`gitHookInstaller.ts`'s generated shell script) that have already drifted out of sync with each
other (`.jsx` included in one, excluded in the other two). A `languages.json` manifest
single-sources all of these. The one place adding a language is **not** just a manifest edit is
symbol resolution (Section 4) — that's a real design decision, correctly deferred to the Python
adapter session rather than guessed at here.
