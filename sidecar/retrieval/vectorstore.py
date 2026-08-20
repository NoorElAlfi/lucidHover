"""
LanceDB wrapper (Session 11 / Build Order step 11) -- the embedded,
single-file-on-disk vector store the spec picked over Chroma (see the
session's design pass: no server to spawn/monitor, matches the
`better-sqlite3` "embedded over server" bias, and avoids Chroma's default
ONNX/duckdb embedding-function dependencies that would sit unused since
embeddings come from Ollama instead of a local Python model call).

One table (`chunks`), one row per `chunking.Chunk` plus its embedding
vector. Rows carry `rel_fname` so a single file's chunks can be dropped and
re-inserted on re-embed without touching the rest of the table -- no
per-row primary-key upsert API is needed for that.

The startup full-repo embed pass runs on a background thread (see
rpc_server.py's `main()` -- fixed after live VS Code testing showed the
synchronous version blocking the named pipe from being created at all
within the extension host's connect-retry budget), while a `reindex_file`
RPC's one-file re-embed runs on the main dispatch thread. `_lock` guards
every table mutation/read against that overlap -- Python's GIL already
makes single attribute reads/writes atomic, but a `replace_all` from the
background thread and a concurrent `replace_file`/`query` from the RPC
thread could otherwise both be mid-flight against the LanceDB table at
once, which isn't a case LanceDB itself is documented to make safe.
"""

from __future__ import annotations

import os
import threading
from typing import Any

import lancedb

TABLE_NAME = "chunks"


def _escape(value: str) -> str:
    return value.replace("'", "''")


class VectorStore:
    def __init__(self, storage_dir: str):
        self._lock = threading.Lock()
        self._db = lancedb.connect(os.path.join(storage_dir, "lancedb"))
        self._table = self._db.open_table(TABLE_NAME) if self._has_table() else None

    def _has_table(self) -> bool:
        # `list_tables()` (not the deprecated `table_names()`) returns a
        # paginated result object, not a plain list -- `.tables` is the
        # actual name list.
        return TABLE_NAME in self._db.list_tables().tables

    def replace_all(self, rows: list[dict[str, Any]]) -> None:
        """Full-repo (re)index, run once at sidecar startup (on a background thread)."""
        with self._lock:
            if not rows:
                if self._has_table():
                    self._db.drop_table(TABLE_NAME)
                self._table = None
                return
            self._table = self._db.create_table(TABLE_NAME, data=rows, mode="overwrite")

    def replace_file(self, rel_fname: str, rows: list[dict[str, Any]]) -> None:
        """One file's chunks, re-run on the save-triggered `reindex_file` path."""
        with self._lock:
            if self._table is None:
                if not rows:
                    return
                self._table = self._db.create_table(TABLE_NAME, data=rows, mode="overwrite")
                return
            self._table.delete(f"rel_fname = '{_escape(rel_fname)}'")
            if rows:
                self._table.add(rows)

    def query(self, vector: list[float], limit: int) -> list[dict[str, Any]]:
        """Nearest `limit` rows by vector distance, closest first. Empty if the store has no data yet."""
        with self._lock:
            if self._table is None or self._table.count_rows() == 0:
                return []
            return self._table.search(vector).limit(limit).to_list()
