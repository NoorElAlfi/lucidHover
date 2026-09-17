"""
Loads `languages.json` and answers "which adapter handles this file" by
extension (Session 21). Files whose extension has no registered adapter are
skipped, not errored -- a workspace containing languages LucidHover doesn't
support yet is expected, not a failure.
"""

from __future__ import annotations

import fnmatch
import json
import os
from pathlib import Path

from .base import LanguageManifestEntry
from .tree_sitter import TreeSitterAdapter

# adapters/ -> repomap/ -> sidecar/ -> repo root
_MANIFEST_PATH = Path(__file__).resolve().parents[3] / "languages.json"

# Excluded regardless of language -- every language's working tree has one.
_UNIVERSAL_EXCLUDED_DIRS = frozenset({".git"})

# Session 83 flagged `Exclusions.dirs` as exact-name-only, unable to express
# a variable-suffix convention like Python's `*.egg-info` (e.g.
# `mypackage.egg-info`). A dir entry containing any of these characters is
# matched via `fnmatch` instead of `==`; entries without them (the common
# case -- "node_modules", ".venv", etc.) stay a plain set-membership check.
_GLOB_CHARS = frozenset("*?[")


class LanguageRegistry:
    def __init__(self, manifest_path: Path = _MANIFEST_PATH):
        with open(manifest_path, "r", encoding="utf-8") as f:
            raw = json.load(f)

        self._adapters: dict[str, TreeSitterAdapter] = {}
        self._ext_to_language: dict[str, str] = {}
        for language_id, data in raw.items():
            entry = LanguageManifestEntry.from_json(language_id, data)
            adapter = TreeSitterAdapter(entry)
            self._adapters[language_id] = adapter
            for ext in entry.extensions:
                self._ext_to_language[ext] = language_id

        self.excluded_dirs: frozenset[str] = _UNIVERSAL_EXCLUDED_DIRS.union(
            *(a.manifest.exclusions.dirs for a in self._adapters.values())
        )
        self._excluded_dir_literals: frozenset[str] = frozenset(
            d for d in self.excluded_dirs if not any(c in d for c in _GLOB_CHARS)
        )
        self._excluded_dir_patterns: tuple[str, ...] = tuple(
            d for d in self.excluded_dirs if any(c in d for c in _GLOB_CHARS)
        )

    def adapter_for_language(self, language_id: str) -> TreeSitterAdapter:
        return self._adapters[language_id]

    def language_for_file(self, fname: str) -> str | None:
        _, ext = os.path.splitext(fname)
        return self._ext_to_language.get(ext)

    def adapter_for_file(self, fname: str) -> TreeSitterAdapter | None:
        language_id = self.language_for_file(fname)
        if language_id is None:
            return None
        return self._adapters[language_id]

    def is_dir_excluded(self, name: str) -> bool:
        """Public (Session: codebase digest export) -- `sidecar/digest/ingestion.py` walks
        every non-excluded file, not just registered-language source files, and needs the
        exact same exact-name/glob-pattern exclusion decision `discover_files` below already
        makes, rather than a second, potentially-drifting copy of the fnmatch logic."""
        if name in self._excluded_dir_literals:
            return True
        return any(fnmatch.fnmatch(name, pattern) for pattern in self._excluded_dir_patterns)

    def discover_files(self, root: str) -> dict[str, list[str]]:
        """
        Walk `root`, dispatching each file to its adapter's language by
        extension. Skips (does not error on) files whose extension matches
        no registered adapter.
        """
        results: dict[str, list[str]] = {language_id: [] for language_id in self._adapters}
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not self.is_dir_excluded(d)]
            for name in filenames:
                language_id = self.language_for_file(name)
                if language_id is not None:
                    results[language_id].append(os.path.join(dirpath, name))
        return results


_registry: LanguageRegistry | None = None


def get_registry() -> LanguageRegistry:
    """Process-wide singleton, built from `languages.json` on first use."""
    global _registry
    if _registry is None:
        _registry = LanguageRegistry()
    return _registry
