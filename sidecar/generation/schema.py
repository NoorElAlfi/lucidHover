"""
JSON schema for the per-function explanation object (Session 6), matching
the spec's "Output Schema + Prompt Design" section exactly. Passed as
Ollama's `format` param (structured-output/grammar-constrained decoding) --
never prose-instructed formatting, per that section's explicit requirement.
"""

from __future__ import annotations

EXPLANATION_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "role_tag": {"type": "string"},
        "one_liner": {"type": "string"},
        "why_it_exists": {"type": "string"},
        "used_by": {"type": "array", "items": {"type": "string"}},
        "calls": {"type": "array", "items": {"type": "string"}},
        "side_effects": {"type": "array", "items": {"type": "string"}},
        "risk_note": {"type": ["string", "null"]},
    },
    "required": [
        "role_tag",
        "one_liner",
        "why_it_exists",
        "used_by",
        "calls",
        "side_effects",
        "risk_note",
    ],
}
