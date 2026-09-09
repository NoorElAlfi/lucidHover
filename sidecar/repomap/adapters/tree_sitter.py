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


def _case_filtered_name_node(name_node):
    """
    Session 78: the structural half of the JSX-reference case filter (see
    `Exclusions.case_sensitive_ref_kinds`). Neither query file's
    `#not-eq?`/`#not-match?` predicates are evaluated by this project's
    tree-sitter binding (see the query files' own header comments), so a JSX
    tag's captured `name` node -- always `identifier` or `member_expression`,
    per both grammars' `jsx_opening_element`/`jsx_self_closing_element`
    fields, confirmed empirically before writing this -- is filtered here
    instead:

    - A plain `identifier` (`<div>`, `<Button>`) follows JSX/React's own
      rule for telling a host element from a component reference: lowercase
      first letter means "host element" (a plain string tag, never a real
      value reference) and is dropped entirely, emitting no Tag at all --
      not merely excluded from matching, since there is nothing here that
      could ever resolve to a definition. Capitalized first letter is kept
      as-is.
    - A `member_expression` (`<Menu.Item>`, `<Foo.Bar.Baz>`) is a JSX tag
      name that can *only* be a value reference (host elements are lowercase
      identifiers only, never dotted paths), so it is always kept regardless
      of casing on any segment -- and resolved down to its root `object`
      identifier (`Menu`, `Foo`), not the rightmost `property_identifier`,
      unlike the existing `obj.method()` call-reference pattern. That
      pattern targets the method itself (usually genuinely defined
      somewhere under that exact name); a JSX member expression targets the
      imported component symbol (`Menu`), which is what could plausibly gain
      a matching definition -- e.g. once the separate, still-open
      compound-component-definition gap (`Object.assign(Root, {Item})` /
      `Foo.Bar = existingFn` never becoming a graph node, session 77) is
      closed. Resolving to the leaf property name instead would almost
      never match anything (no function is likely to be bare-named "Item").

    Returns the node whose `.text` should be used as the tag's name, or
    `None` if this capture should be dropped (produce no Tag at all).
    """
    if name_node.type == "member_expression":
        base = name_node
        while base.type == "member_expression":
            obj = base.child_by_field_name("object")
            if obj is None:
                break
            base = obj
        return base
    text = name_node.text.decode("utf-8")
    if not text[:1].isupper():
        return None
    return name_node


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
            capture_category = None  # e.g. "reference.jsx", the def./ref. capture name itself
            for cap_name, nodes in captures.items():
                if not nodes:
                    continue
                node = nodes[0]
                if cap_name.startswith("name."):
                    name_node = node
                elif cap_name.startswith("definition."):
                    span_node = node
                    kind = "def"
                    capture_category = cap_name
                    capture_kind = self.manifest.capture_kind_map.get(cap_name)
                elif cap_name.startswith("reference."):
                    span_node = node
                    kind = "ref"
                    capture_category = cap_name
                    capture_kind = self.manifest.capture_kind_map.get(cap_name)

            if span_node is None or name_node is None or kind is None:
                continue

            if capture_category in self.manifest.exclusions.case_sensitive_ref_kinds:
                name_node = _case_filtered_name_node(name_node)
                if name_node is None:
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
