"""
Tests for the custom-Ollama-endpoint tier's spawn-time plumbing (Build Order
step 14): `repo_map.ollama_base_url` (set once in `rpc_server.main()`, same
pattern as `embedding_model_id`) must actually reach the real Ollama-calling
functions -- `generate_explanation` (via `_handle_generate_explanation`) and
`query_top_k` (via `_query_retrieved_chunks`) -- rather than silently falling
back to the hardcoded `OLLAMA_BASE_URL` default whenever a custom endpoint is
configured. No live Ollama involved: `generate_explanation`/`query_top_k` are
monkeypatched at the rpc_server module level, same style as
test_rpc_server.py's existing repo_map fixture.
"""

from __future__ import annotations

from sidecar import rpc_server
from sidecar.generation.ollama_client import OLLAMA_BASE_URL
from sidecar.repomap.context import RepoMap


class _StubRepoMap:
    """Minimal stand-in -- only the attributes `_handle_generate_explanation`
    and `_query_retrieved_chunks` actually read."""

    def __init__(self, ollama_base_url: str | None):
        self.ollama_base_url = ollama_base_url
        self.tags_by_file: dict = {}
        self.vector_store = None
        self.embedding_model_id = None

    def get_function_context(self, rel_fname, name, line):
        from sidecar.repomap.context import FunctionContext

        return FunctionContext(rel_fname, name, line)


def test_generate_explanation_uses_custom_base_url(monkeypatch):
    captured: dict = {}

    def fake_generate_explanation(model, fn_source, ctx, retrieved_chunks, base_url):
        captured["base_url"] = base_url
        return {"role_tag": "Utility"}

    monkeypatch.setattr(rpc_server, "generate_explanation", fake_generate_explanation)

    repo_map = _StubRepoMap(ollama_base_url="http://localhost:9999")
    rpc_server._handle_generate_explanation(
        repo_map, {"file_path": "a.js", "name": "target", "line": 0, "fn_source": "function target() {}", "model_id": "m"}
    )

    assert captured["base_url"] == "http://localhost:9999"


def test_generate_explanation_falls_back_to_default_when_unset(monkeypatch):
    captured: dict = {}

    def fake_generate_explanation(model, fn_source, ctx, retrieved_chunks, base_url):
        captured["base_url"] = base_url
        return {"role_tag": "Utility"}

    monkeypatch.setattr(rpc_server, "generate_explanation", fake_generate_explanation)

    repo_map = _StubRepoMap(ollama_base_url=None)
    rpc_server._handle_generate_explanation(
        repo_map, {"file_path": "a.js", "name": "target", "line": 0, "fn_source": "function target() {}", "model_id": "m"}
    )

    assert captured["base_url"] == OLLAMA_BASE_URL


def test_query_retrieved_chunks_uses_custom_base_url(monkeypatch):
    captured: dict = {}

    def fake_query_top_k(store, embed_model, fn_source, rel_fname, start_line, end_line, base_url):
        captured["base_url"] = base_url
        return []

    monkeypatch.setattr(rpc_server, "query_top_k", fake_query_top_k)

    repo_map = _StubRepoMap(ollama_base_url="http://localhost:9999")
    repo_map.vector_store = object()
    repo_map.embedding_model_id = "all-minilm"

    rpc_server._query_retrieved_chunks(repo_map, "function target() {}", "a.js", 0, 1)

    assert captured["base_url"] == "http://localhost:9999"


def test_main_argv_parsing_requires_six_args(monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["sidecar.rpc_server", "addr", "root", "storage", "all-minilm"])

    exited = {}

    def fake_exit(code):
        exited["code"] = code
        raise SystemExit(code)

    monkeypatch.setattr("sys.exit", fake_exit)

    try:
        rpc_server.main()
    except SystemExit:
        pass

    assert exited.get("code") == 1
    assert "ollama-base-url" in capsys.readouterr().err
