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


def build_indices(
    tags_by_file: dict[str, list[Tag]],
) -> tuple[dict[str, list[Tag]], dict[str, list[Tag]], dict[str, list[Tag]]]:
    """
    Group every def/ref tag in the repo by name (twice over -- once for defs,
    once for refs) and by file (defs only). `build_call_graph` uses these
    internally for a one-shot full build; `RepoMap` (context.py) also keeps
    its own copy of these three dicts around after `index()`, and
    `update_call_graph_for_file` maintains them incrementally on top of a
    single file's reindex so a full repo re-group is never needed again.
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

    refs_by_name: dict[str, list[Tag]] = defaultdict(list)
    for r in refs:
        refs_by_name[r.name].append(r)

    return defs_by_name, defs_by_file, refs_by_name


def _add_or_increment_edge(graph: nx.DiGraph, caller_id: NodeId, callee_id: NodeId) -> None:
    if graph.has_edge(caller_id, callee_id):
        graph[caller_id][callee_id]["weight"] += 1
    else:
        graph.add_edge(caller_id, callee_id, weight=1)


def build_call_graph(tags_by_file: dict[str, list[Tag]]) -> nx.DiGraph:
    """
    Build a directed graph where nodes are function/method definitions and
    an edge caller -> callee means caller's body contains a call resolving
    to callee's name. Ambiguous names (defined in multiple files) fan out to
    every matching definition, same as Aider does for unresolved-file idents.
    """
    defs_by_name, defs_by_file, refs_by_name = build_indices(tags_by_file)
    all_defs = [d for defs in defs_by_file.values() for d in defs]
    all_refs = [r for refs in refs_by_name.values() for r in refs]

    graph = nx.DiGraph()
    for d in all_defs:
        graph.add_node(_node_id(d), rel_fname=d.rel_fname, name=d.name, line=d.start_line)

    for ref in all_refs:
        caller_def = _enclosing_def(ref, defs_by_file)
        if caller_def is None:
            continue  # top-level call, not inside any tracked function
        callees = defs_by_name.get(ref.name)
        if not callees:
            continue  # unresolved: external/builtin call, no matching def
        caller_id = _node_id(caller_def)
        for callee in callees:
            callee_id = _node_id(callee)
            _add_or_increment_edge(graph, caller_id, callee_id)

    return graph


def update_call_graph_for_file(
    graph: nx.DiGraph,
    defs_by_name: dict[str, list[Tag]],
    defs_by_file: dict[str, list[Tag]],
    refs_by_name: dict[str, list[Tag]],
    rel_fname: str,
    old_defs: list[Tag],
    old_refs: list[Tag],
    new_defs: list[Tag],
    new_refs: list[Tag],
) -> None:
    """
    Mutate `graph` (plus the three index dicts, which are updated in place so
    the caller's copies stay authoritative) to reflect `rel_fname`'s tag set
    changing from (old_defs, old_refs) to (new_defs, new_refs), producing the
    same graph `build_call_graph` would from a full re-scan of every file --
    without re-scanning any file other than `rel_fname` itself.

    This is possible without a whole-repo rescan because of one structural
    fact `build_call_graph` already relies on: `_enclosing_def` resolves a
    ref's *caller* by byte-range containment within the *same file* the ref
    was extracted from (`defs_by_file.get(ref.rel_fname, ...)`) -- a call
    site can only be lexically inside a function defined in its own file.
    So every edge whose *source* is a caller in `rel_fname` is fully
    determined by `rel_fname`'s own refs plus the (global, but unaffected by
    this update) def name index, and can be recomputed by rescanning only
    `new_refs`. Every edge whose *target* is a def in `rel_fname` comes from
    some ref elsewhere in the repo with a matching name -- `refs_by_name`
    (a reverse index, maintained incrementally right here) finds exactly
    those refs in O(fan-in) instead of an O(repo) scan. Edges that touch
    neither side (any two nodes outside `rel_fname`) are untouched by
    construction: nothing below ever adds an edge without one endpoint in
    `rel_fname`, and the only nodes removed are `rel_fname`'s own old defs.
    """
    # Removing this file's old def nodes drops every edge incident to them
    # (both its own outgoing calls and any prior incoming calls into them) --
    # networkx does this automatically as part of node removal.
    for d in old_defs:
        node_id = _node_id(d)
        if graph.has_node(node_id):
            graph.remove_node(node_id)

    def _drop_file_from_index(index: dict[str, list[Tag]], tags: list[Tag]) -> None:
        for t in tags:
            bucket = index.get(t.name)
            if bucket is None:
                continue
            kept = [x for x in bucket if x.rel_fname != rel_fname]
            if kept:
                index[t.name] = kept
            else:
                del index[t.name]

    _drop_file_from_index(defs_by_name, old_defs)
    _drop_file_from_index(refs_by_name, old_refs)

    for d in new_defs:
        defs_by_name.setdefault(d.name, []).append(d)
    for r in new_refs:
        refs_by_name.setdefault(r.name, []).append(r)
    defs_by_file[rel_fname] = new_defs

    for d in new_defs:
        graph.add_node(_node_id(d), rel_fname=d.rel_fname, name=d.name, line=d.start_line)

    # This file's own outgoing edges: its refs against the current (global)
    # def-name index.
    for ref in new_refs:
        caller_def = _enclosing_def(ref, defs_by_file)
        if caller_def is None:
            continue
        callees = defs_by_name.get(ref.name)
        if not callees:
            continue
        caller_id = _node_id(caller_def)
        for callee in callees:
            _add_or_increment_edge(graph, caller_id, _node_id(callee))

    # Incoming edges into this file's new defs, from other files' refs --
    # found via the reverse index instead of scanning every other file.
    # (Old defs need no symmetric step: removing their nodes above already
    # dropped any edges that used to point at them.)
    new_def_names = {d.name for d in new_defs}
    for name in new_def_names:
        callees_here = [d for d in new_defs if d.name == name]
        for ref in refs_by_name.get(name, []):
            if ref.rel_fname == rel_fname:
                continue  # this file's own refs are handled above
            caller_def = _enclosing_def(ref, defs_by_file)
            if caller_def is None:
                continue
            caller_id = _node_id(caller_def)
            for callee in callees_here:
                _add_or_increment_edge(graph, caller_id, _node_id(callee))
