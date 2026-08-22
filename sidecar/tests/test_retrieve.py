"""
Tests for sidecar/retrieval/retrieve.py's query orchestration (Session 11),
especially the self-overlap exclusion: a function is maximally similar to
its own source, so chunks overlapping the function's own span must never
appear in its own retrieved-context section. `embed()` is monkeypatched
throughout -- no live Ollama involved, only LanceDB (a plain embedded
library) and pure Python.

Session 31 added coverage for `_rows_for`'s per-chunk failure handling: only
a genuine context-window-overflow error skipped just that one chunk; every
other `OllamaError` (Ollama unreachable, the embedding model not pulled,
any other server error) was systemic -- every remaining chunk would fail
identically -- and had to fail the whole batch fast rather than being
silently swallowed chunk-by-chunk.

Session 33 moved `_rows_for` from one `embed()` call per chunk to grouped
`embed_batch()` calls (a real, measured 17.8x-54x throughput win -- see
`retrieve.py`'s module-level `EMBED_BATCH_SIZE` comment and
`ollama_client.embed_batch`'s docstring). The per-chunk overflow-skip test
below is replaced with a batch-shaped equivalent: `embed_batch` is now the
monkeypatched seam, and only whole-batch failures (still systemic -- the
one failure mode `/api/embed` can actually raise for) are exercised, since
session 33 confirmed live that `/api/embed` does not raise on content-level
overflow at all (it silently truncates), so there is no longer a per-chunk
failure signal to simulate.
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


def _model_not_found_error() -> OllamaError:
    return OllamaError("Ollama model 'all-minilm' is not available (model not found). Run: ollama pull all-minilm")


def _connection_refused_error() -> OllamaError:
    return OllamaError("Cannot reach Ollama at http://localhost:11434 (connection refused). Is Ollama running?")


def _chunk(rel_fname: str, n: int) -> Chunk:
    return Chunk(rel_fname=rel_fname, start_line=n, end_line=n + 1, text=f"chunk {n}")


def test_rows_for_embeds_all_chunks_via_embed_batch_preserving_order(monkeypatch):
    chunks = [_chunk("a.js", 0), _chunk("a.js", 1), _chunk("a.js", 2)]
    seen_batches = []

    def fake_embed_batch(model, texts, base_url=None):
        seen_batches.append(list(texts))
        return [[float(i), 0.0] for i in range(len(texts))]

    monkeypatch.setattr(retrieve_module, "embed_batch", fake_embed_batch)
    rows = _rows_for(chunks, "all-minilm", "http://x")

    assert [r["text"] for r in rows] == ["chunk 0", "chunk 1", "chunk 2"]
    assert [r["vector"] for r in rows] == [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]]
    # One batch call for all 3 (well under EMBED_BATCH_SIZE).
    assert seen_batches == [["chunk 0", "chunk 1", "chunk 2"]]


def test_rows_for_splits_more_than_embed_batch_size_chunks_into_multiple_calls(monkeypatch):
    n = retrieve_module.EMBED_BATCH_SIZE + 5
    chunks = [_chunk("a.js", i) for i in range(n)]
    seen_batch_sizes = []

    def fake_embed_batch(model, texts, base_url=None):
        seen_batch_sizes.append(len(texts))
        return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(retrieve_module, "embed_batch", fake_embed_batch)
    rows = _rows_for(chunks, "all-minilm", "http://x")

    assert len(rows) == n
    assert seen_batch_sizes == [retrieve_module.EMBED_BATCH_SIZE, 5]


def test_rows_for_reraises_on_a_connectivity_level_failure(monkeypatch):
    chunks = [_chunk("a.js", 0), _chunk("a.js", 1)]

    def fake_embed_batch(model, texts, base_url=None):
        raise _connection_refused_error()

    monkeypatch.setattr(retrieve_module, "embed_batch", fake_embed_batch)

    with pytest.raises(OllamaError):
        _rows_for(chunks, "all-minilm", "http://x")


def test_rows_for_reraises_on_a_model_not_found_failure(monkeypatch):
    # "model not found" (a misconfigured embedding_model_id) is systemic --
    # every chunk in every batch would fail identically -- so it must
    # re-raise and surface the "Run: ollama pull <model>" diagnostic.
    chunks = [_chunk("a.js", 0), _chunk("a.js", 1)]

    def fake_embed_batch(model, texts, base_url=None):
        raise _model_not_found_error()

    monkeypatch.setattr(retrieve_module, "embed_batch", fake_embed_batch)

    with pytest.raises(OllamaError, match="ollama pull"):
        _rows_for(chunks, "all-minilm", "http://x")


def test_reindex_repo_chunks_embeds_chunks_from_every_file(tmp_path, monkeypatch):
    (tmp_path / "a.js").write_text("function a() { return 1; }\n", encoding="utf-8")
    (tmp_path / "b.js").write_text("function b() { return 2; }\n", encoding="utf-8")

    def fake_embed_batch(model, texts, base_url=None):
        return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(retrieve_module, "embed_batch", fake_embed_batch)

    store = VectorStore(str(tmp_path))
    embedded_count = reindex_repo_chunks(str(tmp_path), store, "all-minilm")

    assert embedded_count == 2
    rows = store.query([1.0, 0.0], 10)
    assert {row["rel_fname"] for row in rows} == {"a.js", "b.js"}


def test_reindex_repo_chunks_writes_nothing_when_the_embed_batch_call_fails(tmp_path, monkeypatch):
    # A systemic embed_batch failure (session 33: the only kind /api/embed
    # can actually raise) aborts before store.replace_all() runs -- same
    # "fail loud, don't half-write" contract session 31 established for
    # systemic failures specifically (connectivity, model not found).
    (tmp_path / "a.js").write_text("function a() { return 1; }\n", encoding="utf-8")

    def fake_embed_batch(model, texts, base_url=None):
        raise _model_not_found_error()

    monkeypatch.setattr(retrieve_module, "embed_batch", fake_embed_batch)

    store = VectorStore(str(tmp_path))
    with pytest.raises(OllamaError, match="ollama pull"):
        reindex_repo_chunks(str(tmp_path), store, "all-minilm")

    assert store.query([1.0, 0.0], 10) == []


def test_reindex_file_chunks_embeds_every_chunk_in_the_file(tmp_path, monkeypatch):
    lines = "\n".join(f"const x{i} = {i};" for i in range(15))
    (tmp_path / "a.js").write_text(lines + "\nconst y = 1;\n", encoding="utf-8")

    def fake_embed_batch(model, texts, base_url=None):
        return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(retrieve_module, "embed_batch", fake_embed_batch)

    store = VectorStore(str(tmp_path))
    embedded_count = reindex_file_chunks(str(tmp_path), "a.js", store, "all-minilm")

    assert embedded_count >= 1
    assert len(store.query([1.0, 0.0], 10)) == embedded_count
