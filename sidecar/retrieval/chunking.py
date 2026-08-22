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

Chunk size: up to 12 lines AND up to `CHUNK_MAX_CHARS` characters, no
overlap, whichever bound is hit first -- a plain heuristic for the spec's
"~200 tokens/chunk" target, calibrated against the actual bundled embedding
model (`all-minilm`, a MiniLM-L6 build). Its context window is a hard 256
tokens (confirmed session 31 directly against the running model: `ollama
show all-minilm` reports `bert.context_length` as 512, the architecture's
max, but the Modelfile bakes in `PARAMETER num_ctx 256` -- 256 is the real
operative limit Ollama actually runs this model with, matching what session
11 found empirically; a stale `context_length`-field reading from `ollama
list` reported 512 in session 29, which was the wrong field for this
purpose). Ollama's `/api/embeddings` returns `{"error": "the input length
exceeds the context length"}` on overflow rather than silently truncating.

Line count alone (the original v1 heuristic, 12 lines with no character
guard) is not a reliable proxy for staying under that limit: session 31
measured real chunks from pokerogue (a 600+ file real repo, not the small
hand-written fixture repo used to originally calibrate 12) and found ~0.7%
of real 12-line chunks still overflow -- not because of one pathologically
long line (the failing chunks' individual lines were unremarkable, 97-260
chars), but because 12 lines of denser real code (long JSDoc comments, long
import lists, chained conditionals) can add up to 750-1275 total characters,
crossing the real failure boundary (bracketed empirically between 691 chars,
confirmed OK, and 759 chars, confirmed failing, across both the original
fixture calibration and this session's real-repo measurement) even though
no single line looks unusual. `CHUNK_MAX_CHARS = 500` adds real margin below
that ~700-800 char boundary. A single line longer than `CHUNK_MAX_CHARS` on
its own (not observed in this session's real sample, but structurally
possible -- e.g. a very long string literal or type signature) is split
into fixed-size character windows rather than ever emitted as one oversized
chunk. No token-counting library was added to compute any of this
precisely -- Ollama's tokenizer isn't exposed locally without loading the
model, and a fixed-size window only needs to be reliably under the limit,
not exact.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import pathspec

from ..repomap.extraction import find_source_files

CHUNK_LINES = 12
CHUNK_MAX_CHARS = 500
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
    n = len(lines)
    start = 0
    while start < n:
        # +1 approximates the "\n" that will join this line to the rest of
        # the chunk once assembled below.
        if len(lines[start]) + 1 > CHUNK_MAX_CHARS:
            # A single line alone exceeds CHUNK_MAX_CHARS -- split it into
            # fixed-size character windows so no chunk is ever emitted over
            # budget, regardless of how the surrounding lines are shaped.
            # Checked upfront (not as a fallback after the loop below) so an
            # overlong first line can never slip through as a one-line
            # chunk that's still over budget.
            long_line = lines[start]
            for i in range(0, len(long_line), CHUNK_MAX_CHARS):
                piece = long_line[i : i + CHUNK_MAX_CHARS]
                if piece.strip():
                    chunks.append(Chunk(rel_fname=rel_fname, start_line=start, end_line=start + 1, text=piece))
            start += 1
            continue

        end = start
        char_count = 0
        while end < n and (end - start) < CHUNK_LINES:
            line_len = len(lines[end]) + 1
            if char_count + line_len > CHUNK_MAX_CHARS:
                break
            char_count += line_len
            end += 1

        chunk_text = "\n".join(lines[start:end])
        if chunk_text.strip():
            chunks.append(Chunk(rel_fname=rel_fname, start_line=start, end_line=end, text=chunk_text))
        start = end
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
