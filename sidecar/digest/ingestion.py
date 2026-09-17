"""
Codebase digest export (chat-discussed follow-up, not a Build Order step):
walks the workspace and builds a gitingest-style single-document digest --
one-line summary + ASCII directory tree + gitignore/size-budget-filtered
file contents -- for the user to copy and paste into any LLM themselves.
Core Rule 1: this never sends the digest anywhere itself, it only renders
text the extension host opens as a document (see
`src/extension/digest/generateDigestCommand.ts`). Not part of the
explanation cache (Core Rule 5/9 don't apply here) -- this is a
point-in-time export, not a cached, invalidatable artifact.

Reuses `repomap.adapters.get_registry()`'s exact-name/glob-pattern dir
exclusion (`is_dir_excluded`, made public for this) and `retrieval.chunking`'s
root-`.gitignore`-loading pattern (`pathspec`, Continue.dev's convention per
the spec's "OSS to Borrow" table) rather than a second gitignore parser --
root-level only, matching that existing scope decision, not a new gap (see
that module's own docstring). New work this module needed that neither of
those already had: walking *every* non-excluded file, not just
registered-language source files (`find_source_files` is scoped to
languages.json's adapters; a gitingest-style digest is meant to include
config/docs/etc. too), and the binary/size/total-budget filtering below.

Binary detection is a small ported heuristic (not a new dependency): read
the first `_BINARY_SNIFF_BYTES`, treat a NUL byte or an outright UTF-8
decode failure as binary. Not exact (a UTF-16 file with no NUL in its first
KB would slip through), but reliable enough for "should an LLM prompt
include this raw," which is all this needs.

Budget constants (chosen via this session's own `AskUserQuestion`, "Fixed,
generous LLM-context defaults") are sized for pasting into an LLM's own
context window, not gitingest's own defaults (10MB per file / 500MB total),
which assume its own web UI, not an LLM prompt:
  - `MAX_FILE_SIZE_BYTES`: a file over this is listed in the tree and in the
    "Skipped files" note, but never read.
  - `MAX_TOTAL_OUTPUT_BYTES`: once already-read file content would push the
    running total over this, every remaining file is skipped too (still
    listed in the tree, so nothing is silently missing from the structure,
    only from its content) -- `DigestResult.truncated` flags this.
  - `MAX_FILES`: a hard cap on the walk itself, independent of size, so a
    repo with an enormous number of tiny files can't make the walk unbounded
    either. Also sets `truncated`.

Explicitly out of scope (this session's own brief): nested per-directory
`.gitignore` files (root-level only, matching `chunking.py`'s existing
scope) and sending the digest to an LLM directly (Core Rule 1 -- it's for
the user to paste themselves).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

import pathspec

from ..repomap.adapters import get_registry

GITIGNORE_FILENAME = ".gitignore"

MAX_FILE_SIZE_BYTES = 100_000  # ~100KB per file
MAX_TOTAL_OUTPUT_BYTES = 2_000_000  # ~2MB of file content, total
MAX_FILES = 5_000  # hard cap on files walked, independent of size

_BINARY_SNIFF_BYTES = 1024
_SEPARATOR = "=" * 48


@dataclass(frozen=True)
class DigestFile:
    rel_path: str
    size_bytes: int
    skipped: bool
    skip_reason: str | None  # None | "binary" | "too-large" | "budget-exceeded" | "unreadable"
    content: str | None


@dataclass(frozen=True)
class DigestResult:
    root_name: str
    tree_lines: list[str]
    files: list[DigestFile] = field(default_factory=list)
    total_files: int = 0
    included_files: int = 0
    truncated: bool = False


def _load_gitignore_spec(root: str) -> pathspec.PathSpec | None:
    # Same root-.gitignore-only pattern as retrieval/chunking.py's own
    # `_load_gitignore_spec` -- duplicated rather than imported since it's a
    # few lines and importing a leading-underscore name across a module
    # boundary would be a worse coupling than the small duplication (same
    # precedent as blastRadiusCommand.ts's `closestResolved`, TS-side).
    gitignore_path = os.path.join(root, GITIGNORE_FILENAME)
    if not os.path.isfile(gitignore_path):
        return None
    with open(gitignore_path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()
    return pathspec.PathSpec.from_lines("gitwildmatch", lines)


def _is_probably_binary(fname: str) -> bool:
    try:
        with open(fname, "rb") as f:
            chunk = f.read(_BINARY_SNIFF_BYTES)
    except OSError:
        return True
    if b"\x00" in chunk:
        return True
    try:
        chunk.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


def _walk_included_files(root: str) -> tuple[list[str], bool]:
    """Every non-excluded-dir, non-gitignored file under root, as sorted
    root-relative forward-slash paths. Returns (rel_paths, hit_max_files) --
    the walk stops the moment MAX_FILES is reached, same "stop rather than
    silently return an unbounded list" behavior MAX_TOTAL_OUTPUT_BYTES gets
    later in `generate_digest`."""
    registry = get_registry()
    spec = _load_gitignore_spec(root)
    rel_paths: list[str] = []
    hit_cap = False
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not registry.is_dir_excluded(d))
        for name in sorted(filenames):
            fname = os.path.join(dirpath, name)
            rel = os.path.relpath(fname, root).replace(os.sep, "/")
            if spec is not None and spec.match_file(rel):
                continue
            rel_paths.append(rel)
            if len(rel_paths) >= MAX_FILES:
                hit_cap = True
                return rel_paths, hit_cap
    return rel_paths, hit_cap


def _build_tree(root_name: str, rel_paths: list[str]) -> list[str]:
    """ASCII directory tree, built from the already gitignore/exclusion-
    filtered `rel_paths` list -- so the tree and the content section below
    always agree on what's included, there's no separate second walk that
    could drift from it."""
    tree: dict[str, dict] = {}
    for rel in rel_paths:
        parts = rel.split("/")
        node = tree
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node.setdefault(parts[-1], None)  # None marks a file (leaf), dict marks a dir

    lines = [f"{root_name}/"]

    def _render(node: dict, prefix: str) -> None:
        entries = sorted(node.items(), key=lambda kv: kv[0].lower())
        for i, (name, child) in enumerate(entries):
            is_last = i == len(entries) - 1
            connector = "└── " if is_last else "├── "
            is_dir = isinstance(child, dict)
            lines.append(f"{prefix}{connector}{name}{'/' if is_dir else ''}")
            if is_dir:
                lines_prefix = "    " if is_last else "│   "
                _render(child, prefix + lines_prefix)

    _render(tree, "")
    return lines


def generate_digest(root: str) -> DigestResult:
    root_name = os.path.basename(os.path.normpath(root)) or root
    rel_paths, hit_max_files = _walk_included_files(root)
    tree_lines = _build_tree(root_name, rel_paths)

    files: list[DigestFile] = []
    running_total = 0
    budget_exhausted = False
    for rel in rel_paths:
        fname = os.path.join(root, rel)
        try:
            size = os.path.getsize(fname)
        except OSError:
            files.append(DigestFile(rel, 0, True, "unreadable", None))
            continue

        if budget_exhausted:
            files.append(DigestFile(rel, size, True, "budget-exceeded", None))
            continue
        if size > MAX_FILE_SIZE_BYTES:
            files.append(DigestFile(rel, size, True, "too-large", None))
            continue
        if _is_probably_binary(fname):
            files.append(DigestFile(rel, size, True, "binary", None))
            continue

        try:
            with open(fname, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except OSError:
            files.append(DigestFile(rel, size, True, "unreadable", None))
            continue

        running_total += len(content)
        if running_total > MAX_TOTAL_OUTPUT_BYTES:
            budget_exhausted = True
            files.append(DigestFile(rel, size, True, "budget-exceeded", None))
            continue

        files.append(DigestFile(rel, size, False, None, content))

    included_files = sum(1 for f in files if not f.skipped)
    return DigestResult(
        root_name=root_name,
        tree_lines=tree_lines,
        files=files,
        total_files=len(rel_paths),
        included_files=included_files,
        truncated=hit_max_files or budget_exhausted,
    )


def render_digest(result: DigestResult) -> str:
    """Assembles the final digest text: a one-line summary, the ASCII tree, a
    "Skipped files" note (only for files whose content was omitted -- kept
    as one short list rather than a full separator block per file, so a
    repo with many skipped files doesn't drown the real content in noise),
    then a `File: <path>` + content block per included file."""
    skipped = [f for f in result.files if f.skipped]
    included = [f for f in result.files if not f.skipped]

    lines: list[str] = [f"Codebase digest: {result.root_name}", ""]
    summary = f"{result.included_files} of {result.total_files} file(s) included"
    if skipped:
        summary += f", {len(skipped)} skipped"
    lines.append(summary + ".")
    if result.truncated:
        lines.append(
            "NOTE: this digest was truncated by a size/count budget -- see the skipped-file "
            "notes below. Narrow the workspace or increase scope some other way if you need "
            "the omitted content."
        )
    lines.append("")
    lines.append("Directory structure:")
    lines.extend(result.tree_lines)
    lines.append("")

    if skipped:
        lines.append("Skipped files:")
        for f in skipped:
            lines.append(f"  - {f.rel_path} ({f.skip_reason}, {f.size_bytes} bytes)")
        lines.append("")

    for f in included:
        lines.append(_SEPARATOR)
        lines.append(f"File: {f.rel_path}")
        lines.append(_SEPARATOR)
        lines.append(f.content or "")
        lines.append("")

    return "\n".join(lines)
