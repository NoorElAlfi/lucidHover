"""
Tests for sidecar/generation/generate.py's `_sanitize_explanation` -- a
deterministic backstop against invented caller/callee names in the LLM's
`used_by`/`calls` output. Added after the user reported what looked like a
dead click-to-navigate link; investigation showed that specific case wasn't
actually invented (the name was a real caller), but the backstop is worth
having regardless since the prompt instruction alone is not a guarantee.
See session-08 artifact's follow-up conversation.
"""

from __future__ import annotations

from sidecar.generation.generate import _sanitize_explanation
from sidecar.repomap.context import FunctionContext, RelatedFunction


def _ctx(callers: list[str], callees: list[str]) -> FunctionContext:
    return FunctionContext(
        "a.js",
        "target",
        0,
        callers=[RelatedFunction("a.js", n, 0, 0.0) for n in callers],
        callees=[RelatedFunction("a.js", n, 0, 0.0) for n in callees],
    )


def test_drops_invented_caller_name():
    explanation = {"used_by": ["realCaller", "madeUpCaller"], "calls": []}
    result = _sanitize_explanation(explanation, _ctx(["realCaller"], []))
    assert result["used_by"] == ["realCaller"]


def test_drops_invented_callee_name():
    explanation = {"used_by": [], "calls": ["realCallee", "madeUpCallee"]}
    result = _sanitize_explanation(explanation, _ctx([], ["realCallee"]))
    assert result["calls"] == ["realCallee"]


def test_keeps_all_names_when_all_are_real():
    explanation = {"used_by": ["a", "b"], "calls": ["c", "d"]}
    result = _sanitize_explanation(explanation, _ctx(["a", "b"], ["c", "d"]))
    assert result["used_by"] == ["a", "b"]
    assert result["calls"] == ["c", "d"]


def test_empty_ground_truth_drops_everything_invented():
    explanation = {"used_by": ["totallyMadeUp"], "calls": ["alsoMadeUp"]}
    result = _sanitize_explanation(explanation, _ctx([], []))
    assert result["used_by"] == []
    assert result["calls"] == []


def test_leaves_other_fields_untouched():
    explanation = {
        "role_tag": "Utility",
        "one_liner": "Does a thing.",
        "why_it_exists": "Used by madeUpCaller for reasons.",
        "used_by": ["madeUpCaller"],
        "calls": [],
        "side_effects": [],
        "risk_note": None,
    }
    result = _sanitize_explanation(explanation, _ctx([], []))
    assert result["role_tag"] == "Utility"
    assert result["one_liner"] == "Does a thing."
    # Free text is intentionally NOT rewritten -- only structured fields are guarded.
    assert result["why_it_exists"] == "Used by madeUpCaller for reasons."
    assert result["used_by"] == []


def test_does_not_mutate_the_input_dict():
    explanation = {"used_by": ["madeUp"], "calls": []}
    _sanitize_explanation(explanation, _ctx([], []))
    assert explanation["used_by"] == ["madeUp"]  # original untouched
