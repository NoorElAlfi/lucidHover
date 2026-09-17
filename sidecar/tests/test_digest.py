"""
Tests for sidecar/digest/ingestion.py (codebase digest export). Pure
filesystem tests via `tmp_path`, mirroring test_chunking.py's own pattern
for the identical "small tmp_path repo with a real .gitignore" shape -- no
sidecar process, no Ollama.
"""

from __future__ import annotations

from sidecar.digest.ingestion import (
    MAX_FILE_SIZE_BYTES,
    MAX_FILES,
    MAX_TOTAL_OUTPUT_BYTES,
    generate_digest,
    render_digest,
)


def _write(path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _write_bytes(path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def test_includes_a_plain_source_file(tmp_path):
    _write(tmp_path / "a.py", "def a():\n    return 1\n")
    result = generate_digest(str(tmp_path))
    assert result.total_files == 1
    assert result.included_files == 1
    assert result.files[0].rel_path == "a.py"
    assert result.files[0].content == "def a():\n    return 1\n"
    assert not result.files[0].skipped


def test_includes_non_source_files_too(tmp_path):
    """Unlike find_source_files (registered-language-only), the digest walk
    picks up any file with no adapter, e.g. a README or a config file --
    that's the whole point of a gitingest-style export."""
    _write(tmp_path / "README.md", "# hello\n")
    _write(tmp_path / "config.yaml", "key: value\n")
    result = generate_digest(str(tmp_path))
    rel_paths = {f.rel_path for f in result.files}
    assert rel_paths == {"README.md", "config.yaml"}


def test_skips_excluded_dirs(tmp_path):
    _write(tmp_path / "a.js", "function a() {}\n")
    _write(tmp_path / "node_modules" / "dep.js", "function shouldNotAppear() {}\n")
    result = generate_digest(str(tmp_path))
    rel_paths = {f.rel_path for f in result.files}
    assert rel_paths == {"a.js"}


def test_respects_root_gitignore(tmp_path):
    _write(tmp_path / "a.js", "function a() {}\n")
    _write(tmp_path / "generated" / "b.js", "function shouldNotAppear() {}\n")
    _write(tmp_path / ".gitignore", "generated/\n")
    result = generate_digest(str(tmp_path))
    rel_paths = {f.rel_path for f in result.files}
    assert rel_paths == {"a.js", ".gitignore"}


def test_binary_file_is_skipped_not_read(tmp_path):
    _write_bytes(tmp_path / "image.png", bytes(range(256)))  # contains \x00
    result = generate_digest(str(tmp_path))
    assert result.total_files == 1
    assert result.included_files == 0
    f = result.files[0]
    assert f.skipped is True
    assert f.skip_reason == "binary"
    assert f.content is None


def test_oversized_file_is_skipped_not_read(tmp_path, monkeypatch):
    monkeypatch.setattr("sidecar.digest.ingestion.MAX_FILE_SIZE_BYTES", 10)
    _write(tmp_path / "big.txt", "x" * 50)
    result = generate_digest(str(tmp_path))
    f = result.files[0]
    assert f.skipped is True
    assert f.skip_reason == "too-large"
    assert f.content is None
    assert f.size_bytes == 50


def test_total_budget_stops_reading_further_files_but_keeps_them_in_the_tree(tmp_path, monkeypatch):
    monkeypatch.setattr("sidecar.digest.ingestion.MAX_TOTAL_OUTPUT_BYTES", 15)
    _write(tmp_path / "a.txt", "0123456789")  # 10 bytes -- fits under the 15-byte budget alone
    _write(tmp_path / "b.txt", "should be budget-exceeded")  # pushes the running total past it

    result = generate_digest(str(tmp_path))
    assert result.truncated is True

    by_path = {f.rel_path: f for f in result.files}
    assert by_path["a.txt"].skipped is False  # already under budget on its own, so it's kept
    assert by_path["b.txt"].skipped is True
    assert by_path["b.txt"].skip_reason == "budget-exceeded"

    # Still listed in the tree even though its content was never read.
    tree_text = "\n".join(result.tree_lines)
    assert "b.txt" in tree_text


def test_max_files_cap_sets_truncated(tmp_path, monkeypatch):
    monkeypatch.setattr("sidecar.digest.ingestion.MAX_FILES", 2)
    _write(tmp_path / "a.txt", "a")
    _write(tmp_path / "b.txt", "b")
    _write(tmp_path / "c.txt", "c")

    result = generate_digest(str(tmp_path))
    assert result.total_files == 2
    assert result.truncated is True


def test_tree_reflects_nested_directories(tmp_path):
    _write(tmp_path / "src" / "main.py", "pass\n")
    _write(tmp_path / "src" / "utils" / "helpers.py", "pass\n")
    _write(tmp_path / "README.md", "hi\n")

    result = generate_digest(str(tmp_path))
    tree_text = "\n".join(result.tree_lines)
    assert "README.md" in tree_text
    assert "src/" in tree_text
    assert "main.py" in tree_text
    assert "helpers.py" in tree_text
    # utils/ should be nested under src/, not a top-level entry.
    assert tree_text.index("src/") < tree_text.index("helpers.py")


def test_render_digest_includes_content_and_skip_notes(tmp_path):
    _write(tmp_path / "a.py", "def a():\n    return 1\n")
    _write_bytes(tmp_path / "blob.bin", bytes(range(256)))

    result = generate_digest(str(tmp_path))
    text = render_digest(result)

    assert "def a():" in text
    assert "File: a.py" in text
    assert "blob.bin" in text
    assert "binary" in text
    # The binary file's own content must never appear as raw text.
    assert "File: blob.bin" not in text


def test_default_budget_constants_are_sane():
    # Sanity check on the shipped defaults themselves -- not a behavioral
    # test, just guards against an accidental unit mixup (e.g. bytes vs KB)
    # slipping through unnoticed.
    assert MAX_FILE_SIZE_BYTES == 100_000
    assert MAX_TOTAL_OUTPUT_BYTES == 2_000_000
    assert MAX_FILES == 5_000
