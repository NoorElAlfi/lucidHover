# Session 3: Repomap port (call-graph ranking)

**Date:** 2026-08-19
**Build-order step(s) completed:** 3
**Status:** complete

## Files touched
- [sidecar/__init__.py](../../sidecar/__init__.py) — new, empty package marker.
- [sidecar/repomap/__init__.py](../../sidecar/repomap/__init__.py) — new; package docstring carries the Apache-2.0 attribution to Aider-AI/aider and a summary of the three ways this port diverges from `repomap.py`.
- [sidecar/repomap/queries/javascript_tags.scm](../../sidecar/repomap/queries/javascript_tags.scm) — new; JS tag query adapted from Aider's `javascript-tags.scm`, trimmed of doc-comment association and class/`new`-expression patterns, and with `#not-eq?`/`#not-match?` predicates removed (see Deviations).
- [sidecar/repomap/extraction.py](../../sidecar/repomap/extraction.py) — new; tree-sitter tag extraction (`Tag`, `extract_tags`, `find_js_files`, `extract_tags_for_repo`). JS-only for v0.
- [sidecar/repomap/graph.py](../../sidecar/repomap/graph.py) — new; builds a *function-level* `networkx.DiGraph` (nodes = individual defs, not files) by matching call references to their lexically-enclosing definition via byte-range containment.
- [sidecar/repomap/rank.py](../../sidecar/repomap/rank.py) — new; plain unpersonalized `nx.pagerank()` over the function graph.
- [sidecar/repomap/context.py](../../sidecar/repomap/context.py) — new; `RepoMap` class, the Session 4 entry point — `index()` once, then `get_function_context(rel_fname, name, line)` returns ranked, capped (`CALLER_CALLEE_CAP = 15`) callers/callees with omitted counts.
- [sidecar/repomap/cli.py](../../sidecar/repomap/cli.py) — new; manual validation runner (`python -m sidecar.repomap.cli <root>`), not wired into the sidecar process yet.
- [sidecar/requirements.txt](../../sidecar/requirements.txt) — new; pins `tree-sitter`, `tree-sitter-javascript`, `networkx`, `numpy`, `scipy`, `pytest` to the versions actually installed and validated this session.
- [sidecar/tests/__init__.py](../../sidecar/tests/__init__.py), [sidecar/tests/test_repomap.py](../../sidecar/tests/test_repomap.py) — new; 6 smoke tests codifying this session's manual validation (function count, top rank, truncation, empty case, cross-file resolution, shared-caller case). All pass.
- [fixtures/sample-repo/repomap/{logging,utils,db,email,handlers}.js](../../fixtures/sample-repo/repomap/) — new fixture, 21 functions across 5 files, added as a subdirectory alongside the existing `sample.js`/`SearchForm.js` (untouched — those serve Session 1/2's hover-provider and Workspace Trust tests and weren't part of this session's scope).
- [.gitignore](../../.gitignore) — added `__pycache__/`, `.pytest_cache/`, `*.pyc` (first Python code in the repo).

## Decisions made
- **Function-level graph, not Aider's file-level graph.** Aider's `MultiDiGraph` has files as nodes because its output is "which whole files matter for a repo map." We need actual caller/callee *names* per function, so `graph.py` builds one node per definition and resolves each reference to its enclosing function via byte-range containment (`_enclosing_def`) before adding an edge. This is the single biggest structural deviation from the source — documented in `sidecar/repomap/__init__.py` and `graph.py`'s docstrings.
- **No token-budget binary search.** The spec's Context Budget caps caller/callee lists at a fixed count (~15), not a token budget, so `context.py` does a plain rank-and-slice (`RepoMap._cap`) instead of porting Aider's `get_ranked_tags_map_uncached()` render/estimate/retry loop. That loop exists to fit a variable-size repo map into a token budget for a chat prompt — not our problem shape.
- **No PageRank personalization.** Aider biases toward "chat files" (currently open) and user-mentioned identifiers. LucidHover indexes every function uniformly with no analogous session context, so `rank.py` runs unpersonalized `nx.pagerank()`. Also skipped: Aider's identifier-heuristic edge-weight multipliers (10x for long/mentioned names, 0.1x for `_`-prefixed or >5-file-defined names) — those exist to shape a token-budgeted whole-repo ranking, not a per-function 1-hop neighborhood rank.
- **JS-only, one language for v0**, per the spec's Open Items ("pick 1 for v0, based on tree-sitter resolution quality"). Matches the existing `fixtures/sample-repo` fixtures from Sessions 1-2, which are already JS.
- **`.scm` predicates dropped, filtered in Python instead.** Verified empirically (see Deviations) that this project's tree-sitter binding version (`tree-sitter==0.26.0`, queried via `QueryCursor.matches()`) does not evaluate `#not-eq?`/`#not-match?` predicates — `constructor` and `require` both still matched with the predicates present. Rather than debug an undocumented binding-version behavior, the query file carries no predicates and `extraction.py` filters `_EXCLUDED_DEF_NAMES = {"constructor"}` / `_EXCLUDED_REF_NAMES = {"require"}` explicitly after extraction. Noted with a comment in both the `.scm` file and `extraction.py`.
- **Fixture sized at 21 functions, not 10-20**, to satisfy the session's explicit ask to exercise truncation (one function with >15 callers). `logEvent` has exactly 17 distinct callers (15 shown + "+2 more"). Documented in `fixtures/sample-repo/repomap/utils.js` and `handlers.js` comments.
- **Added `sidecar/requirements.txt` and a pytest smoke suite**, not explicitly requested but minimal and directly load-bearing: without a requirements file, the module Session 4 needs to build on isn't reproducibly installable; without automated tests, the file-ownership table's `sidecar/tests/` convention would sit empty despite this being the first session with real Python logic to test. Both are scoped tightly to what this session built — no additional abstraction.

## Deviations from spec
- Query predicates (`#not-eq?`, `#not-match?`) present in Aider's original `.scm` are not evaluated by the installed tree-sitter binding when queried via `QueryCursor.matches()` — confirmed by direct test (see Decisions above). Filtering was moved to Python. This is a binding-version finding, not a design choice; flagging in case a future session upgrades `tree-sitter` and wants to move filtering back into the query file.
- Everything else (function-level graph, no personalization, no token-budget search, JS-only scope) was anticipated in the task prompt as expected simplifications for the narrower per-function use case, not spec deviations.

## Test status
- **Automated:** `python -m pytest sidecar/tests/test_repomap.py -v` — 6/6 pass (function count, top-rank correctness, truncation + omitted-count, empty-case, cross-file resolution, shared-caller case).
- **Manual (Step 3 requirement):** `python -m sidecar.repomap.cli fixtures/sample-repo/repomap` run and output inspected by hand:
  - `logEvent` (17 total callers across all 5 files) ranks highest by importance (0.3511) and correctly truncates to 15 shown + "+2 more".
  - `validateAndPersistSignup` shows exactly its 2 real callers (`handleSignupRoute`, `retryQueueWorker`), mirroring the spec's Output Schema `used_by` example.
  - `isEmpty` (deliberately unused, calls nothing) shows 0 callers, 0 callees, 0 omitted on both — empty case confirmed.
  - Cross-file chains resolve correctly: `db.js:insertUser` → `utils.js:validateEmail`; `email.js:sendWelcomeEmail` → `utils.js:formatDate`; `handlers.js:validateAndPersistSignup` → functions in `utils.js`, `db.js`, and `email.js` simultaneously.
  - Sanity re-run against the full `fixtures/sample-repo` (including the pre-existing `sample.js` and the JSX-containing `SearchForm.js`) indexed 28 functions with no crash or parse failure — confirms the JS grammar handles JSX fine and nothing here regresses Session 1/2's fixtures.
- **Not tested:** integration into an actual sidecar process (no socket/process exists yet — that's Session 4). No non-JS language tested (out of v0 scope).

## Blockers / open questions
- None.

## Handoff for next session
- Session 4 per Build Order step 4: sidecar process + socket protocol + heartbeat stub. Wire `sidecar/repomap/context.py`'s `RepoMap` (call `.index()` once at sidecar startup when trusted, per CLAUDE.md rule 6, then serve `.get_function_context(rel_fname, name, line)` over the socket) — the module is already a clean, dependency-free (of the extension host) library boundary, no further repomap changes anticipated for Session 4 beyond wiring.
- `sidecar/repomap/cli.py` remains useful standalone for debugging ranking output without spinning up the full sidecar — keep it.
- Install step for the sidecar going forward: `pip install -r sidecar/requirements.txt` (not yet wired into any setup script or the extension's activation flow — Session 4 should decide how/when the sidecar's Python env gets provisioned, e.g. bundled venv vs. user's system Python).
- `RepoMap.index()` currently does a full re-parse of every file on every call (no caching by mtime, unlike Aider's `diskcache`-backed `get_tags`). Fine for v0's fixture-repo scale; if Session 4's manual-refresh or Session 8's debounced-save re-indexing needs incremental re-parsing at real-repo scale, revisit — not needed yet, flagging only so it isn't rediscovered from scratch.
