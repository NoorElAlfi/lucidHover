# LucidHover — Current State (as of Session 19)

*Generated as a planning reference, not a spec to build against. This document describes what
exists in the repository today — architecture, decisions, what's implemented, what's tested, and
what's still open — so it can be read alongside a rough next-steps plan and a language-extension
plan and reconciled into a real Build Order. It is not itself a proposal for what to build next.*

## What LucidHover is

A VS Code extension that explains a hovered function in natural language, relative to the entire
codebase — not just the function body in isolation. Explanations are **pre-generated during
background indexing and served from a local SQLite cache on hover**; hovering is a cache lookup,
not a live LLM call (with one narrow, deliberate exception — see Core Rule 4 below). Fully local:
no API keys, no cloud LLM providers, a bundled small model via Ollama by default with an optional
larger local Ollama model as an upgrade tier.

**Differentiator vs. reviewed OSS tools** (Aider, Continue.dev, Serena, Cody): none of them do
ambient, hover-triggered, pre-cached explanation. LucidHover borrows their solved sub-problems
(call-graph ranking from Aider, embeddings/retrieval conventions from Continue.dev, LSP-wrapping
pattern from Serena — none of these are rewritten from scratch) and puts its own build effort into
the cache/invalidation/hover-UX core and the prompt/content design.

**Current language scope: JavaScript only** (`.js`/`.jsx`, one tree-sitter grammar
`tree_sitter_javascript` — JSX is parsed by the same JS grammar, not counted as a second language).
This was an explicit v0 scope decision ("pick 1 language for v0, based on tree-sitter resolution
quality without needing LSP wrapping; expand post-MVP") that has never been revisited — no second
language has been added. This is almost certainly the most relevant fact for a language-extension
plan to build on.

## Status: v0 + all currently-defined post-MVP work is complete

The spec's Build Order table defines 17 numbered steps (1-8 = v0/MVP, 9-17 = post-MVP). **All 17
are complete.** There is no numbered step 18 defined anywhere in the spec — the project is at a
genuine "everything currently planned is done" point, which is why this planning pass is happening
now.

Two additional, unnumbered bug-fix sessions (18 and 19 in the session log, but explicitly *not*
Build Order milestones) have also landed:
- **Session 18** — fixed `fnId` (the cache's stable per-function identity key) to be stable across
  line-shifting edits. Previously `fnId = relFile::name::line`, so any edit that shifted a
  function's line number (even an unrelated edit earlier in the same file) spuriously invalidated
  its cache entry. Now `fnId = relFile::enclosingScopeQualifiedName` (e.g. `Foo.handle`), with a
  `#n` document-order suffix only for genuine duplicate qualified names. Cost: a one-time full
  cache invalidation (old-format rows become unreachable, no migration was built — consistent with
  how the cache has never had row eviction/GC).
- **Session 19** — fixed a prompt-adherence bug where the `side_effects` output field was
  sometimes a single comma-joined string instead of properly split array elements (both satisfy
  the JSON schema, so this wasn't a schema bug). `PROMPT_VERSION` bumped `few-shot-v3` →
  `few-shot-v4`.

Every commit and its rationale is recorded as a per-session artifact in `.claude/sessions/`
(`session-01-*.md` through `session-19-*.md`), indexed in `CLAUDE.md`'s session log table. That's
the authoritative history — this document is a synthesis of it, not a replacement.

## Architecture

```
VS Code Extension (TypeScript, src/extension/)
  Hover Provider (level 0, cache lookup + narrow fallback)
  CodeLens role badge + gutter icon providers
  Docked WebviewView (levels 1-2, cursor-synced)
  File Watcher (debounced save + dirty-tracking + periodic flush + git hooks)
  Refresh command, staleness badge, summary-doc generator command
  Workspace Trust gate
                    │
                    ▼ (only if workspace trusted)
Python Sidecar (sidecar/, local named-pipe/Unix-socket, newline-delimited JSON-RPC,
                heartbeat + crash-recovery supervision with exponential backoff)
  1. Tree-sitter parse (ported from Aider's repomap.py)
  2. PageRank call graph (ported from Aider's repomap.py)
  3. Local embeddings + retrieval (Continue.dev convention: Ollama embeddings + LanceDB)
  4. Context bundle assembly (token-budgeted, deterministic truncation)
  5. Generation call(s) → structured JSON (Ollama, JSON-schema-enforced output)
  6. Cache write (SQLite, owned by the extension host, not the sidecar)
  7. [Secondary] Template pass → per-file/module Markdown summary docs
                    │
                    ▼
SQLite cache (src/extension/cache/): cache_key -> { explanation_json, generated_at, model_id,
  embedding_model_id, fn_hash, context_hash, prompt_version, context_tier }
```

No cross-file LSP wrapping is implemented yet (the spec calls for wrapping existing LSP servers,
Serena-style, "for languages where tree-sitter alone is weak" — not needed since v0 scoped to one
language where tree-sitter alone is sufficient).

## Core Design Decisions (from the spec, `codebase-explainer-vscode-extension.md`)

1. Pre-generate is the default path. Hover falls through to on-demand generation only as a narrow,
   last-resort fallback (session 9) for a function background indexing hasn't reached yet. The
   docked panel's render path has no such fallback and stays a pure cache lookup, always. *(Worded
   this way as of session 17 — originally stated as an unconditional "never generate on hover,"
   amended to match what session 9 had already built and what CLAUDE.md's Core Rule 4 says.)*
2. Cache key = `hash(fn_source + context_hashes + model_id + embedding_model_id + prompt_version)`.
3. Temperature=0 reduces variance, does not guarantee determinism — invalidation is always
   content-hash-driven, never assumed-safe-to-skip.
4. Invalidate on content hash, never timestamps.
5. Never silently regenerate — only on hash invalidation or explicit refresh.
6. No BYO API keys, no cloud LLM providers. Fully local.
7. Indexing runs in a Python sidecar over a local socket, with heartbeat + auto-restart (hardened
   in session 16 with exponential backoff and a give-up threshold).
8. One cached JSON object per function backs all three explanation tiers AND the secondary summary
   doc — no duplicate generation passes.
9. Change handling uses a layered trigger model (dirty-tracking → debounced save → periodic flush
   → git-hook diff → manual) — fully implemented as of session 12, not just the v0
   debounced-save-only subset.
10. Extension declares and respects VS Code Workspace Trust — sidecar spawn, indexing, and
    generation are all gated on `vscode.workspace.isTrusted`; hover/CodeLens registration is not.
11. Expansion beyond the default hover uses a docked `WebviewView`, not the (still proposed-only,
    confirmed non-shippable) Hover Verbosity API.

**CLAUDE.md's project-instructions layer adds a few more, aimed at how sessions should be run**
(not duplicated from the spec above): borrow-don't-rebuild for the three vendored OSS techniques;
respect the v0/post-MVP split; one session = one milestone, don't pull scope forward.

## Tech stack (as actually implemented)

| Layer | Choice |
|---|---|
| Extension host | TypeScript, VS Code Extension API (stable surface only) |
| Sidecar | Python, local named pipe (Windows) / Unix domain socket (POSIX), newline-delimited JSON-RPC |
| Parsing + ranking | Tree-sitter (`tree_sitter_javascript`) + a ported/adapted `sidecar/repomap/` (from Aider's `repomap.py`) |
| Embeddings | Local, Ollama's `/api/embeddings` (`all-minilm`), Continue.dev-pattern pipeline |
| Vector store | LanceDB |
| Cache store | SQLite via `better-sqlite3` (extension-host-owned, not sidecar-owned) |
| Generation output | Structured JSON, schema-enforced via Ollama |
| Bundled LLM | Local Ollama, `qwen2.5-coder:1.5b` |
| Optional upgrade LLM | User-configured local Ollama endpoint + model (loopback-only, validated and rejected if non-local) |
| Explanation UI | Stable `Hover`/`MarkdownString` (level 0) + `WebviewViewProvider` docked panel (levels 1-2) |
| Change detection | Full layered model: dirty-tracking, debounced save, periodic flush, git hooks, manual refresh |
| Testing | Mocha + sinon + `@vscode/test-electron` (TS), pytest (Python), a scripted acceptance test |
| Packaging | `@vscode/vsce`, `.vscodeignore` added session 17/follow-up — `.vsix` measures ~11 MB |

## Feature inventory (what's actually built, by area)

- **Hover (level 0):** role tag, one-liner, freshness badge (`fresh`/`dirty`/`stale`), "Show more"
  link into the docked panel.
- **Docked panel (levels 1-2):** `why_it_exists`, `used_by`/`calls` (clickable, navigate on click —
  sidecar-side `resolve_function` RPC used ahead of VS Code's own workspace-symbol search),
  `side_effects`, `risk_note`. Renders from the same cached JSON object as the hover, no separate
  generation pass.
- **CodeLens + gutter icons:** role-category badge above each function; gutter icon per role
  category.
- **Background/startup indexing:** walks the full ranked call graph and pre-generates explanations
  for every function not yet cached, on workspace open / first trust grant. Throttled (a fixed
  inter-generation delay) so it can't starve interactive hover/save/refresh requests, since the
  sidecar's RPC dispatch loop is strictly one-request-at-a-time.
- **Change triggers (full layered model):** on-type dirty-tracking (in-memory, no re-index) →
  debounced save (re-parse + hash-diff changed file) → periodic background flush (catches dirty
  functions with no save yet, default 25s) → git-hook diff (`post-checkout`/`post-merge`/
  `post-commit`, appended not overwritten, opt-in install command) → manual full re-index
  (safety-valve command).
- **Retrieval tier:** local embeddings + LanceDB top-k retrieval, added to the context bundle
  alongside call-graph data; degrades gracefully (falls back to call-graph-only context) if the
  embedding model isn't pulled or Ollama is unreachable — never blocks generation.
- **Custom Ollama endpoint tier:** `lucidHover.ollamaEndpoint` setting, spawn-time (sidecar
  restart required), validated as loopback-only; `lucidHover.modelId` setting, per-request (no
  restart needed). Both flow into the cache key so a change invalidates exactly the right rows.
- **Secondary summary docs:** `LucidHover: Generate Summary Docs` command — template pass over
  already-cached per-function JSON, one additional LLM call per file for a purpose paragraph
  (separate `SUMMARY_DOC_PROMPT_VERSION`, doesn't invalidate the main per-function cache). Writes
  real files to `docs/wiki/` in the workspace.
- **Sidecar crash-recovery:** heartbeat-driven and immediate-exit-driven restart triggers, both
  funneled through one recovery loop; exponential backoff (2s/4s/8s/16s/30s), gives up after 5
  consecutive failed attempts with a status-bar indicator and a one-time toast offering a manual
  restart; a manual restart always resets the backoff state, even mid-backoff.
- **Testing infrastructure (session 17):** 39 plain-Node Mocha unit tests (cache-key hashing, the
  SQLite cache layer, the debounce primitive, Ollama-endpoint validation — all vscode-free logic)
  + 9 integration tests running in a real `@vscode/test-electron` Extension Development Host
  (Workspace Trust wrapper correctness, hover's cache-hit-never-touches-sidecar guarantee, and 5
  tests automating the crash-recovery loop's spawn/crash/dispose/give-up/manual-restart paths via
  constructor-injected `spawnFn`/`connectFn` fakes) + the pre-existing `sidecar/tests/` pytest
  suite (79 tests) + `scripts/acceptance_test.py` (the "8/10-15 correct and non-obvious on hovers
  over a real repo" bar from the v0 Definition of Done).
- **Packaging:** `.vscodeignore` added; `.vsix` measures ~11 MB against the Marketplace's 25MB
  default (previously 77 MB before the `.vscodeignore` existed — the dominant excluded content was
  a vendored-clones `reference/` folder never meant to ship). `package.json` still has no
  `publisher`/`repository`/LICENSE — fine for local packaging, would need those for a real
  Marketplace publish.

## Module map

```
src/extension/
  extension.ts                  - activation entry point, wires everything together
  trust.ts                      - Workspace Trust gating wrappers
  functionResolution.ts         - document-symbol -> ResolvedFunction (fnId/fnHash/range/source)
  generation.ts                 - generateAndCache(): sidecar call + cache-key + cache write
  debounce.ts                   - KeyedDebouncer (pure, vscode-free)
  dirtyTracking.ts / staleTracking.ts - in-memory dirty/stale bookkeeping
  saveReindex.ts / backgroundFlush.ts / gitHookReindex.ts / backgroundIndex.ts
                                 - the four change-trigger managers
  gitHookInstaller.ts           - installs/detects git hooks
  refreshExplanationCommand.ts  - manual refresh command
  summaryDocGenerator.ts        - secondary summary-doc generator + command
  cache/
    hash.ts                     - computeFnId / computeFnHash / computeCacheKey (pure)
    ollamaEndpoint.ts           - pure Ollama-endpoint loopback validation (session 17 extraction)
    config.ts                   - MODEL_ID/PROMPT_VERSION/EMBEDDING_MODEL_ID + vscode-config wrappers
    explanationCache.ts         - SQLite cache class (pure, no vscode dependency)
  sidecar/
    sidecarManager.ts           - spawn/socket/heartbeat/crash-recovery supervision
  hover/functionHoverProvider.ts
  panel/explanationPanelProvider.ts
  codelens/roleCodeLensProvider.ts, roleGutterDecorations.ts, roleCategory.ts
  __tests__/
    unit/                       - plain-Node Mocha tests (no vscode)
    suite/ + runTest.ts         - @vscode/test-electron integration tests

sidecar/
  rpc_server.py                 - JSON-RPC server entry point (named pipe / Unix socket)
  repomap/                      - ported/adapted from Aider's repomap.py (extraction, graph, rank, context)
  generation/                   - prompt.py, schema.py, generate.py, ollama_client.py
  retrieval/                    - chunking.py, retrieve.py, vectorstore.py (LanceDB)
  cache/hashing.py              - sidecar-side context-hash helper
  tests/                        - pytest suite (79 tests as of session 19)

fixtures/
  REQUIREMENTS.md               - structural requirements every language's fixture dir must satisfy
  javascript/                   - default fixture (sample.js, repomap/, docs/) -- sessions 1-19's original fixture
  typescript/                   - second-language fixture (sample.ts, repomap/) -- Session 24
scripts/acceptance_test.py      - the v0 Definition of Done acceptance check, scriptable
```

## Explicit Non-Goals (v1, current wording)

No cross-repo indexing. No resolution into third-party library internals. No live/on-demand
regeneration on hover *as the primary mechanism* (pre-generation is the default, with the narrow
cache-miss fallback noted above). No semantic/similarity cache matching — exact content-hash only.
No BYO API keys, no cloud providers, no Ollama Cloud as default. No variable-level explanations. No
diagrams/impact-radius/minimap in v1. Secondary summary docs use template-and-reuse only, no
bespoke pipeline. No indexing/generation in untrusted workspaces. No proposed/experimental VS Code
APIs — stable API surface only.

## Deferred / not yet built (still real gaps, not just "later")

These are the spec's own "Deferred / Next Steps" items that remain genuinely unstarted — not
because they were rejected, but because they were never reached:

- **Variable-level explanations** — different content model, needs its own schema pass.
- **On-demand Mermaid call-chain diagrams, an "impact radius" command, file-level summary
  CodeLens** — explicitly out of v1 scope.
- **A second language.** As noted above, this is the single biggest piece of unstarted scope and
  almost certainly the anchor point for the incoming language-extension plan. Whatever gets
  proposed needs to reckon with: `sidecar/repomap/extraction.py`'s hardcoded `tree_sitter_javascript`
  grammar/query-file convention, `package.json`'s `activationEvents: ["onLanguage:javascript"]`,
  the fixture repo being JS-only, and the spec's own open item about when tree-sitter alone stops
  being sufficient and Serena-style LSP wrapping becomes necessary.
- **Real Marketplace publish** — no `publisher`/`repository`/LICENSE yet; packaging itself
  (`.vsix` size) is now resolved, but publishing was never attempted.
- **SCIP adoption** — spec explicitly says "not needed for v0," never revisited.
- **A few small unresolved "Open Items" from the spec** that don't currently block anything:
  docked-panel default-open-state UX, git-hook install default (auto-with-opt-out vs. fully
  opt-in — currently opt-in via an explicit install command), and whether
  `backgroundFlushIntervalSeconds`'s current default (25s) was ever deliberately tuned vs. just
  picked.

## Known process/tooling notes worth carrying into planning

- **Session Artifact pattern**: every session writes `.claude/sessions/session-<NN>-<slug>.md`
  using a fixed template (Files touched / Decisions made / Deviations from spec / Test status /
  Blockers / Handoff), indexed in `CLAUDE.md`. This has been followed for all 19 sessions and is
  load-bearing for how this project resumes context session to session — worth explicitly deciding
  whether a new plan continues this numbering (20, 21, ...) or starts its own scheme, given
  sessions 18-19 already show what happens when two lines of work claim the same number.
- **File-ownership table** in CLAUDE.md assigns each area (extension host, hover, panel, sidecar,
  vendored repomap code, cache layer, tests, fixtures) an owner path — useful precedent if new
  parallel work (e.g. a second sidecar language backend) needs its own lane.
- **Testing is now real** (session 17) — any new plan can assume unit + integration + pytest
  infrastructure already exists rather than needing to bootstrap it.
- Git history: `master` is a single linear line of squashed/merged session work; three previously-
  parallel bug-fix worktrees were merged and cleaned up as of session 19's follow-up work.
