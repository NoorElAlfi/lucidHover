"""
Session 78: closes session 77's confirmed JSX-usage blind-spot finding
(javascript_tags.scm/typescript_tsx_tags.scm previously had no
`@reference.call` pattern for JSX tag usage at all, so a component used as
`<Button />` N times showed 0 captured callers regardless of N).

These are synthetic, isolated-snippet tests (via a temp directory and each
language's real registered adapter) rather than only relying on the real
fixture in test_repomap_typescript.py -- they exercise the extraction layer
directly (`Tag` lists from `extract_tags`), including edge cases the fixture
doesn't need to carry itself (e.g. `jsx_opening_element` with children,
non-JSX case-sensitive-kind isolation, the plain `typescript` (`.ts`) adapter
never gaining JSX patterns at all).
"""

from __future__ import annotations

from sidecar.repomap.adapters.registry import get_registry


def _tags(adapter, tmp_path, filename: str, source: str):
    fname = tmp_path / filename
    fname.write_text(source, encoding="utf-8")
    return adapter.extract_tags(str(fname), filename)


def _refs(tags):
    return [t.name for t in tags if t.kind == "ref"]


def test_capitalized_self_closing_component_is_captured(tmp_path):
    adapter = get_registry().adapter_for_language("javascript")
    tags = _tags(
        adapter,
        tmp_path,
        "a.jsx",
        "function App() { return <Button onClick={noop} />; }",
    )
    assert "Button" in _refs(tags)
    ref = next(t for t in tags if t.name == "Button")
    assert ref.kind == "ref"
    assert ref.capture_kind == "jsx"


def test_capitalized_opening_element_with_children_is_captured(tmp_path):
    adapter = get_registry().adapter_for_language("javascript")
    tags = _tags(
        adapter,
        tmp_path,
        "a.jsx",
        "function App() { return <Panel>{children}</Panel>; }",
    )
    # Exactly one "Panel" ref -- the opening tag's name, not double-counted
    # via the closing tag (jsx_closing_element has no query pattern).
    assert _refs(tags).count("Panel") == 1


def test_lowercase_host_element_produces_no_tag(tmp_path):
    adapter = get_registry().adapter_for_language("javascript")
    tags = _tags(
        adapter,
        tmp_path,
        "a.jsx",
        "function App() { return <div className='x'><span/></div>; }",
    )
    assert _refs(tags) == []


def test_namespaced_usage_resolves_to_root_identifier(tmp_path):
    adapter = get_registry().adapter_for_language("javascript")
    tags = _tags(
        adapter,
        tmp_path,
        "a.jsx",
        "function App() { return <Menu.Item />; }",
    )
    assert _refs(tags) == ["Menu"]


def test_deeply_nested_namespaced_usage_resolves_to_root_identifier(tmp_path):
    adapter = get_registry().adapter_for_language("javascript")
    tags = _tags(
        adapter,
        tmp_path,
        "a.jsx",
        "function App() { return <Foo.Bar.Baz />; }",
    )
    assert _refs(tags) == ["Foo"]


def test_lowercase_rooted_namespaced_usage_is_still_captured(tmp_path):
    """A dotted JSX tag name can never be a host element (those are plain
    lowercase identifiers only), so it is kept regardless of the root's
    casing -- unlike a plain identifier tag, where lowercase means drop."""
    adapter = get_registry().adapter_for_language("javascript")
    tags = _tags(
        adapter,
        tmp_path,
        "a.jsx",
        "function App() { return <lower.Thing />; }",
    )
    assert _refs(tags) == ["lower"]


def test_real_call_inside_jsx_attribute_is_unaffected(tmp_path):
    """A real call_expression written inside a JSX attribute's expression
    container must still be captured as an ordinary call reference -- the
    blind spot is JSX *element* usage, not code that happens to be nested
    inside JSX (session 77's own documented distinction)."""
    adapter = get_registry().adapter_for_language("javascript")
    tags = _tags(
        adapter,
        tmp_path,
        "a.jsx",
        "function App() { return <Menu.Item onSelect={() => handleSelect()} />; }",
    )
    call_refs = [t for t in tags if t.kind == "ref" and t.capture_kind == "call"]
    assert [t.name for t in call_refs] == ["handleSelect"]


def test_typescriptreact_adapter_captures_jsx_the_same_way(tmp_path):
    adapter = get_registry().adapter_for_language("typescriptreact")
    tags = _tags(
        adapter,
        tmp_path,
        "a.tsx",
        "function App(): JSX.Element { return <Button onClick={noop} />; }",
    )
    assert "Button" in _refs(tags)


def test_plain_typescript_adapter_has_no_jsx_capture_kind(tmp_path):
    """The plain `typescript` (`.ts`) manifest entry deliberately never gets
    JSX query patterns -- `language_typescript` has no JSX node types at all
    (confirmed empirically; `Query()` construction throws for
    `jsx_opening_element` against that grammar), so `typescriptreact` (`.tsx`)
    is a separate manifest entry with its own query file
    (typescript_tsx_tags.scm) instead. This just confirms the plain adapter
    still parses ordinary TS fine and produces no "jsx" captures, since there
    is nothing JSX-shaped in its query file to match."""
    adapter = get_registry().adapter_for_language("typescript")
    tags = _tags(
        adapter,
        tmp_path,
        "a.ts",
        "export function add(a: number, b: number): number { return a + b; }",
    )
    assert all(t.capture_kind != "jsx" for t in tags)
    assert any(t.name == "add" and t.kind == "def" for t in tags)
