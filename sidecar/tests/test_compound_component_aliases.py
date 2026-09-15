"""
Session 105: closes session 77's confirmed, carried-forward "compound-
component exports vanish entirely" finding -- `const Menu =
Object.assign(MenuRoot, {Item: MenuItem})` and `Foo.Bar = existingFn` (a
static-property assignment to an *already-declared* function reference, as
opposed to defining a new one inline) both declare a name with no graph node
of its own before this session, so any reference to that name (JSX or a
plain call) resolved to nothing.

These are synthetic, isolated-snippet tests against each language's real
registered adapter and `graph.py`'s resolution helpers directly -- mirroring
test_jsx_reference_capture.py's own shape -- plus real-fixture regression
coverage in test_repomap_typescript.py's Session 105 section (dashboard.tsx).
"""

from __future__ import annotations

from sidecar.repomap.adapters.registry import get_registry
from sidecar.repomap.graph import _resolve_callees, build_alias_targets, build_call_graph


def _aliases(adapter, tmp_path, filename: str, source: str):
    fname = tmp_path / filename
    fname.write_text(source, encoding="utf-8")
    return adapter.extract_aliases(str(fname), filename)


def _tags(adapter, tmp_path, filename: str, source: str):
    fname = tmp_path / filename
    fname.write_text(source, encoding="utf-8")
    return adapter.extract_tags(str(fname), filename)


def test_static_property_assignment_inside_function_body_is_not_aliased(tmp_path):
    """Reproduces a real false positive found in code review: a plain
    property assignment from a local variable/parameter, inside a function
    body, has the exact same AST shape as the module-level static-property-
    assignment idiom this session targets -- but it's a routine local rebind,
    not a compound-component export, and must not become an alias."""
    adapter = get_registry().adapter_for_language("javascript")
    aliases = _aliases(
        adapter,
        tmp_path,
        "a.js",
        "function clickHandler() {}\n"
        "function setup(self, clickHandler) {\n"
        "  self.onClick = clickHandler;\n"
        "}\n",
    )
    assert aliases == []


def test_object_assign_inside_function_body_is_not_aliased(tmp_path):
    """Same false-positive class as above, for the `Object.assign` idiom --
    a local variable holding a merge result inside a function body is a
    routine idiom, not a compound-component export."""
    adapter = get_registry().adapter_for_language("javascript")
    aliases = _aliases(
        adapter,
        tmp_path,
        "a.js",
        "function Base() {}\n"
        "function factory() {\n"
        "  const local = Object.assign(Base, {});\n"
        "  return local;\n"
        "}\n",
    )
    assert aliases == []


def test_exported_top_level_object_assign_is_still_aliased(tmp_path):
    """The function-scope rejection above must not also reject a genuinely
    module-level declaration wrapped in `export` -- `export_statement` is not
    itself a function-like scope."""
    adapter = get_registry().adapter_for_language("javascript")
    aliases = _aliases(
        adapter,
        tmp_path,
        "a.js",
        "function MenuRoot() {}\nexport const Menu = Object.assign(MenuRoot, {});\n",
    )
    assert len(aliases) == 1
    assert aliases[0].name == "Menu"
    assert aliases[0].target_name == "MenuRoot"


def test_top_level_static_property_assignment_after_a_function_is_still_aliased(tmp_path):
    """The rejection targets nesting *inside* a function body -- a
    static-property assignment written at module level, right after the
    function declaration it's attached to (not inside it), must still be
    captured."""
    adapter = get_registry().adapter_for_language("javascript")
    aliases = _aliases(
        adapter,
        tmp_path,
        "a.js",
        "function TooltipArrow() {}\nfunction Tooltip() {}\nTooltip.Arrow = TooltipArrow;\n",
    )
    assert len(aliases) == 1
    assert aliases[0].name == "Arrow"
    assert aliases[0].target_name == "TooltipArrow"


def test_object_assign_produces_alias(tmp_path):
    adapter = get_registry().adapter_for_language("javascript")
    aliases = _aliases(
        adapter,
        tmp_path,
        "a.js",
        "function MenuRoot() {}\nfunction MenuItem() {}\n"
        "const Menu = Object.assign(MenuRoot, { Item: MenuItem });\n",
    )
    assert len(aliases) == 1
    assert aliases[0].name == "Menu"
    assert aliases[0].target_name == "MenuRoot"


def test_static_property_assignment_to_identifier_produces_alias(tmp_path):
    adapter = get_registry().adapter_for_language("javascript")
    aliases = _aliases(
        adapter,
        tmp_path,
        "a.js",
        "function TooltipArrow() {}\nfunction Tooltip() {}\nTooltip.Arrow = TooltipArrow;\n",
    )
    assert len(aliases) == 1
    assert aliases[0].name == "Arrow"
    assert aliases[0].target_name == "TooltipArrow"


def test_object_assign_second_argument_pairs_are_not_separately_aliased(tmp_path):
    """Deliberate scope cut (see js_ts_aliases.scm's header): only the
    declared name and the first Object.assign argument become an alias --
    the object literal's own keys (`Item`) do not."""
    adapter = get_registry().adapter_for_language("javascript")
    aliases = _aliases(
        adapter,
        tmp_path,
        "a.js",
        "function MenuRoot() {}\nfunction MenuItem() {}\n"
        "const Menu = Object.assign(MenuRoot, { Item: MenuItem });\n",
    )
    assert all(a.name != "Item" for a in aliases)


def test_object_assign_with_non_object_callee_is_not_aliased(tmp_path):
    """Since `#eq?` predicates aren't evaluated (see js_ts_aliases.scm's own
    header), the "really is Object.assign" check happens in Python --
    confirm a same-shaped call to a *different* namespace's `.assign` is
    correctly rejected, not treated as an alias."""
    adapter = get_registry().adapter_for_language("javascript")
    aliases = _aliases(
        adapter,
        tmp_path,
        "a.js",
        "function Base() {}\nconst Menu = SomeOtherNamespace.assign(Base, {});\n",
    )
    assert aliases == []


def test_object_method_other_than_assign_is_not_aliased(tmp_path):
    adapter = get_registry().adapter_for_language("javascript")
    aliases = _aliases(
        adapter,
        tmp_path,
        "a.js",
        "function Base() {}\nconst Menu = Object.merge(Base, {});\n",
    )
    assert aliases == []


def test_assignment_with_function_rhs_is_not_captured_as_alias(tmp_path):
    """`Foo.Bar = () => {}` defines a *new* function inline -- it already
    matches javascript_tags.scm's own `@definition.function` pattern and
    must NOT also produce an Alias (the two query files' patterns are
    disjoint by RHS node type: `[(arrow_function)(function_expression)]`
    for a real definition, plain `(identifier)` for an alias)."""
    adapter = get_registry().adapter_for_language("javascript")
    aliases = _aliases(adapter, tmp_path, "a.js", "const Foo = {};\nFoo.Bar = () => {};\n")
    assert aliases == []

    tags = _tags(adapter, tmp_path, "a2.js", "const Foo = {};\nFoo.Bar = () => {};\n")
    assert any(t.kind == "def" and t.name == "Bar" for t in tags)


def test_typescript_adapter_also_supports_aliases(tmp_path):
    """The alias mechanism isn't JSX-specific -- the plain `typescript`
    (`.ts`, no JSX grammar) adapter shares `js_ts_aliases.scm` too, since
    none of its patterns need any JSX node type."""
    adapter = get_registry().adapter_for_language("typescript")
    aliases = _aliases(
        adapter,
        tmp_path,
        "a.ts",
        "function base(): void {}\nconst alias = Object.assign(base, {});\n",
    )
    assert len(aliases) == 1
    assert aliases[0].name == "alias"
    assert aliases[0].target_name == "base"


def test_typescriptreact_adapter_also_supports_aliases(tmp_path):
    adapter = get_registry().adapter_for_language("typescriptreact")
    aliases = _aliases(
        adapter,
        tmp_path,
        "a.tsx",
        "function MenuRoot(): JSX.Element { return <nav />; }\n"
        "const Menu = Object.assign(MenuRoot, {});\n",
    )
    assert len(aliases) == 1
    assert aliases[0].name == "Menu"
    assert aliases[0].target_name == "MenuRoot"


def test_python_adapter_has_no_alias_query(tmp_path):
    """Python's `languages.json` entry has no `aliasQueryFile` (its grammar
    has no `variable_declarator`/`assignment_expression`/`call_expression`
    node shapes to reuse anyway) -- `extract_aliases` must return `[]`
    unconditionally rather than erroring."""
    adapter = get_registry().adapter_for_language("python")
    aliases = _aliases(adapter, tmp_path, "a.py", "def base():\n    pass\n")
    assert aliases == []


def test_resolve_callees_combines_direct_and_alias_sources():
    """Unit-level check of graph.py's `_resolve_callees` in isolation, not
    routed through a real adapter -- a name with no literal def resolves
    purely through its alias; a name with both a literal def *and* an alias
    combines both (the rare-collision case `_resolve_callees`'s own
    docstring documents), each entry appearing only once."""
    from sidecar.repomap.extraction import Tag

    base = Tag(
        rel_fname="a.js", fname="/a.js", name="Base", kind="def",
        start_line=0, end_line=1, start_byte=0, end_byte=10,
    )
    literal_menu = Tag(
        rel_fname="b.js", fname="/b.js", name="Menu", kind="def",
        start_line=0, end_line=1, start_byte=0, end_byte=10,
    )
    defs_by_name = {"Base": [base], "Menu": [literal_menu]}

    assert _resolve_callees("Menu", defs_by_name, {}) == [literal_menu]
    assert _resolve_callees("Menu", defs_by_name, {"Menu": ["Base"]}) == [literal_menu, base]
    assert _resolve_callees("Other", defs_by_name, {"Other": ["Base"]}) == [base]
    assert _resolve_callees("Nothing", defs_by_name, {}) == []


def test_build_call_graph_resolves_reference_through_alias(tmp_path):
    """End-to-end (extraction -> build_indices/build_alias_targets ->
    build_call_graph), confirming a JSX-sourced reference to a compound
    export resolves into a real edge -- the exact repro of session 77's
    original finding, now fixed."""
    adapter = get_registry().adapter_for_language("typescriptreact")
    source = (
        "function MenuRoot(): JSX.Element { return <nav />; }\n"
        "const Menu = Object.assign(MenuRoot, {});\n"
        "function App(): JSX.Element { return <Menu />; }\n"
    )
    fname = tmp_path / "a.tsx"
    fname.write_text(source, encoding="utf-8")
    tags = adapter.extract_tags(str(fname), "a.tsx")
    aliases = adapter.extract_aliases(str(fname), "a.tsx")

    tags_by_file = {"a.tsx": tags}
    aliases_by_file = {"a.tsx": aliases}
    graph = build_call_graph(tags_by_file, aliases_by_file)

    menu_root_node = next(n for n in graph.nodes if n[1] == "MenuRoot")
    callers = [n for n in graph.predecessors(menu_root_node) if graph[n][menu_root_node]["confident"]]
    assert [n[1] for n in callers] == ["App"]


def test_build_call_graph_defaults_to_no_aliases(tmp_path):
    """Every pre-Session-105 call site passes no `aliases_by_file` argument
    at all -- confirm that default still produces the exact same graph as
    passing an explicit empty dict, i.e. this is a backward-compatible
    optional parameter, not a behavior change for callers that don't opt in."""
    adapter = get_registry().adapter_for_language("javascript")
    source = "function base() {}\nfunction app() { base(); }\n"
    fname = tmp_path / "a.js"
    fname.write_text(source, encoding="utf-8")
    tags = adapter.extract_tags(str(fname), "a.js")
    tags_by_file = {"a.js": tags}

    no_arg = build_call_graph(tags_by_file)
    explicit_empty = build_call_graph(tags_by_file, {})
    assert set(no_arg.edges) == set(explicit_empty.edges)


def test_build_alias_targets_dedupes_repeated_same_pair():
    from sidecar.repomap.adapters.base import Alias

    aliases_by_file = {
        "a.js": [Alias(rel_fname="a.js", name="Menu", target_name="MenuRoot")],
        "b.js": [Alias(rel_fname="b.js", name="Menu", target_name="MenuRoot")],
    }
    targets = build_alias_targets(aliases_by_file)
    assert targets == {"Menu": ["MenuRoot"]}
