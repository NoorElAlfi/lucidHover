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

Session 78 added `dashboard.tsx`'s `UserBadge`/`Menu` (two new function
components exercising the new jsx_opening_element/jsx_self_closing_element
reference capture), bumping the count from 26 to 28 -- see the JSX-specific
tests near the bottom of this file.
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
    assert len(repo_map.list_functions()) == 28


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


def _assert_matches_full_rebuild(rm):
    """Mirrors test_repomap.py's helper of the same name: `reindex_file`'s
    incremental graph update must always match a full `build_call_graph`
    rescan -- same nodes, same edges, same (weight, confident) per edge."""
    fresh = build_call_graph(rm.tags_by_file)
    assert set(rm.graph.nodes) == set(fresh.nodes)
    actual_edges = {
        (u, v): (rm.graph[u][v]["weight"], rm.graph[u][v]["confident"]) for u, v in rm.graph.edges
    }
    fresh_edges = {(u, v): (fresh[u][v]["weight"], fresh[u][v]["confident"]) for u, v in fresh.edges}
    assert actual_edges == fresh_edges


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


# Session 78: real-fixture confirmation of the new JSX reference capture
# (session 77's blind-spot audit, closed this session), against the corpus's
# one real .tsx file rather than only synthetic snippets.


def test_jsx_component_usage_is_a_captured_caller(repo_map):
    """`<UserBadge />`, used 3x inside `Dashboard`, must now produce a real
    caller edge -- before this session it would have been invisible (session
    77's confirmed finding: captured callers stayed at 0 regardless of real
    JSX usage count)."""
    user_badge = next(n for n in repo_map.list_functions() if n[1] == "UserBadge")
    ctx = repo_map.get_function_context(*user_badge)
    assert {(c.rel_fname, c.name) for c in ctx.callers} == {("dashboard.tsx", "Dashboard")}


def test_jsx_namespaced_usage_resolves_to_root_identifier(repo_map):
    """`<Menu.Item />` resolves to `Menu` (the root/object identifier of the
    member expression), not `Item` -- this session's documented decision."""
    menu = next(n for n in repo_map.list_functions() if n[1] == "Menu")
    ctx = repo_map.get_function_context(*menu)
    assert {(c.rel_fname, c.name) for c in ctx.callers} == {("dashboard.tsx", "Dashboard")}


def test_jsx_lowercase_host_element_produces_no_reference_tag(repo_map):
    """`<div>` (a lowercase host element) must not become a reference Tag at
    all -- checked at the extraction level, not just absence from the graph,
    since a wrongly-captured `div` reference could still silently resolve to
    nothing (no function named `div` exists) and this test would pass for
    the wrong reason if it only checked the graph."""
    dashboard_tags = repo_map.tags_by_file["dashboard.tsx"]
    ref_names = {t.name for t in dashboard_tags if t.kind == "ref"}
    assert "div" not in ref_names
    assert "span" not in ref_names  # UserBadge's own host element, same check
    assert "nav" not in ref_names  # Menu's own host element, same check


# Session 79: session 44's ambiguous-name `confident` filter was built and
# tested only against call_expression-sourced refs. It's computed purely off
# `Tag.name`/`Tag.rel_fname` (see `_confident_callee_ids`), with no branching
# on `capture_kind` anywhere in graph.py, so it should generalize to
# JSX-sourced refs (session 78) with no code changes -- these tests confirm
# that generalization actually holds, mirroring session 44's own two
# duplicate-name scenarios (`test_reindex_file_new_file_with_duplicate_name_
# in_other_file_drops_from_context` / `..._in_callers_own_file_is_preferred`
# in test_repomap.py) but with a `<Component />`-sourced ambiguous edge
# instead of a call-expression-sourced one.


def test_jsx_sourced_ambiguous_caller_with_no_same_file_definition_is_unconfident(
    scratch_repo_map,
):
    """A JSX-sourced reference to an ambiguous name (defined in two files,
    neither of which is the caller's own file) must be suppressed from
    `get_function_context` the same way an ambiguous call-expression-sourced
    reference already is -- while the raw graph edges (for PageRank, Core
    Rule 3) still exist for both candidates."""
    rm, scratch_root = scratch_repo_map

    (scratch_root / "widget_user.tsx").write_text(
        "export function WidgetUser(): JSX.Element {\n  return <Shared />;\n}\n",
        encoding="utf-8",
    )
    rm.reindex_file("widget_user.tsx")

    (scratch_root / "widgets_a.tsx").write_text(
        "export function Shared(): JSX.Element {\n  return <div>A</div>;\n}\n",
        encoding="utf-8",
    )
    rm.reindex_file("widgets_a.tsx")

    widget_user = next(n for n in rm.list_functions() if n[1] == "WidgetUser")
    before = {(c.rel_fname, c.name) for c in rm.get_function_context(*widget_user).callees}
    assert ("widgets_a.tsx", "Shared") in before  # unambiguous so far -- confident

    (scratch_root / "widgets_b.tsx").write_text(
        "export function Shared(): JSX.Element {\n  return <div>B</div>;\n}\n",
        encoding="utf-8",
    )
    rm.reindex_file("widgets_b.tsx")

    after = {(c.rel_fname, c.name) for c in rm.get_function_context(*widget_user).callees}
    assert not any(name == "Shared" for _, name in after)

    graph_callees = {n[:2] for n in rm.graph.successors(widget_user)}
    assert ("widgets_a.tsx", "Shared") in graph_callees
    assert ("widgets_b.tsx", "Shared") in graph_callees
    _assert_matches_full_rebuild(rm)


def test_jsx_sourced_ambiguous_caller_prefers_same_file_definition(scratch_repo_map):
    """Same ambiguous-name scenario as above, except the duplicate definition
    lands in a file unrelated to either candidate, and the caller
    (`Dashboard`) shares a file with one of the two `UserBadge` definitions
    (`dashboard.tsx` itself) -- the same-file candidate must stay the
    confident one, dropping the unrelated duplicate."""
    rm, scratch_root = scratch_repo_map

    dashboard = next(n for n in rm.list_functions() if n[1] == "Dashboard")
    before = {(c.rel_fname, c.name) for c in rm.get_function_context(*dashboard).callees}
    assert ("dashboard.tsx", "UserBadge") in before

    (scratch_root / "other_badge.tsx").write_text(
        "export function UserBadge(): JSX.Element {\n  return <div>other</div>;\n}\n",
        encoding="utf-8",
    )
    rm.reindex_file("other_badge.tsx")

    after = {(c.rel_fname, c.name) for c in rm.get_function_context(*dashboard).callees}
    assert ("dashboard.tsx", "UserBadge") in after
    assert ("other_badge.tsx", "UserBadge") not in after
    _assert_matches_full_rebuild(rm)
