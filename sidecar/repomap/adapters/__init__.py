"""
Language Adapter interface + registry (Session 21). See
docs/language-surface-audit.md for the design rationale and `languages.json`
at the repo root for the manifest itself.
"""

from __future__ import annotations

from .base import LanguageAdapter, LanguageManifestEntry, Tag
from .registry import LanguageRegistry, get_registry
from .tree_sitter import TreeSitterAdapter

__all__ = [
    "LanguageAdapter",
    "LanguageManifestEntry",
    "LanguageRegistry",
    "Tag",
    "TreeSitterAdapter",
    "get_registry",
]
