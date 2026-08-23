"""
Content-specific smoke test for the TypeScript fixture (Session 24), mirroring
test_repomap.py's JavaScript coverage but against fixtures/typescript/repomap
(26 functions, 6 files -- including one `.tsx` file backed by a second
manifest entry, `typescriptreact`, since real JSX needs the `language_tsx`
grammar rather than `language_typescript` -- see typescript_tags.scm's header
and this session's artifact for why). Session 23 deliberately left
per-language content assertions un-looped across a shared test file (a second
language's functions/counts are inherently its own); this is that second
file.

Session 49 added `audit.ts`'s `auditWrite` (a top-level arrow-const) between
`AuditLogger.record` (a class method) and `logEvent` (a free function),
bumping the count from 25 to 26 -- see the graph-view tests near the bottom
of this file for why (blast radius / call trace cross-language validation).
"""

from __future__ import annotations

import shutil

import pytest

from sidecar.repomap.context import RepoMap
from sidecar.repomap.graph import build_call_graph
from sidecar.tests.fixture_paths import fixture_repomap_root

FIXTURE_ROOT = fixture_repomap_root("typescript")


@pytest.fixture(scope="module")
def repo_map():
    rm = RepoMap(FIXTURE_ROOT)
    rm.index()
    return rm


def test_indexes_all_functions(repo_map):
    assert len(repo_map.list_functions()) == 26


def test_most_called_function_ranks_highest(repo_map):
    top_node = max(repo_map.list_functions(), key=lambda n: repo_map.importance[n])
    assert top_node[1] == "logEvent"


def test_truncates_callers_past_cap_with_omitted_count(repo_map):
    log_event = next(n for n in repo_map.list_functions() if n[1] == "logEvent")
    ctx = repo_map.get_function_context(*log_event)
    assert len(ctx.callers) == 15
    assert ctx.callers_omitted == 6  # 21 total callers, cap is 15


def test_function_with_no_callers_or_callees(repo_map):
    is_empty = next(n for n in repo_map.list_functions() if n[1] == "isEmpty")
    ctx = repo_map.get_function_context(*is_empty)
    assert ctx.callers == []
    assert ctx.callees == []
    assert ctx.callers_omitted == 0
    assert ctx.callees_omitted == 0


def test_cross_file_call_resolves(repo_map):
    insert_user = next(n for n in repo_map.list_functions() if n[1] == "insertUser")
    ctx = repo_map.get_function_context(*insert_user)
    callee_names = {(c.rel_fname, c.name) for c in ctx.callees}
    assert ("utils.ts", "validateEmail") in callee_names


def test_tsx_file_resolves_cross_file_call_into_ts_files(repo_map):
    """
    The one `.tsx` file in this corpus (dashboard.tsx, parsed via the
    `typescriptreact` manifest entry's `language_tsx` grammar) must resolve
    its calls into plain `.ts` files the same as any other file -- proving
    the two-grammar TypeScript/TSX split actually participates in one shared
    call graph, not two disconnected ones.
    """
    dashboard = next(n for n in repo_map.list_functions() if n[1] == "Dashboard")
    ctx = repo_map.get_function_context(*dashboard)
    callee_names = {(c.rel_fname, c.name) for c in ctx.callees}
    assert ("db.ts", "findUserByEmail") in callee_names
    assert ("logging.ts", "logEvent") in callee_names


def test_shared_helper_has_both_expected_callers(repo_map):
    shared = next(n for n in repo_map.list_functions() if n[1] == "validateAndPersistSignup")
    ctx = repo_map.get_function_context(*shared)
    caller_names = {c.name for c in ctx.callers}
    assert caller_names == {"handleSignupRoute", "retryQueueWorker"}


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
    `validateAndPersistSignup` shifts `handleSignupRoute`/`retryQueueWorker`'s
    line numbers without changing their content. Confirm `reindex_file`
    rebuilds the graph so `handleSignupRoute` is still resolvable at its new
    line and its call edges are unchanged.
    """
    rm, scratch_root = scratch_repo_map
    handlers_path = scratch_root / "handlers.ts"
    original = handlers_path.read_text(encoding="utf-8")
    mutated = original.replace(
        "export function validateAndPersistSignup(data: SignupPayload): User {\n",
        "export function validateAndPersistSignup(data: SignupPayload): User {\n"
        "  logEvent('extra line to shift everything below');\n",
    )
    assert mutated != original, "fixture source didn't match the expected function header -- update the test"
    handlers_path.write_text(mutated, encoding="utf-8")

    rm.reindex_file("handlers.ts")

    handle_signup_route = next(n for n in rm.list_functions() if n[1] == "handleSignupRoute")
    ctx = rm.get_function_context(*handle_signup_route)
    callee_names = {c.name for c in ctx.callees}
    assert callee_names == {"logEvent", "validateAndPersistSignup"}

    # Session 38: every def in handlers.ts shifted node id (line number is
    # part of `NodeId`) -- exactly the case `update_call_graph_for_file`'s
    # full local reset-and-recompute (not a diff-by-name patch) needs to get
    # right without touching any other file.
    fresh = build_call_graph(rm.tags_by_file)
    assert set(rm.graph.nodes) == set(fresh.nodes)
    actual_edges = {(u, v): rm.graph[u][v]["weight"] for u, v in rm.graph.edges}
    fresh_edges = {(u, v): fresh[u][v]["weight"] for u, v in fresh.edges}
    assert actual_edges == fresh_edges


# Session 49: sessions 45-48 (get_blast_radius/get_call_trace) were only ever
# exercised against the JavaScript fixture. `audit.ts`'s `record` (class
# method) -> `auditWrite` (arrow-const) -> `logEvent` (free function) chain
# gives both graph walks a real TS-specific-shape chain to run against --
# arrow-const in particular is the exact def shape session 25 found a real
# `isFunctionLike` bug on (extension-host side; these tests confirm the
# sidecar-side tree-sitter capture and graph walk have no analogous gap).


def test_call_trace_spans_class_method_arrow_const_and_free_function(repo_map):
    record = next(n for n in repo_map.list_functions() if n[1] == "record")
    trace = repo_map.get_call_trace(*record)
    assert [(n.rel_fname, n.name, n.depth) for n in trace.nodes] == [
        ("audit.ts", "auditWrite", 1),
        ("logging.ts", "logEvent", 2),
    ]
    assert trace.branches == []


def test_blast_radius_from_arrow_const_shows_class_method_caller(repo_map):
    audit_write = next(n for n in repo_map.list_functions() if n[1] == "auditWrite")
    blast = repo_map.get_blast_radius(*audit_write)
    assert [(n.rel_fname, n.name, n.depth) for n in blast.nodes] == [("audit.ts", "record", 1)]
    assert blast.omissions == []
