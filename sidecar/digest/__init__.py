"""
Codebase digest export (chat-discussed follow-up, not a Build Order step) --
see `ingestion.py`'s module docstring for the design.
"""

from __future__ import annotations

from .ingestion import (
    MAX_FILE_SIZE_BYTES,
    MAX_FILES,
    MAX_TOTAL_OUTPUT_BYTES,
    DigestFile,
    DigestResult,
    generate_digest,
    render_digest,
)

__all__ = [
    "MAX_FILE_SIZE_BYTES",
    "MAX_FILES",
    "MAX_TOTAL_OUTPUT_BYTES",
    "DigestFile",
    "DigestResult",
    "generate_digest",
    "render_digest",
]
