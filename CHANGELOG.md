# Changelog

All notable changes to LucidHover are documented in this file. Entries are added per release going
forward; the 56 development sessions preceding this file are not backfilled here — see
`.claude/sessions/` for that history.

## 0.1.0 — Initial release

First public-readiness snapshot. Highlights:

- Hover explanations for JavaScript, TypeScript, and TSX functions, generated locally via Ollama
  and served from a local SQLite cache — hover is a cache lookup, not a live model call, except for
  a narrow cache-miss fallback.
- Docked explanation panel, redesigned as a themed card layout (why it exists, side effects, risk
  notes, known callers/callees, copy, regenerate, relative timestamp, and a "Back to caller" link
  when you navigate into a used-by/calls row).
- CodeLens role badges and gutter icons.
- Blast radius and execution trace graph views, sharing the same card-based visual design as the
  explanation panel, with inline branch expansion on execution traces.
- "Show Most Important Functions" and "Search Explanations" quick pick commands.
- "Prioritize Indexing for This File" and pausable/resumable background indexing.
- Full layered change-detection model: dirty-tracking, debounced save, periodic flush, git hooks,
  manual refresh.
- Local embeddings + retrieval (Ollama + LanceDB) folded into generation context.
- Configurable Ollama endpoint (loopback-only) and model.
- Automatic superseded-cache-row eviction, with a manual purge command as an alternative.
- Sidecar crash-recovery with classified failure reporting (spawn failure vs. crash vs. slow first
  index).
- Panel content stays consistent with the active selection: navigating via a caller/callee link or
  either quick pick command always refreshes the docked panel, and a rapid sequence of cursor moves
  can no longer leave a stale explanation on screen.
