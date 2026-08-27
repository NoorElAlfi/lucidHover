"""
Orchestrates the two-stage generation call (Session 6) -- see prompt.py's
module docstring for why generation is split into an unconstrained
reasoning pass followed by a schema-constrained JSON pass.
"""

from __future__ import annotations

from typing import Any

from ..repomap.context import FunctionContext
from ..retrieval.retrieve import RetrievedChunk
from .ollama_client import OLLAMA_BASE_URL, generate_structured, generate_text
from .prompt import (
    CLUSTER_SUMMARY_SYSTEM_INSTRUCTION,
    FILE_SUMMARY_SYSTEM_INSTRUCTION,
    SYSTEM_INSTRUCTION,
    build_cluster_summary_prompt,
    build_context_bundle,
    build_file_summary_prompt,
    build_json_prompt,
    build_reasoning_prompt,
)
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
    model: str,
    fn_source: str,
    ctx: FunctionContext,
    retrieved_chunks: list[RetrievedChunk] | None = None,
    base_url: str = OLLAMA_BASE_URL,
) -> dict[str, Any]:
    caller_names = [c.name for c in ctx.callers]
    callee_names = [c.name for c in ctx.callees]
    context_bundle = build_context_bundle(ctx, retrieved_chunks)

    reasoning_prompt = build_reasoning_prompt(fn_source, caller_names, callee_names, context_bundle)
    reasoning = generate_text(model, SYSTEM_INSTRUCTION, reasoning_prompt, stop=["{"], base_url=base_url)

    json_prompt = build_json_prompt(fn_source, caller_names, callee_names, context_bundle, reasoning)
    explanation = generate_structured(model, SYSTEM_INSTRUCTION, json_prompt, EXPLANATION_SCHEMA, base_url=base_url)

    return _sanitize_explanation(explanation, ctx)


def generate_file_summary(
    model: str,
    file_path: str,
    functions: list[dict[str, Any]],
    base_url: str = OLLAMA_BASE_URL,
) -> str:
    """
    Build Order step 15: the one new LLM call the secondary summary-doc
    generator needs -- a purpose paragraph for one file, synthesized from
    that file's already-generated per-function `role_tag`/`one_liner`
    pairs (the extension host resolves and passes these in; this module
    never touches `ExplanationCache`, which is TS-owned). One unconstrained
    `generate_text` call, same as `generate_explanation`'s Stage A, but
    with no Stage B -- there's no structured schema for a prose paragraph.
    """
    prompt = build_file_summary_prompt(file_path, functions)
    summary = generate_text(model, FILE_SUMMARY_SYSTEM_INSTRUCTION, prompt, base_url=base_url)
    return summary.strip()


def generate_cluster_summary(
    model: str,
    root_name: str,
    root_role: str | None,
    root_one_liner: str | None,
    callers: list[dict[str, Any]],
    base_url: str = OLLAMA_BASE_URL,
) -> str:
    """
    Session 68 (call-graph-clustered rollup summary): the one new LLM call
    the feature needs -- a purpose paragraph for a root function's cluster
    (itself plus its already-cached transitive upstream callers, selected by
    the extension host via the sidecar's existing `get_blast_radius` RPC).
    Same shape as `generate_file_summary` above: one unconstrained
    `generate_text` call, no Stage B. This module never touches
    `ExplanationCache` (TS-owned) or `RepoMap`/the call graph directly --
    both the cluster selection and the cache reads already happened before
    this is called.
    """
    prompt = build_cluster_summary_prompt(root_name, root_role, root_one_liner, callers)
    summary = generate_text(model, CLUSTER_SUMMARY_SYSTEM_INSTRUCTION, prompt, base_url=base_url)
    return summary.strip()
