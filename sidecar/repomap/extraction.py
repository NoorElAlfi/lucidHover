"""
Tag extraction via tree-sitter, adapted from Aider-AI/aider's
aider/repomap.py:get_tags_raw() (Apache-2.0):
https://github.com/Aider-AI/aider/blob/main/aider/repomap.py

v0 is scoped to JavaScript only (per spec: "pick 1 language for v0, based on
tree-sitter resolution quality without needing LSP wrapping"); the fixture
repo and existing hover-provider tests already assume JS. Aider's def/ref
distinction ("name.definition.*" vs "name.reference.*" capture-tag prefixes)
and per-language .scm query file convention are kept as-is. Not ported:
Aider's diskcache mtime-based tag cache (this module is invoked per full
index in v0, not per-hover, so caching wasn't needed yet) and its Pygments
fallback for def-only grammars (irrelevant -- our one JS query already emits
both defs and refs).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from tree_sitter import Language, Parser, Query, QueryCursor
import tree_sitter_javascript as tsjs

_JS_LANGUAGE = Language(tsjs.language())
_QUERY_PATH = Path(__file__).parent / "queries" / "javascript_tags.scm"
_QUERY_TEXT = _QUERY_PATH.read_text(encoding="utf-8")
_QUERY = Query(_JS_LANGUAGE, _QUERY_TEXT)

# Names the .scm's predicates would have excluded, filtered explicitly here
# instead -- see javascript_tags.scm's NOTE for why.
_EXCLUDED_DEF_NAMES = {"constructor"}
_EXCLUDED_REF_NAMES = {"require"}

EXCLUDED_DIRS = {"node_modules", ".git", "out", "dist", "build"}


@dataclass(frozen=True)
class Tag:
    rel_fname: str
    fname: str
    name: str
    kind: str  # "def" | "ref"
    start_line: int  # 0-indexed
    end_line: int
    start_byte: int
    end_byte: int


def extract_tags(fname: str, rel_fname: str) -> list[Tag]:
    """Extract def/ref tags from one JS source file."""
    code = Path(fname).read_bytes()
    parser = Parser(_JS_LANGUAGE)
    tree = parser.parse(code)
    cursor = QueryCursor(_QUERY)

    tags: list[Tag] = []
    for _pattern_idx, captures in cursor.matches(tree.root_node):
        span_node = None
        name_node = None
        kind = None
        for cap_name, nodes in captures.items():
            if not nodes:
                continue
            node = nodes[0]
            if cap_name.startswith("name."):
                name_node = node
            elif cap_name.startswith("definition."):
                span_node = node
                kind = "def"
            elif cap_name.startswith("reference."):
                span_node = node
                kind = "ref"

        if span_node is None or name_node is None or kind is None:
            continue

        name = name_node.text.decode("utf-8")
        if kind == "def" and name in _EXCLUDED_DEF_NAMES:
            continue
        if kind == "ref" and name in _EXCLUDED_REF_NAMES:
            continue

        tags.append(
            Tag(
                rel_fname=rel_fname,
                fname=fname,
                name=name,
                kind=kind,
                start_line=span_node.start_point[0],
                end_line=span_node.end_point[0],
                start_byte=span_node.start_byte,
                end_byte=span_node.end_byte,
            )
        )
    return tags


_JS_EXTENSIONS = (".js", ".jsx")


def find_js_files(root: str) -> list[str]:
    """
    Recursively find JS/JSX files under root, skipping excluded dirs.

    `.jsx` is included alongside `.js` -- not a second language: tree-sitter's
    JS grammar (`tree_sitter_javascript`) parses JSX natively (confirmed
    directly against a real React component before adding this), so the same
    grammar/query already used for `.js` handles it with no changes. `.tsx`/
    `.ts` are NOT included -- those need TypeScript's grammar and would
    misparse under the JS one; that's a real second-language addition,
    deliberately deferred to post-MVP (spec: "pick 1 language for v0 ...
    expand post-MVP"). See session-08 artifact.
    """
    results = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS]
        for name in filenames:
            if name.endswith(_JS_EXTENSIONS):
                results.append(os.path.join(dirpath, name))
    return results


def extract_tags_for_repo(root: str) -> dict[str, list[Tag]]:
    """Extract tags for every JS file under root, keyed by relative path."""
    tags_by_file: dict[str, list[Tag]] = {}
    for fname in find_js_files(root):
        rel_fname = os.path.relpath(fname, root).replace(os.sep, "/")
        tags_by_file[rel_fname] = extract_tags(fname, rel_fname)
    return tags_by_file
