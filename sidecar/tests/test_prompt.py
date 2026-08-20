"""
Tests for sidecar/generation/prompt.py's context-bundle formatting -- added
alongside the top-k "most significant" caller/callee highlighting. Follow-up
to Session 8: the acceptance test run against a real repo showed
why_it_exists inconsistently grounding on long (~15-name) caller/callee
lists, which had no signal about which names mattered most and no few-shot
example demonstrating what to do with a long list.
"""

from __future__ import annotations

from sidecar.generation.prompt import _EXAMPLE_3, TOP_K_HIGHLIGHT, build_context_bundle
from sidecar.repomap.context import FunctionContext, RelatedFunction
from sidecar.retrieval.retrieve import RetrievedChunk


def _related(n: int) -> list[RelatedFunction]:
    return [RelatedFunction(f"file{i}.js", f"fn{i}", i, 0.0) for i in range(n)]


def test_short_list_has_no_highlight_section():
    ctx = FunctionContext("a.js", "target", 0, callers=_related(TOP_K_HIGHLIGHT), callees=[])
    bundle = build_context_bundle(ctx)
    assert "Most significant" not in bundle
    assert "Full list" not in bundle


def test_long_list_highlights_top_k_ranked_first():
    callers = _related(TOP_K_HIGHLIGHT + 5)
    ctx = FunctionContext("a.js", "target", 0, callers=callers, callees=[])
    bundle = build_context_bundle(ctx)
    assert f"Most significant (top {TOP_K_HIGHLIGHT}" in bundle

    highlight_section = bundle.split("Full list")[0]
    for c in callers[:TOP_K_HIGHLIGHT]:
        assert c.name in highlight_section
    for c in callers[TOP_K_HIGHLIGHT:]:
        assert c.name not in highlight_section  # not in the highlight -- still appears later in the full list


def test_long_list_full_list_still_contains_every_name():
    callers = _related(TOP_K_HIGHLIGHT + 5)
    ctx = FunctionContext("a.js", "target", 0, callers=callers, callees=[])
    bundle = build_context_bundle(ctx)
    for c in callers:
        assert c.name in bundle


def test_empty_list_renders_none_with_no_highlight():
    ctx = FunctionContext("a.js", "target", 0, callers=[], callees=[])
    bundle = build_context_bundle(ctx)
    assert "Callers (0):\n  none" in bundle
    assert "Most significant" not in bundle


def test_example_3_context_bundle_matches_real_formatting():
    """
    `_EXAMPLE_3`'s `context_bundle` is a hand-written literal, not generated
    at runtime -- if it ever drifts out of sync with what `build_context_bundle`
    actually produces, the few-shot prompt would teach the model a format
    the real input slot doesn't use. Confirms the highlight section, the
    full list, and the top-3-first ranking order are all present and
    consistent with `_EXAMPLE_3.caller_names`.
    """
    bundle = _EXAMPLE_3.context_bundle
    assert f"Most significant (top {TOP_K_HIGHLIGHT}" in bundle
    assert "Full list" in bundle

    highlight_section, _, full_list_section = bundle.partition("Full list")
    for name in _EXAMPLE_3.caller_names[:TOP_K_HIGHLIGHT]:
        assert name in highlight_section
    for name in _EXAMPLE_3.caller_names:
        assert name in bundle

    order_in_full_list = [n for n in _EXAMPLE_3.caller_names if n in full_list_section]
    assert order_in_full_list == _EXAMPLE_3.caller_names


def test_no_retrieved_chunks_renders_none():
    ctx = FunctionContext("a.js", "target", 0, callers=[], callees=[])
    bundle = build_context_bundle(ctx, [])
    assert "Retrieved context (0):\n  none" in bundle


def test_retrieved_chunks_are_included_with_their_location():
    ctx = FunctionContext("a.js", "target", 0, callers=[], callees=[])
    chunk = RetrievedChunk(rel_fname="utils.js", start_line=10, end_line=12, text="function helper() {}")
    bundle = build_context_bundle(ctx, [chunk])
    assert "Retrieved context (1):" in bundle
    assert "utils.js:11-12" in bundle
    assert "function helper() {}" in bundle


def test_omitted_retrieved_chunks_argument_matches_empty_list():
    ctx = FunctionContext("a.js", "target", 0, callers=[], callees=[])
    assert build_context_bundle(ctx) == build_context_bundle(ctx, [])
