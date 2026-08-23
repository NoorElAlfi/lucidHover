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
