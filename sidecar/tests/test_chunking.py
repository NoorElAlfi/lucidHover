"""
Tests for sidecar/retrieval/chunking.py (Session 11): the fixed-size
line-window chunker + `.gitignore`-aware file scope for the retrieval tier.
Pure filesystem tests via `tmp_path` -- no Ollama/LanceDB involved.
"""

from __future__ import annotations

from sidecar.retrieval.chunking import CHUNK_LINES, CHUNK_MAX_CHARS, chunk_file, chunk_repo


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


def test_chunk_never_exceeds_char_budget_even_under_the_line_cap(tmp_path):
    # Session 31: real pokerogue chunks at exactly 11-12 lines (well under
    # CHUNK_LINES) still overflowed all-minilm's real context window purely
    # from cumulative character count -- e.g. long JSDoc lines, long import
    # lists. Regression: a handful of moderately long lines (well fewer than
    # CHUNK_LINES of them) must still be split once their combined length
    # would cross CHUNK_MAX_CHARS.
    line = "x" * 100  # 10 of these = 1000+ chars, over CHUNK_MAX_CHARS (500), under CHUNK_LINES (12)
    lines = "\n".join(line for _ in range(10))
    _write(tmp_path / "a.js", lines + "\n")
    chunks = chunk_file(str(tmp_path), "a.js")
    assert len(chunks) > 1
    for c in chunks:
        assert len(c.text) <= CHUNK_MAX_CHARS


def test_single_line_longer_than_char_budget_is_split_into_windows(tmp_path):
    # A pathological single line (e.g. a very long string literal or type
    # signature) longer than CHUNK_MAX_CHARS on its own must never be
    # emitted as one oversized chunk.
    long_line = "y" * (CHUNK_MAX_CHARS * 2 + 50)
    _write(tmp_path / "a.js", long_line + "\n")
    chunks = chunk_file(str(tmp_path), "a.js")
    assert len(chunks) == 3
    for c in chunks:
        assert len(c.text) <= CHUNK_MAX_CHARS
        assert c.start_line == 0
        assert c.end_line == 1
    assert "".join(c.text for c in chunks) == long_line


def test_short_lines_still_fill_up_to_chunk_lines_when_under_char_budget(tmp_path):
    # Confirms the char cap doesn't regress the common case: short lines
    # (like the fixture repo's own content) should still batch up to
    # CHUNK_LINES per chunk, not be split at every line.
    lines = "\n".join(f"const x{i} = {i};" for i in range(CHUNK_LINES))
    _write(tmp_path / "a.js", lines + "\n")
    chunks = chunk_file(str(tmp_path), "a.js")
    assert len(chunks) == 1
    assert chunks[0].start_line == 0
    assert chunks[0].end_line == CHUNK_LINES
