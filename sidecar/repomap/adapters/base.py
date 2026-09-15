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
class Alias:
    """
    Session 105: a compound-component/static-property alias fact -- `name`
    (the declared name, e.g. `Menu` in `const Menu = Object.assign(MenuRoot,
    {...})`, or `Bar` in `Foo.Bar = existingFn`) should resolve, for call
    graph purposes, through whatever `target_name` already resolves to.

    Deliberately not a `Tag`: an alias has no source span of its own to
    explain (there's no function body behind a bare re-export), so it must
    never become its own graph node -- see graph.py's `_resolve_callees`,
    the only place this is consumed. It only ever widens which *names* a
    reference can resolve through; the resolved node is always the
    already-existing def the alias points at.
    """

    rel_fname: str
    name: str
    target_name: str


@dataclass(frozen=True)
class TreeSitterSpec:
    grammar_package: str
    grammar_function: str


@dataclass(frozen=True)
class Exclusions:
    dirs: frozenset[str] = field(default_factory=frozenset)
    def_names: frozenset[str] = field(default_factory=frozenset)
    ref_names: frozenset[str] = field(default_factory=frozenset)
    # Session 78: capture categories (e.g. "reference.jsx") whose captured
    # name needs a structural case check rather than a literal name-list
    # exclusion -- see tree_sitter.py's extract_tags for what the check does.
    # Declared per-language here (both languages that register JSX patterns
    # list "reference.jsx") rather than hardcoded in the adapter, matching
    # def_names/ref_names' own manifest-driven-not-hardcoded precedent.
    case_sensitive_ref_kinds: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class LanguageManifestEntry:
    language_id: str  # the languages.json key, e.g. "javascript"
    display_name: str
    vscode_language_id: str
    extensions: tuple[str, ...]
    tree_sitter: TreeSitterSpec
    tag_query_file: str
    # Session 105: optional -- only javascript/typescript/typescriptreact set
    # this (all three share one file, `js_ts_aliases.scm`; see that file's
    # header for why one file suffices where the JSX split needed two).
    # `None` means "this language has no alias-detection patterns", not a
    # missing/misconfigured entry -- Python's tree-sitter grammar has no
    # `variable_declarator`/`assignment_expression` node shapes to reuse
    # anyway.
    alias_query_file: str | None
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
            alias_query_file=data.get("aliasQueryFile"),
            exclusions=Exclusions(
                dirs=frozenset(excl.get("dirs", [])),
                def_names=frozenset(excl.get("defNames", [])),
                ref_names=frozenset(excl.get("refNames", [])),
                case_sensitive_ref_kinds=frozenset(excl.get("caseSensitiveRefKinds", [])),
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
