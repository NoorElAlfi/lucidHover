"""
v0 Definition of Done acceptance test (Session 6).

Per the spec: "Open a real personal repo with genuine cross-file call
chains... Hover over 10-15 functions not written in the current session.
Pass bar: at least 8 of them produce an explanation that is correct and
non-obvious." That correctness/non-obviousness judgment is explicitly
human-in-the-loop -- this script's job is to make that review fast, not to
replace it: it indexes a target repo, generates real explanations for a
sample of functions, writes a human-readable report, and runs a first-pass
automated filter for structural problems (invalid JSON, placeholder text,
multi-sentence one_liners) so a human reviewer isn't wasting time on
mechanically-broken output before judging quality.

Usage:
    python scripts/acceptance_test.py <repo_path> [options]

Options:
    --model MODEL        Ollama model id to generate with (required).
    --limit N             Max functions to sample when --functions isn't
                           given (default 15, per the spec's "10-15").
    --functions a,b,c     Explicit function names to test instead of the
                           importance-ranked sample.
    --report PATH          Where to write the Markdown report
                           (default: ./acceptance_report.md).

Example:
    python scripts/acceptance_test.py fixtures/javascript/repomap \\
        --model qwen2.5-coder:1.5b --limit 15
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

# `sidecar` is a top-level package relative to the repo root, not to this
# script's own directory -- add the repo root to sys.path so this can be
# run directly (`python scripts/acceptance_test.py ...`) without installing
# anything.
_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from sidecar.generation.generate import generate_explanation  # noqa: E402
from sidecar.generation.ollama_client import OllamaError  # noqa: E402
from sidecar.repomap.context import FunctionContext, RepoMap  # noqa: E402

# "unknown" is deliberately NOT in here -- unlike the others, it's common
# enough as genuine content (a real fallback value/enum/string literal from
# the actual source, e.g. a function that really does return `'Unknown
# Model'`) that treating every occurrence as a hedge produces false
# positives. See `_WEAK_PLACEHOLDER_PATTERNS` below.
_PLACEHOLDER_PATTERNS = ["n/a", "tbd", "todo", "and more", "etc."]

# Same idea as the caller/callee-mention check below: a real signal worth a
# human's attention, but not reliable enough on its own to count as a
# mechanical defect -- goes to `notes`, not `issues`. Confirmed directly:
# the acceptance test run against a real repo flagged `getPlayerModelKey`
# for containing "unknown", but its `why_it_exists` was accurately
# describing the function's real `'Unknown Model'` fallback string, not
# hedging about something it didn't know.
_WEAK_PLACEHOLDER_PATTERNS = ["unknown"]


def _find_def_tag(repo_map: RepoMap, rel_fname: str, name: str, line: int):
    for tag in repo_map.tags_by_file.get(rel_fname, []):
        if tag.kind == "def" and tag.name == name and tag.start_line == line:
            return tag
    return None


def _read_fn_source(repo_map: RepoMap, root: str, rel_fname: str, name: str, line: int) -> str:
    tag = _find_def_tag(repo_map, rel_fname, name, line)
    if tag is None:
        raise RuntimeError(f"could not locate def tag for {rel_fname}::{name}::{line}")
    data = Path(os.path.join(root, rel_fname)).read_bytes()
    return data[tag.start_byte : tag.end_byte].decode("utf-8")


def _select_functions(repo_map: RepoMap, limit: int, name_filter: set[str] | None) -> list:
    functions = repo_map.list_functions()
    if name_filter is not None:
        selected = [n for n in functions if n[1] in name_filter]
        missing = name_filter - {n[1] for n in selected}
        for name in sorted(missing):
            print(f"warning: requested function '{name}' not found in repo, skipping", file=sys.stderr)
        return selected
    ranked = sorted(functions, key=lambda n: -repo_map.importance.get(n, 0.0))
    return ranked[:limit]


def _check_schema(
    explanation: dict, caller_names: list[str], callee_names: list[str]
) -> tuple[list[str], list[str]]:
    """
    First-pass automated filter. Returns (issues, notes):
    - issues: structural/mechanical defects (missing/malformed fields, strong placeholder
      text, a multi-sentence one_liner) -- objective, and these are what the report's
      pass/fail count is based on.
    - notes: softer, heuristic-only signals worth a human's attention but NOT counted as
      a failure:
        - the caller/callee-mention check: a model can legitimately ground `why_it_exists`
          in the real given names without quoting any of them verbatim (e.g. "used by
          several admin endpoints for fetching, creating, and deleting data" instead of
          naming `fetchAdminModels`/`createAdminModel`/`deleteAdminModel` literally) --
          that's a paraphrase, not proof of generic ungrounded reasoning.
        - the weak placeholder pattern ("unknown"): common enough as genuine content (a
          real fallback value/string from the source) that flagging every occurrence as
          a hedge produces false positives (confirmed directly against a real repo --
          see session-08 artifact's follow-up).
      Neither should count against the automated pass rate the way an actually-missing
      field does.
    """
    issues: list[str] = []
    notes: list[str] = []
    required = ["role_tag", "one_liner", "why_it_exists", "used_by", "calls", "side_effects", "risk_note"]
    for field in required:
        if field not in explanation:
            issues.append(f"missing field: {field}")
    if issues:
        return issues, notes  # can't check further without the fields present

    if not isinstance(explanation["role_tag"], str) or not explanation["role_tag"].strip():
        issues.append("role_tag is empty or not a string")

    one_liner = explanation["one_liner"]
    if not isinstance(one_liner, str) or not one_liner.strip():
        issues.append("one_liner is empty or not a string")
    else:
        # Rough "roughly one sentence" heuristic: count sentence-terminal
        # punctuation. Allows for the occasional abbreviation/decimal, but
        # flags anything that looks like 2+ full sentences.
        terminators = len(re.findall(r"[.!?](?:\s|$)", one_liner.strip()))
        if terminators > 1:
            issues.append(f"one_liner looks like more than one sentence ({terminators} terminators)")

    for field in ("used_by", "calls", "side_effects"):
        value = explanation[field]
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            issues.append(f"{field} is not a list of strings")

    side_effects = explanation.get("side_effects")
    if isinstance(side_effects, list):
        for effect in side_effects:
            if isinstance(effect, str) and effect.count(",") >= 2:
                notes.append(
                    f"side_effects element looks like it may comma-join multiple distinct "
                    f"effects into one array element instead of splitting them (see "
                    f"prompt.py's side_effects field rule): '{effect}'"
                )

    if explanation["risk_note"] is not None and not isinstance(explanation["risk_note"], str):
        issues.append("risk_note is neither a string nor null")

    for field in ("role_tag", "one_liner", "why_it_exists", "risk_note"):
        value = explanation.get(field)
        if isinstance(value, str):
            lowered = value.lower()
            for pattern in _PLACEHOLDER_PATTERNS:
                if pattern in lowered:
                    issues.append(f"{field} contains placeholder-like text: '{pattern}'")
            for pattern in _WEAK_PLACEHOLDER_PATTERNS:
                if pattern in lowered:
                    notes.append(
                        f"{field} contains the word '{pattern}' -- may be genuine content "
                        "(e.g. a real fallback value/string from the source) rather than a "
                        "hedge; read it yourself"
                    )

    if caller_names or callee_names:
        why = explanation.get("why_it_exists", "")
        mentioned = any(n in why for n in caller_names + callee_names)
        if not mentioned:
            notes.append(
                "why_it_exists doesn't literally quote any given caller/callee name -- "
                "may be a paraphrase of what they do rather than a real miss; read it yourself"
            )

    return issues, notes


def run(repo_path: str, model: str, limit: int, name_filter: set[str] | None, report_path: str) -> None:
    print(f"indexing {repo_path} ...")
    repo_map = RepoMap(repo_path)
    repo_map.index()
    print(f"indexed {len(repo_map.list_functions())} functions")

    targets = _select_functions(repo_map, limit, name_filter)
    if not targets:
        print("no functions selected -- nothing to do", file=sys.stderr)
        sys.exit(1)
    print(f"generating explanations for {len(targets)} function(s) using model '{model}' ...")

    results = []
    for i, node in enumerate(targets, start=1):
        rel_fname, name, line = node
        print(f"  [{i}/{len(targets)}] {rel_fname}::{name}::{line} ...", end=" ", flush=True)
        t0 = time.time()
        try:
            fn_source = _read_fn_source(repo_map, repo_path, rel_fname, name, line)
            ctx = repo_map.get_function_context(rel_fname, name, line)
            explanation = generate_explanation(model, fn_source, ctx)
        except OllamaError as exc:
            # Connectivity/model-availability problems affect every
            # remaining function identically -- fail loudly and stop
            # instead of grinding through a report full of the same error.
            print("FAILED")
            print(f"\nGeneration failed: {exc}", file=sys.stderr)
            sys.exit(1)

        elapsed = time.time() - t0
        caller_names = [c.name for c in ctx.callers]
        callee_names = [c.name for c in ctx.callees]
        issues, notes = _check_schema(explanation, caller_names, callee_names)
        print(f"ok ({elapsed:.1f}s, {len(issues)} automated issue(s), {len(notes)} note(s))")

        results.append(
            {
                "rel_fname": rel_fname,
                "name": name,
                "line": line,
                "fn_source": fn_source,
                "caller_names": caller_names,
                "callee_names": callee_names,
                "explanation": explanation,
                "issues": issues,
                "notes": notes,
                "elapsed": elapsed,
            }
        )

    _write_report(report_path, repo_path, model, results)

    clean = sum(1 for r in results if not r["issues"])
    print(f"\n{clean}/{len(results)} passed automated schema checks with no issues.")
    print(f"Report written to {report_path}")
    print(
        "Automated checks are a first-pass filter only -- the actual "
        "'correct and non-obvious' judgment (pass bar: 8/10-15) is "
        "human-in-the-loop. Open the report and read each explanation."
    )


def _write_report(report_path: str, repo_path: str, model: str, results: list[dict]) -> None:
    lines = [
        "# LucidHover Acceptance Test Report",
        "",
        f"- Repo: `{repo_path}`",
        f"- Model: `{model}`",
        f"- Functions sampled: {len(results)}",
        f"- Passed automated schema checks: {sum(1 for r in results if not r['issues'])}/{len(results)}",
        "",
        "Automated checks only catch mechanically broken output (invalid shape, placeholder text, "
        "multi-sentence one-liners). They do NOT judge whether an explanation is correct or "
        "non-obvious -- read each one below and judge that yourself. Per the spec's v0 Definition "
        "of Done, pass bar is **at least 8 of 10-15 correct and non-obvious**. A separate 'notes' "
        "line (when present) flags a softer heuristic signal that's worth a second look but is NOT "
        "counted as an issue -- either why_it_exists not literally quoting a given caller/callee name "
        "(a grounded paraphrase isn't the same as generic, ungrounded reasoning), or a field "
        "containing a word like 'unknown' that may be genuine content (e.g. a real fallback value "
        "from the source) rather than a hedge.",
        "",
        "---",
        "",
    ]

    for r in results:
        status = "PASS (automated)" if not r["issues"] else f"{len(r['issues'])} AUTOMATED ISSUE(S)"
        lines.append(f"## `{r['name']}` -- {r['rel_fname']}:{r['line']} [{status}]")
        lines.append("")
        if r["issues"]:
            lines.append("**Automated issues:**")
            for issue in r["issues"]:
                lines.append(f"- {issue}")
            lines.append("")
        if r["notes"]:
            lines.append("**Automated notes (not counted as issues -- read and judge yourself):**")
            for note in r["notes"]:
                lines.append(f"- {note}")
            lines.append("")
        lines.append(f"**Known callers:** {r['caller_names'] or 'none'}")
        lines.append(f"**Known callees:** {r['callee_names'] or 'none'}")
        lines.append("")
        lines.append("<details><summary>Function source</summary>")
        lines.append("")
        lines.append("```javascript")
        lines.append(r["fn_source"])
        lines.append("```")
        lines.append("</details>")
        lines.append("")
        lines.append("**Generated explanation:**")
        lines.append("")
        lines.append("```json")
        lines.append(json.dumps(r["explanation"], indent=2))
        lines.append("```")
        lines.append("")
        lines.append("**Your verdict:** [ ] correct & non-obvious &nbsp;&nbsp; [ ] wrong/obvious/generic")
        lines.append("")
        lines.append("---")
        lines.append("")

    Path(report_path).write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("repo_path", help="Path to the target repo to index and sample functions from.")
    parser.add_argument("--model", required=True, help="Ollama model id to generate with.")
    parser.add_argument("--limit", type=int, default=15, help="Max functions to sample (default 15).")
    parser.add_argument(
        "--functions", default=None, help="Comma-separated exact function names to test instead of a sample."
    )
    parser.add_argument("--report", default="acceptance_report.md", help="Output report path (Markdown).")
    args = parser.parse_args()

    name_filter = set(args.functions.split(",")) if args.functions else None
    run(args.repo_path, args.model, args.limit, name_filter, args.report)


if __name__ == "__main__":
    main()
