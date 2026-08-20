"""
Tests for sidecar/retrieval/vectorstore.py's LanceDB wrapper (Session 11).
Uses small synthetic vectors, not real embeddings -- no Ollama involved,
only LanceDB itself, which is a plain embedded/in-process library.
"""

from __future__ import annotations

from sidecar.retrieval.vectorstore import VectorStore


def _row(rel_fname: str, start_line: int, vector: list[float], text: str = "chunk text") -> dict:
    return {
        "rel_fname": rel_fname,
        "start_line": start_line,
        "end_line": start_line + 1,
        "text": text,
        "vector": vector,
    }


def test_query_on_empty_store_returns_nothing(tmp_path):
    store = VectorStore(str(tmp_path))
    assert store.query([0.0, 0.0, 0.0, 0.0], 5) == []


def test_replace_all_with_no_rows_leaves_store_empty(tmp_path):
    store = VectorStore(str(tmp_path))
    store.replace_all([])
    assert store.query([0.0, 0.0, 0.0, 0.0], 5) == []


def test_replace_all_then_query_returns_nearest_first(tmp_path):
    store = VectorStore(str(tmp_path))
    store.replace_all(
        [
            _row("a.js", 0, [1.0, 0.0, 0.0, 0.0], text="near"),
            _row("b.js", 0, [0.0, 0.0, 0.0, 1.0], text="far"),
        ]
    )
    results = store.query([0.9, 0.0, 0.0, 0.0], 1)
    assert len(results) == 1
    assert results[0]["text"] == "near"


def test_replace_file_only_touches_that_files_rows(tmp_path):
    store = VectorStore(str(tmp_path))
    store.replace_all(
        [
            _row("a.js", 0, [1.0, 0.0, 0.0, 0.0], text="a-old"),
            _row("b.js", 0, [0.0, 1.0, 0.0, 0.0], text="b-unchanged"),
        ]
    )
    store.replace_file("a.js", [_row("a.js", 0, [1.0, 0.0, 0.0, 0.0], text="a-new")])

    all_rows = store.query([0.5, 0.5, 0.0, 0.0], 10)
    texts = {row["text"] for row in all_rows}
    assert texts == {"a-new", "b-unchanged"}


def test_replace_file_with_no_rows_just_deletes(tmp_path):
    store = VectorStore(str(tmp_path))
    store.replace_all([_row("a.js", 0, [1.0, 0.0, 0.0, 0.0])])
    store.replace_file("a.js", [])
    assert store.query([1.0, 0.0, 0.0, 0.0], 5) == []


def test_reopening_the_store_sees_previously_written_rows(tmp_path):
    store = VectorStore(str(tmp_path))
    store.replace_all([_row("a.js", 0, [1.0, 0.0, 0.0, 0.0], text="persisted")])

    reopened = VectorStore(str(tmp_path))
    results = reopened.query([1.0, 0.0, 0.0, 0.0], 5)
    assert len(results) == 1
    assert results[0]["text"] == "persisted"
