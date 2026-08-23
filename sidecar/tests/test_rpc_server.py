"""
Tests for sidecar/rpc_server.py's `_handle_resolve_function` -- the
sidecar-side location lookup the docked panel's click-to-navigate now tries
first, ahead of VS Code's own `executeWorkspaceSymbolProvider`. Added after
the user reported what looked like a dead navigate link; investigation
showed the target (`handleRenderRoute`) was a real, correctly-identified
caller in `fixtures/javascript/repomap/handlers.js` -- the sidecar's own
repomap already knows exactly where it is, VS Code's built-in symbol search
just didn't (it only knows about files the JS/TS language service has
already opened). See session-08 artifact's follow-up conversation.
"""

from __future__ import annotations

import pytest

from sidecar.repomap.context import RepoMap
from sidecar.rpc_server import _handle_get_blast_radius, _handle_get_call_trace, _handle_resolve_function
from sidecar.tests.fixture_paths import fixture_repomap_root

FIXTURE_ROOT = fixture_repomap_root("javascript")


@pytest.fixture(scope="module")
def repo_map():
    rm = RepoMap(FIXTURE_ROOT)
    rm.index()
    return rm


def test_resolves_the_exact_reported_case(repo_map):
    """The specific case from the user's report: handleRenderRoute is a
    real function the sidecar already knows about."""
    result = _handle_resolve_function(repo_map, {"name": "handleRenderRoute"})
    assert result == {"found": True, "rel_fname": "handlers.js", "line": 59}


def test_unknown_name_returns_not_found(repo_map):
    result = _handle_resolve_function(repo_map, {"name": "thisFunctionDoesNotExist"})
    assert result == {"found": False}


def test_ambiguous_name_resolves_to_the_higher_importance_candidate(tmp_path):
    """
    Two files each define a function named `shared`. `busy.js`'s version is
    called from three places (high importance); `quiet.js`'s version is
    never called. `resolve_function` should pick the busier one -- the more
    likely thing the user means -- rather than an arbitrary first match.
    """
    (tmp_path / "quiet.js").write_text("function shared() { return 1; }\n", encoding="utf-8")
    (tmp_path / "busy.js").write_text(
        "function shared() { return 2; }\n"
        "function callerA() { shared(); }\n"
        "function callerB() { shared(); }\n"
        "function callerC() { shared(); }\n",
        encoding="utf-8",
    )
    rm = RepoMap(str(tmp_path))
    rm.index()

    result = _handle_resolve_function(rm, {"name": "shared"})
    assert result["found"] is True
    assert result["rel_fname"] == "busy.js"


def test_get_blast_radius_returns_nodes_and_edges_for_multi_hop_chain(repo_map):
    """
    Session 45. `line` is deliberately approximate -- `_find_def_tag`'s
    nearest-line tolerance (same one `_handle_generate_explanation` already
    relies on) resolves it to the sidecar's own `validateEmail` def
    regardless, since there's only one function of that name in utils.js.
    """
    result = _handle_get_blast_radius(repo_map, {"file_path": "utils.js", "name": "validateEmail", "line": 0})

    assert result["rel_fname"] == "utils.js"
    assert result["name"] == "validateEmail"
    depth_by_name = {n["name"]: n["depth"] for n in result["nodes"]}
    assert depth_by_name == {
        "validateAndPersistSignup": 1,
        "insertUser": 1,
        "handleSignupRoute": 2,
        "retryQueueWorker": 2,
    }
    edge_pairs = {(e["caller_name"], e["callee_name"]) for e in result["edges"]}
    assert ("validateAndPersistSignup", "validateEmail") in edge_pairs
    assert ("insertUser", "validateEmail") in edge_pairs


def test_get_blast_radius_reports_omissions_for_capped_level(repo_map):
    """
    Session 47. `logEvent` has 17 real direct callers in the fixture (the
    same node `test_repomap.py`'s single-hop-cap test uses) -- confirms the
    new `omissions` field survives the RPC `asdict()` serialization as a
    plain list of {depth, omitted_count} dicts, not just at the `RepoMap`
    layer. The RPC handler uses the default max_depth (3), so 2 further
    depth-2 nodes are also present beyond the capped 15 at depth 1 -- this
    only asserts on the depth-1 cap itself.
    """
    result = _handle_get_blast_radius(repo_map, {"file_path": "logging.js", "name": "logEvent", "line": 0})

    depth_1_nodes = [n for n in result["nodes"] if n["depth"] == 1]
    assert len(depth_1_nodes) == 15
    assert result["omissions"] == [{"depth": 1, "omitted_count": 2}]


def test_get_blast_radius_unresolvable_function_returns_empty(repo_map):
    result = _handle_get_blast_radius(repo_map, {"file_path": "utils.js", "name": "doesNotExist", "line": 0})
    assert result["rel_fname"] == "utils.js"
    assert result["name"] == "doesNotExist"
    assert result["nodes"] == []
    assert result["edges"] == []


def test_get_call_trace_returns_single_hop_chain_for_real_fixture(repo_map):
    """
    Session 46. `line` is deliberately approximate, same nearest-line
    tolerance as the blast-radius test above. `logEvent` is the fixture's
    highest-importance function and has no callees itself, so the real
    primary-path trace from `handleSignupRoute` is exactly one hop.
    """
    result = _handle_get_call_trace(repo_map, {"file_path": "handlers.js", "name": "handleSignupRoute", "line": 0})

    assert result["rel_fname"] == "handlers.js"
    assert result["name"] == "handleSignupRoute"
    assert [(n["name"], n["depth"]) for n in result["nodes"]] == [("logEvent", 1)]
    edge_pairs = {(e["caller_name"], e["callee_name"]) for e in result["edges"]}
    assert ("handleSignupRoute", "logEvent") in edge_pairs


def test_get_call_trace_reports_branches_for_non_primary_callees(repo_map):
    """
    Session 48. `validateAndPersistSignup` calls five functions;
    `logEvent` (the fixture's highest-importance function, 17 real callers)
    wins the primary-path choice at depth 1, and the other four become a
    single depth-1 branch entry -- confirms the new `branches` field
    survives the RPC `asdict()` serialization as plain
    {depth, alternates: [...], omitted_count} data, not just at the
    `RepoMap` layer.
    """
    result = _handle_get_call_trace(
        repo_map, {"file_path": "handlers.js", "name": "validateAndPersistSignup", "line": 0}
    )

    assert [(n["name"], n["depth"]) for n in result["nodes"]] == [("logEvent", 1)]
    assert len(result["branches"]) == 1
    branch = result["branches"][0]
    assert branch["depth"] == 1
    assert branch["omitted_count"] == 0
    assert {a["name"] for a in branch["alternates"]} == {
        "validateEmail",
        "hashPassword",
        "insertUser",
        "sendWelcomeEmail",
    }


def test_get_call_trace_unresolvable_function_returns_empty(repo_map):
    result = _handle_get_call_trace(repo_map, {"file_path": "handlers.js", "name": "doesNotExist", "line": 0})
    assert result["rel_fname"] == "handlers.js"
    assert result["name"] == "doesNotExist"
    assert result["nodes"] == []
    assert result["edges"] == []
