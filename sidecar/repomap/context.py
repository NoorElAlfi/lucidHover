"""
Per-function context assembly: the entry point Session 4's sidecar process
will call. Not a port of any single Aider function -- it's the piece that
replaces Aider's token-budget binary search (aider/repomap.py's
get_ranked_tags_map_uncached()) with the simpler fixed-count cap the spec
calls for (Context Budget section: "cap ~15 each, ranked by ... PageRank
proximity"). No token estimation or render-and-retry loop is needed because
the cap is a plain count, not a token budget.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from ..concurrency import RWLock
from .extraction import Tag, extract_tags, extract_tags_for_repo
from .graph import NodeId, build_call_graph, build_indices, update_call_graph_for_file
from .rank import compute_importance

CALLER_CALLEE_CAP = 15


@dataclass(frozen=True)
class RelatedFunction:
    rel_fname: str
    name: str
    line: int
    importance: float


@dataclass(frozen=True)
class FunctionContext:
    rel_fname: str
    name: str
    line: int
    callers: list[RelatedFunction] = field(default_factory=list)
    callers_omitted: int = 0
    callees: list[RelatedFunction] = field(default_factory=list)
    callees_omitted: int = 0


class RepoMap:
    """Indexes a repo's call graph once; serves ranked per-function context."""

    def __init__(self, root: str):
        self.root = root
        self.tags_by_file: dict[str, list] = {}
        self.graph = None
        self.importance: dict[NodeId, float] = {}
        # Reverse indices (name -> defs/refs, file -> defs) that `index()`
        # populates in full and `reindex_file()` maintains incrementally
        # (session 38) -- see graph.py::update_call_graph_for_file's
        # docstring for why these make a single-file reindex not need to
        # re-scan the rest of the repo.
        self.defs_by_name: dict[str, list[Tag]] = {}
        self.defs_by_file: dict[str, list[Tag]] = {}
        self.refs_by_name: dict[str, list[Tag]] = {}
        # Guards concurrent access to the mutable attributes above -- see
        # sidecar/concurrency.py's module docstring (session 37). Held by
        # callers (rpc_server.py's handlers), not by this class's own
        # methods, since some callers read tags_by_file/importance directly
        # rather than only through get_function_context/list_functions.
        self.lock = RWLock()

    def index(self) -> None:
        self.tags_by_file = extract_tags_for_repo(self.root)
        self.graph = build_call_graph(self.tags_by_file)
        self.defs_by_name, self.defs_by_file, self.refs_by_name = build_indices(self.tags_by_file)
        self.importance = compute_importance(self.graph)

    def reindex_file(self, rel_fname: str) -> int:
        """
        Re-parse one file and incrementally update the graph from the
        updated tag set (Session 8: debounced-save re-indexing; Session 38:
        made incremental). Only this file's tags are re-extracted from disk,
        and -- as of Session 38 -- only this file's own def/ref delta plus
        whatever other files' refs point at names this file defines are
        touched to update the graph; no other file is re-scanned and no
        other file's nodes/edges are recomputed. See
        `graph.py::update_call_graph_for_file`'s docstring for the
        correctness argument.

        PageRank (`compute_importance`) still runs over the *whole* updated
        graph every call, unchanged from before: Session 33 measured it at
        only ~83ms of a ~440ms full `reindex_file` at pokerogue's real scale
        (~19%), so incrementalizing it too -- which Core Rule 3 forbids
        rewriting the algorithm itself to do anyway -- wasn't worth the risk
        here; the graph-rebuild share it was paired with is the part this
        session's incremental update actually removes.

        Returns the number of functions now indexed for `rel_fname`.
        """
        if self.graph is None:
            # `index()` was never called first, so `defs_by_name`/
            # `refs_by_name`/`defs_by_file` were never populated for the
            # rest of the repo. Building the incremental update on top of
            # that would silently scope them to just this one file instead
            # of the whole repo -- do a real full index instead.
            self.index()
            return sum(1 for t in self.tags_by_file.get(rel_fname, []) if t.kind == "def")

        fname = os.path.join(self.root, rel_fname)
        old_tags = self.tags_by_file.get(rel_fname, [])
        old_defs = [t for t in old_tags if t.kind == "def"]
        old_refs = [t for t in old_tags if t.kind == "ref"]

        new_tags = extract_tags(fname, rel_fname)
        new_defs = [t for t in new_tags if t.kind == "def"]
        new_refs = [t for t in new_tags if t.kind == "ref"]

        self.tags_by_file[rel_fname] = new_tags
        update_call_graph_for_file(
            self.graph,
            self.defs_by_name,
            self.defs_by_file,
            self.refs_by_name,
            rel_fname,
            old_defs,
            old_refs,
            new_defs,
            new_refs,
        )
        self.importance = compute_importance(self.graph)
        return sum(1 for tag in new_defs if tag.kind == "def")

    def list_functions(self) -> list[NodeId]:
        if self.graph is None:
            return []
        return list(self.graph.nodes)

    def get_function_context(self, rel_fname: str, name: str, line: int) -> FunctionContext:
        node_id: NodeId = (rel_fname, name, line)
        if self.graph is None or node_id not in self.graph:
            return FunctionContext(rel_fname, name, line)

        callees_all = sorted(
            self.graph.successors(node_id), key=lambda n: -self.importance.get(n, 0.0)
        )
        callers_all = sorted(
            self.graph.predecessors(node_id), key=lambda n: -self.importance.get(n, 0.0)
        )
        callees, callees_omitted = self._cap(callees_all)
        callers, callers_omitted = self._cap(callers_all)

        return FunctionContext(
            rel_fname=rel_fname,
            name=name,
            line=line,
            callers=callers,
            callers_omitted=callers_omitted,
            callees=callees,
            callees_omitted=callees_omitted,
        )

    def _cap(self, nodes: list[NodeId]) -> tuple[list[RelatedFunction], int]:
        capped = nodes[:CALLER_CALLEE_CAP]
        omitted = max(0, len(nodes) - CALLER_CALLEE_CAP)
        related = [
            RelatedFunction(rel_fname=n[0], name=n[1], line=n[2], importance=self.importance.get(n, 0.0))
            for n in capped
        ]
        return related, omitted
