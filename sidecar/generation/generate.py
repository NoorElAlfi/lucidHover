"""
Orchestrates the two-stage generation call (Session 6) -- see prompt.py's
module docstring for why generation is split into an unconstrained
reasoning pass followed by a schema-constrained JSON pass.
"""

from __future__ import annotations

from typing import Any

from ..repomap.context import FunctionContext
from ..retrieval.retrieve import RetrievedChunk
from .ollama_client import generate_structured, generate_text
from .prompt import SYSTEM_INSTRUCTION, build_context_bundle, build_json_prompt, build_reasoning_prompt
from .schema import EXPLANATION_SCHEMA


def _sanitize_explanation(explanation: dict[str, Any], ctx: FunctionContext) -> dict[str, Any]:
    """
    Deterministic backstop against invented caller/callee names -- never
    rely on the prompt instruction alone to guarantee `used_by`/`calls`
    only contain real given names. Filters both fields down to exactly
    `ctx.callers`/`ctx.callees`'s real names; anything else the model wrote
    is dropped before the explanation is ever cached or rendered, so a
    "couldn't find X" dead click-to-navigate link can never happen
    regardless of model behavior. Free-text fields (why_it_exists,
    one_liner, risk_note) are left untouched -- this only guards the
    structured fields that actually drive clickable links in the panel UI.
    """
    real_callers = {c.name for c in ctx.callers}
    real_callees = {c.name for c in ctx.callees}

    sanitized = dict(explanation)
    if isinstance(sanitized.get("used_by"), list):
        sanitized["used_by"] = [n for n in sanitized["used_by"] if n in real_callers]
    if isinstance(sanitized.get("calls"), list):
        sanitized["calls"] = [n for n in sanitized["calls"] if n in real_callees]
    return sanitized


def generate_explanation(
    model: str, fn_source: str, ctx: FunctionContext, retrieved_chunks: list[RetrievedChunk] | None = None
) -> dict[str, Any]:
    caller_names = [c.name for c in ctx.callers]
    callee_names = [c.name for c in ctx.callees]
    context_bundle = build_context_bundle(ctx, retrieved_chunks)

    reasoning_prompt = build_reasoning_prompt(fn_source, caller_names, callee_names, context_bundle)
    reasoning = generate_text(model, SYSTEM_INSTRUCTION, reasoning_prompt, stop=["{"])

    json_prompt = build_json_prompt(fn_source, caller_names, callee_names, context_bundle, reasoning)
    explanation = generate_structured(model, SYSTEM_INSTRUCTION, json_prompt, EXPLANATION_SCHEMA)

    return _sanitize_explanation(explanation, ctx)
