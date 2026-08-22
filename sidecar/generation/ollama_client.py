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

`OLLAMA_BASE_URL` is still the default host every function falls back to,
but each of `generate_text`/`embed`/`generate_structured` (and `_post`)
now also accepts an optional `base_url` override (Build Order step 14: the
custom-Ollama-endpoint tier) -- the extension host resolves and validates
the real value (`lucidHover.ollamaEndpoint`, loopback-only per Core Rule 1)
and passes it down from `rpc_server.py`'s spawn-time arg; nothing here
re-validates it, this module just dials whatever host it's given.
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


def _post(path: str, payload: dict[str, Any], base_url: str = OLLAMA_BASE_URL) -> dict[str, Any]:
    url = f"{base_url}{path}"
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
            f"Cannot reach Ollama at {base_url} ({exc.reason}). "
            f"Is Ollama running? Start it, then retry (e.g. `ollama serve`, "
            f"or launch the Ollama app)."
        ) from exc


def generate_text(
    model: str, system: str, prompt: str, stop: list[str] | None = None, base_url: str = OLLAMA_BASE_URL
) -> str:
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
    result = _post("/api/generate", payload, base_url)
    return result.get("response", "")


def embed(model: str, text: str, base_url: str = OLLAMA_BASE_URL) -> list[float]:
    """
    Embedding vector for one chunk of text, via Ollama's `/api/embeddings`
    (Session 11) -- the same local HTTP interface `generate_text`/
    `generate_structured` already use, per the decision to reuse Ollama as
    the embedding runtime rather than add a second local-model runtime
    (sentence-transformers, fastembed, etc.). No `temperature`/`stop`
    options -- embeddings aren't a sampling process.

    Kept alongside `embed_batch` below for the retrieval tier's single-text
    query-side call (`retrieve.py::query_top_k`, one query vector per hover-
    triggered retrieval -- no batching opportunity there). Deliberately still
    uses the older `/api/embeddings` endpoint, not `/api/embed`: session 33
    confirmed live that `/api/embeddings` raises a real, catchable error
    ("the input length exceeds the context length") on context-window
    overflow, which some caller might still want to catch -- `/api/embed`
    does not (see `embed_batch`'s docstring).
    """
    result = _post("/api/embeddings", {"model": model, "prompt": text}, base_url)
    embedding = result.get("embedding")
    if not isinstance(embedding, list):
        raise OllamaError(f"Ollama returned no embedding for model '{model}': {result!r}")
    return embedding


def embed_batch(model: str, texts: list[str], base_url: str = OLLAMA_BASE_URL) -> list[list[float]]:
    """
    Embedding vectors for multiple chunks of text in one HTTP round trip, via
    Ollama's newer `/api/embed` endpoint (`input` accepts a list of strings
    and returns one embedding per input, in order).

    Added session 33 (indexing/caching efficiency audit): the full-repo and
    per-file corpus-embedding passes (`retrieve.py::_rows_for`) previously
    called `embed()` once per chunk, strictly sequentially -- confirmed live
    against the real running `all-minilm` at ~2.08s/chunk (20 sequential
    `/api/embeddings` calls, dominated by Ollama's per-request model-load/
    dispatch overhead, not the actual embedding compute). The same 20 texts
    embedded as one `/api/embed` call took 2.34s total (~0.12s/chunk) -- a
    real, measured 17.8x throughput improvement, with no change to what gets
    embedded, only how many HTTP round trips it costs.

    Correctness caveat, also confirmed live and the reason this is a
    separate function rather than a drop-in replacement for `embed` in every
    caller: `/api/embed` does NOT raise on context-window overflow the way
    `/api/embeddings` does. A single absurdly long input (>>256 tokens) sent
    through `/api/embed` returns HTTP 200 with a (silently truncated, so
    semantically incomplete) embedding instead of Ollama's usual
    `{"error": "the input length exceeds the context length"}`. This means
    `embed_batch` cannot support the kind of per-item "skip just this one
    failing item" handling `_rows_for` used to do around single-item
    `embed()` calls (session 31) -- there is no per-item failure signal to
    catch. This is judged safe for `_rows_for`'s actual real inputs: every
    chunk it embeds is already guaranteed by `chunking.py` to be at or under
    `CHUNK_MAX_CHARS` (500 chars), which session 31 confirmed empirically
    sits with real margin below the real overflow boundary (759+ chars) --
    0 of 1243 real post-fix pokerogue chunks overflowed. A genuine overflow
    reaching this function would now be silently truncated-and-embedded
    rather than skipped-with-a-chunk-count-decrement; still strictly better
    than the pre-session-31 failure mode (one bad chunk discarding an entire
    pass), just less precise than session 31's per-chunk skip. `embed`
    (single-item) is kept unchanged and still used by `query_top_k`'s
    one-off query-side call, which has no batching opportunity anyway.
    """
    if not texts:
        return []
    result = _post("/api/embed", {"model": model, "input": texts}, base_url)
    embeddings = result.get("embeddings")
    if not isinstance(embeddings, list) or len(embeddings) != len(texts):
        raise OllamaError(f"Ollama returned {len(embeddings) if isinstance(embeddings, list) else 'no'} embeddings for {len(texts)} inputs, model '{model}': {result!r}")
    return embeddings


def generate_structured(
    model: str, system: str, prompt: str, schema: dict[str, Any], base_url: str = OLLAMA_BASE_URL
) -> dict[str, Any]:
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
    result = _post("/api/generate", payload, base_url)
    response_text = result.get("response", "")
    try:
        return json.loads(response_text)
    except json.JSONDecodeError as exc:
        raise OllamaError(
            f"Ollama returned non-JSON output for schema-constrained generation "
            f"despite `format` being set: {response_text!r}"
        ) from exc
