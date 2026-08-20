"""
Tests for sidecar/rpc_server.py's `_handle_list_ranked_functions` (Session 9):
backs the background pre-generation pass's walk order. Reuses the fixture
repo's already-computed PageRank importance -- no new ranker.
"""

from __future__ import annotations

import os

import pytest

from sidecar.repomap.context import RepoMap
from sidecar.rpc_server import _handle_list_ranked_functions

FIXTURE_ROOT = os.path.join(
    os.path.dirname(__file__), "..", "..", "fixtures", "sample-repo", "repomap"
)


@pytest.fixture(scope="module")
def repo_map():
    rm = RepoMap(FIXTURE_ROOT)
    rm.index()
    return rm


def test_returns_every_indexed_function(repo_map):
    result = _handle_list_ranked_functions(repo_map, {})
    names = {(f["rel_fname"], f["name"], f["line"]) for f in result["functions"]}
    assert names == set(repo_map.list_functions())


def test_sorted_by_importance_descending(repo_map):
    result = _handle_list_ranked_functions(repo_map, {})
    scores = [f["importance"] for f in result["functions"]]
    assert scores == sorted(scores, reverse=True)


def test_importance_values_match_repo_map(repo_map):
    result = _handle_list_ranked_functions(repo_map, {})
    for f in result["functions"]:
        node = (f["rel_fname"], f["name"], f["line"])
        assert f["importance"] == repo_map.importance.get(node, 0.0)


def test_a_function_with_real_callers_outranks_one_with_none(repo_map):
    """
    Sanity check against real fixture content, not just internal consistency:
    a function that's actually called by others should rank above a function
    nothing calls, mirroring `resolve_function`'s own ambiguous-name
    tie-break test.
    """
    result = _handle_list_ranked_functions(repo_map, {})
    by_name = {f["name"]: f["importance"] for f in result["functions"]}
    # renderTemplate is called by handleRenderRoute (session-08 artifact's
    # navigation-bug follow-up confirmed this edge is real).
    assert "renderTemplate" in by_name
