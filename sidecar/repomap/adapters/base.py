"""
Language Adapter interface and manifest types (Session 21). See
docs/language-surface-audit.md for the design rationale -- this module's
`LanguageManifestEntry` mirrors that document's Section 2 `languages.json`
schema field-for-field, and `Tag.capture_kind` is Section 3's [Decided - Q1]
accommodation for future variable-level capture.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


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
    # [Decided - Q1] the capture name's suffix (e.g. "function", "method",
    # "call"), from the manifest's captureKindMap -- not read by any
    # consumer yet (graph.py/context.py still only use `kind`). Kept
    # additive so a future variable-capture feature has a seam without a
    # `Tag` redesign.
    capture_kind: str | None = None


@dataclass(frozen=True)
class TreeSitterSpec:
    grammar_package: str
    grammar_function: str


@dataclass(frozen=True)
class Exclusions:
    dirs: frozenset[str] = field(default_factory=frozenset)
    def_names: frozenset[str] = field(default_factory=frozenset)
    ref_names: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class LanguageManifestEntry:
    language_id: str  # the languages.json key, e.g. "javascript"
    display_name: str
    vscode_language_id: str
    extensions: tuple[str, ...]
    tree_sitter: TreeSitterSpec
    tag_query_file: str
    exclusions: Exclusions
    resolution_strategy: str  # "tree-sitter-only" | "lsp-wrapped"
    capture_kind_map: dict[str, str]

    @classmethod
    def from_json(cls, language_id: str, data: dict) -> "LanguageManifestEntry":
        ts = data["treeSitter"]
        excl = data.get("exclusions", {})
        return cls(
            language_id=language_id,
            display_name=data["displayName"],
            vscode_language_id=data["vscodeLanguageId"],
            extensions=tuple(data["extensions"]),
            tree_sitter=TreeSitterSpec(
                grammar_package=ts["grammarPackage"],
                grammar_function=ts["grammarFunction"],
            ),
            tag_query_file=data["tagQueryFile"],
            exclusions=Exclusions(
                dirs=frozenset(excl.get("dirs", [])),
                def_names=frozenset(excl.get("defNames", [])),
                ref_names=frozenset(excl.get("refNames", [])),
            ),
            resolution_strategy=data["resolutionStrategy"],
            capture_kind_map=dict(data.get("captureKindMap", {})),
        )


class LanguageAdapter(Protocol):
    """
    What a sidecar language adapter must provide. `extract_tags` is the only
    behavior a consumer (the registry) needs -- how a language turns source
    text into `Tag`s is entirely up to the adapter (today, every registered
    language happens to be tree-sitter-based; see `tree_sitter.py`).
    """

    manifest: LanguageManifestEntry

    def extract_tags(self, fname: str, rel_fname: str) -> list[Tag]: ...
