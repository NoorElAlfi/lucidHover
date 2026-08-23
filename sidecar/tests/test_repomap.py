"""
Smoke test for Session 3's repomap port, codifying the manual validation run
against fixtures/javascript/repomap (21 functions, 5 files, deliberate
cross-file call chains -- see .claude/sessions/session-03-repomap-port.md).
Session 8 adds coverage for `RepoMap.reindex_file` (the debounced-save
re-indexing entry point) and `find_js_files`'s `.jsx` support (added
mid-session once a real target repo turned out to have a JSX frontend).
Session 24 renames `find_js_files` to `find_source_files` (now walking every
registered language, not just JavaScript, once TypeScript became a second
one) and updates the extension-inclusion test below accordingly.
"""

import os
import shutil

import pytest

from sidecar.repomap.context import RepoMap
from sidecar.repomap.extraction import find_source_files
from sidecar.repomap.graph import build_call_graph
from sidecar.tests.fixture_paths import fixture_repomap_root

FIXTURE_ROOT = fixture_repomap_root("javascript")


@pytest.fixture(scope="module")
def repo_map():
    rm = RepoMap(FIXTURE_ROOT)
    rm.index()
    return rm


def _node(rel_fname, name, line):
    return (rel_fname, name, line)


def test_indexes_all_functions(repo_map):
    assert len(repo_map.list_functions()) == 21


def test_most_called_function_ranks_highest(repo_map):
    top_node = max(repo_map.list_functions(), key=lambda n: repo_map.importance[n])
    assert top_node[1] == "logEvent"


def test_truncates_callers_past_cap_with_omitted_count(repo_map):
    log_event = next(n for n in repo_map.list_functions() if n[1] == "logEvent")
    ctx = repo_map.get_function_context(*log_event)
    assert len(ctx.callers) == 15
    assert ctx.callers_omitted == 2  # 17 total callers, cap is 15


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
    assert ("utils.js", "validateEmail") in callee_names


def test_shared_helper_has_both_expected_callers(repo_map):
    shared = next(n for n in repo_map.list_functions() if n[1] == "validateAndPersistSignup")
    ctx = repo_map.get_function_context(*shared)
    caller_names = {c.name for c in ctx.callers}
    assert caller_names == {"handleSignupRoute", "retryQueueWorker"}


@pytest.fixture()
def scratch_repo_map(tmp_path):
    """A private, mutable copy of the fixture repo -- `reindex_file` tests
    edit a file on disk, which must never touch the real fixture used by the
    module-scoped `repo_map` fixture above."""
    scratch_root = tmp_path / "repomap"
    shutil.copytree(FIXTURE_ROOT, scratch_root)
    rm = RepoMap(str(scratch_root))
    rm.index()
    return rm, scratch_root


def _assert_matches_full_rebuild(rm):
    """Session 38: `reindex_file`'s incremental graph update must always
    produce exactly the graph a full `build_call_graph` rescan of every file
    would -- same nodes, same edges, same weights (and, since Session 44,
    same `confident` flag per edge). This is the invariant the whole
    incremental design rests on."""
    fresh = build_call_graph(rm.tags_by_file)
    assert set(rm.graph.nodes) == set(fresh.nodes)
    actual_edges = {
        (u, v): (rm.graph[u][v]["weight"], rm.graph[u][v]["confident"]) for u, v in rm.graph.edges
    }
    fresh_edges = {(u, v): (fresh[u][v]["weight"], fresh[u][v]["confident"]) for u, v in fresh.edges}
    assert actual_edges == fresh_edges


def test_reindex_file_picks_up_new_call_edge(scratch_repo_map):
    """
    Session 8: `reindex_file` re-parses one file and rebuilds the graph so a
    newly-added call site is reflected without a full repo re-index. Before
    the edit, `isEmpty` deliberately has no callees (see utils.js's header
    comment) -- add a call from `isEmpty` to `validateEmail` and confirm the
    graph picks it up after `reindex_file("utils.js")`, and that the returned
    function count matches the file's actual def count.
    """
    rm, scratch_root = scratch_repo_map
    is_empty_before = next(n for n in rm.list_functions() if n[1] == "isEmpty")
    assert rm.get_function_context(*is_empty_before).callees == []

    utils_path = scratch_root / "utils.js"
    original = utils_path.read_text(encoding="utf-8")
    mutated = original.replace(
        "function isEmpty(value) {\n  return value === null || value === undefined || value === '';\n}",
        "function isEmpty(value) {\n  validateEmail('probe@example.com');\n  return value === null || value === undefined || value === '';\n}",
    )
    assert mutated != original, "fixture source didn't match the expected isEmpty body -- update the test"
    utils_path.write_text(mutated, encoding="utf-8")

    functions_indexed = rm.reindex_file("utils.js")
    assert functions_indexed == 4  # validateEmail, hashPassword, formatDate, isEmpty

    is_empty_after = next(n for n in rm.list_functions() if n[1] == "isEmpty")
    ctx = rm.get_function_context(*is_empty_after)
    callee_names = {c.name for c in ctx.callees}
    assert "validateEmail" in callee_names
    _assert_matches_full_rebuild(rm)


def test_reindex_file_before_index_falls_back_to_a_real_full_index(tmp_path):
    """
    Session 38: calling `reindex_file` before `index()` must not silently
    scope `tags_by_file`/`defs_by_name`/`refs_by_name` to just the one
    reindexed file -- it must fall back to a real, full `index()` so the
    rest of the repo's tags are still there.
    """
    shutil.copytree(FIXTURE_ROOT, tmp_path / "repomap")
    scratch_root = tmp_path / "repomap"
    rm = RepoMap(str(scratch_root))

    functions_indexed = rm.reindex_file("utils.js")

    assert functions_indexed == 4  # validateEmail, hashPassword, formatDate, isEmpty
    assert len(rm.list_functions()) == 21  # every file, not just utils.js
    insert_user = next(n for n in rm.list_functions() if n[1] == "insertUser")
    callee_names = {(c.rel_fname, c.name) for c in rm.get_function_context(*insert_user).callees}
    assert ("utils.js", "validateEmail") in callee_names


def test_find_source_files_includes_every_registered_language_excludes_unknown(tmp_path):
    """
    `.jsx` uses the same tree-sitter-javascript grammar as `.js` (confirmed
    directly against a real React component before adding this -- see
    session-08 artifact), so it's included. `.ts`/`.tsx` are registered as of
    Session 24 (their own grammars, via the "typescript"/"typescriptreact"
    manifest entries) and are now included too. `.py` has no registered
    adapter -- confirm it's still NOT silently (mis)picked up, same as `.ts`
    was before Session 24 added it.
    """
    (tmp_path / "a.js").write_text("function a() {}", encoding="utf-8")
    (tmp_path / "b.jsx").write_text("function B() { return <div />; }", encoding="utf-8")
    (tmp_path / "c.ts").write_text("function c(): void {}", encoding="utf-8")
    (tmp_path / "d.tsx").write_text("function D(): JSX.Element { return <div />; }", encoding="utf-8")
    (tmp_path / "e.py").write_text("def e(): pass", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "f.jsx").write_text("function F() {}", encoding="utf-8")

    found = {os.path.basename(f) for f in find_source_files(str(tmp_path))}
    assert found == {"a.js", "b.jsx", "c.ts", "d.tsx"}


def test_reindex_file_leaves_other_files_call_graph_intact(scratch_repo_map):
    """A single-file reindex must not corrupt cross-file edges into files it
    didn't touch -- reindex a file with no relation to insertUser/validateEmail,
    then confirm that existing cross-file edge (Session 3's own test) still
    resolves correctly."""
    rm, _ = scratch_repo_map
    rm.reindex_file("logging.js")

    insert_user = next(n for n in rm.list_functions() if n[1] == "insertUser")
    ctx = rm.get_function_context(*insert_user)
    callee_names = {(c.rel_fname, c.name) for c in ctx.callees}
    assert ("utils.js", "validateEmail") in callee_names
    _assert_matches_full_rebuild(rm)


def test_reindex_file_new_file_with_duplicate_name_in_other_file_drops_from_context(
    scratch_repo_map,
):
    """
    Session 38: `reindex_file` must find *existing* callers of a name without
    reindexing their file, via the reverse ref-by-name index -- not just
    handle same-file changes. Session 44 changed what happens once that
    fan-out is found: `validateAndPersistSignup` (in handlers.js) calling
    `validateEmail` becomes ambiguous once a second `validateEmail` exists in
    a brand-new third file, and neither candidate shares a file with the
    caller -- so both edges exist in the graph (ranking still sees the
    fan-out, confirmed via `_assert_matches_full_rebuild`'s confident-aware
    comparison below) but neither is a *confident* callee, so
    `get_function_context` now reports none. This deliberately replaces the
    old "fans out to both" expectation the pre-Session-44 version of this
    test asserted.
    """
    rm, scratch_root = scratch_repo_map

    shared = next(n for n in rm.list_functions() if n[1] == "validateAndPersistSignup")
    before = {(c.rel_fname, c.name) for c in rm.get_function_context(*shared).callees}
    assert ("utils.js", "validateEmail") in before  # unambiguous (one match) -- still confident

    new_file = scratch_root / "new_helpers.js"
    new_file.write_text(
        "function validateEmail(email) {\n  return email.includes('@');\n}\n"
        "module.exports = { validateEmail };\n",
        encoding="utf-8",
    )
    rm.reindex_file("new_helpers.js")

    after = {(c.rel_fname, c.name) for c in rm.get_function_context(*shared).callees}
    assert not any(name == "validateEmail" for _, name in after)
    # The ambiguous edges still exist in the underlying graph for PageRank
    # (Core Rule 3 -- ranking is untouched), just not as confident callees.
    graph_callees = {n[:2] for n in rm.graph.successors(shared)}
    assert ("utils.js", "validateEmail") in graph_callees
    assert ("new_helpers.js", "validateEmail") in graph_callees
    _assert_matches_full_rebuild(rm)


def test_reindex_file_new_file_with_duplicate_name_in_callers_own_file_is_preferred(
    scratch_repo_map,
):
    """
    Session 44: the same ambiguous-`validateEmail` scenario as above, except
    the new duplicate is added to `handlers.js` itself -- the caller's own
    file. Same-file candidates are preferred when a name is ambiguous, so
    `validateAndPersistSignup`'s confident callee should narrow to just the
    same-file one, dropping the unrelated `utils.js` definition even though
    it's still a name match.
    """
    rm, scratch_root = scratch_repo_map

    shared = next(n for n in rm.list_functions() if n[1] == "validateAndPersistSignup")

    handlers_path = scratch_root / "handlers.js"
    handlers_path.write_text(
        handlers_path.read_text(encoding="utf-8")
        + "\nfunction validateEmail(email) {\n  return email.includes('@');\n}\n",
        encoding="utf-8",
    )
    rm.reindex_file("handlers.js")

    after = {(c.rel_fname, c.name) for c in rm.get_function_context(*shared).callees}
    assert ("handlers.js", "validateEmail") in after
    assert ("utils.js", "validateEmail") not in after
    _assert_matches_full_rebuild(rm)


def test_get_blast_radius_multi_hop_with_shared_convergent_node(repo_map):
    """
    Session 45: `validateEmail` (utils.js) is called directly by both
    `validateAndPersistSignup` and `insertUser` (depth 1); both of those
    funnel up to `handleSignupRoute`/`retryQueueWorker` at depth 2, and
    `validateAndPersistSignup` itself also calls `insertUser` -- a depth-2
    edge into an already-visited depth-1 node. Confirms nodes are recorded
    once at their shortest depth while every real edge (including the
    convergent one) is still captured.
    """
    validate_email = next(n for n in repo_map.list_functions() if n[1] == "validateEmail")
    blast = repo_map.get_blast_radius(*validate_email, max_depth=3)

    depth_by_name = {n.name: n.depth for n in blast.nodes}
    assert depth_by_name == {
        "validateAndPersistSignup": 1,
        "insertUser": 1,
        "handleSignupRoute": 2,
        "retryQueueWorker": 2,
    }

    edge_pairs = {(e.caller_name, e.callee_name) for e in blast.edges}
    assert edge_pairs == {
        ("validateAndPersistSignup", "validateEmail"),
        ("insertUser", "validateEmail"),
        ("handleSignupRoute", "validateAndPersistSignup"),
        ("retryQueueWorker", "validateAndPersistSignup"),
        ("validateAndPersistSignup", "insertUser"),
    }


def test_get_blast_radius_respects_max_depth_cap(repo_map):
    validate_email = next(n for n in repo_map.list_functions() if n[1] == "validateEmail")
    blast = repo_map.get_blast_radius(*validate_email, max_depth=1)

    assert {n.name for n in blast.nodes} == {"validateAndPersistSignup", "insertUser"}
    assert all(n.depth == 1 for n in blast.nodes)
    edge_pairs = {(e.caller_name, e.callee_name) for e in blast.edges}
    assert edge_pairs == {
        ("validateAndPersistSignup", "validateEmail"),
        ("insertUser", "validateEmail"),
    }


def test_get_blast_radius_caps_fan_out_at_single_level(repo_map):
    """
    Session 47: `logEvent` has 17 real callers in the fixture (same node
    `test_truncates_callers_past_cap_with_omitted_count` above uses for
    `get_function_context`'s single-hop cap) -- confirms `get_blast_radius`
    applies the same BLAST_RADIUS_LEVEL_CAP (15) cap at depth 1 and reports
    the 2 omitted callers instead of silently truncating.
    """
    log_event = next(n for n in repo_map.list_functions() if n[1] == "logEvent")
    blast = repo_map.get_blast_radius(*log_event, max_depth=1)

    assert len(blast.nodes) == 15
    assert [(o.depth, o.omitted_count) for o in blast.omissions] == [(1, 2)]


def test_get_blast_radius_omitted_caller_is_not_expanded_to_next_level(tmp_path):
    """
    Session 47: the per-level cap must actually stop the walk from
    continuing through an omitted caller, not just hide it from the
    returned node list. `target` has 16 direct callers: `caller1..caller15`
    (each boosted with 3 of their own callers, so they clearly outrank
    `weakCaller` in importance) and `weakCaller` (1 caller of its own,
    `grandCaller`). With the cap at 15, `weakCaller` must be the one omitted
    at depth 1 -- and because it's omitted, its own caller `grandCaller`
    must never appear at depth 2, and the `weakCaller -> target` edge itself
    must be dropped too (recording it would just reproduce the unbounded
    fan-out the cap exists to avoid).
    """
    target_src = "function target() {}\n"
    (tmp_path / "target.js").write_text(target_src, encoding="utf-8")

    callers_src = ""
    for i in range(1, 16):
        callers_src += f"function caller{i}() {{ target(); }}\n"
        for b in range(3):
            callers_src += f"function boost_{i}_{b}() {{ caller{i}(); }}\n"
    (tmp_path / "callers.js").write_text(callers_src, encoding="utf-8")

    (tmp_path / "weak.js").write_text(
        "function weakCaller() { target(); }\nfunction grandCaller() { weakCaller(); }\n",
        encoding="utf-8",
    )

    rm = RepoMap(str(tmp_path))
    rm.index()
    target_node = next(n for n in rm.list_functions() if n[1] == "target")
    blast = rm.get_blast_radius(*target_node, max_depth=3)

    depth_1_names = {n.name for n in blast.nodes if n.depth == 1}
    assert depth_1_names == {f"caller{i}" for i in range(1, 16)}
    assert "weakCaller" not in depth_1_names
    assert next(o.omitted_count for o in blast.omissions if o.depth == 1) == 1
    assert not any(e.caller_name == "weakCaller" for e in blast.edges)
    assert not any(n.name == "grandCaller" for n in blast.nodes)


def test_get_blast_radius_omitted_caller_never_resurfaces_via_an_alternate_edge(tmp_path):
    """
    Session 47 (found by code-reviewer, not by any of the tests above):
    `weakCaller` is omitted at depth 1 for the same reason as the previous
    test (outranked by 15 boosted siblings), but it *also* directly calls
    `caller1` -- a kept depth-1 node -- giving it a second, indirect edge
    into the walk. Before this fix, `omitted_ever` wasn't tracked past the
    depth that omitted a node, so `weakCaller` would be "rediscovered" as a
    brand-new candidate at depth 2 via that second edge, resurface at the
    wrong (deeper) depth, and have its true, shorter `weakCaller -> target`
    edge silently replaced by the indirect `weakCaller -> caller1` one --
    breaking the "recorded once, at its true shortest depth" invariant for
    exactly the nodes the cap is supposed to hide. A once-omitted node must
    never resurface as a node OR an edge at any later depth, however it's
    reached.
    """
    (tmp_path / "target.js").write_text("function target() {}\n", encoding="utf-8")

    callers_src = ""
    for i in range(1, 16):
        callers_src += f"function caller{i}() {{ target(); }}\n"
        for b in range(3):
            callers_src += f"function boost_{i}_{b}() {{ caller{i}(); }}\n"
    (tmp_path / "callers.js").write_text(callers_src, encoding="utf-8")

    # weakCaller: the 16th, lowest-importance caller of target (omitted at
    # depth 1), but also a direct caller of caller1 (a kept depth-1 node) --
    # a second, indirect edge into the already-explored walk.
    (tmp_path / "weak.js").write_text(
        "function weakCaller() { target(); caller1(); }\n",
        encoding="utf-8",
    )

    rm = RepoMap(str(tmp_path))
    rm.index()
    target_node = next(n for n in rm.list_functions() if n[1] == "target")
    blast = rm.get_blast_radius(*target_node, max_depth=3)

    assert not any(n.name == "weakCaller" for n in blast.nodes)
    assert not any(e.caller_name == "weakCaller" for e in blast.edges)
    assert next(o.omitted_count for o in blast.omissions if o.depth == 1) == 1


def test_get_blast_radius_function_with_no_callers_is_empty(repo_map):
    is_empty = next(n for n in repo_map.list_functions() if n[1] == "isEmpty")
    blast = repo_map.get_blast_radius(*is_empty)
    assert blast.nodes == []
    assert blast.edges == []


def test_get_blast_radius_unknown_node_returns_empty(repo_map):
    blast = repo_map.get_blast_radius("nope.js", "doesNotExist", 0)
    assert blast.rel_fname == "nope.js"
    assert blast.name == "doesNotExist"
    assert blast.nodes == []
    assert blast.edges == []


def test_get_blast_radius_terminates_on_cyclic_call_chain(tmp_path):
    """
    Session 45: mutual recursion (`a` calls `b`, `b` calls `a`) must not send
    the BFS looping forever. Rooted at `a`: `b` is the one depth-1 caller
    (`b` calls `a`); `a`'s own call back into `b` is a real edge but `a` is
    already visited (it's the root), so it's recorded without re-expanding
    or adding a second node.
    """
    (tmp_path / "cyclic.js").write_text(
        "function a() { b(); }\nfunction b() { a(); }\n",
        encoding="utf-8",
    )
    rm = RepoMap(str(tmp_path))
    rm.index()
    a_node = next(n for n in rm.list_functions() if n[1] == "a")

    blast = rm.get_blast_radius(*a_node, max_depth=5)

    assert {n.name for n in blast.nodes} == {"b"}
    assert {(e.caller_name, e.callee_name) for e in blast.edges} == {("b", "a"), ("a", "b")}


def test_get_blast_radius_excludes_unconfident_ambiguous_callers(tmp_path):
    """
    Session 44's confident-edge filter must apply to blast radius the same
    way it already applies to `get_function_context`: an ambiguous caller (a
    name collision with no same-file candidate) must never appear as an
    asserted real caller, even though the edge still exists in the
    underlying graph for PageRank.
    """
    (tmp_path / "target.js").write_text("function shared() { return 1; }\n", encoding="utf-8")
    (tmp_path / "other.js").write_text("function shared() { return 2; }\n", encoding="utf-8")
    (tmp_path / "caller.js").write_text("function caller() { shared(); }\n", encoding="utf-8")
    rm = RepoMap(str(tmp_path))
    rm.index()

    target = next(n for n in rm.list_functions() if n[0] == "target.js" and n[1] == "shared")
    blast = rm.get_blast_radius(*target)

    assert blast.nodes == []
    assert blast.edges == []
    # The ambiguous edge still exists in the underlying graph (ranking is
    # untouched, Core Rule 3) -- just never surfaced as a confident caller.
    assert any(n[1] == "caller" for n in rm.graph.predecessors(target))


def test_get_call_trace_follows_single_highest_importance_callee_at_each_hop(tmp_path):
    """
    Session 46. `root` calls both `x` and `y`; `x` is called by two other
    functions too (`other1`/`other2`) so it out-ranks `y` (uncalled
    elsewhere) and is the primary-path choice at depth 1. `x` calls both `p`
    and `q`; `p` is likewise made higher-importance than `q` via its own
    extra caller (`pCaller`), so it's chosen at depth 2. `p` itself has no
    callees, terminating the walk there -- not because of the depth cap.
    """
    (tmp_path / "root.js").write_text("function root() { x(); y(); }\n", encoding="utf-8")
    (tmp_path / "other.js").write_text(
        "function other1() { x(); }\nfunction other2() { x(); }\n", encoding="utf-8"
    )
    (tmp_path / "x.js").write_text("function x() { p(); q(); }\n", encoding="utf-8")
    (tmp_path / "pcaller.js").write_text("function pCaller() { p(); }\n", encoding="utf-8")
    (tmp_path / "p.js").write_text("function p() { return 1; }\n", encoding="utf-8")
    (tmp_path / "q.js").write_text("function q() { return 2; }\n", encoding="utf-8")
    (tmp_path / "y.js").write_text("function y() { return 3; }\n", encoding="utf-8")

    rm = RepoMap(str(tmp_path))
    rm.index()
    root = next(n for n in rm.list_functions() if n[1] == "root")

    trace = rm.get_call_trace(*root, max_depth=3)

    assert [(n.name, n.depth) for n in trace.nodes] == [("x", 1), ("p", 2)]
    assert [(e.caller_name, e.callee_name) for e in trace.edges] == [("root", "x"), ("x", "p")]


def test_get_call_trace_respects_max_depth_cap(tmp_path):
    """Same shape as the test above, but with a real depth-3 callee (`z`) added past `p` -- capping at 2 must stop at `p` even though `p -> z` exists in the graph."""
    (tmp_path / "root.js").write_text("function root() { x(); y(); }\n", encoding="utf-8")
    (tmp_path / "other.js").write_text(
        "function other1() { x(); }\nfunction other2() { x(); }\n", encoding="utf-8"
    )
    (tmp_path / "x.js").write_text("function x() { p(); q(); }\n", encoding="utf-8")
    (tmp_path / "pcaller.js").write_text("function pCaller() { p(); }\n", encoding="utf-8")
    (tmp_path / "p.js").write_text("function p() { z(); }\n", encoding="utf-8")
    (tmp_path / "q.js").write_text("function q() { return 2; }\n", encoding="utf-8")
    (tmp_path / "y.js").write_text("function y() { return 3; }\n", encoding="utf-8")
    (tmp_path / "z.js").write_text("function z() { return 4; }\n", encoding="utf-8")

    rm = RepoMap(str(tmp_path))
    rm.index()
    root = next(n for n in rm.list_functions() if n[1] == "root")

    full = rm.get_call_trace(*root, max_depth=3)
    assert [n.name for n in full.nodes] == ["x", "p", "z"]

    capped = rm.get_call_trace(*root, max_depth=2)
    assert [n.name for n in capped.nodes] == ["x", "p"]


def test_get_call_trace_function_with_no_callees_is_empty(repo_map):
    is_empty = next(n for n in repo_map.list_functions() if n[1] == "isEmpty")
    trace = repo_map.get_call_trace(*is_empty)
    assert trace.nodes == []
    assert trace.edges == []


def test_get_call_trace_unknown_node_returns_empty(repo_map):
    trace = repo_map.get_call_trace("nope.js", "doesNotExist", 0)
    assert trace.rel_fname == "nope.js"
    assert trace.name == "doesNotExist"
    assert trace.nodes == []
    assert trace.edges == []


def test_get_call_trace_single_hop_against_real_fixture(repo_map):
    """
    Realistic case against the real fixture repo: `logEvent` is the
    fixture's single most-called (highest-importance) function, so it's the
    primary-path choice from any of several callers, and -- since `logEvent`
    itself has no callees -- the trace terminates there at depth 1.
    """
    handle_signup_route = next(n for n in repo_map.list_functions() if n[1] == "handleSignupRoute")
    trace = repo_map.get_call_trace(*handle_signup_route)
    assert [(n.name, n.depth) for n in trace.nodes] == [("logEvent", 1)]
    assert [(e.caller_name, e.callee_name) for e in trace.edges] == [("handleSignupRoute", "logEvent")]


def test_get_call_trace_terminates_on_cyclic_call_chain(tmp_path):
    """
    Session 46: mutual recursion (`a` calls `b`, `b` calls `a`) must not send
    the walk looping forever. Rooted at `a`: `b` is the single depth-1
    callee; `b`'s own call back into `a` is a real edge but `a` is already
    visited (it's the root), so it's recorded without re-adding a node or
    continuing the walk.
    """
    (tmp_path / "cyclic.js").write_text(
        "function a() { b(); }\nfunction b() { a(); }\n",
        encoding="utf-8",
    )
    rm = RepoMap(str(tmp_path))
    rm.index()
    a_node = next(n for n in rm.list_functions() if n[1] == "a")

    trace = rm.get_call_trace(*a_node, max_depth=5)

    assert [n.name for n in trace.nodes] == ["b"]
    assert [(e.caller_name, e.callee_name) for e in trace.edges] == [("a", "b"), ("b", "a")]


def test_get_call_trace_excludes_unconfident_ambiguous_callees(tmp_path):
    """
    Session 44's confident-edge filter must apply to the downstream walk the
    same way it already applies to `get_function_context`/`get_blast_radius`:
    an ambiguous callee (a name collision with no same-file candidate) must
    never be followed as the primary path, even though the edge still exists
    in the underlying graph for PageRank.
    """
    (tmp_path / "target.js").write_text("function shared() { return 1; }\n", encoding="utf-8")
    (tmp_path / "other.js").write_text("function shared() { return 2; }\n", encoding="utf-8")
    (tmp_path / "caller.js").write_text("function caller() { shared(); }\n", encoding="utf-8")
    rm = RepoMap(str(tmp_path))
    rm.index()

    caller = next(n for n in rm.list_functions() if n[1] == "caller")
    trace = rm.get_call_trace(*caller)

    assert trace.nodes == []
    assert trace.edges == []
    # The ambiguous edge still exists in the underlying graph (ranking is
    # untouched, Core Rule 3) -- just never surfaced as a confident callee.
    assert any(n[1] == "shared" for n in rm.graph.successors(caller))


def test_get_call_trace_records_non_primary_branches_at_each_hop(tmp_path):
    """
    Session 48. Same fixture shape as
    test_get_call_trace_follows_single_highest_importance_callee_at_each_hop:
    `root` calls `x` (primary at depth 1) and `y` (the branch alternate);
    `x` calls `p` (primary at depth 2) and `q` (the branch alternate). Each
    hop's non-chosen confident callee(s) must be recorded in `branches`
    under the depth of the primary-path node that hop produced, without
    themselves becoming trace nodes or being walked further.
    """
    (tmp_path / "root.js").write_text("function root() { x(); y(); }\n", encoding="utf-8")
    (tmp_path / "other.js").write_text(
        "function other1() { x(); }\nfunction other2() { x(); }\n", encoding="utf-8"
    )
    (tmp_path / "x.js").write_text("function x() { p(); q(); }\n", encoding="utf-8")
    (tmp_path / "pcaller.js").write_text("function pCaller() { p(); }\n", encoding="utf-8")
    (tmp_path / "p.js").write_text("function p() { return 1; }\n", encoding="utf-8")
    (tmp_path / "q.js").write_text("function q() { return 2; }\n", encoding="utf-8")
    (tmp_path / "y.js").write_text("function y() { return 3; }\n", encoding="utf-8")

    rm = RepoMap(str(tmp_path))
    rm.index()
    root = next(n for n in rm.list_functions() if n[1] == "root")

    trace = rm.get_call_trace(*root, max_depth=3)

    assert [(n.name, n.depth) for n in trace.nodes] == [("x", 1), ("p", 2)]
    branches_by_depth = {b.depth: [a.name for a in b.alternates] for b in trace.branches}
    assert branches_by_depth == {1: ["y"], 2: ["q"]}
    assert all(b.omitted_count == 0 for b in trace.branches)
    # Branch alternates are never walked -- `y`/`q` must not appear as trace nodes.
    assert {n.name for n in trace.nodes}.isdisjoint({"y", "q"})


def test_get_call_trace_no_branch_entry_when_only_one_confident_callee(repo_map):
    """Sparse convention: a hop with no alternate at all (the fixture's
    `handleHealthCheck -> logEvent` single-confident-callee hop -- its only
    other call is `res.status(200).end()`, which resolves to no real def
    and so contributes no confident edge at all) must not add a branches
    entry, same as `BlastRadiusOmission`'s "only depths that actually
    omitted something get an entry"."""
    handle_health_check = next(n for n in repo_map.list_functions() if n[1] == "handleHealthCheck")
    trace = repo_map.get_call_trace(*handle_health_check)
    assert [n.name for n in trace.nodes] == ["logEvent"]
    assert trace.branches == []


def test_get_call_trace_branch_alternates_capped_with_omitted_count(tmp_path):
    """
    Session 48, mirroring session 47's
    test_get_blast_radius_omitted_caller_never_resurfaces_via_an_alternate_edge
    setup style: `root` calls `primary` (boosted to the top rank by 2 extra
    callers) plus 16 other functions. `alt1`..`alt15` are each boosted by
    one extra caller so they deterministically outrank the unboosted
    `alt16`, which is the one dropped once the 15-alternate cap is applied.
    """
    root_src = "function root() { primary(); "
    root_src += " ".join(f"alt{i}();" for i in range(1, 17))
    root_src += " }\n"
    (tmp_path / "root.js").write_text(root_src, encoding="utf-8")
    (tmp_path / "other.js").write_text(
        "function other1() { primary(); }\nfunction other2() { primary(); }\n", encoding="utf-8"
    )
    (tmp_path / "primary.js").write_text("function primary() { return 0; }\n", encoding="utf-8")
    alts_src = "".join(f"function alt{i}() {{ return {i}; }}\n" for i in range(1, 17))
    (tmp_path / "alts.js").write_text(alts_src, encoding="utf-8")
    boosts_src = "".join(f"function boost{i}() {{ alt{i}(); }}\n" for i in range(1, 16))
    (tmp_path / "boosts.js").write_text(boosts_src, encoding="utf-8")

    rm = RepoMap(str(tmp_path))
    rm.index()
    root = next(n for n in rm.list_functions() if n[1] == "root")

    trace = rm.get_call_trace(*root, max_depth=1)

    assert [n.name for n in trace.nodes] == ["primary"]
    assert len(trace.branches) == 1
    branch = trace.branches[0]
    assert branch.depth == 1
    assert len(branch.alternates) == 15
    assert branch.omitted_count == 1
    assert {a.name for a in branch.alternates} == {f"alt{i}" for i in range(1, 16)}


def test_get_call_trace_no_branch_recorded_for_cycle_closing_hop(tmp_path):
    """
    Session 48. `a` calls `b` (primary, boosted) and `c` (a real depth-1
    branch alternate); `b` calls back into `a` (closing the cycle) and also
    into `d` (a real, would-be depth-2 alternate that outranks `a` -- wait,
    `a` outranks `d` here since `a` has one caller (`b`) and `d` has none,
    so `a` is depth 2's primary choice). The walk breaks at depth 2 before
    adding a node (per session 46's cycle handling) -- and, per this
    session's own scope, before adding a branch entry either: a branch
    point is only ever recorded alongside a real primary-path node, and the
    cycle-closing hop never gets one.
    """
    (tmp_path / "a.js").write_text("function a() { b(); c(); }\n", encoding="utf-8")
    (tmp_path / "bboost.js").write_text("function bBoost() { b(); }\n", encoding="utf-8")
    (tmp_path / "b.js").write_text("function b() { a(); d(); }\n", encoding="utf-8")
    (tmp_path / "c.js").write_text("function c() { return 1; }\n", encoding="utf-8")
    (tmp_path / "d.js").write_text("function d() { return 2; }\n", encoding="utf-8")

    rm = RepoMap(str(tmp_path))
    rm.index()
    a_node = next(n for n in rm.list_functions() if n[1] == "a")

    trace = rm.get_call_trace(*a_node, max_depth=5)

    assert [n.name for n in trace.nodes] == ["b"]
    branches_by_depth = {b.depth: [alt.name for alt in b.alternates] for b in trace.branches}
    assert branches_by_depth == {1: ["c"]}


def test_reindex_file_rename_updates_cross_file_edge_once_caller_reindexed(scratch_repo_map):
    """
    Session 38: a real cross-file rename -- `validateEmail` renamed to
    `validateEmailAddress` in its defining file (utils.js) *and* at its call
    site (handlers.js), each reindexed on its own as its own save would
    trigger. The final graph must point at the new name's node and have no
    dangling edge to the old, now-nonexistent one.
    """
    rm, scratch_root = scratch_repo_map

    utils_path = scratch_root / "utils.js"
    utils_path.write_text(
        utils_path.read_text(encoding="utf-8").replace("validateEmail", "validateEmailAddress"),
        encoding="utf-8",
    )
    rm.reindex_file("utils.js")

    handlers_path = scratch_root / "handlers.js"
    handlers_path.write_text(
        handlers_path.read_text(encoding="utf-8").replace("validateEmail", "validateEmailAddress"),
        encoding="utf-8",
    )
    rm.reindex_file("handlers.js")

    assert not any(n[1] == "validateEmail" for n in rm.list_functions())
    shared = next(n for n in rm.list_functions() if n[1] == "validateAndPersistSignup")
    callee_names = {(c.rel_fname, c.name) for c in rm.get_function_context(*shared).callees}
    assert ("utils.js", "validateEmailAddress") in callee_names
    _assert_matches_full_rebuild(rm)
