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
from .extraction import extract_tags, extract_tags_for_repo
from .graph import NodeId, build_call_graph
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
        # Guards concurrent access to the three mutable attributes above --
        # see sidecar/concurrency.py's module docstring (session 37). Held
        # by callers (rpc_server.py's handlers), not by this class's own
        # methods, since some callers read tags_by_file/importance directly
        # rather than only through get_function_context/list_functions.
        self.lock = RWLock()

    def index(self) -> None:
        self.tags_by_file = extract_tags_for_repo(self.root)
        self.graph = build_call_graph(self.tags_by_file)
        self.importance = compute_importance(self.graph)

    def reindex_file(self, rel_fname: str) -> int:
        """
        Re-parse one file and rebuild the graph/importance from the updated
        tag set (Session 8: debounced-save re-indexing). Only this file's
        tags are re-extracted from disk -- the expensive part (tree-sitter
        parsing + file IO) stays scoped to the one changed file, per the
        session instructions ("re-run the Session 3 repomap module against
        the changed file only"). Rebuilding the graph/importance from
        `tags_by_file` is still whole-repo, but that part is pure in-memory
        work over already-extracted tags, not file IO -- cheap at v0 scale,
        and necessary because an edit to one file can change edges pointing
        at or from other files (e.g. a new call site, a renamed function).

        Returns the number of functions now indexed for `rel_fname`.
        """
        fname = os.path.join(self.root, rel_fname)
        self.tags_by_file[rel_fname] = extract_tags(fname, rel_fname)
        self.graph = build_call_graph(self.tags_by_file)
        self.importance = compute_importance(self.graph)
        return sum(1 for tag in self.tags_by_file[rel_fname] if tag.kind == "def")

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
