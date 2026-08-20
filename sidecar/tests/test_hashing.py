"""
Tests for sidecar/cache/hashing.py's `compute_context_hash` -- Session 11
extends it to fold retrieved chunks into the same sorted-chunk-hash scheme
already used for caller/callee context, so a cache row invalidates when
retrieved content changes and not only when the call graph does.
"""

from __future__ import annotations

from sidecar.cache.hashing import compute_context_hash
from sidecar.repomap.context import FunctionContext, RelatedFunction
from sidecar.retrieval.retrieve import RetrievedChunk


def _ctx() -> FunctionContext:
    return FunctionContext(
        "a.js", "target", 0, callers=[RelatedFunction("a.js", "caller", 1, 0.0)], callees=[]
    )


def _chunk(text: str) -> RetrievedChunk:
    return RetrievedChunk(rel_fname="b.js", start_line=0, end_line=1, text=text)


def test_no_retrieved_chunks_matches_omitted_argument():
    assert compute_context_hash(_ctx()) == compute_context_hash(_ctx(), [])


def test_retrieved_chunks_change_the_hash():
    without = compute_context_hash(_ctx(), [])
    with_chunk = compute_context_hash(_ctx(), [_chunk("const x = 1;")])
    assert without != with_chunk


def test_changed_retrieved_chunk_text_changes_the_hash():
    first = compute_context_hash(_ctx(), [_chunk("const x = 1;")])
    second = compute_context_hash(_ctx(), [_chunk("const x = 2;")])
    assert first != second


def test_retrieved_chunk_order_does_not_affect_the_hash():
    a = _chunk("const a = 1;")
    b = RetrievedChunk(rel_fname="c.js", start_line=0, end_line=1, text="const b = 2;")
    assert compute_context_hash(_ctx(), [a, b]) == compute_context_hash(_ctx(), [b, a])


def test_same_inputs_are_deterministic():
    chunks = [_chunk("const x = 1;")]
    assert compute_context_hash(_ctx(), chunks) == compute_context_hash(_ctx(), chunks)
