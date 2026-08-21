"""
Shared fixture-repo path resolution for the pytest suite (Session 23).

Before this, `test_repomap.py`, `test_rpc_server.py`, and
`test_list_ranked_functions.py` each independently defined the same
`FIXTURE_ROOT = os.path.join(..., "fixtures", "sample-repo", "repomap")`
join. Single-sourcing it here means a second language's fixture (see
`fixtures/REQUIREMENTS.md` for what a language's fixture directory must
contain) only needs a call to `fixture_repomap_root("<language>")`, not a
fourth independently-derived path.
"""

from __future__ import annotations

import os

_FIXTURES_ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "fixtures")


def fixture_repomap_root(language: str) -> str:
    """Path to a language fixture's `repomap/` call-graph corpus, e.g.
    `fixture_repomap_root("javascript")` -> `.../fixtures/javascript/repomap`."""
    return os.path.join(_FIXTURES_ROOT, language, "repomap")
