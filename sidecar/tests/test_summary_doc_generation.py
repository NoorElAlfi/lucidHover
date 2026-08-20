"""
Tests for the secondary summary-doc generator's one new sidecar surface
(Build Order step 15): the "generate_file_summary" RPC method and its
underlying `generate.generate_file_summary`/`prompt.build_file_summary_prompt`
helpers. No live Ollama involved -- `generate_text` is monkeypatched at the
generation-module level, same style as test_ollama_base_url_plumbing.py's
`rpc_server`-level monkeypatching.
"""

from __future__ import annotations

from sidecar import rpc_server
from sidecar.generation import generate as generate_module
from sidecar.generation.ollama_client import OLLAMA_BASE_URL
from sidecar.generation.prompt import build_file_summary_prompt


class _StubRepoMap:
    """Only the attribute `_handle_generate_file_summary` actually reads."""

    def __init__(self, ollama_base_url: str | None):
        self.ollama_base_url = ollama_base_url


def test_build_file_summary_prompt_includes_each_function_role_and_one_liner():
    prompt = build_file_summary_prompt(
        "utils/db.js",
        [
            {"name": "getOrder", "role_tag": "Persistence", "one_liner": "Fetches an order by id."},
            {"name": "updateOrder", "role_tag": "Persistence", "one_liner": "Writes order fields to the DB."},
        ],
    )
    assert "utils/db.js" in prompt
    assert "getOrder (Persistence): Fetches an order by id." in prompt
    assert "updateOrder (Persistence): Writes order fields to the DB." in prompt


def test_build_file_summary_prompt_handles_missing_role_or_one_liner():
    prompt = build_file_summary_prompt("a.js", [{"name": "mystery"}])
    assert "mystery (unknown role): no summary available" in prompt


def test_generate_file_summary_strips_and_returns_model_output(monkeypatch):
    captured: dict = {}

    def fake_generate_text(model, system, prompt, stop=None, base_url=OLLAMA_BASE_URL):
        captured["model"] = model
        captured["system"] = system
        captured["prompt"] = prompt
        captured["base_url"] = base_url
        return "  This file handles order persistence.  \n"

    monkeypatch.setattr(generate_module, "generate_text", fake_generate_text)

    summary = generate_module.generate_file_summary(
        "qwen2.5-coder:1.5b", "utils/db.js", [{"name": "getOrder", "role_tag": "Persistence", "one_liner": "x"}]
    )

    assert summary == "This file handles order persistence."
    assert captured["model"] == "qwen2.5-coder:1.5b"
    assert "utils/db.js" in captured["prompt"]
    assert captured["base_url"] == OLLAMA_BASE_URL


def test_handle_generate_file_summary_uses_custom_base_url(monkeypatch):
    captured: dict = {}

    def fake_generate_file_summary(model, file_path, functions, base_url):
        captured["base_url"] = base_url
        return "a summary"

    monkeypatch.setattr(rpc_server, "generate_file_summary", fake_generate_file_summary)

    repo_map = _StubRepoMap(ollama_base_url="http://localhost:9999")
    result = rpc_server._handle_generate_file_summary(
        repo_map, {"file_path": "a.js", "functions": [], "model_id": "m"}
    )

    assert captured["base_url"] == "http://localhost:9999"
    assert result == {"summary": "a summary"}


def test_handle_generate_file_summary_falls_back_to_default_when_unset(monkeypatch):
    captured: dict = {}

    def fake_generate_file_summary(model, file_path, functions, base_url):
        captured["base_url"] = base_url
        return "a summary"

    monkeypatch.setattr(rpc_server, "generate_file_summary", fake_generate_file_summary)

    repo_map = _StubRepoMap(ollama_base_url=None)
    rpc_server._handle_generate_file_summary(repo_map, {"file_path": "a.js", "functions": [], "model_id": "m"})

    assert captured["base_url"] == OLLAMA_BASE_URL


def test_handle_generate_file_summary_surfaces_ollama_error(monkeypatch):
    from sidecar.generation.ollama_client import OllamaError

    def fake_generate_file_summary(model, file_path, functions, base_url):
        raise OllamaError("Cannot reach Ollama")

    monkeypatch.setattr(rpc_server, "generate_file_summary", fake_generate_file_summary)

    repo_map = _StubRepoMap(ollama_base_url=None)
    try:
        rpc_server._handle_generate_file_summary(repo_map, {"file_path": "a.js", "functions": [], "model_id": "m"})
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "Cannot reach Ollama" in str(exc)


def test_generate_file_summary_is_registered_as_an_rpc_method():
    assert "generate_file_summary" in rpc_server._METHODS
