# Session 38: Incremental `RepoMap.reindex_file()`

**Date:** 2026-08-23
**Build-order step(s) completed:** None -- targeted fix for session 33's carried-forward
`reindex_file()` whole-graph-rebuild finding (not a Core Build Order step).
**Status:** complete

## Files touched
- [sidecar/repomap/graph.py](../../sidecar/repomap/graph.py) -- added `build_indices()` (extracted
  from `build_call_graph`'s previously-local grouping logic, now also called directly by
  `context.py`), `_add_or_increment_edge()` (shared helper), and the new
  `update_call_graph_for_file()` -- the incremental-update entry point, with the full correctness
  argument in its docstring. `build_call_graph()`'s public signature/behavior is unchanged (it now
  calls `build_indices()` internally instead of inlining the grouping).
- [sidecar/repomap/context.py](../../sidecar/repomap/context.py) -- `RepoMap` now holds three
  reverse-index dicts (`defs_by_name`, `defs_by_file`, `refs_by_name`), populated in full by
  `index()` and maintained incrementally by `reindex_file()`, which now calls
  `update_call_graph_for_file()` instead of rebuilding `build_call_graph(self.tags_by_file)` from
  scratch on every call.
- [sidecar/tests/test_repomap.py](../../sidecar/tests/test_repomap.py) -- three new tests
  (duplicate-name fan-out via the reverse index without reindexing the caller's file; cross-file
  rename with each file reindexed independently; `reindex_file` called before `index()` falls back
  to a real full index instead of a truncated one) plus a `_assert_matches_full_rebuild()` invariant
  helper added to all three JS `reindex_file` tests (new and pre-existing).
- [sidecar/tests/test_repomap_typescript.py](../../sidecar/tests/test_repomap_typescript.py) -- the
  existing line-shift regression test (every def in the edited file gets a new `NodeId` since line
  number is part of it) now also asserts the same full-rebuild invariant.

No extension-host (TS) files touched. No cache-key/`PROMPT_VERSION`/context-composition change --
this is purely an in-memory data-structure change inside the sidecar's call-graph indexer.

## Decisions made

### The core insight enabling incrementality without touching `rank.py`
`graph.py::_enclosing_def` resolves a ref's *caller* by byte-range containment within
`defs_by_file.get(ref.rel_fname, [])` -- a call site can only be lexically inside a function defined
in its *own* file. So when file F is reindexed: every edge whose *source* is a caller in F is fully
determined by F's own refs plus the (already-current) global `defs_by_name`, and every edge whose
*target* is a def in F comes only from refs elsewhere in the repo that share a name with one of F's
defs -- found via `refs_by_name[name]` (a reverse index maintained incrementally) in O(fan-in)
instead of an O(repo) rescan. Edges between two files neither of which is F are untouched by
construction. This is a *full local reset*, not a name-diff patch: `update_call_graph_for_file`
unconditionally removes all of F's old def nodes (networkx auto-drops every incident edge, both
directions) and unconditionally recomputes all of F's new nodes'/edges' from the current global
index state -- which is what makes it self-heal correctly across arbitrary call orderings, repeated
reindexes, renames, and line-shifts without needing to reason about which specific names "changed."
`rank.py`'s PageRank call itself was not touched, per Core Rule 3 and the session prompt's explicit
scoping ("does it need to re-run over the whole graph every save," not "does the algorithm need
replacing").

### PageRank still runs in full every call -- measured, not assumed, to be the right call
Session 33 measured `compute_importance()` alone at ~83ms of a ~440ms full `reindex_file()`
(~19%), with the rest being graph-rebuild cost. This session's real pokerogue measurement (see
"Test status") confirms that estimate almost exactly (~84-88ms observed, flat across three files of
very different size/fan-in) and confirms the graph-rebuild share is what the incremental update
actually removes. Incrementalizing PageRank too was out of scope (Core Rule 3 forbids rewriting the
algorithm) and, per the session prompt's own instruction to "measure both and pick based on real
numbers," the graph-build savings alone are the dominant win at every real file size measured --
not worth the added risk of a partial-PageRank scheme this session.

### `reindex_file()` before `index()`: fixed a latent bug the `code-reviewer` pass found
The first draft's fallback for "`self.graph` is `None`" (i.e. `reindex_file` called before
`index()`) rebuilt off `self.tags_by_file`, but by that point `self.tags_by_file[rel_fname]` had
already been overwritten with just the one file being reindexed -- silently producing a one-file
"repo" graph instead of a real full index, with `defs_by_name`/`refs_by_name` scoped the same way.
Currently unreachable in production (`rpc_server.py` always calls `repo_map.index()` synchronously
before the dispatch loop starts) but untested and fragile against any future change to startup
sequencing. Fixed by checking `self.graph is None` *before* touching `tags_by_file` at all and
calling the real `self.index()` in that case; added a regression test
(`test_reindex_file_before_index_falls_back_to_a_real_full_index`) so this can't silently regress
again.

## Deviations from spec
None from the extension spec. Session 33's own handoff explicitly scoped this as "a dedicated
follow-up session," which this is.

## Test status
- `/c/Python313/python -m pytest sidecar/tests/ -q`: **116 passed**, 0 failed (113 baseline at
  session start, +3: two new cross-file correctness tests in `test_repomap.py`
  (`test_reindex_file_new_file_with_duplicate_name_fans_out_to_both`,
  `test_reindex_file_rename_updates_cross_file_edge_once_caller_reindexed`) plus
  `test_reindex_file_before_index_falls_back_to_a_real_full_index`). All five `reindex_file` tests
  across both JS and TS fixtures (three pre-existing, two new) now also assert
  `_assert_matches_full_rebuild` -- the incremental graph must exactly match node set + edge weights
  of a from-scratch `build_call_graph(tags_by_file)` call, not just "look right" on the specific
  assertion each test was already making.
- **`code-reviewer` pass**, scoped specifically to cross-file correctness (not general style):
  traced weight-double-counting risk across sequential reindexes (not present -- every reindex does
  a full local reset before recomputing, never an incremental bump on stale state), stale
  reverse-index entries (not present -- `_drop_file_from_index` purges the whole per-name bucket by
  exact `rel_fname` match before re-adding), the 3-file "definer removed while a third file's caller
  is never revisited" case (correct -- node removal cascades the edge away without rescanning the
  third file), and confirmed the RWLock write-lock in `rpc_server.py::_handle_reindex_file` already
  wraps the whole multi-step mutation atomically (unchanged from before, no new gap). Found the one
  real issue described above (the `graph is None` fallback), which is now fixed and covered by a
  regression test; also flagged that the TS line-shift test didn't yet assert the full-rebuild
  invariant, which is now fixed too.
- **Real, live timing against `B:\pokerogue`** (6,633 defs / 128,515 edges, unchanged from session
  33), via a background `general-purpose` agent, not estimated:

  | File | def count | fan-in refs | `reindex_file()` avg (3 runs) | session 33 baseline |
  |---|---|---|---|---|
  | `src/data/gender.ts` (small) | 2 | 22 | 0.087s | -- (not measured before) |
  | `src/data/egg.ts` (session 33's file) | 30 | 81 | 0.090s | ~0.437s |
  | `src/utils/common.ts` (large, heavy fan-in) | 34 | 773 | 0.094s | -- (not measured before) |

  `egg.ts`: **~4.8x speedup** (437ms -> 90ms), confirming session 33's baseline is gone. Phase
  breakdown (same agent, isolating `extract_tags` / `update_call_graph_for_file` /
  `compute_importance`): the incremental graph-update step itself scaled with fan-in --
  0.2ms (22 fan-in refs) -> 2.2ms (81) -> 5.6ms (773), a 28x spread tracking the edited file's local
  footprint, not repo size -- while `compute_importance` stayed flat at ~84-88ms across all three
  files, matching session 33's isolated PageRank measurement almost exactly. This directly confirms
  the session's goal: cost now scales with edit size, and the remaining flat cost is exactly the
  PageRank floor the "Decisions made" section above already accounts for, not a residual graph-build
  cost.

## Blockers / open questions
None. Every angle the session prompt asked for (design, cross-file correctness tests, real
before/after timing) was completed and verified live, not estimated.

## Handoff for next session
- `reindex_file()`'s cost is now dominated by PageRank's flat ~85-90ms (unchanged, whole-graph, by
  design this session). If a future session wants to shrink debounced-save latency further, that's
  the next thing to look at -- but doing so safely would mean either accepting an approximate/stale
  PageRank between saves or finding an incremental PageRank scheme, both bigger asks than this
  session's scope allowed (Core Rule 3 still applies: don't rewrite the algorithm without a strong
  reason).
- Sessions 26/29/31/32/36's carried-forward sidecar request-contention/RPC-scheduling item remains
  untouched by this session (this was purely an in-memory algorithmic change inside one RPC
  handler's body, not a scheduling change) and is still the most-flagged open item across recent
  sessions.
- The SQLite explanation-cache eviction gap (session 33's other handoff item) is also still
  untouched.
