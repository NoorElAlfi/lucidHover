"""
Few-shot prompt construction (Session 6), per the spec's "Output Schema +
Prompt Design" section: a system instruction with the field rules, 2 worked
examples each showing a `Reasoning:` step before the JSON, then the real
input slot (`fn_source`/`caller_names`/`callee_names`/`context_bundle`)
ending in `Reasoning:` as a prompt continuation.

Two-stage generation, and why: Ollama's `format` (JSON-schema-constrained
decoding, see ollama_client.py) forces the *entire* response to match the
schema from the first token -- it cannot emit free prose ("Reasoning: ...")
followed by a JSON object in one call. To keep both spec requirements
literally true -- a real free-text Reasoning: continuation AND genuine
schema-enforced (not prose-instructed) JSON output -- generation runs as two
calls: an unconstrained reasoning pass (stopped right before it would start
emitting JSON) followed by a schema-constrained JSON pass that is given the
reasoning text as extra context. See generate.py and session-06 artifact.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..repomap.context import FunctionContext
from ..retrieval.retrieve import RetrievedChunk

SYSTEM_INSTRUCTION = """You are an expert code reviewer explaining one function from a codebase to \
another engineer who has never seen it. You are given the function's source, plus the names of \
its actual known callers and callees from the codebase's call graph.

Field rules -- follow exactly:
- role_tag: a short (1-3 word) category for what kind of function this is (e.g. "Handler", \
"Validator", "Utility", "Persistence", "Middleware", "Worker").
- one_liner: exactly one sentence, plain language, no jargon dump.
- why_it_exists: must reference the ACTUAL given caller/callee names to explain this function's \
purpose in the codebase -- never generic restated-docstring reasoning. You do NOT need to name \
every caller/callee: when the context bundle marks a "Most significant" subset, name those \
specifically -- they're ranked highest by codebase importance -- and you may summarize the rest by \
count/category (e.g. "and 9 other account routes") instead of listing every name. Still, you must \
name at least one real given name whenever any are given -- never fall back to describing the \
group with no names at all just because the list is long. If there are no callers or callees \
given, say so plainly rather than inventing a reason.
- used_by: the caller names, exactly as given -- do not shorten, rename, or add names not given.
- calls: the callee names, exactly as given -- same rule.
- side_effects: only effects you can actually see in the function body (DB writes, network calls, \
file I/O, sent messages, mutation of arguments/globals). Empty array if none -- never invent one.
- risk_note: only a genuine correctness/safety concern visible from the given source and \
callers/callees (e.g. a caller that skips a check this function relies on). null if none -- do \
not speculate or manufacture a risk to fill the field.
- Never invent function names, and never append filler like "and more" -- the caller/callee lists \
you are given are already complete for this context tier.
- Empty/absent is a real answer, not a gap to fill: an empty array or null means "confirmed none", \
not "unknown"."""


@dataclass(frozen=True)
class FewShotExample:
    fn_source: str
    caller_names: list[str]
    callee_names: list[str]
    context_bundle: str
    reasoning: str
    explanation: dict


_EXAMPLE_1 = FewShotExample(
    fn_source=(
        "function isValidPort(port) {\n"
        "  return Number.isInteger(port) && port > 0 && port < 65536;\n"
        "}"
    ),
    caller_names=[],
    callee_names=[],
    context_bundle="Callers (0): none\nCallees (0): none",
    reasoning=(
        "No callers or callees are given for this function, so I can't say anything about how "
        "it's used in the codebase -- I'll describe only what's visible in the source itself. "
        "The body is a pure range/type check on a single argument with no I/O, no mutation, and "
        "no dependency on anything external, so this is a plain utility/validator with no side "
        "effects and no risk worth flagging."
    ),
    explanation={
        "role_tag": "Validator",
        "one_liner": "Checks whether a given number is a valid TCP/UDP port (1-65535).",
        "why_it_exists": (
            "No callers or callees were provided for this function, so its role in the wider "
            "codebase can't be determined here -- based on the source alone, it exists as a "
            "reusable range/type check for port numbers."
        ),
        "used_by": [],
        "calls": [],
        "side_effects": [],
        "risk_note": None,
    },
)

_EXAMPLE_2 = FewShotExample(
    fn_source=(
        "function processRefund(orderId, amount) {\n"
        "  const order = db.getOrder(orderId);\n"
        "  stripeClient.refund(order.paymentId, amount);\n"
        "  db.updateOrder(orderId, { refunded: true });\n"
        "  logEvent(`refund issued for order ${orderId}`);\n"
        "}"
    ),
    caller_names=["adminRefundRoute", "chargebackWebhook"],
    callee_names=["db.getOrder", "stripeClient.refund", "db.updateOrder", "logEvent"],
    context_bundle=(
        "Callers (2):\n"
        "  - adminRefundRoute (routes/admin.js:41)\n"
        "  - chargebackWebhook (webhooks/stripe.js:19)\n"
        "Callees (4):\n"
        "  - db.getOrder (db.js:12)\n"
        "  - stripeClient.refund (payments/stripe.js:55)\n"
        "  - db.updateOrder (db.js:30)\n"
        "  - logEvent (logging.js:4)"
    ),
    reasoning=(
        "This function is called from two places: adminRefundRoute, which is presumably a "
        "human-triggered admin action, and chargebackWebhook, which is an automated webhook "
        "handler that reacts to Stripe chargeback events. It calls stripeClient.refund (an "
        "external payment API call, a real side effect), db.getOrder/db.updateOrder (DB reads "
        "and writes, also side effects), and logEvent. Because chargebackWebhook is an "
        "automated caller and the function has no visible idempotency or duplicate-refund check, "
        "a retried webhook delivery could trigger this function twice for the same chargeback -- "
        "that's a genuine risk worth flagging, not a speculative one, since it follows directly "
        "from the given caller list and the function body."
    ),
    explanation={
        "role_tag": "Handler",
        "one_liner": "Issues a refund for an order via Stripe and marks the order as refunded.",
        "why_it_exists": (
            "Shared refund logic used by both adminRefundRoute (manual admin action) and "
            "chargebackWebhook (automated Stripe chargeback handling), so refund issuance and "
            "order bookkeeping stay in one place instead of duplicated across both callers."
        ),
        "used_by": ["adminRefundRoute", "chargebackWebhook"],
        "calls": ["db.getOrder", "stripeClient.refund", "db.updateOrder", "logEvent"],
        "side_effects": ["calls external Stripe API", "writes to DB", "writes a log event"],
        "risk_note": (
            "chargebackWebhook calls this without any idempotency check -- a retried webhook "
            "delivery could issue a duplicate refund for the same chargeback."
        ),
    },
)

_EXAMPLE_3 = FewShotExample(
    fn_source=(
        "function requireAuth(req, res, next) {\n"
        "  if (!req.session || !req.session.userId) {\n"
        "    return res.status(401).json({ error: 'not authenticated' });\n"
        "  }\n"
        "  next();\n"
        "}"
    ),
    caller_names=[
        "getAccountRoute", "createOrderRoute", "checkoutRoute", "updateAccountRoute",
        "deleteAccountRoute", "getOrdersRoute", "cancelOrderRoute", "getCartRoute",
        "updateCartRoute", "getWishlistRoute", "addToWishlistRoute", "getNotificationsRoute",
    ],
    callee_names=[],
    context_bundle=(
        "Callers (12):\n"
        "  Most significant (top 3, ranked by codebase importance -- prioritize naming these in "
        "why_it_exists):\n"
        "    - getAccountRoute (routes/account.js:13)\n"
        "    - createOrderRoute (routes/orders.js:21)\n"
        "    - checkoutRoute (routes/checkout.js:8)\n"
        "  Full list (already ranked, most significant first):\n"
        "  - getAccountRoute (routes/account.js:13)\n"
        "  - createOrderRoute (routes/orders.js:21)\n"
        "  - checkoutRoute (routes/checkout.js:8)\n"
        "  - updateAccountRoute (routes/account.js:27)\n"
        "  - deleteAccountRoute (routes/account.js:40)\n"
        "  - getOrdersRoute (routes/orders.js:7)\n"
        "  - cancelOrderRoute (routes/orders.js:34)\n"
        "  - getCartRoute (routes/cart.js:5)\n"
        "  - updateCartRoute (routes/cart.js:18)\n"
        "  - getWishlistRoute (routes/wishlist.js:6)\n"
        "  - addToWishlistRoute (routes/wishlist.js:14)\n"
        "  - getNotificationsRoute (routes/notifications.js:4)\n"
        "Callees (0):\n"
        "  none"
    ),
    reasoning=(
        "There are 12 callers here, far too many to discuss individually -- but they're already "
        "ranked by importance, and the context bundle calls out the top 3 (getAccountRoute, "
        "createOrderRoute, checkoutRoute), which cover the highest-traffic paths: account access "
        "and the order/checkout flow. I'll name those three specifically to ground why_it_exists, "
        "then summarize the remaining 9 by category (other account/cart/wishlist/notification "
        "routes) rather than listing every name -- that keeps the sentence readable without "
        "dropping the grounding the field rules require. The function itself is a pure auth gate "
        "with no callees and no side effects beyond the 401 response, so no risk worth flagging."
    ),
    explanation={
        "role_tag": "Middleware",
        "one_liner": "Rejects any request without an authenticated session before it reaches the route handler.",
        "why_it_exists": (
            "Shared auth gate in front of most of the app's protected routes -- used directly by "
            "getAccountRoute, createOrderRoute, and checkoutRoute (its three highest-traffic "
            "callers), plus 9 other account/cart/wishlist/notification routes, so authentication "
            "logic lives in one place instead of being duplicated across every handler."
        ),
        "used_by": [
            "getAccountRoute", "createOrderRoute", "checkoutRoute", "updateAccountRoute",
            "deleteAccountRoute", "getOrdersRoute", "cancelOrderRoute", "getCartRoute",
            "updateCartRoute", "getWishlistRoute", "addToWishlistRoute", "getNotificationsRoute",
        ],
        "calls": [],
        "side_effects": ["sends a 401 response when unauthenticated"],
        "risk_note": None,
    },
)

FEW_SHOT_EXAMPLES = [_EXAMPLE_1, _EXAMPLE_2, _EXAMPLE_3]


TOP_K_HIGHLIGHT = 3


def _format_related_section(noun: str, related: list, omitted: int) -> list[str]:
    """
    One section (callers or callees) of the context bundle. `related` is
    already PageRank-sorted by context.py's get_function_context, so "top"
    here just means "first" -- no new ranking logic, just surfacing the
    existing order more explicitly than a flat list does.

    When there are more than TOP_K_HIGHLIGHT entries, calls out the
    top-ranked few in their own labeled subsection before the full list.
    This exists to fight why_it_exists dilution on long lists: with e.g. 15
    flat names and no signal about which matter most, models tend to fall
    back to generic prose instead of naming any of them (observed directly
    against a real repo's acceptance-test run -- see session-08 artifact's
    follow-up). Short lists (<= TOP_K_HIGHLIGHT) skip the subsection
    entirely since it would just repeat the same 1-3 names twice.
    """
    label = f"{noun.capitalize()}s"
    lines = [f"{label} ({len(related)}):"]
    if not related:
        lines.append("  none")
        return lines

    if len(related) > TOP_K_HIGHLIGHT:
        lines.append(
            f"  Most significant (top {TOP_K_HIGHLIGHT}, ranked by codebase importance -- "
            "prioritize naming these in why_it_exists):"
        )
        for c in related[:TOP_K_HIGHLIGHT]:
            lines.append(f"    - {c.name} ({c.rel_fname}:{c.line})")
        lines.append("  Full list (already ranked, most significant first):")

    for c in related:
        lines.append(f"  - {c.name} ({c.rel_fname}:{c.line})")
    if omitted:
        lines.append(f"  ... and {omitted} more {noun}(s) not shown")

    return lines


def _format_retrieved_section(retrieved_chunks: list[RetrievedChunk]) -> list[str]:
    """
    Session 11: retrieved chunks are content from *outside* the call-graph
    tier (own source + caller/callee signatures) -- surfaced as their own
    labeled section so the model doesn't mistake them for known callers/
    callees. Fixed top-k, no adaptive token-budget truncation (same
    fixed-count-cap style context.py already uses for callers/callees).
    """
    lines = [f"Retrieved context ({len(retrieved_chunks)}):"]
    if not retrieved_chunks:
        lines.append("  none")
        return lines
    for c in retrieved_chunks:
        lines.append(f"  - {c.rel_fname}:{c.start_line + 1}-{c.end_line}")
        for text_line in c.text.splitlines():
            lines.append(f"      {text_line}")
    return lines


def build_context_bundle(ctx: FunctionContext, retrieved_chunks: list[RetrievedChunk] | None = None) -> str:
    """
    Own source + ranked callers/callees (v0), plus the retrieval tier
    (Session 11 / post-MVP): top-k chunks from outside the call graph, per
    the spec's "Context Budget" section. Includes the omitted-count marker
    so it's reflected in what the model sees (the hash of this same data
    lives separately in cache/hashing.py's compute_context_hash, which
    hashes the structured inputs directly and is unaffected by this
    rendering format).
    """
    lines = _format_related_section("caller", ctx.callers, ctx.callers_omitted)
    lines += _format_related_section("callee", ctx.callees, ctx.callees_omitted)
    lines += _format_retrieved_section(retrieved_chunks or [])
    return "\n".join(lines)


def _format_example(ex: FewShotExample) -> str:
    import json

    return (
        f"Function source:\n{ex.fn_source}\n\n"
        f"Known callers: {json.dumps(ex.caller_names)}\n"
        f"Known callees: {json.dumps(ex.callee_names)}\n"
        f"Context bundle:\n{ex.context_bundle}\n\n"
        f"Reasoning: {ex.reasoning}\n\n"
        f"{json.dumps(ex.explanation, indent=2)}"
    )


def _format_input_slot(fn_source: str, caller_names: list[str], callee_names: list[str], context_bundle: str) -> str:
    import json

    return (
        f"Function source:\n{fn_source}\n\n"
        f"Known callers: {json.dumps(caller_names)}\n"
        f"Known callees: {json.dumps(callee_names)}\n"
        f"Context bundle:\n{context_bundle}\n\n"
        f"Reasoning:"
    )


def build_reasoning_prompt(fn_source: str, caller_names: list[str], callee_names: list[str], context_bundle: str) -> str:
    """Stage A: few-shot examples + real input slot, ending in 'Reasoning:' for free-text continuation."""
    examples = "\n\n---\n\n".join(_format_example(ex) for ex in FEW_SHOT_EXAMPLES)
    real_input = _format_input_slot(fn_source, caller_names, callee_names, context_bundle)
    return f"{examples}\n\n---\n\n{real_input}"


def build_json_prompt(
    fn_source: str, caller_names: list[str], callee_names: list[str], context_bundle: str, reasoning: str
) -> str:
    """Stage B: same input slot, now with the Stage A reasoning text filled in, asking for the schema-constrained JSON that follows it."""
    real_input = _format_input_slot(fn_source, caller_names, callee_names, context_bundle)
    return f"{real_input} {reasoning.strip()}\n\nJSON:"
