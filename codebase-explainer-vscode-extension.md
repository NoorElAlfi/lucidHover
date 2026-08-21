# LucidHover — Codebase-Aware Function Explainer (v7 Plan)

## Project Summary

VS Code extension that explains a hovered function in natural language, relative to the entire codebase. Explanations are pre-generated during background indexing and served from a cache on hover — hover is a lookup, never a live LLM call.

**v1 scope: functions only.** Variables/closures deferred (see Deferred section).

**Differentiator:** no reviewed OSS tool (Aider, Continue.dev, Serena, Cody) does ambient hover-triggered pre-cached explanation. Borrow their solved problems (ranking, retrieval, cross-file resolution); build effort goes into the cache/invalidation/hover-UX core and the prompt/content design.

## v0 / Definition of Done (MVP — build this first, in full)

**Goal:** prove the core thesis — ambient, pre-cached, hover-triggered explanation, using only the bundled local model — before investing in anything that improves quality or polish rather than proving the concept.

**Scope cuts from full v1, all deferred to post-MVP:**

| Include in v0 | Defer to post-MVP |
|---|---|
| Extension skeleton + hover provider | CodeLens role badges + gutter icons |
| Workspace Trust gating | Custom local Ollama endpoint tier |
| Ported Aider repomap (call-graph ranking only — no embeddings) | Continue-style embeddings + retrieval layer (top-k semantic chunks) |
| Sidecar + socket + heartbeat | Full layered change-trigger model (dirty-tracking, periodic flush, git hooks) |
| SQLite cache + hashing | Staleness UI (freshness badge) |
| Real generation: bundled `qwen2.5-coder:1.5b`, JSON schema + few-shot prompt | Secondary summary-doc generator |
| Two-surface UI: hover (level 0) + docked panel (levels 1-2) | Sidecar crash-recovery hardening |
| Debounced save + manual refresh command only (invalidation) | Packaging / Marketplace publish |

**Context bundle for v0 runs on call-graph data alone** (own source + ranked callers/callees from the ported repomap). No embeddings-based retrieval yet — that's a real quality reduction, accepted deliberately to validate the concept faster.

**Invalidation for v0** is debounced save (re-parse + re-index the changed file) plus the manual refresh command, pulled forward from its later milestone. Dirty-tracking, periodic background flush, and git-hook diffing are real refinements, not required to prove the concept.

### Acceptance test (the actual "done" check)

Open a real personal repo with genuine cross-file call chains (e.g. the PokeRogue bot or Showdown bot). Hover over 10-15 functions not written in the current session. **Pass bar: at least 8 of them produce an explanation that is correct and non-obvious** — telling you something the code and its inline comments didn't already make clear.

Write this as an actual repeatable test (not just a manual spot-check) during the generation session (build-order step 6 / session 6 below), not deferred to the full test-suite pass — you want a fast way to know if the concept is working well before you're deep into later sessions.

**If the acceptance test fails:** the fix is prompt/schema iteration (session 6-7) or reconsidering the bundled model size (`1.5b` → `3b`), not adding scope back in from the "defer" column. Adding embeddings retrieval or a bigger model too early would confound whether the core ambient-hover-cache concept works at all.

## Core Design Decisions (do not relitigate)

1. Pre-generate is the default path. Hover falls through to on-demand generation only as a narrow,
   last-resort fallback (Session 9) for a function background indexing hasn't reached yet — see
   CLAUDE.md's Core Rule 4 for the exact scope. This is not an exception to reach for elsewhere:
   the docked panel's render path has no such fallback and stays a pure cache lookup, always.
2. Cache key = `hash(fn_source + context_hashes + model_id + embedding_model_id + prompt_version)`.
3. Temperature=0 reduces variance, does not guarantee determinism — invalidation is always content-hash-driven, never assumed-safe-to-skip.
4. Invalidate on content hash, never timestamps.
5. Never silently regenerate — only on hash invalidation or explicit refresh.
6. No BYO API keys, no cloud LLM providers. Fully local (see Rejected Directions).
7. Indexing runs in a Python sidecar over a local socket, with heartbeat + auto-restart.
8. One cached JSON object per function backs all three explanation tiers AND the secondary summary doc — no duplicate generation passes.
9. Change handling uses a layered trigger model (dirty-tracking → debounced save → periodic flush → git-hook diff → manual), never a single trigger. **v0 exception: debounced save + manual refresh only — see v0 Definition of Done above.**
10. Extension must declare and respect VS Code Workspace Trust — the sidecar executes parsing/embedding/LLM code against workspace contents. See "Workspace Trust" below.
11. **Expansion beyond the default hover uses a docked WebviewView, not the Hover Verbosity API.** Confirmed (2026-08): `editorHoverVerbosityLevel` has been a proposed-only API since April 2024 with no stable graduation — it requires `enabledApiProposals`, only runs in VS Code Insiders, and cannot ship to the Marketplace. This is a resolved decision, not an open risk — do not revisit without checking whether the API has since stabilized (search for `vscode.proposed.editorHoverVerbosityLevel.d.ts` — if this file no longer exists and the members appear directly in stable `vscode.d.ts`, it has graduated).

## OSS to Borrow (clone, don't rebuild)

| Component | Repo | License | Take |
|---|---|---|---|
| Call-graph ranking | [Aider-AI/aider](https://github.com/Aider-AI/aider) → [`repomap.py`](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py) | Apache-2.0 | Tree-sitter extraction + PageRank ranking + token-budget packing. **Required for v0.** |
| Local embeddings/retrieval | [continuedev/continue](https://github.com/continuedev/continue) | Apache-2.0 | Local embedding pipeline, vector index pattern, `.gitignore`-respecting scope. **Post-MVP.** |
| Cross-file/language resolution | [oraios/serena](https://github.com/oraios/serena) | MIT | Wraps existing LSP servers — use for languages where tree-sitter alone is weak. **Post-MVP** (v0 scopes to one language where tree-sitter alone is sufficient). |
| Symbol format (optional) | [sourcegraph/scip](https://github.com/sourcegraph/scip) + [scip-python](https://github.com/sourcegraph/scip-python)/[scip-typescript](https://github.com/sourcegraph/scip-typescript) | Apache-2.0 | Adopt only if per-language extractor effort otherwise too high. Not needed for v0. |

## Architecture

```
VS Code Extension (TS): Hover Provider (level 0 only, cache lookup) │
CodeLens/gutter [post-MVP] │ Docked WebviewView (levels 1-2, cursor-synced) │
File Watcher (debounced save only in v0) │ Refresh command │ Workspace Trust gate
                    │
                    ▼ (only if workspace trusted)
Python Sidecar (local socket, JSON-RPC, heartbeat, auto-restart)
  1. Tree-sitter parse (Aider repomap)
  2. PageRank call graph (Aider repomap)
  3. LSP wrap for weak-resolution languages (Serena) [post-MVP]
  4. Local embeddings + .gitignore-aware retrieval (Continue convention) [post-MVP]
  5. Context bundle assembly (token-budgeted, deterministic truncation;
     v0 = call-graph only, no retrieved chunks)
  6. ONE generation call/function → structured JSON (all tiers)
  7. Cache write
  8. [Secondary, post-index, post-MVP] Template pass → Markdown summary docs
                    │
                    ▼
SQLite cache: key -> { explanation_json, generated_at, model_id,
  embedding_model_id, fn_hash, context_hash, prompt_version, context_tier }
```

## Workspace Trust

VS Code disables or limits extensions that execute code against workspace contents when a folder is opened in Restricted Mode — this applies directly since the sidecar parses, embeds, and runs LLM inference over arbitrary workspace files.

- Declare `capabilities.untrustedWorkspaces.supported: "limited"` in `package.json`.
- In limited/untrusted mode: hover provider and CodeLens may register, but sidecar spawn, indexing, and any generation must be blocked until `vscode.workspace.isTrusted` is true.
- Listen for `vscode.workspace.onDidGrantWorkspaceTrust` to trigger indexing once trust is granted, rather than requiring a reload.
- Surface clearly in first-run UX: "Indexing paused — trust this workspace to enable LucidHover," not silent inaction.

## Handling Active Development (Change Triggers)

**Full model (post-MVP).** No single trigger suffices — pure time-debounce still burns compute re-analyzing unfinished edits; save-only misses dozens of saves/hour; commit-only leaves hovers stale through an entire session.

| Trigger | Fires on | Action | v0 status |
|---|---|---|---|
| On-type dirty-tracking | Every keystroke, in-memory only | Flag touched `fn_hash` as `dirty` — no re-index | Post-MVP |
| Debounced save | ~500ms-1s after last edit, or blur/tab-switch | Re-parse changed file, hash-diff functions, re-index only changed ones | **In v0** |
| Periodic background flush | Configurable, default ~20-30s (`lucidHover.backgroundFlushIntervalSeconds`) | Catches `dirty` functions with no save event yet | Post-MVP |
| Git-aware hook | `post-checkout`/`post-merge`/`post-commit` | Diff vs. previous HEAD, re-index only changed files — never full rebuild | Post-MVP |
| Manual full re-index | Command palette, rare | Full rebuild — safety valve only | **In v0** |

Notes: `dirty` (in-memory, unconfirmed) is distinct from `stale` (confirmed dependency changed, cached explanation may be wrong). Git hooks are appended, never overwritten, and offered opt-in on first activation in a repo. Sidecar keeps its own exclusion list (`node_modules`, build output, `.git`) independent of VS Code's file watcher.

## Hover UX & Content Model

### Two-surface design (resolved — see Core Design Decision #11, required for v0)

All three tiers render from **one cached JSON object per function** — moving between surfaces never triggers a new LLM call, only a different render of already-cached data.

| Surface | API (stable only) | Shows |
|---|---|---|
| Default hover | `vscode.languages.registerHoverProvider()` + `MarkdownString` | `role_tag`, `one_liner` only — level 0 |
| Docked panel | `WebviewViewProvider` registered in the Secondary Side Bar, content synced to cursor position | `why_it_exists`, `used_by`, `calls`, `side_effects`, `risk_note` — levels 1-2, all at once |

Interaction: hover shows the one-liner immediately. A `command:` link at the bottom of the hover ("Show more →") opens/focuses the docked panel and scrolls it to the current function. The panel persists and updates as the cursor moves to other functions.

### Visual rules
- Hover header always shows role tag + freshness (`🔧 Handler · fresh`). **v0 note:** with only debounced-save invalidation, freshness state is simpler than the full dirty/stale model — treat as `fresh` immediately after a successful re-index, no intermediate `dirty` display in v0.
- One-liner: bold, exactly one sentence.
- Empty fields (`side_effects: []`, `risk_note: null`) render as nothing in the docked panel, never "N/A" — silence means confirmed-none, not unknown.
- `used_by`/`calls` in the docked panel: clickable name-only links that navigate on click (webview posts a message back to the extension host to trigger `vscode.window.showTextDocument`).
- Hover itself stays within VS Code's supported hover HTML subset (`h1-h6`, `hr`, `strong`, `em`, `code`, `a`, `span[color|background-color]`, `ul/li`, `table`); the docked panel is a full webview, not bound by that subset.

### Beyond the hover (post-MVP, function-scoped)
- CodeLens role badge above each function (reuses cached fields, zero interaction).
- Gutter icon per role category (`TextEditorDecorationType.gutterIconPath`).
- Minimap markers: defer until CodeLens/gutter are shipped and validated.

## Output Schema + Prompt Design

```json
{
  "role_tag": "Handler",
  "one_liner": "Validates and persists a new user signup.",
  "why_it_exists": "Signup needs validation before any DB write — shared by both the live route and the async retry path.",
  "used_by": ["handleSignupRoute", "retryQueueWorker"],
  "calls": ["validateEmail", "hashPassword", "db.insertUser"],
  "side_effects": ["writes to DB", "sends welcome email"],
  "risk_note": "retryQueueWorker calls this without rate limiting — duplicate signups possible."
}
```

- Use the backend's structured-output/JSON-schema enforcement mode, not prose-instructed formatting — keeps small local models from drifting on shape over thousands of generations.
- Prompt rules: one sentence for `one_liner`; `why_it_exists` must reference actual given callers/callees, not generic reasoning; empty array/`null` when nothing applies, never invented filler; `used_by`/`calls` are names only (already pre-truncated upstream — model must not append "and more" text).
- Few-shot: 2 worked examples, each showing a `Reasoning:` step before the JSON — measurably helps small models actually use supplied call-graph context for `why_it_exists` instead of paraphrasing the function body.
- Input slot: `{fn_source}`, `{caller_names}`, `{callee_names}`, `{context_bundle}` → `Reasoning:` → JSON. **v0: `context_bundle` is call-graph-derived only, no retrieved chunks.**

## Context Budget

- Own function source: unlimited.
- Caller/callee signatures: cap ~15 each, ranked by Aider-style PageRank proximity; `+N more` marker included in the context hash.
- Top-k retrieved chunks: k=5, ~200 tokens each. **Post-MVP — not present in v0's context bundle.**
- Over-budget truncation order: retrieved chunks → caller signatures → callee signatures. Never truncate own source.
- Store which context tier was actually used in the cache entry, to distinguish "smaller budget" from "real dependency change."

## Secondary Output: Codebase Summary Docs (post-MVP)

**Explicitly secondary — a rendering target for data already computed, not a second pipeline.** If it ever needs its own prompts or test suite, it has become a separate product and belongs in its own milestone, not here. Not part of v0.

- Overview page, per-file/module pages, key-functions index (repo-wide PageRank ranking).
- Generation: template pass over existing per-function JSON; one LLM call per file/module for the purpose paragraph.
- Invalidation: reuses the layered triggers above (post-MVP) — no separate staleness model.
- Output: real files (`docs/wiki/*.md`), user chooses whether to commit or gitignore.

## LLM Backend Strategy

No API keys, no cloud providers. **v0 uses the bundled model only** — the custom-Ollama-endpoint tier is post-MVP.

1. **Bundled default (v0):** `qwen2.5-coder:1.5b` (benchmark `3b` against the fixture repo before deciding — this is exactly what the acceptance test in v0's Definition of Done is for).
2. **Custom local model (post-MVP):** user-supplied local Ollama endpoint. `qwen3:8b` recommended at 8GB VRAM; `qwen3.6:27b` if VRAM is unconstrained.

**Rejected:** BYO API keys. Ollama Cloud as a default backend. If reconsidered, scope Ollama Cloud only as an explicit per-function opt-in "escalate" action, never a default indexing path.

## Deferred / Next Steps (post-MVP and beyond)

- **Background/startup pre-generation indexing (Build Order step 9)** — closes the Core Rule 4 gap where hover still falls back to synchronous on-demand generation for any function not yet pre-generated by a save or refresh. See Build Order step 9 for the full rationale and open design questions.
- Custom local Ollama endpoint tier.
- Continue-style embeddings + retrieval layer.
- Full layered change-trigger model (dirty-tracking, periodic flush, git hooks).
- CodeLens badges, gutter icons, minimap markers.
- Manual refresh polish + staleness badge UI.
- Secondary summary-doc generator.
- Sidecar crash-recovery hardening.
- Packaging / Marketplace publish.
- Variable-level explanations (different content model — needs its own schema pass).
- On-demand Mermaid call-chain diagrams, "impact radius" command, file-level summary CodeLens.

## Build Order

**v0 / MVP (sessions 1-8 — build this first, in full, per the Definition of Done above):**

1. Extension skeleton, hover echoing raw text — no LLM, no cache, no sidecar.
2. Declare Workspace Trust capability; gate all sidecar/indexing behind `isTrusted`.
3. Research + port Aider's repomap into the sidecar (ranking only, no embeddings); validate against a 10-20 function fixture repo with deliberate cross-file call chains.
4. Sidecar process + socket protocol + heartbeat stub.
5. SQLite cache schema + cache-key hashing + hover-to-cache wiring (stub generation, no real LLM yet).
6. Connect real generation with the bundled model, JSON schema + few-shot prompt; confirm cache-hit behavior under edits. **Write the acceptance test in this session.**
7. Implement the two-surface design: level-0 hover + docked WebviewView for levels 1-2, both rendering from one cached object.
8. Debounced save re-indexing + manual refresh command. **Run the acceptance test — this is the v0 completion gate.**

**Post-MVP (sessions 9-17 — only after v0 passes its acceptance test):**

9. **Background/startup pre-generation indexing.** Closes a real gap flagged at the end of v0 (session-08 artifact's follow-up, and Core Rule 4/Core Design Decision #1): the hover provider's cache-miss path has called `generate_explanation` synchronously since Session 5, which v0's Build Order never actually built a fix for -- Session 8's debounced-save work only pre-generates functions in files that get saved during the session, not the whole repo. Build an actual background indexing pass (triggered on workspace open / first Workspace Trust grant, per Core Rule 6) that walks the full ranked call graph and pre-generates explanations for every function not yet cached, so hover becomes cache-lookup-only in practice, not just in intent. Needs its own design pass before implementation: what exactly triggers it, how it's throttled/paused/cancelable (the sidecar's RPC loop is strictly one-request-at-a-time -- see Session 6's heartbeat-starvation bug -- so an unthrottled full-repo pass could starve hover/save/refresh requests for a long stretch), and how it de-dupes against work debounced-save and manual refresh already do, without regenerating the same function twice.
10. CodeLens role badge + gutter icon providers.
11. Continue-style local embeddings + `.gitignore`-aware retrieval; extend cache key with `embedding_model_id`.
12. Full layered change-trigger model: dirty-tracking, periodic flush, git-hook diff re-index.
13. Staleness indicator UI (freshness badge beyond simple fresh/stale binary).
14. Custom local Ollama endpoint tier; confirm cache invalidates on `model_id` change.
15. Secondary summary-doc generator (template pass + per-file synthesis call).
16. Sidecar crash-recovery hardening.
17. Full unit + integration test suite, packaging dry-run (verify `.vsix` size against 25MB Marketplace default).

## Packaging & Distribution (post-MVP)

- VS Code Marketplace's default upload limit is 25MB per `.vsix`. A bundled Python sidecar runtime plus a GGUF model file will likely exceed this.
- Options: (a) ship the extension without model weights, first-run download via Ollama/llama.cpp's own pull mechanism; (b) request a Marketplace size-limit exception; (c) publish platform-specific `.vsix` packages.
- Prefer (a): keeps the extension package thin, avoids re-uploading multi-GB assets on every version bump. Not relevant until post-MVP packaging session.

## Tech Stack

| Layer | Choice |
|---|---|
| Extension host | TypeScript, VS Code Extension API |
| Sidecar | Python, local socket/named-pipe JSON-RPC |
| Parsing + ranking | Tree-sitter + Aider's `repomap.py` |
| Cross-file resolution | Wrapped LSP servers (Serena pattern) — post-MVP |
| Embeddings | Local (`all-MiniLM-L6-v2` or equivalent), Continue.dev convention — post-MVP |
| Vector store | Chroma or LanceDB — post-MVP |
| Cache store | SQLite via `better-sqlite3` |
| Generation output | Structured JSON (schema-enforced) |
| Bundled LLM | Local llama.cpp/GGUF, `qwen2.5-coder:1.5b` |
| Optional upgrade LLM | Local Ollama endpoint, `qwen3:8b` or `qwen3.6:27b` — post-MVP |
| Explanation UI | Stable `Hover`/`MarkdownString` (level 0) + `WebviewViewProvider` docked panel (levels 1-2) — no proposed APIs |
| Change detection | v0: debounced save + manual refresh. Post-MVP: + dirty-tracking + periodic flush + git hooks |
| Testing | Acceptance test (v0, session 6) + unit/integration suite (post-MVP, session 16) |

## Explicit Non-Goals (v1, applies to v0 and beyond)

No cross-repo indexing. No resolution into third-party library internals. No live/on-demand regeneration on hover as the primary mechanism — pre-generation is the default, with a narrow cache-miss fallback for functions background indexing hasn't reached yet (see Core Design Decision #1). No semantic/similarity cache matching — exact content-hash only. No BYO API keys, no cloud providers, no Ollama Cloud as default. No variable-level explanations. No diagrams/impact-radius/minimap in v1. Secondary summary docs use template-and-reuse only, no bespoke pipeline. No single-trigger change detection in the full v1 model (v0's debounced-save-only is an explicit, temporary MVP exception, not a contradiction of this rule). No indexing/generation in untrusted workspaces. No proposed/experimental VS Code APIs — stable API surface only.

## Open Items

- `1.5b` vs `3b` bundled default: resolved by the v0 acceptance test.
- Staleness UX: silent lazy regen vs. visible badge — post-MVP.
- v1 language scope: pick 1 for v0, based on tree-sitter resolution quality without needing LSP wrapping; expand post-MVP.
- SCIP adoption: full format vs. informal Aider-style approach — not needed for v0.
- `backgroundFlushIntervalSeconds` default value — post-MVP.
- Git-hook install: automatic-with-opt-out vs. fully opt-in — post-MVP.
- Model-weight distribution: first-run download vs. Marketplace size exception vs. per-platform `.vsix` — post-MVP packaging session.
- Docked panel default state: auto-open on first "Show more" click vs. requiring manual open once, then auto-sync thereafter.

## Naming

Working name: **LucidHover**. Before final commit: check VS Code Marketplace publisher/extension ID, `npm view lucidhover`, GitHub repo-name availability, and a basic USPTO TESS search in software/dev-tools classes.

## Companion Files

- `CLAUDE.md` — session rules, file ownership, session-log convention.
- `.claude/agents/repo-researcher.md`, `test-runner.md`, `code-reviewer.md` — subagent definitions.

This file is the source of truth for *what* to build; companion files govern *how* an agent works through it across sessions.
