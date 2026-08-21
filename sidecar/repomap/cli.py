"""
Manual validation runner for Session 3. Not wired into the sidecar process
yet (that's Session 4) -- run directly:

    python -m sidecar.repomap.cli fixtures/javascript/repomap
"""

from __future__ import annotations

import sys

from .context import RepoMap


def main(root: str) -> None:
    repo_map = RepoMap(root)
    repo_map.index()

    nodes = sorted(repo_map.list_functions(), key=lambda n: -repo_map.importance.get(n, 0.0))
    print(f"{len(nodes)} functions indexed under {root}\n")

    for rel_fname, name, line in nodes:
        ctx = repo_map.get_function_context(rel_fname, name, line)
        score = repo_map.importance.get((rel_fname, name, line), 0.0)
        print(f"{rel_fname}:{line + 1} {name}()  importance={score:.4f}")

        callers_names = [f"{c.rel_fname}:{c.name}" for c in ctx.callers]
        callees_names = [f"{c.rel_fname}:{c.name}" for c in ctx.callees]

        callers_suffix = f"  (+{ctx.callers_omitted} more)" if ctx.callers_omitted else ""
        callees_suffix = f"  (+{ctx.callees_omitted} more)" if ctx.callees_omitted else ""

        print(f"  callers ({len(ctx.callers)}{callers_suffix}): {callers_names}")
        print(f"  callees ({len(ctx.callees)}{callees_suffix}): {callees_names}")
        print()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python -m sidecar.repomap.cli <repo_root>")
        sys.exit(1)
    main(sys.argv[1])
