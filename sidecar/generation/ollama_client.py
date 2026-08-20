"""
Thin client for Ollama's local HTTP API (Session 6).

Ollama-as-interface decision: the spec's Tech Stack table calls the bundled
model a "local llama.cpp/GGUF runtime" without pinning an interface, while
every other tier (custom Ollama endpoint, Ollama Cloud discussion) already
assumes Ollama. Using Ollama's local HTTP API (http://localhost:11434) for
the bundled model too means `generate()` is the exact same
`generate(prompt, temperature=0) -> text` shape for both the bundled and
future custom-endpoint tiers -- only the model name param differs -- per
the spec's explicit requirement, and avoids building/maintaining a second,
separate GGUF-loading code path. Uses Python's stdlib `urllib` -- no new
dependency for a single local POST. See session-06 artifact.

Per the session instructions: if Ollama can't be reached, or the model
isn't available, this fails loudly with a clear, actionable message. It
never silently stubs or falls back.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

OLLAMA_BASE_URL = "http://localhost:11434"
_TIMEOUT_SECONDS = 120


class OllamaError(RuntimeError):
    """Raised when Ollama can't be reached, or the requested model isn't available."""


def _post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    url = f"{OLLAMA_BASE_URL}{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        message = body
        try:
            message = json.loads(body).get("error", body)
        except json.JSONDecodeError:
            pass
        if "not found" in message.lower():
            model = payload.get("model", "<model>")
            raise OllamaError(
                f"Ollama model '{model}' is not available ({message}). "
                f"Run: ollama pull {model}"
            ) from exc
        raise OllamaError(f"Ollama request to {path} failed ({exc.code}): {message}") from exc
    except urllib.error.URLError as exc:
        raise OllamaError(
            f"Cannot reach Ollama at {OLLAMA_BASE_URL} ({exc.reason}). "
            f"Is Ollama running? Start it, then retry (e.g. `ollama serve`, "
            f"or launch the Ollama app)."
        ) from exc


def generate_text(model: str, system: str, prompt: str, stop: list[str] | None = None) -> str:
    """Unconstrained free-text completion, temperature=0. Used for the Stage A reasoning pass."""
    payload: dict[str, Any] = {
        "model": model,
        "system": system,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0},
    }
    if stop:
        payload["options"]["stop"] = stop
    result = _post("/api/generate", payload)
    return result.get("response", "")


def embed(model: str, text: str) -> list[float]:
    """
    Embedding vector for one chunk of text, via Ollama's `/api/embeddings`
    (Session 11) -- the same local HTTP interface `generate_text`/
    `generate_structured` already use, per the decision to reuse Ollama as
    the embedding runtime rather than add a second local-model runtime
    (sentence-transformers, fastembed, etc.). No `temperature`/`stop`
    options -- embeddings aren't a sampling process.
    """
    result = _post("/api/embeddings", {"model": model, "prompt": text})
    embedding = result.get("embedding")
    if not isinstance(embedding, list):
        raise OllamaError(f"Ollama returned no embedding for model '{model}': {result!r}")
    return embedding


def generate_structured(model: str, system: str, prompt: str, schema: dict[str, Any]) -> dict[str, Any]:
    """
    Schema-constrained completion, temperature=0, via Ollama's `format`
    param (grammar-constrained decoding) -- structured-output mode, not
    prose-instructed formatting, per the spec's explicit requirement.
    """
    payload: dict[str, Any] = {
        "model": model,
        "system": system,
        "prompt": prompt,
        "format": schema,
        "stream": False,
        "options": {"temperature": 0},
    }
    result = _post("/api/generate", payload)
    response_text = result.get("response", "")
    try:
        return json.loads(response_text)
    except json.JSONDecodeError as exc:
        raise OllamaError(
            f"Ollama returned non-JSON output for schema-constrained generation "
            f"despite `format` being set: {response_text!r}"
        ) from exc
