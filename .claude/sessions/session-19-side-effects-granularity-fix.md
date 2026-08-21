# Session 19: side_effects granularity fix

**Date:** 2026-08-20
**Build-order step(s) completed:** None (targeted bug fix, not a build-order milestone step) -- fix
to sidecar/generation/'s prompt and schema per user report, scoped by explicit instruction to
sidecar/generation/ only.
**Status:** complete

**Renumbered from 14 to 19 at merge time:** this fix was done on a worktree branched before the
real Build Order step 14 (custom local Ollama endpoint tier) landed on `master` and claimed that
session number for the "Sessions 13-15" commit -- this artifact's own "Handoff" section already
flagged this exact numbering risk while it was in flight ("double check its build-order numbering
doesn't conflict with this file's 'Session 14' label"). Renumbered to 19 (continuing after session
18, the fnId fix merged immediately before this one) rather than colliding with the real session
14. No other content changed.

## Files touched
- `sidecar/generation/prompt.py` — reworded the `side_effects` field rule to explicitly forbid
  comma-joining multiple effects into one array element, and added a fourth few-shot example
  (`_EXAMPLE_4`, `syncUserRecord`) demonstrating a function with all five side-effect categories at
  once, each correctly split into its own array element. Went through two iterations (see
  Deviations below).
- `src/extension/cache/config.ts` — bumped `PROMPT_VERSION` from `few-shot-v3` to `few-shot-v4`
  per Core Design Decision #2, with a comment documenting why.
- `scripts/acceptance_test.py` — `_check_schema` now adds a `notes` (not `issues`) entry when a
  `side_effects` element contains 2+ commas, as a heuristic regression detector for this exact
  failure mode, consistent with the existing issues/notes split.
- `sidecar/tests/test_acceptance_test.py` — two new tests for the comma-join note
  (`test_comma_joined_side_effects_is_a_note_not_an_issue`,
  `test_granular_side_effects_produce_no_note`).

## Decisions made
- **Prompt-only fix, no post-generation heuristic split.** Weighed the normalization-pass option
  from the task brief and rejected it: a real single side-effect description can legitimately
  contain a comma (e.g. "writes to the users, orders tables"), and the model's actual phrasing
  never matches fixed category strings closely enough to split on reliably. A prompt fix that
  addresses the model's behavior directly is more correct than a fragile string-splitting backstop
  that risks corrupting genuine content. This mirrors `_sanitize_explanation`'s existing
  precedent of "deterministic backstop for structured fields," but `side_effects` is free text,
  not a closed set of real names, so the same technique doesn't transfer safely.
- **Acceptance-test note, not issue, for comma-joined output.** Added detection (2+ commas in one
  `side_effects` element) to `_check_schema`'s heuristic `notes` list, not `issues` -- same
  precedent as the existing caller/callee-mention and "unknown"-word checks: a real signal worth a
  human's attention, not proof of a mechanical defect (a legitimate single effect could coincide
  with 2 commas). Verified it produces zero false positives against the real acceptance-test run
  below.
- **Used session number 14, not 13.** The task instructions reference
  `.claude/sessions/session-13-staleness-badge.md` as an existing file to leave untouched, but that
  file does not exist in this worktree (some other session/branch owns it). Used 14 to avoid a
  future numbering collision when that work lands, and added the corresponding row to CLAUDE.md's
  session log index.
- **Did not touch `used_by`/`calls`.** Per the task brief's own note, these are sanitized
  deterministically against real caller/callee names already (`generate.py`'s
  `_sanitize_explanation`), and are exact-name lists, not "combine related facts" free text, so the
  granularity failure mode this session addresses doesn't apply to them. Confirmed by reading
  `generate.py` and its tests -- no change needed.

## Deviations from spec
- **First attempt at the field-rule fix introduced a worse regression, caught and fixed within this
  session.** The initial version added an inline `WRONG: [...]` / `RIGHT: [...]` bracketed example
  directly in the system instruction (a literal, copy-pasteable JSON-array-shaped snippet). Running
  the real acceptance test against `fixtures/sample-repo/repomap` with `qwen2.5-coder:1.5b` showed
  the model parroting those exact bracketed strings verbatim as `side_effects` for functions that
  don't remotely have those effects -- e.g. `validateEmail` (a pure regex check with no I/O) came
  back with `["DB writes", "network calls", "file I/O"]`, and `formatDate` (pure date formatting,
  zero side effects) came back with `["writes to the DB", "makes a network call", "writes a
  file"]`, copied near-verbatim from the RIGHT example. This is a worse failure than the original
  bug report (fabricated content, not just a granularity/shape inconsistency). Root-caused to the
  literal bracketed example being an irresistibly cheap, valid-looking answer for a 1.5B model
  under schema-constrained decoding. Fixed by removing the bracketed literal entirely and
  rewriting the field rule as prose only, with an explicit "these are illustrative categories, not
  fixed text to output — never copy this list verbatim, and never list a category the function
  doesn't actually exercise" instruction. Re-ran the acceptance test after the rewrite; the
  hallucination was gone (see Test status). This is the version now in the repo — see prompt.py's
  current `side_effects` field rule and the "Test status" section below for the corrected output.

## Test status
- `python -m pytest` (sidecar, from `sidecar/`): 66 passed, 1 pre-existing unrelated failure
  (`test_rpc_server.py::test_resolves_the_exact_reported_case`, a stale line-number assertion
  against `fixtures/sample-repo/repomap/handlers.js` -- confirmed via `git status` that neither
  that test file nor the fixture was touched this session; pre-existing, out of scope).
- Ran `python scripts/acceptance_test.py fixtures/sample-repo/repomap --model qwen2.5-coder:1.5b
  --limit 15` twice against the real local Ollama instance (confirmed reachable,
  `qwen2.5-coder:1.5b` pulled):
  - **First run (bracketed-example version):** 15/15 passed automated schema checks, 0 issues, but
    manual inspection of `side_effects` across all 15 functions showed severe hallucination (see
    Deviations above) -- caught by eyeballing the report, not by the automated filter itself (the
    automated filter only checks shape, not correctness, per its own docstring).
  - **Second run (final prose-only version):** 15/15 passed automated schema checks, 0 issues, 0
    `comma-join` notes. Manual inspection: every function with multiple real side effects (e.g.
    `validateAndPersistSignup`, `updateUser`, `handleSignupRoute`) now gets distinct, granular,
    function-specific array elements; no comma-joined single strings; no hallucinated
    boilerplate-category output on functions with few/no real effects. `validateAndPersistSignup`
    in particular produced 4 correctly-split effects (log write, DB update, push notification,
    analytics call) — structurally the same pattern `_EXAMPLE_4` teaches, on a real (not few-shot)
    function.
  - Separately noted, out of scope for this fix: a few functions (`hashPassword`, `deleteUser`,
    `sendPasswordReset`) have `side_effects` entries describing their own return-value construction
    rather than a true external effect (e.g. "Returns true if the user was successfully deleted").
    That's a different, pre-existing quality question (what counts as a side effect at all) not
    related to the granularity/comma-joining bug this session was scoped to fix -- flagged here for
    visibility, not fixed.

## Blockers / open questions
- The "return value described as a side effect" quality issue noted above (not the bug this
  session targeted) -- worth a follow-up session's `why_it_exists`/`side_effects` field-rule pass
  if it recurs on a real (non-fixture) repo.
- Did not re-run the acceptance test against a larger/real personal repo, only the fixture repo
  (`fixtures/sample-repo/repomap`, 21 functions) -- the fixture was sufficient to catch and confirm
  the fix for the reported bug, but the spec's actual v0 Definition of Done bar (8/10-15 correct
  and non-obvious on a *real* repo) was not re-validated end-to-end this session.

## Handoff for next session
- No specific next action required for this fix -- it's complete and verified. If a future session
  touches `sidecar/generation/prompt.py` or `schema.py` again, remember: avoid literal
  bracketed/JSON-shaped "WRONG"/"RIGHT" example snippets in the system instruction for the bundled
  1.5B model -- verified directly in this session that such snippets get echoed back verbatim
  regardless of the real function body. Prefer prose-only rules, plus few-shot examples grounded in
  varied, specific fictional functions, to teach a pattern instead.
- If/when `.claude/sessions/session-13-staleness-badge.md` lands in this worktree, double check its
  build-order numbering doesn't conflict with this file's "Session 14" label.
