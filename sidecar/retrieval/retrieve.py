"""
Retrieval orchestration (Session 11): wires `chunking.py` + the Ollama
`embed()` client + `vectorstore.py` together. Kept separate from
`repomap/context.py` deliberately -- everything in `context.py` is pure
in-memory graph lookup, while chunking-and-embedding a repo is a real
network-calling, I/O-bound pass; mixing the two would make `RepoMap` depend
on Ollama being reachable just to build its (embedding-free) call graph.

`RetrievedChunk` is passed around as its own value rather than folded into
`FunctionContext` -- retrieval is an orthogonal input to generation, not a
new field of the call-graph context the rest of the codebase already
depends on.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..generation.ollama_client import OLLAMA_BASE_URL, embed
from .chunking import Chunk, chunk_file, chunk_repo
from .vectorstore import VectorStore

TOP_K = 5
# Overfetched, then self-overlap-filtered down to TOP_K -- the function
# being explained's own chunks would otherwise dominate the nearest-
# neighbor results (a function is maximally similar to itself).
OVERFETCH = TOP_K + 15


@dataclass(frozen=True)
class RetrievedChunk:
    rel_fname: str
    start_line: int  # 0-indexed, inclusive
    end_line: int  # 0-indexed, exclusive
    text: str


def _rows_for(chunks: list[Chunk], embed_model: str, base_url: str) -> list[dict]:
    return [
        {
            "rel_fname": c.rel_fname,
            "start_line": c.start_line,
            "end_line": c.end_line,
            "text": c.text,
            "vector": embed(embed_model, c.text, base_url),
        }
        for c in chunks
    ]


def reindex_repo_chunks(root: str, store: VectorStore, embed_model: str, base_url: str = OLLAMA_BASE_URL) -> int:
    """Full-repo chunk + embed pass, run once at sidecar startup. Returns the chunk count."""
    chunks = chunk_repo(root)
    store.replace_all(_rows_for(chunks, embed_model, base_url))
    return len(chunks)


def reindex_file_chunks(
    root: str, rel_fname: str, store: VectorStore, embed_model: str, base_url: str = OLLAMA_BASE_URL
) -> int:
    """One file's chunks, re-run on the save-triggered `reindex_file` RPC. Returns the chunk count."""
    chunks = chunk_file(root, rel_fname)
    store.replace_file(rel_fname, _rows_for(chunks, embed_model, base_url))
    return len(chunks)


def _overlaps(rel_fname: str, start_line: int, end_line: int, row: dict) -> bool:
    if row["rel_fname"] != rel_fname:
        return False
    return row["start_line"] < end_line and row["end_line"] > start_line


def query_top_k(
    store: VectorStore,
    embed_model: str,
    fn_source: str,
    rel_fname: str,
    start_line: int,
    end_line: int,
    base_url: str = OLLAMA_BASE_URL,
) -> list[RetrievedChunk]:
    """
    Top-`TOP_K` nearest chunks to `fn_source`, excluding chunks that overlap
    the function's own span (own source is already given to the model in
    full -- retrieval is for content *outside* it, per the spec's Context
    Budget section).
    """
    vector = embed(embed_model, fn_source, base_url)
    rows = store.query(vector, OVERFETCH)
    kept = [row for row in rows if not _overlaps(rel_fname, start_line, end_line, row)]
    return [
        RetrievedChunk(rel_fname=row["rel_fname"], start_line=row["start_line"], end_line=row["end_line"], text=row["text"])
        for row in kept[:TOP_K]
    ]
