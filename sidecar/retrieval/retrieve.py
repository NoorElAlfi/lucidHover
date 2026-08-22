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

from ..generation.ollama_client import OLLAMA_BASE_URL, OllamaError, embed, embed_batch
from .chunking import CHUNK_MAX_CHARS, Chunk, chunk_file, chunk_repo
from .vectorstore import VectorStore

TOP_K = 5
# Overfetched, then self-overlap-filtered down to TOP_K -- the function
# being explained's own chunks would otherwise dominate the nearest-
# neighbor results (a function is maximally similar to itself).
OVERFETCH = TOP_K + 15

# Chunks per `embed_batch()` call in `_rows_for` (session 33). Chosen from a
# real live sweep against the running `all-minilm`: 8-wide batches ran
# ~260ms/chunk, 32-wide ~73ms/chunk, 64-wide ~38ms/chunk (stable across 3
# repeated trials), 128-wide ~21ms/chunk, 256-wide ~12ms/chunk -- diminishing
# returns past ~64, and batches of 400-512 hit real, observed intermittent
# failures from Ollama's own internal runner subprocess (a `dial tcp ...
# connectex: actively refused` error talking to its own tokenize helper, not
# a documented size limit) during the same sweep. 64 sits comfortably below
# that observed instability while already capturing most of the win (~38ms
# vs. ~2.08s/chunk sequential -- see `embed_batch`'s docstring) and keeps a
# single failed batch's blast radius small relative to a full-repo pass.
EMBED_BATCH_SIZE = 64


@dataclass(frozen=True)
class RetrievedChunk:
    rel_fname: str
    start_line: int  # 0-indexed, inclusive
    end_line: int  # 0-indexed, exclusive
    text: str


def _rows_for(chunks: list[Chunk], embed_model: str, base_url: str) -> list[dict]:
    """
    Embeds every chunk in `EMBED_BATCH_SIZE`-wide groups via `embed_batch()`
    (session 33 -- see that function's docstring for the real measured
    throughput win: ~38ms/chunk batched vs. ~2.08s/chunk from the old
    strictly-sequential `embed()`-per-chunk loop this replaced).

    Session 31's per-chunk skip-on-overflow behavior (only a genuine
    context-window-overflow `OllamaError` was swallowed; every other
    failure -- Ollama unreachable, model not pulled -- re-raised
    immediately) is NOT preserved here, because it cannot be: session 33
    confirmed live that `/api/embed` (unlike the single-item `/api/embeddings`
    `embed()` used) does not raise on overflow at all -- it silently returns
    a truncated embedding with HTTP 200. There is no longer a per-item
    failure signal to catch. This is judged safe because every chunk reaching
    this function is already guaranteed by `chunking.py` to be at or under
    `CHUNK_MAX_CHARS`, which session 31 confirmed sits with real margin below
    the real overflow boundary (0 of 1243 real post-fix pokerogue chunks
    overflowed) -- the skip path this replaces was already unreachable for
    any chunk `chunking.py` actually produces.

    A batch-level `OllamaError` (connectivity, model not found, or any other
    non-2xx response) still re-raises immediately and aborts the whole
    `_rows_for` call, same as a systemic failure always has: every chunk in
    every remaining batch would fail identically, so failing loud and fast
    (surfacing e.g. "Run: ollama pull <model>") is still correct. This does
    mean one failed batch now discards that batch's own (up to
    `EMBED_BATCH_SIZE`) chunks together rather than one at a time -- accepted
    given only systemic failures can trigger it at all now, and
    `EMBED_BATCH_SIZE` was chosen partly to keep that blast radius small.
    """
    rows = []
    for i in range(0, len(chunks), EMBED_BATCH_SIZE):
        batch = chunks[i : i + EMBED_BATCH_SIZE]
        vectors = embed_batch(embed_model, [c.text for c in batch], base_url)
        for c, vector in zip(batch, vectors):
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
