"""
Tests for the call-graph-clustered rollup summary's one new sidecar surface
(Session 68): the "generate_cluster_summary" RPC method and its underlying
`generate.generate_cluster_summary`/`prompt.build_cluster_summary_prompt`
helpers. Mirrors test_summary_doc_generation.py's structure exactly -- no
live Ollama involved, `generate_text` is monkeypatched at the
generation-module level.
"""

from __future__ import annotations

from sidecar import rpc_server
from sidecar.generation import generate as generate_module
from sidecar.generation.ollama_client import OLLAMA_BASE_URL
from sidecar.generation.prompt import build_cluster_summary_prompt


class _StubRepoMap:
    """Only the attribute `_handle_generate_cluster_summary` actually reads."""

    def __init__(self, ollama_base_url: str | None):
        self.ollama_base_url = ollama_base_url


def test_build_cluster_summary_prompt_includes_root_and_callers():
    prompt = build_cluster_summary_prompt(
        "processRefund",
        "Handler",
        "Issues a refund for an order.",
        [
            {"name": "adminRefundRoute", "role_tag": "Handler", "one_liner": "Admin refund endpoint.", "depth": 1},
            {"name": "chargebackWebhook", "role_tag": "Handler", "one_liner": "Stripe webhook handler.", "depth": 1},
        ],
    )
    assert "Root function: processRefund" in prompt
    assert "(Handler): Issues a refund for an order." in prompt
    assert "adminRefundRoute (depth 1, Handler): Admin refund endpoint." in prompt
    assert "chargebackWebhook (depth 1, Handler): Stripe webhook handler." in prompt


def test_build_cluster_summary_prompt_handles_uncached_root_and_no_callers():
    prompt = build_cluster_summary_prompt("mystery", None, None, [])
    assert "Root function: mystery" in prompt
    assert "(not yet indexed)" in prompt
    assert "none" in prompt


def test_generate_cluster_summary_strips_and_returns_model_output(monkeypatch):
    captured: dict = {}

    def fake_generate_text(model, system, prompt, stop=None, base_url=OLLAMA_BASE_URL):
        captured["model"] = model
        captured["system"] = system
        captured["prompt"] = prompt
        captured["base_url"] = base_url
        return "  Coordinates refund issuance across two entry points.  \n"

    monkeypatch.setattr(generate_module, "generate_text", fake_generate_text)

    summary = generate_module.generate_cluster_summary(
        "qwen2.5-coder:1.5b",
        "processRefund",
        "Handler",
        "Issues a refund.",
        [{"name": "adminRefundRoute", "role_tag": "Handler", "one_liner": "x", "depth": 1}],
    )

    assert summary == "Coordinates refund issuance across two entry points."
    assert captured["model"] == "qwen2.5-coder:1.5b"
    assert "processRefund" in captured["prompt"]
    assert captured["base_url"] == OLLAMA_BASE_URL


def test_handle_generate_cluster_summary_uses_custom_base_url(monkeypatch):
    captured: dict = {}

    def fake_generate_cluster_summary(model, root_name, root_role, root_one_liner, callers, base_url):
        captured["base_url"] = base_url
        return "a summary"

    monkeypatch.setattr(rpc_server, "generate_cluster_summary", fake_generate_cluster_summary)

    repo_map = _StubRepoMap(ollama_base_url="http://localhost:9999")
    result = rpc_server._handle_generate_cluster_summary(
        repo_map,
        {"root_name": "processRefund", "root_role": "Handler", "root_one_liner": "x", "callers": [], "model_id": "m"},
    )

    assert captured["base_url"] == "http://localhost:9999"
    assert result == {"summary": "a summary"}


def test_handle_generate_cluster_summary_falls_back_to_default_when_unset(monkeypatch):
    captured: dict = {}

    def fake_generate_cluster_summary(model, root_name, root_role, root_one_liner, callers, base_url):
        captured["base_url"] = base_url
        return "a summary"

    monkeypatch.setattr(rpc_server, "generate_cluster_summary", fake_generate_cluster_summary)

    repo_map = _StubRepoMap(ollama_base_url=None)
    rpc_server._handle_generate_cluster_summary(
        repo_map,
        {"root_name": "processRefund", "root_role": None, "root_one_liner": None, "callers": [], "model_id": "m"},
    )

    assert captured["base_url"] == OLLAMA_BASE_URL


def test_handle_generate_cluster_summary_surfaces_ollama_error(monkeypatch):
    from sidecar.generation.ollama_client import OllamaError

    def fake_generate_cluster_summary(model, root_name, root_role, root_one_liner, callers, base_url):
        raise OllamaError("Cannot reach Ollama")

    monkeypatch.setattr(rpc_server, "generate_cluster_summary", fake_generate_cluster_summary)

    repo_map = _StubRepoMap(ollama_base_url=None)
    try:
        rpc_server._handle_generate_cluster_summary(
            repo_map,
            {"root_name": "processRefund", "root_role": None, "root_one_liner": None, "callers": [], "model_id": "m"},
        )
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "Cannot reach Ollama" in str(exc)


def test_generate_cluster_summary_is_registered_as_an_rpc_method():
    assert "generate_cluster_summary" in rpc_server._METHODS
