"""
Sidecar process entry point (Session 4): a newline-delimited JSON-RPC server
reachable over a local socket -- a Windows named pipe or a POSIX Unix domain
socket, per Core Design Decision #7 and the Architecture diagram.

Run as:
  python -m sidecar.rpc_server <pipe-or-socket-address> <workspace-root> \
      <storage-dir> <embedding-model-id> <ollama-base-url>

`storage_dir` (Session 11) is where the LanceDB retrieval index lives
(`<storage_dir>/lancedb`) -- the extension host's `context.storageUri`,
workspace-scoped, passed at spawn time rather than discovered later so the
startup full-repo embedding pass (below) has somewhere to write before any
RPC request arrives. `embedding_model_id` is likewise spawn-time config, not
a per-request param like `model_id` -- the corpus embedding pass and every
later retrieval query must use the exact same embedding model, or nearest-
neighbor search would silently compare vectors from two different models;
single-sourcing it at spawn removes that drift risk entirely.

`ollama_base_url` (Build Order step 14, custom local Ollama endpoint tier)
is spawn-time for the same reason as `embedding_model_id`: the startup
embedding pass needs it before any RPC request could otherwise deliver one,
and generation + embeddings must hit the same Ollama daemon (mismatched
daemons could have different models pulled). The extension host resolves
and validates it (`lucidHover.ollamaEndpoint`, loopback-only per Core Rule
1) before ever passing it here -- this module trusts the value it's given.

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
    artifact. The Ollama host itself (`ollama_base_url`) is read from
    `repo_map.ollama_base_url`, the spawn-time value set in `main()` below,
    not a request param -- see this module's own docstring for why. A
    retrieval-query failure (e.g. the embedding model isn't pulled)
    degrades to an empty retrieved-chunks list rather than failing the
    whole request -- retrieval is an additive context tier, not a
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
  - "get_blast_radius" (Session 45): given a function's location, returns a
    transitive-upstream-caller graph (who calls this, transitively, up to a
    hardcoded depth) -- confident-edges-only, same filter
    `get_function_context`'s single-hop callers already applies (Session 44).
    Plain graph facts only (rel_fname/name/line/importance per node, edges as
    caller/callee pairs); no cache lookups, no role_tag/one_liner -- the
    extension host enriches from its own `ExplanationCache` afterward (Core
    Rule 9). No LLM call.
  - "get_call_trace" (Session 46): given a function's location, returns a
    downstream single-primary-path call chain (what this calls, transitively,
    following only the highest-importance confident callee at each hop, up to
    a hardcoded depth) -- the mirror image of "get_blast_radius", same
    confident-edges-only filter (Session 44). Plain graph facts only
    (rel_fname/name/line/importance per node, edges as caller/callee pairs);
    no cache lookups, no role_tag/one_liner -- the extension host enriches
    from its own `ExplanationCache` afterward (Core Rule 9). No LLM call.
    Session 48 adds `branches`: the non-primary confident callees passed
    over at each hop (capped the same way `get_blast_radius`'s fan-out is,
    session 47), so the primary path no longer silently swallows every
    other real downstream call.
  - "generate_file_summary" (Session 15 / Build Order step 15, secondary
    summary-doc generator): given a file path and the already-generated
    role_tag/one_liner for each of its functions (the extension host reads
    these from its own `ExplanationCache`, not read here), returns one short
    prose purpose paragraph for the file. The one new LLM call the
    summary-doc generator needs -- everything else in that feature is a
    template pass over data the cache already has. Same `ollama_base_url`
    resolution as "generate_explanation" above.

The extension host is the only client and connects/reconnects at most once
per process lifetime (a crashed sidecar is a whole new process, not a
reconnect), so a simple accept-one-then-loop-forever server is enough here.

Dispatch concurrency (Session 37): each request line is handed to a worker
thread from a shared `ThreadPoolExecutor` (`_dispatch_worker`) instead of
being processed inline before the next line is even read. Previously, a
slow in-flight handler (most commonly `generate_explanation`'s Ollama call,
up to `_TIMEOUT_SECONDS`) blocked the single read loop from consuming the
next line at all -- an interactive request sent while a background request
was already being processed sat unread in the socket/pipe buffer until the
background handler returned, confirmed live by session 36's own
measurement (+2,742ms of pure added queueing delay on top of the
interactive request's own round trip). Reading continues immediately now,
so a subsequent request starts its own handler (and, for `generate_explanation`
/`generate_file_summary`, its own Ollama call) without waiting on an
unrelated in-flight one. Responses carry the original request `id` and are
already matched by id, not by arrival order, on the extension-host side
(`SidecarManager.handleMessage`) -- out-of-order responses were already a
supported case before this change, not a new requirement introduced by it.
`RepoMap`'s mutable state (`tags_by_file`/`graph`/`importance`) is the one
thing this concurrency makes newly unsafe -- see `sidecar/concurrency.py`
and `RepoMap.lock`'s own comment for the readers-writer lock that protects
it. `VectorStore` already had its own lock (session 11). Worker threads
never touch the pipe/socket at all, though: they only push their finished
response onto a `queue.Queue`, and `_serve_windows`/`_serve_posix`'s own
single main thread is the only thing that ever calls `send_line`, in a
short poll loop (`_POLL_INTERVAL_S`) that alternates draining that queue
with a non-blocking check for new input (`PeekNamedPipe` on Windows, a
short `recv` timeout on POSIX). An earlier version of this fix had worker
threads call `send_line` directly under a shared lock instead -- a live
repro against a real spawned sidecar showed that deadlocks outright on
Windows (confirmed in isolation too): a worker thread's `WriteFile` racing
the main thread's blocking `ReadFile` on the *same* named-pipe handle never
returns, not occasionally, every time. The poll loop sidesteps the question
entirely by keeping the pipe/socket touched by exactly one thread, always.
Priority (the extension host's client-side `interactive`/`background` scheduling hint
from sessions 32/36) still never reaches this module -- this fix is
priority-agnostic: it works by making the dispatch loop generically
concurrent, not by reading or acting on which caller considers itself more
important. Whether Ollama itself can usefully run two generations
concurrently, rather than queueing the second behind the first internally,
is outside this module's control and was live-measured for this session's
artifact rather than assumed.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import queue
import socket
import sys
import threading
import time
from dataclasses import asdict
from typing import Any

from .cache.hashing import CONTEXT_TIER_CALL_GRAPH_AND_RETRIEVAL, CONTEXT_TIER_CALL_GRAPH_ONLY, compute_context_hash
from .generation.generate import generate_explanation, generate_file_summary
from .generation.ollama_client import OLLAMA_BASE_URL, OllamaError
from .repomap.context import BlastRadius, CallTrace, FunctionContext, RepoMap
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
    with repo_map.lock.read_lock():
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
    base_url = getattr(repo_map, "ollama_base_url", None) or OLLAMA_BASE_URL
    if vector_store is None or not embedding_model_id:
        return []
    try:
        return query_top_k(vector_store, embedding_model_id, fn_source, rel_fname, start_line, end_line, base_url)
    except OllamaError as exc:
        _log(f"retrieval query failed, continuing without retrieved chunks: {exc}")
        return []


def _handle_generate_explanation(repo_map: RepoMap, params: dict[str, Any]) -> dict[str, Any]:
    rel_fname = params["file_path"]
    name = params["name"]
    line = params["line"]
    fn_source = params["fn_source"]
    model_id = params["model_id"]

    with repo_map.lock.read_lock():
        tag = _find_def_tag(repo_map, rel_fname, name, line)
        if tag is not None:
            ctx = repo_map.get_function_context(rel_fname, tag.name, tag.start_line)
            span_start, span_end = tag.start_line, tag.end_line
        else:
            # Not resolvable in the ranked graph (e.g. a def shape the
            # tree-sitter query doesn't capture) -- degrade to an empty
            # context rather than erroring the whole hover; still proves the
            # plumbing end-to-end.
            ctx = FunctionContext(rel_fname, name, line)
            span_start, span_end = line, line + 1

    retrieved_chunks = _query_retrieved_chunks(repo_map, fn_source, rel_fname, span_start, span_end)
    context_hash = compute_context_hash(ctx, retrieved_chunks)
    context_tier = CONTEXT_TIER_CALL_GRAPH_AND_RETRIEVAL if retrieved_chunks else CONTEXT_TIER_CALL_GRAPH_ONLY

    base_url = getattr(repo_map, "ollama_base_url", None) or OLLAMA_BASE_URL
    try:
        explanation = generate_explanation(model_id, fn_source, ctx, retrieved_chunks, base_url)
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
    with repo_map.lock.write_lock():
        functions_indexed = repo_map.reindex_file(rel_fname)

    vector_store: VectorStore | None = getattr(repo_map, "vector_store", None)
    embedding_model_id: str | None = getattr(repo_map, "embedding_model_id", None)
    base_url = getattr(repo_map, "ollama_base_url", None) or OLLAMA_BASE_URL
    if vector_store is not None and embedding_model_id:
        try:
            reindex_file_chunks(repo_map.root, rel_fname, vector_store, embedding_model_id, base_url)
        except OllamaError as exc:
            _log(f"re-embedding {rel_fname} failed, retrieval index left stale for this file: {exc}")

    return {"file_path": rel_fname, "functions_indexed": functions_indexed}


def _handle_resolve_function(repo_map: RepoMap, params: dict[str, Any]) -> dict[str, Any]:
    name = params["name"]
    with repo_map.lock.read_lock():
        candidates = [
            tag
            for tags in repo_map.tags_by_file.values()
            for tag in tags
            if tag.kind == "def" and tag.name == name
        ]
        if not candidates:
            return {"found": False}

        # Ambiguous names (the same name defined in more than one file)
        # resolve to the highest-PageRank-importance candidate -- same
        # ranking already used everywhere else in the codebase, and a
        # reasonable tie-break for "which one did the user probably mean"
        # without building a real disambiguation UI (out of scope for v0,
        # same as _find_def_tag's nearest-line matching in
        # generate_explanation above).
        def _importance(tag) -> float:
            return repo_map.importance.get((tag.rel_fname, tag.name, tag.start_line), 0.0)

        best = max(candidates, key=_importance)
        return {"found": True, "rel_fname": best.rel_fname, "line": best.start_line}


def _handle_list_ranked_functions(repo_map: RepoMap, _params: dict[str, Any]) -> dict[str, Any]:
    def _importance(node) -> float:
        return repo_map.importance.get(node, 0.0)

    with repo_map.lock.read_lock():
        ranked = sorted(repo_map.list_functions(), key=_importance, reverse=True)
        functions = [
            {"rel_fname": rel_fname, "name": name, "line": line, "importance": _importance((rel_fname, name, line))}
            for rel_fname, name, line in ranked
        ]
    return {"functions": functions}


def _handle_get_blast_radius(repo_map: RepoMap, params: dict[str, Any]) -> dict[str, Any]:
    rel_fname = params["file_path"]
    name = params["name"]
    line = params["line"]
    with repo_map.lock.read_lock():
        # Same nearest-line resolution as `_handle_generate_explanation`
        # above -- `line` comes from VS Code's document-symbol provider,
        # which doesn't always agree with tree-sitter's def line (see
        # `_find_def_tag`'s own doc comment).
        tag = _find_def_tag(repo_map, rel_fname, name, line)
        if tag is not None:
            blast = repo_map.get_blast_radius(rel_fname, tag.name, tag.start_line)
        else:
            blast = BlastRadius(rel_fname=rel_fname, name=name, line=line)
    return asdict(blast)


def _handle_get_call_trace(repo_map: RepoMap, params: dict[str, Any]) -> dict[str, Any]:
    rel_fname = params["file_path"]
    name = params["name"]
    line = params["line"]
    with repo_map.lock.read_lock():
        # Same nearest-line resolution as `_handle_generate_explanation`/
        # `_handle_get_blast_radius` above -- see `_find_def_tag`'s own doc
        # comment.
        tag = _find_def_tag(repo_map, rel_fname, name, line)
        if tag is not None:
            trace = repo_map.get_call_trace(rel_fname, tag.name, tag.start_line)
        else:
            trace = CallTrace(rel_fname=rel_fname, name=name, line=line)
    return asdict(trace)


def _handle_generate_file_summary(repo_map: RepoMap, params: dict[str, Any]) -> dict[str, Any]:
    file_path = params["file_path"]
    functions = params["functions"]
    model_id = params["model_id"]

    base_url = getattr(repo_map, "ollama_base_url", None) or OLLAMA_BASE_URL
    try:
        summary = generate_file_summary(model_id, file_path, functions, base_url)
    except OllamaError as exc:
        # Same "never silently stub or fall back" rule as
        # _handle_generate_explanation -- the extension host decides how to
        # degrade a single failed page (see summaryDocGenerator.ts), this
        # just surfaces the real error.
        raise RuntimeError(str(exc)) from exc

    return {"summary": summary}


_METHODS = {
    "status": _handle_status,
    "index_file": _handle_index_file,
    "generate_explanation": _handle_generate_explanation,
    "reindex_file": _handle_reindex_file,
    "resolve_function": _handle_resolve_function,
    "list_ranked_functions": _handle_list_ranked_functions,
    "get_blast_radius": _handle_get_blast_radius,
    "get_call_trace": _handle_get_call_trace,
    "generate_file_summary": _handle_generate_file_summary,
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


# Generous cap, not a tuned tuning knob: the real limiting factor on how
# much this actually parallelizes is Ollama's own concurrency (or lack of
# it), which this module has no control over -- see the module docstring's
# "Dispatch concurrency" section. 8 comfortably covers this process's real
# concurrent-request ceiling (one interactive request plus a small number
# of autonomous background loops, per Core Rule 11's callers) with room to
# spare, without spawning threads without bound.
_MAX_WORKERS = 8

# How often the single I/O-owning thread (see `_serve_windows`/`_serve_posix`)
# checks for newly-arrived input and drains any responses workers have
# finished computing, when neither is already available. This -- not thread
# count -- is what bounds how quickly a new request gets read once dispatch
# is no longer synchronous: worst case ~this many ms, a rounding error next
# to the multi-second Ollama calls this whole session is about, and utterly
# negligible next to session 36's own +2,742ms measurement of the bug this
# fixes.
_POLL_INTERVAL_S = 0.02


def _dispatch_worker(repo_map: RepoMap, message: dict[str, Any], out_queue: "queue.Queue[Any]") -> None:
    # Deliberately does not touch the pipe/socket at all -- only the single
    # I/O thread in `_serve_windows`/`_serve_posix` does. See those
    # functions' own comments for why: a live repro against a real spawned
    # sidecar showed that a worker thread calling `WriteFile` while the main
    # thread was blocked in `ReadFile` on the *same* named-pipe handle
    # deadlocks the whole connection outright (confirmed in isolation too,
    # independent of anything else this session changed) -- not a race that
    # occasionally corrupts a response, a hang, every time. Sockets were not
    # separately confirmed broken the same way, but the same single-I/O-
    # thread design sidesteps the question for both transports at once
    # rather than trusting an unconfirmed asymmetry between them.
    response = _dispatch(repo_map, message)
    out_queue.put(json.dumps(response))


def _drain_outgoing(send_line, out_queue: "queue.Queue[Any]") -> None:
    """Writes every response currently sitting in the queue, in the order
    workers finished them -- not necessarily request order; see the module
    docstring's "Dispatch concurrency" section on why that's already fine."""
    while True:
        try:
            item = out_queue.get_nowait()
        except queue.Empty:
            return
        try:
            send_line(item)
        except Exception as exc:
            # The connection may already be gone (client disconnected mid-
            # flight). Must not crash the I/O loop -- the read side's own
            # exception handling / EOF check already covers a genuinely
            # dead connection on its next pass through this same loop.
            _log(f"failed to send response: {exc}")


def _process_lines(
    buf: bytes,
    repo_map: RepoMap,
    out_queue: "queue.Queue[Any]",
    executor: concurrent.futures.ThreadPoolExecutor,
) -> bytes:
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        if not line.strip():
            continue
        try:
            message = json.loads(line.decode("utf-8"))
        except json.JSONDecodeError as exc:
            out_queue.put(json.dumps({"id": None, "error": {"message": f"invalid JSON: {exc}"}}))
            continue
        # Session 37: submit and keep reading, rather than calling
        # `_dispatch` inline here -- see the module docstring's "Dispatch
        # concurrency" section for why this is the actual fix, not just a
        # refactor.
        executor.submit(_dispatch_worker, repo_map, message, out_queue)
    return buf


def _serve_windows(address: str, repo_map: RepoMap) -> None:
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=_MAX_WORKERS, thread_name_prefix="rpc-worker")
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

        # A plain closure over `pipe`, safe here even though `pipe` is
        # reassigned each outer-loop iteration: `send_line` is only ever
        # called by this same thread, within this same iteration (via
        # `_drain_outgoing` below), always before `pipe` could be
        # reassigned. No other thread calls it -- see `_dispatch_worker`'s
        # comment for why that invariant matters.
        def send_line(text: str, _pipe=pipe) -> None:
            win32file.WriteFile(_pipe, text.encode("utf-8") + b"\n")

        out_queue: "queue.Queue[Any]" = queue.Queue()

        buf = b""
        try:
            while True:
                # Session 37: this is the whole fix, in one loop. Dispatch
                # (potentially several seconds of Ollama I/O, on a worker
                # thread via `_process_lines`/`_dispatch_worker` above) no
                # longer blocks this thread from noticing a newly-arrived
                # request -- `PeekNamedPipe` lets it check for input without
                # committing to a blocking `ReadFile` that could otherwise
                # sit for up to the full request timeout. This thread is
                # also the *only* one that ever calls `WriteFile`/`ReadFile`
                # on `pipe` -- see `_dispatch_worker`'s comment for why that
                # matters (not just tidiness): a worker thread writing
                # concurrently with this thread's read deadlocks the pipe.
                _drain_outgoing(send_line, out_queue)
                _, bytes_avail, _ = win32pipe.PeekNamedPipe(pipe, 0)
                if bytes_avail == 0:
                    time.sleep(_POLL_INTERVAL_S)
                    continue
                hr, data = win32file.ReadFile(pipe, 65536)
                if not data:
                    break
                buf = _process_lines(buf + data, repo_map, out_queue, executor)
        except pywintypes.error as exc:
            _log(f"client disconnected ({exc.strerror})")
        finally:
            _drain_outgoing(send_line, out_queue)
            win32file.CloseHandle(pipe)


def _serve_posix(address: str, repo_map: RepoMap) -> None:
    if os.path.exists(address):
        os.unlink(address)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(address)
    server.listen(1)
    _log(f"listening on {address}")

    executor = concurrent.futures.ThreadPoolExecutor(max_workers=_MAX_WORKERS, thread_name_prefix="rpc-worker")
    try:
        while True:
            conn, _ = server.accept()
            _log("client connected")
            # Short recv timeout, not a real deadline: lets this thread fall
            # through to drain outgoing responses and re-check even when no
            # new request has arrived yet -- same role `PeekNamedPipe` plays
            # in `_serve_windows` above, POSIX's more natural equivalent.
            conn.settimeout(_POLL_INTERVAL_S)

            # Same reasoning as `_serve_windows`'s own `send_line` -- see its
            # comment.
            def send_line(text: str, _conn=conn) -> None:
                _conn.sendall(text.encode("utf-8") + b"\n")

            out_queue: "queue.Queue[Any]" = queue.Queue()

            buf = b""
            try:
                while True:
                    _drain_outgoing(send_line, out_queue)
                    try:
                        data = conn.recv(65536)
                    except socket.timeout:
                        continue
                    if not data:
                        break
                    buf = _process_lines(buf + data, repo_map, out_queue, executor)
            finally:
                _drain_outgoing(send_line, out_queue)
                conn.close()
                _log("client disconnected")
    finally:
        server.close()
        if os.path.exists(address):
            os.unlink(address)


def main() -> None:
    if len(sys.argv) != 6:
        print(
            "usage: python -m sidecar.rpc_server <pipe-or-socket-address> <workspace-root> "
            "<storage-dir> <embedding-model-id> <ollama-base-url>",
            file=sys.stderr,
        )
        sys.exit(1)

    address, root, storage_dir, embedding_model_id, ollama_base_url = (
        sys.argv[1],
        sys.argv[2],
        sys.argv[3],
        sys.argv[4],
        sys.argv[5],
    )

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
    repo_map.ollama_base_url = ollama_base_url

    def _embed_repo_in_background() -> None:
        _log(f"embedding repo chunks (model={embedding_model_id}, ollama={ollama_base_url}) ...")
        try:
            chunk_count = reindex_repo_chunks(root, repo_map.vector_store, embedding_model_id, ollama_base_url)
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
