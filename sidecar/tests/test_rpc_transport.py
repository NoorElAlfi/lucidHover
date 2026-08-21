"""
Full named-pipe/socket RPC round-trip, at the real transport level (Build
Order step 17).

Sessions 14 and 15 both attempted this and both hit "a pipe-address quoting
issue in the throw-away test harness itself, not in rpc_server.py" (their
words, in both session artifacts) -- root cause, confirmed here: that
throwaway harness built the pipe path as a shell command line (PowerShell
mangles the backslash-heavy `\\.\pipe\...` address when it's interpolated
into a string and re-parsed by a shell), not a bug in `rpc_server.py`
itself. This test sidesteps that entirely by never going through a shell:
`subprocess.Popen` is called with an argv *list* (`shell=False`, the
default), exactly like `sidecarManager.ts`'s `cp.spawn` already does, and
the pipe address is passed straight through as a Python string with no
re-parsing step. The Windows client side reuses `pywin32`'s `win32file` --
already a project dependency, the same API `rpc_server.py`'s own
`_serve_windows` uses -- rather than introducing a new IPC library.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time

import pytest

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:
    import pywintypes
    import win32file


def _make_address() -> str:
    unique = f"lucidhover-test-{os.getpid()}-{int(time.time() * 1000)}"
    if IS_WINDOWS:
        return f"\\\\.\\pipe\\{unique}"
    import tempfile

    return os.path.join(tempfile.gettempdir(), f"{unique}.sock")


def _connect_windows(address: str, timeout_s: float = 10.0):
    """Retries CreateFile against the named pipe until the server's
    CreateNamedPipe has made it exist (it's created before the server's
    indexing pass finishes -- see rpc_server.py's `_serve_windows` -- so the
    dominant wait here is indexing time, not a real connection race)."""
    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            handle = win32file.CreateFile(
                address,
                win32file.GENERIC_READ | win32file.GENERIC_WRITE,
                0,
                None,
                win32file.OPEN_EXISTING,
                0,
                None,
            )
            return handle
        except pywintypes.error as exc:  # noqa: PERF203 -- a retry loop, not a hot path
            last_err = exc
            time.sleep(0.1)
    raise TimeoutError(f"could not connect to {address} within {timeout_s}s: {last_err}")


def _connect_posix(address: str, timeout_s: float = 10.0):
    import socket

    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.connect(address)
            return sock
        except OSError as exc:
            sock.close()
            last_err = exc
            time.sleep(0.1)
    raise TimeoutError(f"could not connect to {address} within {timeout_s}s: {last_err}")


def _request_windows(handle, payload: dict) -> dict:
    win32file.WriteFile(handle, (json.dumps(payload) + "\n").encode("utf-8"))
    _hr, data = win32file.ReadFile(handle, 65536)
    return json.loads(data.decode("utf-8").splitlines()[0])


def _request_posix(sock, payload: dict) -> dict:
    sock.sendall((json.dumps(payload) + "\n").encode("utf-8"))
    data = sock.recv(65536)
    return json.loads(data.decode("utf-8").splitlines()[0])


@pytest.fixture
def tiny_repo(tmp_path):
    """A one-function fixture repo, deliberately smaller than
    fixtures/javascript -- indexing time (which runs before the pipe/socket
    is even created, see rpc_server.py's `main()`) is the dominant wait
    before this test can connect at all, so keep it minimal."""
    (tmp_path / "tiny.js").write_text("function add(a, b) {\n    return a + b;\n}\n", encoding="utf-8")
    return tmp_path


def test_full_rpc_round_trip_over_the_real_transport(tiny_repo, tmp_path):
    """Spawns the real sidecar process (argv list, no shell) and performs a
    genuine status<->response round trip over the real named pipe/socket --
    not a mock, not calling the handler function directly like every other
    rpc_server.py test in this directory does."""
    address = _make_address()
    storage_dir = tmp_path / "storage"
    storage_dir.mkdir()

    repo_root = os.path.join(os.path.dirname(__file__), "..", "..")
    argv = [
        sys.executable,
        "-m",
        "sidecar.rpc_server",
        address,
        str(tiny_repo),
        str(storage_dir),
        "all-minilm",
        # Deliberately unreachable: rpc_server.py's background embedding
        # pass must degrade gracefully (log-and-continue) on a failed Ollama
        # call, never crash the sidecar or block serving -- see its own
        # `_embed_repo_in_background` doc comment. Using a real endpoint
        # here would make this test depend on a locally running Ollama.
        "http://127.0.0.1:1",
    ]

    proc = None
    handle = None
    try:
        proc = subprocess.Popen(  # noqa: S603 -- argv list, shell=False (the point of this test)
            argv,
            cwd=repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        connect = _connect_windows if IS_WINDOWS else _connect_posix
        request = _request_windows if IS_WINDOWS else _request_posix
        handle = connect(address)

        response = request(handle, {"id": 1, "method": "status", "params": {}})
        assert response["id"] == 1
        assert response["result"]["ok"] is True
        assert response["result"]["pid"] == proc.pid

        # A second round trip on the same connection -- confirms the
        # newline-delimited framing leaves the stream in a clean state for
        # the next request, not just a one-shot connection.
        response2 = request(handle, {"id": 2, "method": "status", "params": {}})
        assert response2["id"] == 2
        assert response2["result"]["ok"] is True
    finally:
        if IS_WINDOWS and handle is not None:
            win32file.CloseHandle(handle)
        elif handle is not None:
            handle.close()
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
