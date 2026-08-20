"""
Tests for sidecar/retrieval/retrieve.py's query orchestration (Session 11),
especially the self-overlap exclusion: a function is maximally similar to
its own source, so chunks overlapping the function's own span must never
appear in its own retrieved-context section. `embed()` is monkeypatched
throughout -- no live Ollama involved, only LanceDB (a plain embedded
library) and pure Python.
"""

from __future__ import annotations

from sidecar.retrieval import retrieve as retrieve_module
from sidecar.retrieval.retrieve import _overlaps, query_top_k
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
    monkeypatch.setattr(retrieve_module, "embed", lambda model, text: [1.0, 0.0, 0.0, 0.0])

    results = query_top_k(store, "all-minilm", "function target() {}", "target.js", 5, 10)

    texts = [c.text for c in results]
    assert "own-function-chunk" not in texts
    assert texts == ["same-file-other-chunk", "other-file-chunk"]


def test_query_top_k_on_empty_store_returns_no_chunks(tmp_path, monkeypatch):
    store = VectorStore(str(tmp_path))
    monkeypatch.setattr(retrieve_module, "embed", lambda model, text: [0.0, 0.0, 0.0, 0.0])
    assert query_top_k(store, "all-minilm", "function target() {}", "target.js", 0, 5) == []
