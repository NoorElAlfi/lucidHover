"""
Smoke test for Session 3's repomap port, codifying the manual validation run
against fixtures/sample-repo/repomap (21 functions, 5 files, deliberate
cross-file call chains -- see .claude/sessions/session-03-repomap-port.md).
Session 8 adds coverage for `RepoMap.reindex_file` (the debounced-save
re-indexing entry point) and `find_js_files`'s `.jsx` support (added
mid-session once a real target repo turned out to have a JSX frontend).
"""

import os
import shutil

import pytest

from sidecar.repomap.context import RepoMap
from sidecar.repomap.extraction import find_js_files

FIXTURE_ROOT = os.path.join(
    os.path.dirname(__file__), "..", "..", "fixtures", "sample-repo", "repomap"
)


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


def test_find_js_files_includes_jsx_excludes_ts(tmp_path):
    """
    `.jsx` uses the same tree-sitter-javascript grammar as `.js` (confirmed
    directly against a real React component before adding this -- see
    session-08 artifact), so it's included. `.ts`/`.tsx` need a different
    grammar the sidecar doesn't have -- confirm they're NOT silently
    (mis)picked up.
    """
    (tmp_path / "a.js").write_text("function a() {}", encoding="utf-8")
    (tmp_path / "b.jsx").write_text("function B() { return <div />; }", encoding="utf-8")
    (tmp_path / "c.ts").write_text("function c(): void {}", encoding="utf-8")
    (tmp_path / "d.tsx").write_text("function D(): JSX.Element { return <div />; }", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "e.jsx").write_text("function E() {}", encoding="utf-8")

    found = {os.path.basename(f) for f in find_js_files(str(tmp_path))}
    assert found == {"a.js", "b.jsx"}


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
