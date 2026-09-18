# Changelog

All notable changes to LucidHover are documented in this file. Entries are added per release going
forward; the development sessions preceding a given entry are not backfilled beyond a summary — see
`.claude/sessions/` for that history.

## 0.2.0 — Python support, call-graph fixes, and UX polish

Everything below shipped since 0.1.0's publish:

- **Python support** — hover explanations, the docked panel, and CodeLens now work for Python
  functions, alongside the existing JavaScript/TypeScript/TSX support. Python additionally requires
  a Python language extension (e.g. [Pylance](https://marketplace.visualstudio.com/items?itemName=ms-python.python))
  installed and active — see the README's "Supported languages" note.
- JSX/TSX component usage (`<Button />`, including namespaced tags like `<Menu.Item />`) is now
  correctly captured and resolved in the call graph — previously invisible regardless of how many
  times a component was used.
- Compound-component exports (`Object.assign(Root, {...})`, `Foo.Bar = existingFn`) are now
  correctly resolved too, closing the matching definition-side gap.
- The docked panel's "Used by"/"Calls" lists now scroll past a handful of rows instead of silently
  truncating to 3 with no indication more existed.
- The sidecar sleeps at a slower poll rate once genuinely idle, instead of waking 50x/sec forever —
  reduces background CPU/power draw with no measurable hit to interactive responsiveness.
- Generation prompt improvements: explanations no longer copy a caller/callee illustrative example's
  wording verbatim into unrelated answers, no longer describe a decorator's behavior from its name
  alone when the body doesn't confirm it, and no longer mistake retrieval-tier background context
  (similar code an embedding search surfaced, not this function's own callers or behavior) for real
  caller/callee/behavior evidence.
- **Generate Codebase Digest** — a new command that walks your workspace and produces a single
  plain-text digest (summary, directory tree, and file contents, respecting `.gitignore` and size
  budgets) in a new untitled document and on your clipboard, ready to paste into any LLM yourself.
  Fully local; nothing is sent anywhere.
- Long file paths in the docked panel's header are now truncated in the middle (keeping the file name
  visible) instead of wrapping onto multiple lines; hover the path for the full text.
- Hovering a function whose explanation fails to generate (for example a timeout) now shows a clear
  "couldn't generate an explanation" message and logs the error, instead of silently showing nothing.
- Restarting the sidecar (the "Restart Sidecar" command, or automatic crash recovery) while background
  indexing is running now pauses and resumes the pass instead of causing avoidable generation failures.
- The status bar's post-indexing coverage tooltip now notes how many functions failed, when any did.

## 0.1.0 — Initial release

First published version. Highlights:

- Hover explanations for JavaScript, TypeScript, and TSX functions, generated locally via Ollama
  and served from a local SQLite cache — hover is a cache lookup, not a live model call, except for
  a narrow cache-miss fallback.
- Docked explanation panel, redesigned as a themed card layout (why it exists, side effects, risk
  notes, known callers/callees, copy, regenerate, relative timestamp, and a "Back to caller" link
  when you navigate into a used-by/calls row).
- CodeLens role badges and gutter icons.
- Blast radius and execution trace graph views, sharing the same card-based visual design as the
  explanation panel, with inline branch expansion on execution traces.
- Cluster summary: a synthesized purpose paragraph over a function and its transitive callers,
  built only from already-cached explanations and generated only on an explicit "Synthesize
  summary" action, never automatically.
- "Show Most Important Functions" and "Search Explanations" quick pick commands.
- "Prioritize Indexing for This File" and pausable/resumable background indexing, with a live
  progress count (including failed attempts), the function currently being processed, a
  time-remaining estimate, and repo-wide coverage against the configured scope once a pass
  completes, all in the status bar.
- Startup background indexing defaults to the repo's most important functions
  (`lucidHover.backgroundIndexScope` / `lucidHover.backgroundIndexTopN`), with full-repo indexing
  available as an explicit opt-in — functions outside the scope are still generated the first time
  they're hovered.
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
