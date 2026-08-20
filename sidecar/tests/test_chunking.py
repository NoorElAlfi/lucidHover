"""
Tests for sidecar/retrieval/chunking.py (Session 11): the fixed-size
line-window chunker + `.gitignore`-aware file scope for the retrieval tier.
Pure filesystem tests via `tmp_path` -- no Ollama/LanceDB involved.
"""

from __future__ import annotations

from sidecar.retrieval.chunking import CHUNK_LINES, chunk_file, chunk_repo


def _write(path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_short_file_is_a_single_chunk(tmp_path):
    _write(tmp_path / "a.js", "function a() {\n  return 1;\n}\n")
    chunks = chunk_file(str(tmp_path), "a.js")
    assert len(chunks) == 1
    assert chunks[0].rel_fname == "a.js"
    assert chunks[0].start_line == 0


def test_long_file_splits_into_multiple_chunks(tmp_path):
    lines = "\n".join(f"const x{i} = {i};" for i in range(CHUNK_LINES * 2 + 5))
    _write(tmp_path / "a.js", lines + "\n")
    chunks = chunk_file(str(tmp_path), "a.js")
    assert len(chunks) == 3
    assert chunks[0].start_line == 0
    assert chunks[0].end_line == CHUNK_LINES
    assert chunks[1].start_line == CHUNK_LINES
    assert chunks[2].end_line == CHUNK_LINES * 2 + 5


def test_blank_file_yields_no_chunks(tmp_path):
    _write(tmp_path / "a.js", "\n\n\n")
    assert chunk_file(str(tmp_path), "a.js") == []


def test_missing_file_yields_no_chunks(tmp_path):
    assert chunk_file(str(tmp_path), "does-not-exist.js") == []


def test_chunk_repo_skips_excluded_dirs(tmp_path):
    _write(tmp_path / "a.js", "function a() {}\n")
    _write(tmp_path / "node_modules" / "dep.js", "function shouldNotAppear() {}\n")
    chunks = chunk_repo(str(tmp_path))
    rel_fnames = {c.rel_fname for c in chunks}
    assert rel_fnames == {"a.js"}


def test_chunk_repo_respects_gitignore(tmp_path):
    _write(tmp_path / "a.js", "function a() {}\n")
    _write(tmp_path / "generated" / "b.js", "function shouldNotAppear() {}\n")
    _write(tmp_path / ".gitignore", "generated/\n")

    chunks = chunk_repo(str(tmp_path))
    rel_fnames = {c.rel_fname for c in chunks}
    assert rel_fnames == {"a.js"}


def test_chunk_repo_with_no_gitignore_includes_everything(tmp_path):
    _write(tmp_path / "a.js", "function a() {}\n")
    _write(tmp_path / "sub" / "b.js", "function b() {}\n")
    chunks = chunk_repo(str(tmp_path))
    rel_fnames = {c.rel_fname for c in chunks}
    assert rel_fnames == {"a.js", "sub/b.js"}
