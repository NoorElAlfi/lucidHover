"""
Tests for sidecar/rpc_server.py's `_handle_resolve_function` -- the
sidecar-side location lookup the docked panel's click-to-navigate now tries
first, ahead of VS Code's own `executeWorkspaceSymbolProvider`. Added after
the user reported what looked like a dead navigate link; investigation
showed the target (`handleRenderRoute`) was a real, correctly-identified
caller in `fixtures/sample-repo/repomap/handlers.js` -- the sidecar's own
repomap already knows exactly where it is, VS Code's built-in symbol search
just didn't (it only knows about files the JS/TS language service has
already opened). See session-08 artifact's follow-up conversation.
"""

from __future__ import annotations

import os

import pytest

from sidecar.repomap.context import RepoMap
from sidecar.rpc_server import _handle_resolve_function

FIXTURE_ROOT = os.path.join(
    os.path.dirname(__file__), "..", "..", "fixtures", "sample-repo", "repomap"
)


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
