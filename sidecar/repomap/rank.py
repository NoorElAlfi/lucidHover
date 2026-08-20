"""
PageRank importance scoring, adapted from the ranking half of Aider-AI/aider's
aider/repomap.py:get_ranked_tags() (Apache-2.0):
https://github.com/Aider-AI/aider/blob/main/aider/repomap.py

Aider runs nx.pagerank() with optional personalization toward "chat files"
(files currently open in the user's session) and boosts for identifiers the
user explicitly mentioned -- both are about biasing a whole-repo map toward
what's relevant to the *current chat*. LucidHover indexes every function
uniformly with no such session context, so this is plain, unpersonalized
PageRank over the function-level graph from graph.py. Aider also
redistributes each file's rank across its outgoing edges to derive per-symbol
scores (since its graph is file-level); not needed here since graph.py's
nodes are already individual functions.
"""

from __future__ import annotations

import networkx as nx

from .graph import NodeId


def compute_importance(graph: nx.DiGraph) -> dict[NodeId, float]:
    """Return a PageRank importance score per function node, in [0, 1]."""
    if graph.number_of_nodes() == 0:
        return {}
    try:
        return nx.pagerank(graph, weight="weight")
    except nx.PowerIterationFailedConvergence:
        uniform = 1.0 / graph.number_of_nodes()
        return {n: uniform for n in graph.nodes}
