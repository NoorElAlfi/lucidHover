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

from ..generation.ollama_client import OLLAMA_BASE_URL, OllamaError, embed
from .chunking import CHUNK_MAX_CHARS, Chunk, chunk_file, chunk_repo
from .vectorstore import VectorStore

TOP_K = 5
# Overfetched, then self-overlap-filtered down to TOP_K -- the function
# being explained's own chunks would otherwise dominate the nearest-
# neighbor results (a function is maximally similar to itself).
OVERFETCH = TOP_K + 15

# The exact phrase Ollama's `/api/embeddings` reports for a context-window
# overflow (confirmed live, session 31) -- the one embed() failure mode
# `_rows_for` below treats as content-specific (skip just that chunk) rather
# than systemic (re-raise). Deliberately narrow: `ollama_client._post` wraps
# *every* non-2xx HTTP response as the same `OllamaError` class, including
# "model not found" (a misconfigured `embedding_model_id`) -- which is just
# as systemic as an unreachable Ollama (every chunk would fail identically)
# and must still surface its "Run: ollama pull <model>" diagnostic rather
# than being silently swallowed chunk-by-chunk.
_CONTEXT_LENGTH_OVERFLOW_SIGNATURE = "exceeds the context length"


@dataclass(frozen=True)
class RetrievedChunk:
    rel_fname: str
    start_line: int  # 0-indexed, inclusive
    end_line: int  # 0-indexed, exclusive
    text: str


def _rows_for(chunks: list[Chunk], embed_model: str, base_url: str) -> list[dict]:
    """
    Embeds each chunk, skipping (not aborting on) any single chunk whose
    `embed()` call fails.

    Session 31: this used to be a plain list comprehension, so one failing
    chunk anywhere in a full-repo or per-file pass raised immediately and
    the whole batch's rows were discarded -- `store.replace_all()` /
    `replace_file()` below never even ran, silently losing every OTHER
    chunk in that same pass too, not just the one that actually failed.
    Even with the char-capped chunker in chunking.py making overflow rare,
    a single chunk can still fail for other reasons (unusual content the
    char heuristic doesn't anticipate); the retrieval tier's whole design
    intent is that a chunk-level failure degrades gracefully, not that it
    takes an entire repo's or file's worth of otherwise-good chunks down
    with it.

    Only a genuine context-window-overflow failure (Ollama's own reported
    error contains `_CONTEXT_LENGTH_OVERFLOW_SIGNATURE`) is skipped
    per-chunk. Every other `OllamaError` -- Ollama unreachable at all, the
    embedding model not pulled, any other server error -- re-raises
    immediately: those are systemic (every remaining chunk would fail
    identically), and swallowing them chunk-by-chunk would silently report
    "embedded 0 chunks" instead of the actionable diagnostic
    `ollama_client.py` was built to surface (e.g. "Run: ollama pull
    <model>"). A broader `isinstance(exc.__cause__, HTTPError)` check was
    tried first and rejected: `ollama_client._post` wraps *every* non-2xx
    HTTP response the same way, including "model not found", which is just
    as systemic as an unreachable Ollama and must not be swallowed either.
    """
    rows = []
    for c in chunks:
        try:
            vector = embed(embed_model, c.text, base_url)
        except OllamaError as exc:
            if _CONTEXT_LENGTH_OVERFLOW_SIGNATURE in str(exc):
                continue
            raise
        rows.append(
            {
                "rel_fname": c.rel_fname,
                "start_line": c.start_line,
                "end_line": c.end_line,
                "text": c.text,
                "vector": vector,
            }
        )
    return rows


def reindex_repo_chunks(root: str, store: VectorStore, embed_model: str, base_url: str = OLLAMA_BASE_URL) -> int:
    """Full-repo chunk + embed pass, run once at sidecar startup. Returns the successfully-embedded chunk count."""
    chunks = chunk_repo(root)
    rows = _rows_for(chunks, embed_model, base_url)
    store.replace_all(rows)
    return len(rows)


def reindex_file_chunks(
    root: str, rel_fname: str, store: VectorStore, embed_model: str, base_url: str = OLLAMA_BASE_URL
) -> int:
    """One file's chunks, re-run on the save-triggered `reindex_file` RPC. Returns the successfully-embedded chunk count."""
    chunks = chunk_file(root, rel_fname)
    rows = _rows_for(chunks, embed_model, base_url)
    store.replace_file(rel_fname, rows)
    return len(rows)


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

    `fn_source` is windowed to `CHUNK_MAX_CHARS` before being embedded as the
    query vector -- session 31 confirmed real pokerogue functions can be
    enormous (the largest real ones ran 3,000-16,000+ lines / up to ~420KB)
    and reliably overflow all-minilm's real 256-token operative context
    window when embedded uncapped, independent of anything chunking.py does
    on the corpus side. This is a similarity search, not a correctness-
    critical value -- an approximate query vector from the function's first
    `CHUNK_MAX_CHARS` characters (signature + opening body, typically the
    most semantically distinctive part) still returns useful nearest
    neighbors; the alternative, an uncaught `OllamaError` degrading this
    function to zero retrieved chunks, is strictly worse.
    """
    query_text = fn_source[:CHUNK_MAX_CHARS]
    vector = embed(embed_model, query_text, base_url)
    rows = store.query(vector, OVERFETCH)
    kept = [row for row in rows if not _overlaps(rel_fname, start_line, end_line, row)]
    return [
        RetrievedChunk(rel_fname=row["rel_fname"], start_line=row["start_line"], end_line=row["end_line"], text=row["text"])
        for row in kept[:TOP_K]
    ]
