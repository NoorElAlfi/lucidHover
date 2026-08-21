"""
Generic tree-sitter-backed LanguageAdapter, manifest-driven (Session 21).

The capture-dispatch loop in `extract_tags` below is adapted from
Aider-AI/aider's aider/repomap.py:get_tags_raw() (Apache-2.0):
https://github.com/Aider-AI/aider/blob/main/aider/repomap.py -- moved here
from `extraction.py` (which carried this attribution and the loop itself
before Session 21), since the loop was never JS-specific -- only the grammar
import, query-file path, and exclusion sets were hardcoded to JavaScript.
Those now come entirely from a language's `languages.json` entry (grammar
package/function, tag query file, excluded def/ref names), so JavaScript is
registered as an instance of this class (see `registry.py`), not a
JavaScript-specific subclass. A second tree-sitter-based language is a
manifest entry + `.scm` query file, not a new Python class.
"""

from __future__ import annotations

import importlib
from pathlib import Path

from tree_sitter import Language, Parser, Query, QueryCursor

from .base import LanguageManifestEntry, Tag

_QUERIES_DIR = Path(__file__).resolve().parent.parent / "queries"


class TreeSitterAdapter:
    def __init__(self, manifest: LanguageManifestEntry):
        self.manifest = manifest

        grammar_module = importlib.import_module(manifest.tree_sitter.grammar_package)
        grammar_fn = getattr(grammar_module, manifest.tree_sitter.grammar_function)
        self._language = Language(grammar_fn())

        query_path = _QUERIES_DIR / manifest.tag_query_file
        self._query = Query(self._language, query_path.read_text(encoding="utf-8"))

    def extract_tags(self, fname: str, rel_fname: str) -> list[Tag]:
        """Extract def/ref tags from one source file via this adapter's grammar/query."""
        code = Path(fname).read_bytes()
        parser = Parser(self._language)
        tree = parser.parse(code)
        cursor = QueryCursor(self._query)

        tags: list[Tag] = []
        for _pattern_idx, captures in cursor.matches(tree.root_node):
            span_node = None
            name_node = None
            kind = None
            capture_kind = None
            for cap_name, nodes in captures.items():
                if not nodes:
                    continue
                node = nodes[0]
                if cap_name.startswith("name."):
                    name_node = node
                elif cap_name.startswith("definition."):
                    span_node = node
                    kind = "def"
                    capture_kind = self.manifest.capture_kind_map.get(cap_name)
                elif cap_name.startswith("reference."):
                    span_node = node
                    kind = "ref"
                    capture_kind = self.manifest.capture_kind_map.get(cap_name)

            if span_node is None or name_node is None or kind is None:
                continue

            name = name_node.text.decode("utf-8")
            if kind == "def" and name in self.manifest.exclusions.def_names:
                continue
            if kind == "ref" and name in self.manifest.exclusions.ref_names:
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
                    capture_kind=capture_kind,
                )
            )
        return tags
