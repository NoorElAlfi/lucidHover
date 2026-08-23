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

# Session 45: hardcoded, not a setting -- see the session brief's
# source-material note ("nothing here yet establishes that a fixed,
# reasonable default is insufficient; add a setting later if real use
# surfaces a need, not preemptively").
BLAST_RADIUS_MAX_DEPTH = 3

# Session 47: per-level fan-out cap for get_blast_radius, closing session 45's
# own carried-forward gap. Measured against real pokerogue (6,633 functions)
# before adding this: several real high-fan-in functions (e.g.
# `getPokemonNameWithAffix`, 287 direct confident callers) returned 400-500+
# total nodes and thousands of edges at the existing max_depth=3 -- a real,
# observed problem, not a hypothetical one (see session-47 artifact for the
# full measurement table). Reuses CALLER_CALLEE_CAP's value rather than a new
# number: it's the same "how many related functions to show a human" judgment
# call `get_function_context`'s single-hop callers/callees already makes, and
# users are already used to that convention. Applied once per depth level (up
# to BLAST_RADIUS_LEVEL_CAP *new* nodes admitted per level), not as a single
# global cap on the whole walk -- a global cap would silently starve whichever
# depth is reached last. At 3 levels this bounds the walk to at most
# 3 * BLAST_RADIUS_LEVEL_CAP = 45 nodes, still far below the unbounded
# real-repo measurements above.
BLAST_RADIUS_LEVEL_CAP = CALLER_CALLEE_CAP

# Session 46: same reasoning as BLAST_RADIUS_MAX_DEPTH above, hardcoded not
# a setting.
CALL_TRACE_MAX_DEPTH = 3


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


@dataclass(frozen=True)
class BlastRadiusNode:
    rel_fname: str
    name: str
    line: int
    importance: float
    depth: int


@dataclass(frozen=True)
class BlastRadiusEdge:
    caller_rel_fname: str
    caller_name: str
    caller_line: int
    callee_rel_fname: str
    callee_name: str
    callee_line: int


@dataclass(frozen=True)
class BlastRadiusOmission:
    """Session 47: how many *additional* new callers existed at a given
    depth beyond BLAST_RADIUS_LEVEL_CAP -- one entry per depth that actually
    omitted something, not a dense depth-indexed structure (a depth with
    nothing omitted has no entry)."""

    depth: int
    omitted_count: int


@dataclass(frozen=True)
class BlastRadius:
    rel_fname: str
    name: str
    line: int
    nodes: list[BlastRadiusNode] = field(default_factory=list)
    edges: list[BlastRadiusEdge] = field(default_factory=list)
    omissions: list[BlastRadiusOmission] = field(default_factory=list)


@dataclass(frozen=True)
class CallTraceNode:
    rel_fname: str
    name: str
    line: int
    importance: float
    depth: int


@dataclass(frozen=True)
class CallTraceEdge:
    caller_rel_fname: str
    caller_name: str
    caller_line: int
    callee_rel_fname: str
    callee_name: str
    callee_line: int


@dataclass(frozen=True)
class CallTraceBranchPoint:
    """Session 48: the non-primary confident callees passed over at a given
    hop -- every confident callee of that hop's caller besides the one
    chosen to continue the primary path. `depth` matches the primary-path
    node recorded for that same hop (`CallTraceNode.depth`), so the
    extension host/panel can attach a branch point to "the node just
    walked into" the same way `BlastRadiusOmission` attaches to a depth.
    One entry per depth that actually has an alternate, not a dense
    depth-indexed array (same sparse convention as `BlastRadiusOmission`).

    Reuses `RepoMap._cap`/`CALLER_CALLEE_CAP` as-is for the same
    "how many related functions to show a human" cap `get_function_context`
    and `get_blast_radius` (session 47) already apply -- no new constant,
    per this session's own instruction to reuse the existing
    constant/pattern rather than invent a new number. Measured against real
    pokerogue (6,633 functions) before adding this: 246 functions have more
    than 15 confident callees at a single hop (e.g. `initMoves` in
    `src/data/moves/move.ts`, 248) -- a real, observed fan-out problem, not
    a hypothetical one.

    Unlike blast radius's `omitted_ever`, a branch here is never itself
    walked further (this session's deliberate v1 scope, per the
    AskUserQuestion answer: an inline "+N other calls from here" expansion,
    not a second recursive tree) -- so there is no resurfacing concern to
    replicate; each hop's branch cap is independent and one-shot.
    """

    depth: int
    alternates: list[RelatedFunction] = field(default_factory=list)
    omitted_count: int = 0


@dataclass(frozen=True)
class CallTrace:
    rel_fname: str
    name: str
    line: int
    nodes: list[CallTraceNode] = field(default_factory=list)
    edges: list[CallTraceEdge] = field(default_factory=list)
    branches: list[CallTraceBranchPoint] = field(default_factory=list)


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

        # Session 44: only `confident` edges are shown as this function's
        # specific known callers/callees (fed into the generation prompt and
        # the acceptance report as asserted fact) -- an ambiguous name with
        # no same-file candidate stays in the graph (PageRank still uses it,
        # untouched) but is never confident, so it's excluded here. See
        # graph.py's module docstring and `_confident_callee_ids`.
        callees_all = sorted(
            (n for n in self.graph.successors(node_id) if self.graph[node_id][n].get("confident")),
            key=lambda n: -self.importance.get(n, 0.0),
        )
        callers_all = sorted(
            (n for n in self.graph.predecessors(node_id) if self.graph[n][node_id].get("confident")),
            key=lambda n: -self.importance.get(n, 0.0),
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

    def get_blast_radius(
        self, rel_fname: str, name: str, line: int, max_depth: int = BLAST_RADIUS_MAX_DEPTH
    ) -> BlastRadius:
        """
        Session 45: "if I change this function, what's affected" -- a
        transitive-upstream-caller walk, the multi-hop generalization of
        `get_function_context()`'s single-hop `callers` list. Reuses the same
        `confident`-edges-only filter (see graph.py's module docstring and
        Session 44) so an ambiguous name collision never shows up as an
        asserted real caller here either.

        BFS over `self.graph` predecessors, depth-capped at `max_depth`, with
        a visited-node set so a recursive/cyclic call chain (mutual
        recursion, an event-handler loop) terminates instead of looping
        forever. A node is recorded once, at the depth it was first reached
        (BFS guarantees that's its shortest upstream distance) and is never
        re-expanded from a deeper path; an edge into an already-visited node
        is still recorded, since it's a real graph fact (e.g. two different
        depth-1 callers both funneling into the same depth-2 function).

        Returns plain graph facts only (rel_fname/name/line/importance per
        node, edges as caller->callee pairs) -- no cache lookups, no
        role_tag/one_liner. Per Core Rule 9, the extension host
        (blastRadiusCommand.ts) is the one that enriches these with cached
        data afterward; the sidecar has no idea what's cached.

        Session 47: fan-out is capped per level at BLAST_RADIUS_LEVEL_CAP new
        callers -- among the *new* (not-yet-visited, not-previously-omitted)
        callers discovered at a depth, only the top BLAST_RADIUS_LEVEL_CAP by
        importance are added as nodes and expanded into the next level; the
        rest are dropped from both `nodes` and `edges` (an edge into an
        omitted caller would just reproduce the same unbounded fan-out this
        cap exists to avoid) and counted in `omissions` instead. An edge into
        an already-visited caller (a convergent path from an earlier depth)
        is unaffected by the cap and is still recorded, same as before -- it
        doesn't add a new node, so it can't blow up the walk the way new
        fan-out can.

        Once a caller is omitted at some depth, it stays omitted for the
        rest of the walk (tracked in `omitted_ever`, separately from
        `visited`) -- it must never resurface at a *deeper* level just
        because a second, indirect/longer edge into it happens to exist from
        an already-kept node. Without this, the shortest-distance-recorded
        invariant above would silently break for exactly the nodes the cap
        is supposed to hide: an omitted node could reappear one or more
        levels later, at the wrong depth, with its true (shorter, capped)
        edge dropped and only the longer alternate edge shown instead.
        """
        node_id: NodeId = (rel_fname, name, line)
        if self.graph is None or node_id not in self.graph:
            return BlastRadius(rel_fname=rel_fname, name=name, line=line)

        visited: set[NodeId] = {node_id}
        omitted_ever: set[NodeId] = set()
        nodes: list[BlastRadiusNode] = []
        edges: list[BlastRadiusEdge] = []
        omissions: list[BlastRadiusOmission] = []
        frontier: list[NodeId] = [node_id]

        for depth in range(1, max_depth + 1):
            candidate_pairs: list[tuple[NodeId, NodeId]] = [
                (caller, current)
                for current in frontier
                for caller in self.graph.predecessors(current)
                if self.graph[caller][current].get("confident")
            ]

            new_callers = sorted(
                {caller for caller, _ in candidate_pairs if caller not in visited and caller not in omitted_ever},
                key=lambda n: -self.importance.get(n, 0.0),
            )
            kept = set(new_callers[:BLAST_RADIUS_LEVEL_CAP])
            omitted_this_level = new_callers[BLAST_RADIUS_LEVEL_CAP:]
            if omitted_this_level:
                omissions.append(BlastRadiusOmission(depth=depth, omitted_count=len(omitted_this_level)))
            omitted_ever.update(omitted_this_level)

            next_frontier: list[NodeId] = []
            for caller, current in candidate_pairs:
                if caller in visited:
                    edges.append(
                        BlastRadiusEdge(
                            caller_rel_fname=caller[0],
                            caller_name=caller[1],
                            caller_line=caller[2],
                            callee_rel_fname=current[0],
                            callee_name=current[1],
                            callee_line=current[2],
                        )
                    )
                    continue
                if caller not in kept:
                    # Either omitted just now, or already-omitted at an
                    # earlier depth and rediscovered here via a second edge
                    # -- neither case gets a node or an edge (see docstring).
                    continue
                edges.append(
                    BlastRadiusEdge(
                        caller_rel_fname=caller[0],
                        caller_name=caller[1],
                        caller_line=caller[2],
                        callee_rel_fname=current[0],
                        callee_name=current[1],
                        callee_line=current[2],
                    )
                )
                visited.add(caller)
                nodes.append(
                    BlastRadiusNode(
                        rel_fname=caller[0],
                        name=caller[1],
                        line=caller[2],
                        importance=self.importance.get(caller, 0.0),
                        depth=depth,
                    )
                )
                next_frontier.append(caller)
            frontier = next_frontier
            if not frontier:
                break

        return BlastRadius(rel_fname=rel_fname, name=name, line=line, nodes=nodes, edges=edges, omissions=omissions)

    def get_call_trace(
        self, rel_fname: str, name: str, line: int, max_depth: int = CALL_TRACE_MAX_DEPTH
    ) -> CallTrace:
        """
        Session 46: "follow this one call chain end-to-end" -- a downstream
        walk over `self.graph` successors, the mirror image of
        `get_blast_radius`'s upstream BFS over predecessors. Same
        confident-edges-only filter as `get_function_context`/
        `get_blast_radius` (Session 44).

        Deliberate v1 scope cut, per this session's own brief (Core Rule 8 --
        one session, one milestone): at each hop, only the single
        highest-importance confident callee is followed as the "primary
        path". This returns one linear chain, not a branching tree of every
        possible downstream call -- alternate-path exploration is a real
        follow-up idea, not attempted here.

        Cycle-safe via the same visited-node-set approach as
        `get_blast_radius`: if the chosen next callee is already on the
        path (mutual/self recursion), the edge closing the loop is still
        recorded as a real graph fact, but the walk does not re-add it as a
        node or continue past it -- so a cyclic call chain terminates
        instead of looping forever.

        Returns plain graph facts only (rel_fname/name/line/importance per
        node, edges as caller->callee pairs) -- no cache lookups, no
        role_tag/one_liner. Per Core Rule 9, the extension host
        (callTraceCommand.ts) enriches these from its own ExplanationCache
        afterward; the sidecar has no idea what's cached.

        Session 48: alongside the primary path, also records the
        non-primary confident callees at each hop as `branches`
        (`CallTraceBranchPoint`, see its own docstring) -- the answer to
        v1's "silently swallows every other real downstream call" scope cut
        (session 46). A branch point is only recorded for a hop that
        actually produced a primary-path node (i.e. not for the final,
        cycle-closing hop where the walk breaks before adding one) so every
        branch point's `depth` always matches a real `CallTraceNode.depth`.
        """
        node_id: NodeId = (rel_fname, name, line)
        if self.graph is None or node_id not in self.graph:
            return CallTrace(rel_fname=rel_fname, name=name, line=line)

        visited: set[NodeId] = {node_id}
        nodes: list[CallTraceNode] = []
        edges: list[CallTraceEdge] = []
        branches: list[CallTraceBranchPoint] = []
        current = node_id

        for depth in range(1, max_depth + 1):
            confident_callees = sorted(
                (n for n in self.graph.successors(current) if self.graph[current][n].get("confident")),
                key=lambda n: -self.importance.get(n, 0.0),
            )
            if not confident_callees:
                break
            primary = confident_callees[0]
            edges.append(
                CallTraceEdge(
                    caller_rel_fname=current[0],
                    caller_name=current[1],
                    caller_line=current[2],
                    callee_rel_fname=primary[0],
                    callee_name=primary[1],
                    callee_line=primary[2],
                )
            )
            if primary in visited:
                break
            visited.add(primary)
            nodes.append(
                CallTraceNode(
                    rel_fname=primary[0],
                    name=primary[1],
                    line=primary[2],
                    importance=self.importance.get(primary, 0.0),
                    depth=depth,
                )
            )
            alternates, omitted_count = self._cap(confident_callees[1:])
            if alternates or omitted_count:
                branches.append(CallTraceBranchPoint(depth=depth, alternates=alternates, omitted_count=omitted_count))
            current = primary

        return CallTrace(rel_fname=rel_fname, name=name, line=line, nodes=nodes, edges=edges, branches=branches)

    def _cap(self, nodes: list[NodeId]) -> tuple[list[RelatedFunction], int]:
        capped = nodes[:CALLER_CALLEE_CAP]
        omitted = max(0, len(nodes) - CALLER_CALLEE_CAP)
        related = [
            RelatedFunction(rel_fname=n[0], name=n[1], line=n[2], importance=self.importance.get(n, 0.0))
            for n in capped
        ]
        return related, omitted
