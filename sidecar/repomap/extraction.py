"""
Tag extraction entry points. v0's tree-sitter parsing (adapted from
Aider-AI/aider's aider/repomap.py:get_tags_raw(), Apache-2.0:
https://github.com/Aider-AI/aider/blob/main/aider/repomap.py) was scoped to
JavaScript only.

Session 21 extracted that JS-specific grammar/query/exclusion logic behind a
Language Adapter interface (`adapters/tree_sitter.py`), driven by the
`languages.json` manifest at the repo root -- see
docs/language-surface-audit.md. This module is now a thin, JS-named wrapper
over the adapter registry: `extract_tags`, `extract_tags_for_repo`,
`find_js_files`, and `EXCLUDED_DIRS` keep their existing names, signatures,
and behavior for every current caller (`context.py`, `graph.py`,
`retrieval/chunking.py`, tests) -- they no longer contain any JS-specific
parsing logic themselves, but still only report JS results. Generalizing
these entry points to be language-agnostic (rather than JS-named) is
deliberately out of scope for Session 21 -- see that session's artifact.
"""

from __future__ import annotations

import os

from .adapters import Tag, get_registry

__all__ = ["Tag", "EXCLUDED_DIRS", "extract_tags", "extract_tags_for_repo", "find_js_files"]

# Union of every registered language's excluded dirs, plus the universal
# ones -- for v0 (JavaScript only) this is identical to the pre-Session-21
# literal `{"node_modules", ".git", "out", "dist", "build"}`.
EXCLUDED_DIRS = set(get_registry().excluded_dirs)


def extract_tags(fname: str, rel_fname: str) -> list[Tag]:
    """Extract def/ref tags from one source file, via its registered language adapter."""
    adapter = get_registry().adapter_for_file(fname)
    if adapter is None:
        return []
    return adapter.extract_tags(fname, rel_fname)


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

    Session 21: extensions and excluded dirs now come from `languages.json`'s
    "javascript" entry via the adapter registry, not a hardcoded tuple.
    """
    return get_registry().discover_files(root).get("javascript", [])


def extract_tags_for_repo(root: str) -> dict[str, list[Tag]]:
    """Extract tags for every JS file under root, keyed by relative path."""
    tags_by_file: dict[str, list[Tag]] = {}
    for fname in find_js_files(root):
        rel_fname = os.path.relpath(fname, root).replace(os.sep, "/")
        tags_by_file[rel_fname] = extract_tags(fname, rel_fname)
    return tags_by_file
