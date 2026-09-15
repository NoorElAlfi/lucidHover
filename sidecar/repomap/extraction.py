"""
Tag extraction entry points. v0's tree-sitter parsing (adapted from
Aider-AI/aider's aider/repomap.py:get_tags_raw(), Apache-2.0:
https://github.com/Aider-AI/aider/blob/main/aider/repomap.py) was scoped to
JavaScript only.

Session 21 extracted that JS-specific grammar/query/exclusion logic behind a
Language Adapter interface (`adapters/tree_sitter.py`), driven by the
`languages.json` manifest at the repo root -- see
docs/language-surface-audit.md. This module is a thin wrapper over the
adapter registry: it contains no per-language parsing logic itself.

Session 21 left `extract_tags_for_repo`/`find_js_files` JS-named and JS-only
(reporting only the "javascript" bucket of `discover_files`), deliberately
deferring generalization until a second language actually existed (see that
session's artifact). Session 24 adds TypeScript, so that deferral is now
resolved: `find_source_files`/`extract_tags_for_repo` walk every registered
language's bucket and flatten them together, so one `root` can contain a mix
of any registered languages' files (e.g. a fixture repo with both `.ts` and
`.tsx` files, backed by two different manifest entries) and still produce one
combined tag set / call graph. Every current caller (`context.py`,
`graph.py`, `retrieval/chunking.py`) gets this for free through the same
function names/signatures except `find_js_files`, renamed to
`find_source_files` since it's no longer JS-specific.
"""

from __future__ import annotations

import os

from .adapters import Alias, Tag, get_registry

__all__ = [
    "Alias",
    "Tag",
    "EXCLUDED_DIRS",
    "extract_tags",
    "extract_tags_for_repo",
    "extract_aliases",
    "extract_aliases_for_repo",
    "find_source_files",
]

# Union of every registered language's excluded dirs, plus the universal
# ones -- for v0 (JavaScript only) this was identical to the pre-Session-21
# literal `{"node_modules", ".git", "out", "dist", "build"}`.
EXCLUDED_DIRS = set(get_registry().excluded_dirs)


def extract_tags(fname: str, rel_fname: str) -> list[Tag]:
    """Extract def/ref tags from one source file, via its registered language adapter."""
    adapter = get_registry().adapter_for_file(fname)
    if adapter is None:
        return []
    return adapter.extract_tags(fname, rel_fname)


def find_source_files(root: str) -> list[str]:
    """
    Recursively find every file under root whose extension matches a
    registered language (any manifest entry, not just one), skipping
    excluded dirs. A file whose extension matches no registered language is
    skipped, not errored -- same "unsupported language is expected, not a
    failure" behavior as `LanguageRegistry.discover_files` itself.
    """
    by_language = get_registry().discover_files(root)
    return [fname for files in by_language.values() for fname in files]


def extract_tags_for_repo(root: str) -> dict[str, list[Tag]]:
    """Extract tags for every registered-language file under root, keyed by relative path."""
    tags_by_file: dict[str, list[Tag]] = {}
    for fname in find_source_files(root):
        rel_fname = os.path.relpath(fname, root).replace(os.sep, "/")
        tags_by_file[rel_fname] = extract_tags(fname, rel_fname)
    return tags_by_file


def extract_aliases(fname: str, rel_fname: str) -> list[Alias]:
    """
    Session 105: extract one file's compound-component/static-property alias
    facts, via its registered language adapter. `[]` for a language with no
    `alias_query_file` (see `adapters/base.py`'s `LanguageManifestEntry`) or
    a file whose adapter can't be resolved at all.
    """
    adapter = get_registry().adapter_for_file(fname)
    if adapter is None:
        return []
    return adapter.extract_aliases(fname, rel_fname)


def extract_aliases_for_repo(root: str) -> dict[str, list[Alias]]:
    """Extract aliases for every registered-language file under root, keyed by relative path.
    A file with no aliases is omitted, not given an empty list -- mirrors
    `defs_by_name`/`refs_by_name`'s own "absent means none" convention rather
    than `tags_by_file`'s "always present, maybe empty" one, since aliases
    are the rare case."""
    aliases_by_file: dict[str, list[Alias]] = {}
    for fname in find_source_files(root):
        rel_fname = os.path.relpath(fname, root).replace(os.sep, "/")
        found = extract_aliases(fname, rel_fname)
        if found:
            aliases_by_file[rel_fname] = found
    return aliases_by_file
