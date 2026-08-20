"""
Tests for sidecar/generation/ollama_client.py's `_post` exception handling.

Regression test for a bug found during session-11 live testing: `HTTPError`
is a subclass of `URLError`, so an `except URLError` clause placed before
`except HTTPError` swallows every HTTP error response (4xx/5xx) and reports
the generic "Cannot reach Ollama... Is Ollama running?" message, masking the
specific "Run: ollama pull <model>" guidance the HTTPError branch is meant
to give. A real "input length exceeds the context length" error from
Ollama's /api/embeddings endpoint was misreported this way; only found via
a direct curl call bypassing this client. See
.claude/sessions/session-11-embeddings-retrieval.md.
"""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

from sidecar.generation.ollama_client import OllamaError, _post


def _http_error(code: int, body: dict) -> urllib.error.HTTPError:
    payload = json.dumps(body).encode("utf-8")
    return urllib.error.HTTPError(
        url="http://localhost:11434/api/generate",
        code=code,
        msg="error",
        hdrs=None,
        fp=io.BytesIO(payload),
    )


def test_model_not_found_gives_pull_guidance(monkeypatch):
    def fake_urlopen(*args, **kwargs):
        raise _http_error(404, {"error": "model 'missing-model' not found"})

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    with pytest.raises(OllamaError, match=r"Run: ollama pull missing-model"):
        _post("/api/generate", {"model": "missing-model", "prompt": "hi"})


def test_other_http_error_gives_specific_status_not_generic_unreachable(monkeypatch):
    def fake_urlopen(*args, **kwargs):
        raise _http_error(400, {"error": "input length exceeds the context length"})

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    with pytest.raises(OllamaError) as exc_info:
        _post("/api/embeddings", {"model": "some-model", "prompt": "hi"})

    message = str(exc_info.value)
    assert "input length exceeds the context length" in message
    assert "Is Ollama running?" not in message


def test_connection_failure_gives_unreachable_message(monkeypatch):
    def fake_urlopen(*args, **kwargs):
        raise urllib.error.URLError("Connection refused")

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    with pytest.raises(OllamaError, match="Is Ollama running?"):
        _post("/api/generate", {"model": "some-model", "prompt": "hi"})
