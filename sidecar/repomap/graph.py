"""
Function-level call graph construction, adapted from the graph-building half
of Aider-AI/aider's aider/repomap.py:get_ranked_tags() (Apache-2.0):
https://github.com/Aider-AI/aider/blob/main/aider/repomap.py

Aider builds a *file-level* MultiDiGraph (nodes = files, edges = "this file
references a symbol defined in that file") because its goal is picking which
whole files matter most for a repo-wide chat context. LucidHover needs actual
caller/callee *function* names for one function at a time, so this builds the
graph one level finer: nodes are individual (file, name, line) definitions,
and an edge is only added when a reference site falls lexically inside a
known definition's byte range (the call's enclosing function). Aider doesn't
need this containment step at all, since it never asks "who is the caller."

Also not ported: Aider's identifier-based edge-weight heuristics (10x boost
for long/mentioned identifiers, 0.1x suppression for "_"-prefixed or
>5-file-defined identifiers) and its self-loop fallback for def-only
identifiers. Those exist to shape a *token-budgeted whole-repo* ranking;
here every call edge counts equally (weight = number of call sites), and
importance is left to PageRank via rank.py.
"""

from __future__ import annotations

from collections import defaultdict

import networkx as nx

from .extraction import Tag

NodeId = tuple[str, str, int]  # (rel_fname, name, start_line)


def _node_id(tag: Tag) -> NodeId:
    return (tag.rel_fname, tag.name, tag.start_line)


def _enclosing_def(ref: Tag, defs_by_file: dict[str, list[Tag]]) -> Tag | None:
    """Find the innermost def in the same file whose byte range contains ref."""
    candidates = [
        d
        for d in defs_by_file.get(ref.rel_fname, [])
        if d.start_byte <= ref.start_byte and ref.end_byte <= d.end_byte
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda d: d.end_byte - d.start_byte)


def build_call_graph(tags_by_file: dict[str, list[Tag]]) -> nx.DiGraph:
    """
    Build a directed graph where nodes are function/method definitions and
    an edge caller -> callee means caller's body contains a call resolving
    to callee's name. Ambiguous names (defined in multiple files) fan out to
    every matching definition, same as Aider does for unresolved-file idents.
    """
    all_tags = [t for tags in tags_by_file.values() for t in tags]
    defs = [t for t in all_tags if t.kind == "def"]
    refs = [t for t in all_tags if t.kind == "ref"]

    defs_by_name: dict[str, list[Tag]] = defaultdict(list)
    for d in defs:
        defs_by_name[d.name].append(d)

    defs_by_file: dict[str, list[Tag]] = defaultdict(list)
    for d in defs:
        defs_by_file[d.rel_fname].append(d)

    graph = nx.DiGraph()
    for d in defs:
        graph.add_node(_node_id(d), rel_fname=d.rel_fname, name=d.name, line=d.start_line)

    for ref in refs:
        caller_def = _enclosing_def(ref, defs_by_file)
        if caller_def is None:
            continue  # top-level call, not inside any tracked function
        callees = defs_by_name.get(ref.name)
        if not callees:
            continue  # unresolved: external/builtin call, no matching def
        caller_id = _node_id(caller_def)
        for callee in callees:
            callee_id = _node_id(callee)
            if graph.has_edge(caller_id, callee_id):
                graph[caller_id][callee_id]["weight"] += 1
            else:
                graph.add_edge(caller_id, callee_id, weight=1)

    return graph
