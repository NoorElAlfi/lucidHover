# Project Instructions for Claude Code

## What this project is

See `codebase-explainer-vscode-extension.md` (v7) for the full spec. Do not re-read that entire
file every session — each session prompt tells you exactly which section is relevant, and the v0
Definition of Done section defines the current milestone scope until it passes its acceptance test.

## Core rules (apply to every session)

1. **This is a fully local extension. No API keys, no cloud LLM providers, ever.** If you think
   a task requires adding one, stop and ask — this was explicitly rejected in the spec's
   "Rejected Directions" section.
2. **Stable VS Code APIs only — no proposed/experimental APIs.** Explanation UI uses a stable
   `Hover`/`MarkdownString` for the default (level 0) hover, and a stable `WebviewViewProvider`
   docked panel for deeper detail (levels 1-2). Do NOT use the Hover Verbosity API — confirmed
   proposed-only as of 2026-08, cannot ship to the Marketplace. Resolved decision, do not revisit.
3. **Borrow, don't rebuild.** Call-graph ranking comes from Aider's `repomap.py`. Local embeddings
   (post-MVP) follow Continue.dev's convention. Cross-file resolution (post-MVP) wraps existing
   LSP servers (Serena's pattern). Do not write a custom PageRank ranker, embeddings pipeline, or
   LSP client from scratch.
4. **Hover is a cache lookup only.** Never call an LLM synchronously from the hover provider path
   or the docked webview panel's render path.
5. **Cache key = hash(fn_source + context_hashes + model_id + embedding_model_id + prompt_version).**
   Any change to context composition, model, or prompt template must be reflected in this key.
6. **Gate everything behind Workspace Trust.** Sidecar spawn, indexing, and generation must check
   `vscode.workspace.isTrusted` first; only hover/CodeLens registration may run in restricted mode.
7. **Respect the v0/post-MVP split.** Sessions 1-8 build only what's in the v0 Definition of Done
   table. Do not pull forward post-MVP scope (embeddings retrieval, custom Ollama tier, full
   layered triggers, CodeLens/gutter icons, etc.) even if it seems like a small addition — it
   confounds the acceptance test's ability to validate the core concept in isolation.
8. **One session = one milestone.** Do not attempt to jump ahead to a later milestone even if it
   seems easy — flag it as a suggestion for the next session's artifact instead.

## Session Artifact pattern

At the end of every session, write a structured artifact file — not a freeform log entry — to:

```
.claude/sessions/session-<NN>-<milestone-slug>.md
```

e.g. `.claude/sessions/session-06-real-generation.md`.

Use this exact template:

```markdown
# Session <NN>: <milestone name>

**Date:** <date>
**Build-order step(s) completed:** <e.g. "5 and part of 6">
**Status:** complete | partial | blocked

## Files touched
- <path> — <one-line description of what changed>

## Decisions made
- <any decision not already in the spec, with brief reasoning>

## Deviations from spec
- <anything implemented differently than the spec describes, and why —
  or "None" if none>

## Test status
- <what was tested, pass/fail, what's still unverified>

## Blockers / open questions
- <anything the next session needs a human or the spec to resolve —
  or "None">

## Handoff for next session
- <the exact next thing to do, concrete enough that the next session
  doesn't need to re-derive it from the spec>
```

Rules for this artifact:

- **One file per session.** Never append to a previous session's artifact — always create a new one.
- **Keep it factual and short.** This is not a narrative recap; it's a state dump the next session reads instead of re-deriving context from the diff or the spec.
- **The next session's first action is to read only the most recent artifact file**, not the whole `.claude/sessions/` history, unless the "Blockers" or "Handoff" section explicitly points back further.
- **If a session is blocked or partial, say so plainly** in Status and Blockers — don't let the next session discover this by re-running tests.

### Session log (index only)

Keep one line per session here, pointing at its artifact file — this is a quick-scan index, not the
detail. Detail lives in the artifact.

| # | Milestone | Status | Artifact |
|---|---|---|---|
<!-- e.g. | 1 | Extension skeleton | complete | session-01-skeleton.md | -->

### Entries go below this line
---
| 1 | Extension skeleton + raw-echo hover provider | complete | [session-01-skeleton.md](.claude/sessions/session-01-skeleton.md) |
| 2 | Workspace Trust gating | complete | [session-02-workspace-trust.md](.claude/sessions/session-02-workspace-trust.md) |
| 3 | Repomap port (call-graph ranking) | complete | [session-03-repomap-port.md](.claude/sessions/session-03-repomap-port.md) |
| 4 | Sidecar process + socket protocol + heartbeat | complete | [session-04-sidecar-process.md](.claude/sessions/session-04-sidecar-process.md) |
| 5 | SQLite cache + cache-key hashing + hover-to-cache wiring | complete | [session-05-cache-and-hashing.md](.claude/sessions/session-05-cache-and-hashing.md) |
| 6 | Real generation (Ollama) + acceptance test script | partial | [session-06-real-generation.md](.claude/sessions/session-06-real-generation.md) |
| 7 | Two-surface UI (hover + docked panel) | complete | [session-07-two-surface-ui.md](.claude/sessions/session-07-two-surface-ui.md) |
| 8 | Debounced save re-indexing + manual refresh (v0 completion gate) | complete | [session-08-debounce-and-gate.md](.claude/sessions/session-08-debounce-and-gate.md) |
| 9 | Background/startup pre-generation indexing | complete | [session-09-background-indexing.md](.claude/sessions/session-09-background-indexing.md) |
| 10 | CodeLens role badge + gutter icon providers | complete | [session-10-codelens-gutter.md](.claude/sessions/session-10-codelens-gutter.md) |
| 11 | Local embeddings + retrieval (Continue.dev pattern, Ollama + LanceDB) | complete | [session-11-embeddings-retrieval.md](.claude/sessions/session-11-embeddings-retrieval.md) |
| 12 | Full layered change triggers (dirty-tracking, periodic flush, git hooks) | complete | [session-12-full-change-triggers.md](.claude/sessions/session-12-full-change-triggers.md) |

## File ownership (avoid overlapping edits across parallel work)

| Area | Owner path |
|---|---|
| Extension host (TS) | `src/extension/` |
| Hover provider (level 0) | `src/extension/hover/` |
| Docked webview panel (levels 1-2) | `src/extension/panel/` |
| Sidecar (Python) | `sidecar/` |
| Vendored/adapted Aider repomap code | `sidecar/repomap/` (keep upstream attribution comment at top of file) |
| Cache layer (SQLite, cache-key logic) | `src/extension/cache/` |
| Sidecar-side context-hash helper | `sidecar/cache/` |
| Tests | `src/extension/__tests__/`, `sidecar/tests/` |
| Fixture repo for testing | `fixtures/sample-repo/` |
| Session artifacts | `.claude/sessions/` |
