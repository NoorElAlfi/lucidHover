"""
Tests for sidecar/retrieval/retrieve.py's query orchestration (Session 11),
especially the self-overlap exclusion: a function is maximally similar to
its own source, so chunks overlapping the function's own span must never
appear in its own retrieved-context section. `embed()` is monkeypatched
throughout -- no live Ollama involved, only LanceDB (a plain embedded
library) and pure Python.

Session 31 adds coverage for `_rows_for`'s per-chunk failure handling: only
a genuine context-window-overflow error skips just that one chunk; every
other `OllamaError` (Ollama unreachable, the embedding model not pulled,
any other server error) is systemic -- every remaining chunk would fail
identically -- and must still fail the whole batch fast rather than being
silently swallowed chunk-by-chunk.
"""

from __future__ import annotations

import pytest

from sidecar.generation.ollama_client import OllamaError
from sidecar.retrieval import retrieve as retrieve_module
from sidecar.retrieval.chunking import CHUNK_MAX_CHARS, Chunk
from sidecar.retrieval.retrieve import _overlaps, _rows_for, query_top_k, reindex_file_chunks, reindex_repo_chunks
from sidecar.retrieval.vectorstore import VectorStore


def _row(rel_fname: str, start_line: int, end_line: int, vector: list[float], text: str) -> dict:
    return {"rel_fname": rel_fname, "start_line": start_line, "end_line": end_line, "text": text, "vector": vector}


def test_overlaps_true_for_intersecting_ranges_in_the_same_file():
    row = {"rel_fname": "a.js", "start_line": 5, "end_line": 15}
    assert _overlaps("a.js", 10, 20, row) is True


def test_overlaps_false_for_disjoint_ranges_in_the_same_file():
    row = {"rel_fname": "a.js", "start_line": 5, "end_line": 10}
    assert _overlaps("a.js", 10, 20, row) is False


def test_overlaps_false_for_a_different_file_even_with_matching_lines():
    row = {"rel_fname": "b.js", "start_line": 10, "end_line": 20}
    assert _overlaps("a.js", 10, 20, row) is False


def test_query_top_k_excludes_chunks_overlapping_the_functions_own_span(tmp_path, monkeypatch):
    store = VectorStore(str(tmp_path))
    store.replace_all(
        [
            _row("target.js", 0, 40, [1.0, 0.0, 0.0, 0.0], "own-function-chunk"),
            _row("target.js", 40, 80, [0.9, 0.0, 0.0, 0.0], "same-file-other-chunk"),
            _row("other.js", 0, 5, [0.8, 0.0, 0.0, 0.0], "other-file-chunk"),
        ]
    )
    monkeypatch.setattr(retrieve_module, "embed", lambda model, text, base_url=None: [1.0, 0.0, 0.0, 0.0])

    results = query_top_k(store, "all-minilm", "function target() {}", "target.js", 5, 10)

    texts = [c.text for c in results]
    assert "own-function-chunk" not in texts
    assert texts == ["same-file-other-chunk", "other-file-chunk"]


def test_query_top_k_on_empty_store_returns_no_chunks(tmp_path, monkeypatch):
    store = VectorStore(str(tmp_path))
    monkeypatch.setattr(retrieve_module, "embed", lambda model, text, base_url=None: [0.0, 0.0, 0.0, 0.0])
    assert query_top_k(store, "all-minilm", "function target() {}", "target.js", 0, 5) == []


def test_query_top_k_windows_an_oversized_fn_source_before_embedding(tmp_path, monkeypatch):
    # Session 31: real pokerogue functions run up to ~420KB (huge data-init
    # functions) and reliably overflow all-minilm's real context window when
    # embedded uncapped -- confirmed live against the real model. query_top_k
    # must window fn_source down to CHUNK_MAX_CHARS before calling embed(),
    # not pass it through whole.
    store = VectorStore(str(tmp_path))
    seen_text = {}

    def fake_embed(model, text, base_url=None):
        seen_text["text"] = text
        return [1.0, 0.0, 0.0, 0.0]

    monkeypatch.setattr(retrieve_module, "embed", fake_embed)

    huge_fn_source = "a" * (CHUNK_MAX_CHARS * 10)
    query_top_k(store, "all-minilm", huge_fn_source, "target.js", 0, 5)

    assert len(seen_text["text"]) <= CHUNK_MAX_CHARS


def test_query_top_k_leaves_a_short_fn_source_unchanged(tmp_path, monkeypatch):
    store = VectorStore(str(tmp_path))
    seen_text = {}

    def fake_embed(model, text, base_url=None):
        seen_text["text"] = text
        return [1.0, 0.0, 0.0, 0.0]

    monkeypatch.setattr(retrieve_module, "embed", fake_embed)

    short_fn_source = "function target() { return 1; }"
    query_top_k(store, "all-minilm", short_fn_source, "target.js", 0, 5)

    assert seen_text["text"] == short_fn_source


def _context_length_overflow_error() -> OllamaError:
    # Mirrors ollama_client._post's real rendering for a context-window
    # overflow: "Ollama request to /api/embeddings failed (400): the input
    # length exceeds the context length".
    return OllamaError("Ollama request to /api/embeddings failed (400): the input length exceeds the context length")


def _model_not_found_error() -> OllamaError:
    # Also an HTTPError-caused OllamaError (same _post branch as the
    # overflow case above), but systemic -- every chunk would fail the same
    # way -- so it must NOT be treated like a per-chunk content failure.
    return OllamaError("Ollama model 'all-minilm' is not available (model not found). Run: ollama pull all-minilm")


def _connection_refused_error() -> OllamaError:
    return OllamaError("Cannot reach Ollama at http://localhost:11434 (connection refused). Is Ollama running?")


def _chunk(rel_fname: str, n: int) -> Chunk:
    return Chunk(rel_fname=rel_fname, start_line=n, end_line=n + 1, text=f"chunk {n}")


def test_rows_for_skips_only_the_chunk_that_overflowed_the_context_window(monkeypatch):
    chunks = [_chunk("a.js", 0), _chunk("a.js", 1), _chunk("a.js", 2)]

    def fake_embed(model, text, base_url=None):
        if text == "chunk 1":
            raise _context_length_overflow_error()
        return [1.0, 0.0]

    monkeypatch.setattr(retrieve_module, "embed", fake_embed)
    rows = _rows_for(chunks, "all-minilm", "http://x")

    assert [r["text"] for r in rows] == ["chunk 0", "chunk 2"]


def test_rows_for_reraises_on_a_connectivity_level_failure(monkeypatch):
    chunks = [_chunk("a.js", 0), _chunk("a.js", 1)]

    def fake_embed(model, text, base_url=None):
        raise _connection_refused_error()

    monkeypatch.setattr(retrieve_module, "embed", fake_embed)

    with pytest.raises(OllamaError):
        _rows_for(chunks, "all-minilm", "http://x")


def test_rows_for_reraises_on_a_model_not_found_failure_rather_than_skipping_every_chunk(monkeypatch):
    # Session 31 code-review finding: "model not found" is also an
    # HTTPError-caused OllamaError (same ollama_client._post branch as a
    # genuine context-length overflow), but it's systemic -- a misconfigured
    # embedding_model_id -- and every chunk would fail identically. It must
    # re-raise (surfacing the "Run: ollama pull <model>" diagnostic), not be
    # silently skipped chunk-by-chunk down to an empty, unexplained result.
    chunks = [_chunk("a.js", 0), _chunk("a.js", 1)]

    def fake_embed(model, text, base_url=None):
        raise _model_not_found_error()

    monkeypatch.setattr(retrieve_module, "embed", fake_embed)

    with pytest.raises(OllamaError, match="ollama pull"):
        _rows_for(chunks, "all-minilm", "http://x")


def test_reindex_repo_chunks_keeps_other_files_chunks_when_one_chunk_fails(tmp_path, monkeypatch):
    # Regression for the pre-session-31 bug: a single content-level embed
    # failure anywhere in the repo used to discard every other chunk too
    # (the whole pass aborted before store.replace_all() ever ran).
    (tmp_path / "a.js").write_text("function a() { return 1; }\n", encoding="utf-8")
    (tmp_path / "b.js").write_text("function b() { return 2; }\n", encoding="utf-8")

    def fake_embed(model, text, base_url=None):
        if "a()" in text:
            raise _context_length_overflow_error()
        return [1.0, 0.0]

    monkeypatch.setattr(retrieve_module, "embed", fake_embed)

    store = VectorStore(str(tmp_path))
    embedded_count = reindex_repo_chunks(str(tmp_path), store, "all-minilm")

    assert embedded_count == 1
    rows = store.query([1.0, 0.0], 10)
    assert len(rows) == 1
    assert rows[0]["rel_fname"] == "b.js"


def test_reindex_file_chunks_keeps_other_chunks_in_the_same_file_when_one_fails(tmp_path, monkeypatch):
    # More than CHUNK_LINES lines so "FAIL" lands in its own, later chunk --
    # confirms the first (good) chunk still gets embedded even though the
    # second (bad) one fails.
    lines = "\n".join(f"const x{i} = {i};" for i in range(15))
    (tmp_path / "a.js").write_text(lines + "\nconst FAIL = 1;\n", encoding="utf-8")

    def fake_embed(model, text, base_url=None):
        if "FAIL" in text:
            raise _context_length_overflow_error()
        return [1.0, 0.0]

    monkeypatch.setattr(retrieve_module, "embed", fake_embed)

    store = VectorStore(str(tmp_path))
    embedded_count = reindex_file_chunks(str(tmp_path), "a.js", store, "all-minilm")

    assert embedded_count == 1
