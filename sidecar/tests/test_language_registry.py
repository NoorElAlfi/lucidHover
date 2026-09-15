"""
Tests for `LanguageRegistry`'s dir-exclusion matching (session 83's flagged
"exact-name-only, can't express `*.egg-info`" gap; session 102 closes it).
"""

from __future__ import annotations

import os

from sidecar.repomap.extraction import find_source_files


def test_glob_dir_exclusion_skips_egg_info(tmp_path):
    """Python's real packaging convention produces a `*.egg-info` dir whose
    exact name varies per-package -- confirm the new glob-pattern matching
    (not just exact `dirs` membership) skips it, using the real registered
    "python" manifest entry (languages.json now lists "*.egg-info")."""
    (tmp_path / "a.py").write_text("def a(): pass", encoding="utf-8")
    (tmp_path / "mypackage.egg-info").mkdir()
    (tmp_path / "mypackage.egg-info" / "b.py").write_text("def b(): pass", encoding="utf-8")

    found = {os.path.basename(f) for f in find_source_files(str(tmp_path))}
    assert found == {"a.py"}


def test_exact_name_dir_exclusion_still_works(tmp_path):
    """Regression: the pre-existing exact-name path (node_modules, etc.)
    must be unaffected by adding glob-pattern support alongside it."""
    (tmp_path / "a.js").write_text("function a() {}", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "dep.js").write_text("function dep() {}", encoding="utf-8")

    found = {os.path.basename(f) for f in find_source_files(str(tmp_path))}
    assert found == {"a.js"}


def test_glob_pattern_does_not_over_match(tmp_path):
    """A dir name that merely contains "egg-info" as a substring, but
    doesn't match the `*.egg-info` glob shape, must not be excluded --
    confirms fnmatch semantics (suffix glob), not a loose substring check."""
    (tmp_path / "egg-info-notes.py").write_text("def c(): pass", encoding="utf-8")
    (tmp_path / "egg-info-notes").mkdir()
    (tmp_path / "egg-info-notes" / "d.py").write_text("def d(): pass", encoding="utf-8")

    found = {os.path.basename(f) for f in find_source_files(str(tmp_path))}
    assert found == {"egg-info-notes.py", "d.py"}
