"""
Sidecar process entry point (Session 4): a newline-delimited JSON-RPC server
reachable over a local socket -- a Windows named pipe or a POSIX Unix domain
socket, per Core Design Decision #7 and the Architecture diagram.

Run as:
  python -m sidecar.rpc_server <pipe-or-socket-address> <workspace-root> \
      <storage-dir> <embedding-model-id>

`storage_dir` (Session 11) is where the LanceDB retrieval index lives
(`<storage_dir>/lancedb`) -- the extension host's `context.storageUri`,
workspace-scoped, passed at spawn time rather than discovered later so the
startup full-repo embedding pass (below) has somewhere to write before any
RPC request arrives. `embedding_model_id` is likewise spawn-time config, not
a per-request param like `model_id` -- the corpus embedding pass and every
later retrieval query must use the exact same embedding model, or nearest-
neighbor search would silently compare vectors from two different models;
single-sourcing it at spawn removes that drift risk entirely.

Methods:
  - "status": heartbeat, echoes {ok: true, pid}.
  - "index_file": runs the Session 3 repomap module (already indexed once at
    startup) over one file and returns every function's ranked caller/callee
    context. No LLM call -- that's Session 6+.
  - "generate_explanation" (Session 5 stub, Session 6 real, Session 11 adds
    the retrieval tier): resolves one function's ranked context, queries the
    retrieval index for top-k related chunks, computes context_hash/
    context_tier over both, and calls the bundled Ollama model
    (sidecar/generation/) to produce a schema-validated explanation JSON.
    `model_id` and `fn_source` are request params supplied by the extension
    host, not sidecar-owned constants -- see
    sidecar/generation/ollama_client.py's module docstring and session-06
    artifact. A retrieval-query failure (e.g. the embedding model isn't
    pulled) degrades to an empty retrieved-chunks list rather than failing
    the whole request -- retrieval is an additive context tier, not a
    generation-correctness requirement (see session-11 artifact).
  - "reindex_file" (Session 8, Session 11 adds re-embedding): re-parses one
    file and rebuilds the ranked call graph, in response to the extension
    host's debounced-save trigger, and also re-chunks/re-embeds that file's
    retrieval-index rows. No LLM call for the call-graph part -- the
    extension host does its own fn_hash hash-diff against the cache
    (Session 5's TS-side hashing) and only calls "generate_explanation" for
    functions whose hash actually changed.
  - "resolve_function" (Session 8 follow-up): given a bare function name,
    returns its real location (rel_fname/line) from the already-indexed
    repo, or `{"found": false}`. Used by the docked panel's click-to-navigate
    (used_by/calls links) as the primary lookup, ahead of VS Code's own
    `executeWorkspaceSymbolProvider` -- that built-in search only knows
    about files the JS/TS language service has already opened/indexed,
    while the sidecar's repomap already parsed the whole repo. No LLM call.
  - "list_ranked_functions" (Session 9): every def tag in the already-indexed
    repo, sorted by the existing PageRank `importance` score descending --
    reuses the same ranking `resolve_function`'s ambiguous-name tie-break
    already reads from, no second ranker. Backs the background
    pre-generation pass's walk order (most-likely-to-be-hovered functions
    first). No LLM call.

The extension host is the only client and connects/reconnects at most once
per process lifetime (a crashed sidecar is a whole new process, not a
reconnect), so a simple accept-one-then-loop-forever server is enough here.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
from dataclasses import asdict
from typing import Any

from .cache.hashing import CONTEXT_TIER_CALL_GRAPH_AND_RETRIEVAL, CONTEXT_TIER_CALL_GRAPH_ONLY, compute_context_hash
from .generation.generate import generate_explanation
from .generation.ollama_client import OllamaError
from .repomap.context import FunctionContext, RepoMap
from .retrieval.retrieve import RetrievedChunk, query_top_k, reindex_file_chunks, reindex_repo_chunks
from .retrieval.vectorstore import VectorStore

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:
    import pywintypes
    import win32file
    import win32pipe


def _log(message: str) -> None:
    # The JSON-RPC stream lives on the pipe/socket, not stdio, so stdout is
    # free to use for diagnostics -- the extension host captures and logs it.
    print(f"[sidecar] {message}", flush=True)


def _handle_status(_repo_map: RepoMap, _params: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "pid": os.getpid()}


def _handle_index_file(repo_map: RepoMap, params: dict[str, Any]) -> dict[str, Any]:
    rel_fname = params["file_path"]
    defs = [tag for tag in repo_map.tags_by_file.get(rel_fname, []) if tag.kind == "def"]

    functions = []
    for tag in defs:
        ctx = repo_map.get_function_context(rel_fname, tag.name, tag.start_line)
        functions.append(
            {
                "name": ctx.name,
                "line": ctx.line,
                "callers": [asdict(c) for c in ctx.callers],
                "callers_omitted": ctx.callers_omitted,
                "callees": [asdict(c) for c in ctx.callees],
                "callees_omitted": ctx.callees_omitted,
            }
        )
    return {"file_path": rel_fname, "functions": functions}


def _find_def_tag(repo_map: RepoMap, rel_fname: str, name: str, line: int):
    """
    Resolve (rel_fname, name, approx line) to the sidecar's own def tag.

    The caller (the extension host's hover provider) computes `line` from
    VS Code's built-in document-symbol provider, which does not always agree
    with tree-sitter's def span start line (e.g. `const foo = () => {}`
    arrow functions) -- matching on name within the file and picking the
    closest line, rather than requiring an exact line match, absorbs that
    drift without needing the two providers to agree exactly. See
    session-05 artifact for the full reasoning.
    """
    candidates = [
        tag
        for tag in repo_map.tags_by_file.get(rel_fname, [])
        if tag.kind == "def" and tag.name == name
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda tag: abs(tag.start_line - line))


def _query_retrieved_chunks(
    repo_map: RepoMap, fn_source: str, rel_fname: str, start_line: int, end_line: int
) -> list[RetrievedChunk]:
    """
    Best-effort retrieval query -- unlike the explanation-generation call
    below, a failure here (most likely: the embedding model isn't pulled
    yet) degrades to "no retrieved chunks" rather than failing the whole
    generate_explanation request. Retrieval is an additive context tier
    (Context Budget section); its absence is exactly what context_tier
    exists to record honestly, not a reason to block hover/save/refresh
    from working at all.
    """
    vector_store: VectorStore | None = getattr(repo_map, "vector_store", None)
    embedding_model_id: str | None = getattr(repo_map, "embedding_model_id", None)
    if vector_store is None or not embedding_model_id:
        return []
    try:
        return query_top_k(vector_store, embedding_model_id, fn_source, rel_fname, start_line, end_line)
    except OllamaError as exc:
        _log(f"retrieval query failed, continuing without retrieved chunks: {exc}")
        return []


def _handle_generate_explanation(repo_map: RepoMap, params: dict[str, Any]) -> dict[str, Any]:
    rel_fname = params["file_path"]
    name = params["name"]
    line = params["line"]
    fn_source = params["fn_source"]
    model_id = params["model_id"]

    tag = _find_def_tag(repo_map, rel_fname, name, line)
    if tag is not None:
        ctx = repo_map.get_function_context(rel_fname, tag.name, tag.start_line)
        span_start, span_end = tag.start_line, tag.end_line
    else:
        # Not resolvable in the ranked graph (e.g. a def shape the tree-sitter
        # query doesn't capture) -- degrade to an empty context rather than
        # erroring the whole hover; still proves the plumbing end-to-end.
        ctx = FunctionContext(rel_fname, name, line)
        span_start, span_end = line, line + 1

    retrieved_chunks = _query_retrieved_chunks(repo_map, fn_source, rel_fname, span_start, span_end)
    context_hash = compute_context_hash(ctx, retrieved_chunks)
    context_tier = CONTEXT_TIER_CALL_GRAPH_AND_RETRIEVAL if retrieved_chunks else CONTEXT_TIER_CALL_GRAPH_ONLY

    try:
        explanation = generate_explanation(model_id, fn_source, ctx, retrieved_chunks)
    except OllamaError as exc:
        # Per the session instructions: never silently stub or fall back on
        # a generation failure -- surface it as a clear JSON-RPC error so
        # the extension host can show the user an actionable message.
        raise RuntimeError(str(exc)) from exc

    return {
        "context_hash": context_hash,
        "context_tier": context_tier,
        "explanation": explanation,
    }


def _handle_reindex_file(repo_map: RepoMap, params: dict[str, Any]) -> dict[str, Any]:
    rel_fname = params["file_path"]
    functions_indexed = repo_map.reindex_file(rel_fname)

    vector_store: VectorStore | None = getattr(repo_map, "vector_store", None)
    embedding_model_id: str | None = getattr(repo_map, "embedding_model_id", None)
    if vector_store is not None and embedding_model_id:
        try:
            reindex_file_chunks(repo_map.root, rel_fname, vector_store, embedding_model_id)
        except OllamaError as exc:
            _log(f"re-embedding {rel_fname} failed, retrieval index left stale for this file: {exc}")

    return {"file_path": rel_fname, "functions_indexed": functions_indexed}


def _handle_resolve_function(repo_map: RepoMap, params: dict[str, Any]) -> dict[str, Any]:
    name = params["name"]
    candidates = [
        tag
        for tags in repo_map.tags_by_file.values()
        for tag in tags
        if tag.kind == "def" and tag.name == name
    ]
    if not candidates:
        return {"found": False}

    # Ambiguous names (the same name defined in more than one file) resolve
    # to the highest-PageRank-importance candidate -- same ranking already
    # used everywhere else in the codebase, and a reasonable tie-break for
    # "which one did the user probably mean" without building a real
    # disambiguation UI (out of scope for v0, same as _find_def_tag's
    # nearest-line matching in generate_explanation above).
    def _importance(tag) -> float:
        return repo_map.importance.get((tag.rel_fname, tag.name, tag.start_line), 0.0)

    best = max(candidates, key=_importance)
    return {"found": True, "rel_fname": best.rel_fname, "line": best.start_line}


def _handle_list_ranked_functions(repo_map: RepoMap, _params: dict[str, Any]) -> dict[str, Any]:
    def _importance(node) -> float:
        return repo_map.importance.get(node, 0.0)

    ranked = sorted(repo_map.list_functions(), key=_importance, reverse=True)
    functions = [
        {"rel_fname": rel_fname, "name": name, "line": line, "importance": _importance((rel_fname, name, line))}
        for rel_fname, name, line in ranked
    ]
    return {"functions": functions}


_METHODS = {
    "status": _handle_status,
    "index_file": _handle_index_file,
    "generate_explanation": _handle_generate_explanation,
    "reindex_file": _handle_reindex_file,
    "resolve_function": _handle_resolve_function,
    "list_ranked_functions": _handle_list_ranked_functions,
}


def _dispatch(repo_map: RepoMap, message: dict[str, Any]) -> dict[str, Any]:
    req_id = message.get("id")
    method = message.get("method")
    params = message.get("params") or {}

    handler = _METHODS.get(method)
    if handler is None:
        return {"id": req_id, "error": {"message": f"unknown method: {method}"}}

    try:
        result = handler(repo_map, params)
    except Exception as exc:
        # A malformed/unlucky single request must not take the whole sidecar
        # process down -- the pipe is a boundary with the extension host, and
        # the heartbeat (not an exception here) is what should trigger a
        # restart, only for a genuinely wedged or dead process.
        return {"id": req_id, "error": {"message": f"{type(exc).__name__}: {exc}"}}

    return {"id": req_id, "result": result}


def _process_lines(buf: bytes, repo_map: RepoMap, send_line) -> bytes:
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        if not line.strip():
            continue
        try:
            message = json.loads(line.decode("utf-8"))
        except json.JSONDecodeError as exc:
            send_line(json.dumps({"id": None, "error": {"message": f"invalid JSON: {exc}"}}))
            continue
        response = _dispatch(repo_map, message)
        send_line(json.dumps(response))
    return buf


def _serve_windows(address: str, repo_map: RepoMap) -> None:
    while True:
        pipe = win32pipe.CreateNamedPipe(
            address,
            win32pipe.PIPE_ACCESS_DUPLEX,
            win32pipe.PIPE_TYPE_BYTE | win32pipe.PIPE_READMODE_BYTE | win32pipe.PIPE_WAIT,
            1,
            65536,
            65536,
            0,
            None,
        )
        _log(f"listening on {address}")
        win32pipe.ConnectNamedPipe(pipe, None)
        _log("client connected")

        def send_line(text: str) -> None:
            win32file.WriteFile(pipe, text.encode("utf-8") + b"\n")

        buf = b""
        try:
            while True:
                hr, data = win32file.ReadFile(pipe, 65536)
                if not data:
                    break
                buf = _process_lines(buf + data, repo_map, send_line)
        except pywintypes.error as exc:
            _log(f"client disconnected ({exc.strerror})")
        finally:
            win32file.CloseHandle(pipe)


def _serve_posix(address: str, repo_map: RepoMap) -> None:
    if os.path.exists(address):
        os.unlink(address)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(address)
    server.listen(1)
    _log(f"listening on {address}")

    try:
        while True:
            conn, _ = server.accept()
            _log("client connected")

            def send_line(text: str) -> None:
                conn.sendall(text.encode("utf-8") + b"\n")

            buf = b""
            try:
                while True:
                    data = conn.recv(65536)
                    if not data:
                        break
                    buf = _process_lines(buf + data, repo_map, send_line)
            finally:
                conn.close()
                _log("client disconnected")
    finally:
        server.close()
        if os.path.exists(address):
            os.unlink(address)


def main() -> None:
    if len(sys.argv) != 5:
        print(
            "usage: python -m sidecar.rpc_server <pipe-or-socket-address> <workspace-root> "
            "<storage-dir> <embedding-model-id>",
            file=sys.stderr,
        )
        sys.exit(1)

    address, root, storage_dir, embedding_model_id = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

    _log(f"indexing {root} ...")
    repo_map = RepoMap(root)
    repo_map.index()
    _log(f"indexed {len(repo_map.list_functions())} functions")

    # Session 11: full-repo chunk + embed pass, once at startup. Runs on a
    # background thread, NOT inline here -- an earlier version blocked
    # `main()` on this before the socket/pipe was created at all, and live
    # VS Code testing showed that alone (even against the small fixture
    # repo: Ollama's cold model load + 16 sequential /api/embeddings calls)
    # already exceeded the extension host's 5s connect-retry budget
    # (`CONNECT_RETRY_ATTEMPTS` x `CONNECT_RETRY_DELAY_MS` in
    # sidecarManager.ts), which was calibrated for the old sub-second
    # tree-sitter-only startup cost -- the sidecar failed to start at all,
    # every time. `repo_map.vector_store` is created up front (empty, or
    # reopened from a prior run's on-disk LanceDB data) so `_serve_windows`/
    # `_serve_posix` can start accepting connections immediately; retrieval
    # queries against it degrade to `call_graph_only` (see
    # _query_retrieved_chunks) until the background pass finishes filling
    # it in. A failure here (e.g. the embedding model isn't pulled)
    # degrades the same way, permanently, until fixed and the sidecar
    # restarted -- it must never crash the sidecar or block generation.
    repo_map.vector_store = VectorStore(storage_dir)
    repo_map.embedding_model_id = embedding_model_id

    def _embed_repo_in_background() -> None:
        _log(f"embedding repo chunks (model={embedding_model_id}) ...")
        try:
            chunk_count = reindex_repo_chunks(root, repo_map.vector_store, embedding_model_id)
            _log(f"embedded {chunk_count} chunks")
        except OllamaError as exc:
            _log(f"initial embedding pass failed, retrieval tier stays empty until fixed: {exc}")

    threading.Thread(target=_embed_repo_in_background, daemon=True).start()

    if IS_WINDOWS:
        _serve_windows(address, repo_map)
    else:
        _serve_posix(address, repo_map)


if __name__ == "__main__":
    main()
