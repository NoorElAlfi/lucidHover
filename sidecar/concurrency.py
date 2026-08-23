"""
Minimal readers-writer lock (Session 37, sidecar dispatch-loop redesign part
2). Python's stdlib has no built-in RWLock, and this repo has no reason to
add a third-party dependency for one.

Session 36 measured, live against real pokerogue, that an interactive
request arriving while a background request is already in flight queues
fully behind it -- because `rpc_server.py`'s dispatch loop previously ran
one request at a time on a single thread, including a synchronous socket
read: it did not even attempt to read the next line off the wire until the
current handler returned. Session 37 fixes this by dispatching each request
onto its own worker thread (see `rpc_server.py`'s module docstring), so the
socket-reading loop stays free to pick up the next request immediately.

That change makes `RepoMap`'s mutable attributes (`tags_by_file`, `graph`,
`importance`, in `sidecar/repomap/context.py`) genuinely concurrently
accessed for the first time: `reindex_file` rebuilds all three from scratch
non-atomically, while every other handler only reads them. This lock lets
any number of readers run concurrently with each other (the common case --
most RPCs never mutate repo_map state) but never with a writer, and never
lets a writer and any reader overlap.

`VectorStore` (sidecar/retrieval/vectorstore.py) already had its own lock
since session 11, because its startup background-embed thread already ran
concurrently with the main dispatch thread -- RepoMap had no such precedent
before this session, since `reindex_file` previously only ever ran on the
single dispatch thread.

This is the textbook first-readers-writers solution: simple and correct,
but writer-starvation-prone if readers arrive back-to-back with no gap.
Judged acceptable here -- `reindex_file` is comparatively infrequent
(save-triggered, background-flush-triggered), and every read-lock hold in
`rpc_server.py` is scoped tightly around the repo_map access only, not
around the multi-second Ollama call that typically follows it -- so a
writer's wait is bounded by many short read holds, not a few long ones.
"""

from __future__ import annotations

import threading


class RWLock:
    def __init__(self) -> None:
        self._readers = 0
        self._readers_lock = threading.Lock()
        self._writer_lock = threading.Lock()

    def acquire_read(self) -> None:
        with self._readers_lock:
            self._readers += 1
            if self._readers == 1:
                self._writer_lock.acquire()

    def release_read(self) -> None:
        with self._readers_lock:
            self._readers -= 1
            if self._readers == 0:
                self._writer_lock.release()

    def acquire_write(self) -> None:
        self._writer_lock.acquire()

    def release_write(self) -> None:
        self._writer_lock.release()

    def read_lock(self) -> "_ReadLockContext":
        return _ReadLockContext(self)

    def write_lock(self) -> "_WriteLockContext":
        return _WriteLockContext(self)


class _ReadLockContext:
    def __init__(self, lock: RWLock) -> None:
        self._lock = lock

    def __enter__(self) -> None:
        self._lock.acquire_read()

    def __exit__(self, *exc_info: object) -> None:
        self._lock.release_read()


class _WriteLockContext:
    def __init__(self, lock: RWLock) -> None:
        self._lock = lock

    def __enter__(self) -> None:
        self._lock.acquire_write()

    def __exit__(self, *exc_info: object) -> None:
        self._lock.release_write()
