"""
Sidecar-side half of the cache-key hashing pipeline (Session 5). The
SQLite cache itself lives in the extension host (src/extension/cache/) --
see .claude/sessions/session-05-cache-and-hashing.md's "Cache ownership
decision" -- this module only computes `context_hash`, the piece that
requires data (the ranked call graph) the sidecar alone has.

`fn_hash` is deliberately NOT computed here even though it's a cache-key
input; it's computed by the extension host from the live document text so
that a cache hit never needs to contact the sidecar at all (Core Rule 4).
"""

from __future__ import annotations

import hashlib

from ..repomap.context import FunctionContext
from ..retrieval.retrieve import RetrievedChunk

CONTEXT_TIER_CALL_GRAPH_ONLY = "call_graph_only"
CONTEXT_TIER_CALL_GRAPH_AND_RETRIEVAL = "call_graph_and_retrieval"


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _context_chunks(ctx: FunctionContext, retrieved_chunks: list[RetrievedChunk]) -> list[str]:
    """
    One string per context "chunk" that feeds the prompt, per the spec's
    Context Budget section ("+N more marker included in the context hash").
    Order doesn't matter here -- compute_context_hash sorts before hashing.

    Retrieved chunks (Session 11) are folded in the same way callers/callees
    already are: a cache row must invalidate when the retrieved content
    changes, not only when the call graph does.
    """
    chunks = [f"caller:{c.rel_fname}:{c.name}:{c.line}" for c in ctx.callers]
    if ctx.callers_omitted:
        chunks.append(f"callers_omitted:{ctx.callers_omitted}")
    chunks += [f"callee:{c.rel_fname}:{c.name}:{c.line}" for c in ctx.callees]
    if ctx.callees_omitted:
        chunks.append(f"callees_omitted:{ctx.callees_omitted}")
    chunks += [
        f"retrieved:{c.rel_fname}:{c.start_line}:{c.end_line}:{c.text}" for c in retrieved_chunks
    ]
    return chunks


def compute_context_hash(ctx: FunctionContext, retrieved_chunks: list[RetrievedChunk] | None = None) -> str:
    """
    Hash of the sorted per-chunk hashes -- the "context_hashes" (plural)
    term in Core Design Decision #2's formula, collapsed to one value here.
    The extension host then folds this single value into the final
    cache_key alongside fn_source (see src/extension/cache/hash.ts).
    """
    chunk_hashes = sorted(_hash(chunk) for chunk in _context_chunks(ctx, retrieved_chunks or []))
    return _hash("".join(chunk_hashes))
