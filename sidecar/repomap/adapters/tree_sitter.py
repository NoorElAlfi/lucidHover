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

from .base import Alias, LanguageManifestEntry, Tag

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


# Session 105 (code-reviewer finding, post-initial-implementation): neither
# alias query pattern is naturally scoped to module level -- tree-sitter
# matches `const X = Object.assign(...)`/`Foo.Bar = existingFn` anywhere in
# the file, including inside a function body against a local variable or
# parameter (e.g. `function setup(self, clickHandler) { self.onClick =
# clickHandler; }` reproduced a real false alias, `onClick -> clickHandler`,
# in review). Since `#eq?`-style predicates aren't evaluated here either, and
# tree-sitter queries can't express "not nested inside a function" as a
# pattern shape at all, this is checked the same way every other
# predicate-shaped constraint in this project is: in Python, by walking the
# match's ancestor chain and rejecting it if any ancestor is a function-like
# scope. Both idioms are genuinely module-level (or, for a static-property
# assignment, at most attached to a top-level class/function declaration
# right after it) in every real compound-component export this session
# measured -- a function-body-local same-shaped assignment is a different,
# unrelated idiom (a plain local rebind/merge), not a compound-component
# export, and must never become an alias.
_FUNCTION_SCOPE_NODE_TYPES = frozenset(
    {
        "function_declaration",
        "function_expression",
        "arrow_function",
        "generator_function_declaration",
        "method_definition",
    }
)


def _is_inside_function_scope(node) -> bool:
    current = node.parent
    while current is not None:
        if current.type in _FUNCTION_SCOPE_NODE_TYPES:
            return True
        current = current.parent
    return False


class TreeSitterAdapter:
    def __init__(self, manifest: LanguageManifestEntry):
        self.manifest = manifest

        grammar_module = importlib.import_module(manifest.tree_sitter.grammar_package)
        grammar_fn = getattr(grammar_module, manifest.tree_sitter.grammar_function)
        self._language = Language(grammar_fn())

        query_path = _QUERIES_DIR / manifest.tag_query_file
        self._query = Query(self._language, query_path.read_text(encoding="utf-8"))

        if manifest.alias_query_file is None:
            self._alias_query = None
        else:
            alias_query_path = _QUERIES_DIR / manifest.alias_query_file
            self._alias_query = Query(self._language, alias_query_path.read_text(encoding="utf-8"))

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

    def extract_aliases(self, fname: str, rel_fname: str) -> list[Alias]:
        """
        Session 105: compound-component/static-property alias facts (see
        `js_ts_aliases.scm`'s header). Languages with no `alias_query_file`
        (today: Python) always return `[]` -- there is no query compiled to
        run.

        Uses its own `Parser`/`QueryCursor` pass rather than folding into
        `extract_tags`'s loop above: the two capture shapes here need *two*
        name nodes per match (the declared alias name and its target), which
        doesn't fit that loop's one-`name_node`-per-match dispatch, and
        keeping the two passes independent means neither risks the other's
        capture names colliding.
        """
        if self._alias_query is None:
            return []

        code = Path(fname).read_bytes()
        parser = Parser(self._language)
        tree = parser.parse(code)
        cursor = QueryCursor(self._alias_query)

        aliases: list[Alias] = []
        for _pattern_idx, captures in cursor.matches(tree.root_node):
            declared_nodes = captures.get("name.alias.declared")
            target_nodes = captures.get("name.alias.target")
            if not declared_nodes or not target_nodes:
                continue

            if _is_inside_function_scope(declared_nodes[0]):
                continue

            callee_object_nodes = captures.get("alias.calleeObject")
            callee_method_nodes = captures.get("alias.calleeMethod")
            if callee_object_nodes and callee_method_nodes:
                # The `const X = Object.assign(Base, {...})` pattern -- since
                # `#eq?` predicates aren't evaluated (see the query file's own
                # header), confirm the callee really is `Object.assign` here,
                # in Python, matching this project's established precedent
                # for every other predicate-shaped check.
                callee_object = callee_object_nodes[0].text.decode("utf-8")
                callee_method = callee_method_nodes[0].text.decode("utf-8")
                if callee_object != "Object" or callee_method != "assign":
                    continue

            aliases.append(
                Alias(
                    rel_fname=rel_fname,
                    name=declared_nodes[0].text.decode("utf-8"),
                    target_name=target_nodes[0].text.decode("utf-8"),
                )
            )
        return aliases
