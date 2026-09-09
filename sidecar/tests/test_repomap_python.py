"""
Content-specific smoke test for the Python fixture (Session 91), mirroring
test_repomap_typescript.py's shape but against fixtures/python/repomap (25
functions, 6 files).

`audit.py` adds a construct neither JS nor TS's fixture has: a bare (non-call)
decorator on a class method (`@traced` on `AuditLogger.record`). Session 83
confirmed directly that a decorator is a sibling node to the
`function_definition` it wraps, not an argument to a call -- `traced` itself
therefore has zero real callers (invisible to a call-expression-only query,
the same documented gap TS's own `@traced` example has), while `record`
itself is still captured as an ordinary definition and resolves normally when
called elsewhere (`audit_signup`'s `logger.record(event)`, an attribute-call).
"""

from __future__ import annotations

import shutil

import pytest

from sidecar.repomap.context import RepoMap
from sidecar.repomap.graph import build_call_graph
from sidecar.tests.fixture_paths import fixture_repomap_root

FIXTURE_ROOT = fixture_repomap_root("python")


@pytest.fixture(scope="module")
def repo_map():
    rm = RepoMap(FIXTURE_ROOT)
    rm.index()
    return rm


def test_indexes_all_functions(repo_map):
    assert len(repo_map.list_functions()) == 25


def test_most_called_function_ranks_highest(repo_map):
    top_node = max(repo_map.list_functions(), key=lambda n: repo_map.importance[n])
    assert top_node[1] == "log_event"


def test_truncates_callers_past_cap_with_omitted_count(repo_map):
    log_event = next(n for n in repo_map.list_functions() if n[1] == "log_event")
    ctx = repo_map.get_function_context(*log_event)
    assert len(ctx.callers) == 15
    assert ctx.callers_omitted == 3  # 18 total callers, cap is 15


def test_function_with_no_callers_or_callees(repo_map):
    is_empty = next(n for n in repo_map.list_functions() if n[1] == "is_empty")
    ctx = repo_map.get_function_context(*is_empty)
    assert ctx.callers == []
    assert ctx.callees == []
    assert ctx.callers_omitted == 0
    assert ctx.callees_omitted == 0


def test_cross_file_call_resolves(repo_map):
    insert_user = next(n for n in repo_map.list_functions() if n[1] == "insert_user")
    ctx = repo_map.get_function_context(*insert_user)
    callee_names = {(c.rel_fname, c.name) for c in ctx.callees}
    assert ("utils.py", "validate_email") in callee_names


def test_shared_helper_has_both_expected_callers(repo_map):
    shared = next(n for n in repo_map.list_functions() if n[1] == "validate_and_persist_signup")
    ctx = repo_map.get_function_context(*shared)
    caller_names = {c.name for c in ctx.callers}
    assert caller_names == {"handle_signup_route", "retry_queue_worker"}


def test_bare_decorator_produces_no_call_edge_to_decorated_function(repo_map):
    """`@traced` (bare, no call syntax) must not manufacture a fake caller
    edge into `traced` -- Session 83's structural finding, confirmed here
    against the real fixture rather than only a synthetic snippet."""
    traced = next(n for n in repo_map.list_functions() if n[1] == "traced")
    ctx = repo_map.get_function_context(*traced)
    assert ctx.callers == []


def test_decorated_method_still_resolves_as_an_ordinary_callee(repo_map):
    """The decoration itself produces no edge, but `record`'s own body is
    still captured as a definition and resolves normally when called
    elsewhere -- via `logger.record(event)`, an attribute-call, proving
    Python's no-separate-method-node shape (a method is just a
    `function_definition` like any free function) round-trips through the
    same resolution path as a plain function."""
    record = next(n for n in repo_map.list_functions() if n[1] == "record")
    ctx = repo_map.get_function_context(*record)
    assert {c.name for c in ctx.callers} == {"audit_signup"}
    assert {c.name for c in ctx.callees} == {"log_event"}


@pytest.fixture()
def scratch_repo_map(tmp_path):
    """A private, mutable copy of the fixture repo -- reindex_file tests edit
    a file on disk, which must never touch the real fixture used by the
    module-scoped `repo_map` fixture above."""
    scratch_root = tmp_path / "repomap"
    shutil.copytree(FIXTURE_ROOT, scratch_root)
    rm = RepoMap(str(scratch_root))
    rm.index()
    return rm, scratch_root


def test_reindex_file_leaves_line_shifted_functions_call_graph_intact(scratch_repo_map):
    """
    REQUIREMENTS.md structural requirement 4: editing inside
    `validate_and_persist_signup` shifts `handle_signup_route`/
    `retry_queue_worker`'s line numbers without changing their content.
    Confirm `reindex_file` rebuilds the graph so `handle_signup_route` is
    still resolvable at its new line and its call edges are unchanged.
    """
    rm, scratch_root = scratch_repo_map
    handlers_path = scratch_root / "handlers.py"
    original = handlers_path.read_text(encoding="utf-8")
    mutated = original.replace(
        'def validate_and_persist_signup(data):\n',
        'def validate_and_persist_signup(data):\n'
        '    log_event("extra line to shift everything below")\n',
    )
    assert mutated != original, "fixture source didn't match the expected function header -- update the test"
    handlers_path.write_text(mutated, encoding="utf-8")

    rm.reindex_file("handlers.py")

    handle_signup_route = next(n for n in rm.list_functions() if n[1] == "handle_signup_route")
    ctx = rm.get_function_context(*handle_signup_route)
    callee_names = {c.name for c in ctx.callees}
    assert callee_names == {"log_event", "validate_and_persist_signup"}

    fresh = build_call_graph(rm.tags_by_file)
    assert set(rm.graph.nodes) == set(fresh.nodes)
    actual_edges = {(u, v): rm.graph[u][v]["weight"] for u, v in rm.graph.edges}
    fresh_edges = {(u, v): fresh[u][v]["weight"] for u, v in fresh.edges}
    assert actual_edges == fresh_edges
