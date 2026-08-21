"""
Fixed-size line-window chunking over the repo's JS corpus (Session 11 /
Build Order step 11), for the retrieval tier the spec's Context Budget
section calls "top-k retrieved chunks" -- content outside what the
call-graph tier (own source + ranked caller/callee signatures) already
covers.

Reuses `repomap.extraction.find_source_files` (same `EXCLUDED_DIRS` walk the
call-graph indexer already uses, across every registered language -- Session
24) rather than a second file walker, then
layers `.gitignore` filtering on top via `pathspec` -- Continue.dev's
convention per the spec's "OSS to Borrow" table. `pathspec` (not a
hand-rolled matcher) because gitignore glob semantics (`**`, negation,
anchored vs. unanchored patterns) are easy to get subtly wrong, and this is
exactly the kind of small, well-scoped library the "borrow, don't rebuild"
principle is for.

Chunk size: 12 lines, no overlap -- a plain line-count heuristic for the
spec's "~200 tokens/chunk" target, calibrated down from an initial ~40-line
guess after live-testing against the actual bundled embedding model
(`all-minilm`, a MiniLM-L6 build): its own context window is a hard 256
tokens, and a 40-line JS chunk (even without unusually long lines) reliably
overflowed it -- Ollama's `/api/embeddings` returns `{"error": "the input
length exceeds the context length"}` rather than silently truncating. 12
lines stayed comfortably under that limit against every chunk in the
fixture repo, including its most comment-dense file. No token-counting
library was added to compute this precisely -- Ollama's tokenizer isn't
exposed locally without loading the model, and a fixed-size window only
needs to be reliably under the limit, not exact.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import pathspec

from ..repomap.extraction import find_source_files

CHUNK_LINES = 12
GITIGNORE_FILENAME = ".gitignore"


@dataclass(frozen=True)
class Chunk:
    rel_fname: str
    start_line: int  # 0-indexed, inclusive
    end_line: int  # 0-indexed, exclusive
    text: str


def _load_gitignore_spec(root: str) -> pathspec.PathSpec | None:
    gitignore_path = os.path.join(root, GITIGNORE_FILENAME)
    if not os.path.isfile(gitignore_path):
        return None
    with open(gitignore_path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()
    return pathspec.PathSpec.from_lines("gitwildmatch", lines)


def _chunk_file_text(rel_fname: str, text: str) -> list[Chunk]:
    lines = text.splitlines()
    chunks = []
    for start in range(0, len(lines), CHUNK_LINES):
        end = min(start + CHUNK_LINES, len(lines))
        chunk_text = "\n".join(lines[start:end])
        if chunk_text.strip():
            chunks.append(Chunk(rel_fname=rel_fname, start_line=start, end_line=end, text=chunk_text))
    return chunks


def chunk_repo(root: str) -> list[Chunk]:
    """Chunks every non-gitignored, registered-language source file under root."""
    spec = _load_gitignore_spec(root)
    chunks: list[Chunk] = []
    for fname in find_source_files(root):
        rel_fname = os.path.relpath(fname, root).replace(os.sep, "/")
        if spec is not None and spec.match_file(rel_fname):
            continue
        chunks.extend(chunk_file(root, rel_fname))
    return chunks


def chunk_file(root: str, rel_fname: str) -> list[Chunk]:
    """Chunks one already-known-included source file. Used by the save-triggered re-embed path."""
    fname = os.path.join(root, rel_fname)
    if not os.path.isfile(fname):
        return []
    with open(fname, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    return _chunk_file_text(rel_fname, text)
