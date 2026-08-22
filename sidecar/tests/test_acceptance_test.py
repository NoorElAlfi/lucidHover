"""
Tests for scripts/acceptance_test.py's automated schema/grounding filter --
covers the issues/notes split added after a real acceptance-test run showed
the caller/callee-mention check false-positiving on legitimate
paraphrased-but-grounded explanations (session-08 artifact follow-up:
`requestJson` correctly described what its 5 callers do -- "fetching,
creating, deleting, updating, and cloning models" -- without quoting any
caller's literal identifier).

`scripts/` isn't a package (no `__init__.py`), so it's imported here by
adding it to `sys.path` directly, same as `acceptance_test.py` itself does
for the repo root.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

from acceptance_test import _check_schema  # noqa: E402


def _explanation(**overrides):
    base = {
        "role_tag": "Utility",
        "one_liner": "Does one thing.",
        "why_it_exists": "Generic reasoning with no names.",
        "used_by": [],
        "calls": [],
        "side_effects": [],
        "risk_note": None,
    }
    base.update(overrides)
    return base


def test_missing_field_is_an_issue():
    explanation = _explanation()
    del explanation["risk_note"]
    issues, notes = _check_schema(explanation, [], [])
    assert any("missing field: risk_note" in i for i in issues)
    assert notes == []


def test_placeholder_text_is_an_issue():
    explanation = _explanation(why_it_exists="TBD, need to fill this in later.")
    issues, notes = _check_schema(explanation, [], [])
    assert any("placeholder-like text" in i for i in issues)


def test_strong_placeholder_patterns_stay_issues():
    """
    "n/a", "tbd", "todo", "and more", "etc." are essentially never genuine
    content in a real explanation -- these stay hard issues, unlike "unknown"
    (see test_weak_placeholder_word_is_a_note_not_an_issue below).
    """
    for pattern in ("n/a", "tbd", "todo", "and more", "etc."):
        explanation = _explanation(why_it_exists=f"Some reasoning with {pattern} in it.")
        issues, notes = _check_schema(explanation, [], [])
        assert any("placeholder-like text" in i for i in issues), f"pattern {pattern!r} should be an issue"
        assert notes == []


def test_weak_placeholder_word_is_a_note_not_an_issue():
    """
    The getPlayerModelKey case from benchmarking 1.5b/3b against a real repo:
    why_it_exists accurately described the function's real `'Unknown Model'`
    fallback string, but got flagged as if "unknown" were a hedge. "unknown"
    is common enough as genuine content that it must not count toward the
    issue total (and thus not toward the report's pass/fail rate).
    """
    explanation = _explanation(
        why_it_exists="Defaults to 'Unknown Model' when no model id is present."
    )
    issues, notes = _check_schema(explanation, [], [])
    assert issues == []
    assert len(notes) == 1
    assert "unknown" in notes[0]


def test_multi_sentence_one_liner_is_an_issue():
    explanation = _explanation(one_liner="Does one thing. Then does another thing.")
    issues, notes = _check_schema(explanation, [], [])
    assert any("more than one sentence" in i for i in issues)


def test_literal_name_match_produces_neither_issue_nor_note():
    explanation = _explanation(why_it_exists="Called by fetchAdminModels to load data.")
    issues, notes = _check_schema(explanation, ["fetchAdminModels"], [])
    assert issues == []
    assert notes == []


def test_no_literal_name_match_is_a_note_not_an_issue():
    """
    The requestJson case: why_it_exists paraphrases what the callers do
    without quoting any literal identifier. This must NOT count toward the
    issue total (and thus not toward the report's pass/fail rate) -- it's a
    heuristic signal for the human reviewer, not a mechanical defect.
    """
    explanation = _explanation(
        why_it_exists="Used by several admin model endpoints for fetching, creating, and deleting data."
    )
    issues, notes = _check_schema(explanation, ["fetchAdminModels", "createAdminModel", "deleteAdminModel"], [])
    assert issues == []
    assert len(notes) == 1
    assert "doesn't literally quote" in notes[0]


def test_no_callers_or_callees_given_produces_no_note():
    explanation = _explanation(why_it_exists="Pure utility with no known callers or callees.")
    issues, notes = _check_schema(explanation, [], [])
    assert issues == []
    assert notes == []


def test_missing_fields_short_circuit_before_any_notes():
    explanation = _explanation()
    del explanation["why_it_exists"]
    issues, notes = _check_schema(explanation, ["someCaller"], [])
    assert any("missing field: why_it_exists" in i for i in issues)
    assert notes == []


def test_comma_joined_side_effects_is_a_note_not_an_issue():
    """
    The bug this field rule/example addition targets: side_effects returned
    as one comma-joined string instead of several distinct array elements.
    Both shapes satisfy the JSON schema ("array of strings"), so this is a
    heuristic note for a human reviewer, not a mechanical schema defect --
    same issues/notes split as the other heuristic checks in this file.
    """
    explanation = _explanation(
        side_effects=["DB writes, network calls, file I/O, sent messages, mutation of arguments/globals"]
    )
    issues, notes = _check_schema(explanation, [], [])
    assert issues == []
    assert len(notes) == 1
    assert "comma-join" in notes[0]


def test_granular_side_effects_produce_no_note():
    explanation = _explanation(side_effects=["writes to the DB", "makes a network call", "writes a file"])
    issues, notes = _check_schema(explanation, [], [])
    assert issues == []
    assert notes == []


def test_callees_contradiction_is_a_note_not_an_issue():
    """
    The recordNamespaced defect from session-25: why_it_exists claims "no
    callees" in the same sentence calls actually names one (logEvent).
    """
    explanation = _explanation(
        why_it_exists="Logs it using the logEvent function -- does not have any callees.",
        calls=["logEvent"],
    )
    issues, notes = _check_schema(explanation, [], [])
    assert issues == []
    assert len(notes) == 1
    assert "self-contradiction" in notes[0]


def test_callers_contradiction_is_a_note_not_an_issue():
    explanation = _explanation(
        why_it_exists="A pure utility with no callers.",
        used_by=["someCaller"],
    )
    issues, notes = _check_schema(explanation, [], [])
    assert issues == []
    assert len(notes) == 1
    assert "self-contradiction" in notes[0]


def test_contradiction_pattern_needs_a_nonempty_array():
    """
    The negation phrase alone isn't a contradiction -- it only becomes one
    when the corresponding array actually names something. An accurate "no
    callees" claim next to an empty calls array must not be flagged.
    """
    explanation = _explanation(why_it_exists="A pure utility with no callees and no callers.")
    issues, notes = _check_schema(explanation, [], [])
    assert issues == []
    assert notes == []


def test_consistent_why_it_exists_produces_no_contradiction_note():
    explanation = _explanation(
        why_it_exists="Logs an event via logEvent, called from recordNamespaced's callers.",
        calls=["logEvent"],
        used_by=["someCaller"],
    )
    issues, notes = _check_schema(explanation, [], [])
    assert issues == []
    assert notes == []


def test_boilerplate_triad_is_a_note_not_an_issue():
    """
    The isEmpty<T>/handleLoginRoute defect from session-25: side_effects is a
    near-verbatim copy of 3 of prompt.py's own illustrative category phrases,
    despite the function doing none of them.
    """
    explanation = _explanation(
        side_effects=[
            "reading or writing a file",
            "sending a message or notification",
            "mutating a parameter or global",
        ]
    )
    issues, notes = _check_schema(explanation, [], [])
    assert issues == []
    assert len(notes) == 1
    assert "boilerplate" in notes[0]


def test_single_boilerplate_phrase_produces_no_note():
    """
    A single matching phrase is weak evidence on its own -- a function could
    genuinely do exactly one of these things -- so it must not fire alone.
    """
    explanation = _explanation(side_effects=["writes a file to disk"])
    issues, notes = _check_schema(explanation, [], [])
    assert issues == []
    assert notes == []
