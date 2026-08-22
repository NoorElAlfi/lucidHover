# Session 30: Contradiction-detector false-positive fix

**Date:** 2026-08-22
**Build-order step(s) completed:** None — targeted bug-fix session on `scripts/acceptance_test.py`'s
session-28 contradiction detector, not a Core Build Order step.
**Status:** complete

## Files touched
- [scripts/acceptance_test.py](../../scripts/acceptance_test.py) — narrowed the window in both
  `_CALLEES_NEGATION_PATTERN` and `_CALLERS_NEGATION_PATTERN` from `[^.]{0,40}` to `[^.]{0,20}`
  chars between the negation trigger and the caller/callee word, with a comment documenting the
  measured char-gap reasoning (true positives ≤16 chars, the confirmed false positive at 24 chars).
- [sidecar/tests/test_acceptance_test.py](../../sidecar/tests/test_acceptance_test.py) — 4 new
  regression tests inserted before `test_single_boilerplate_phrase_produces_no_note`:
  - `test_risky_caller_behavior_idiom_produces_no_contradiction_note` — the exact session-28
    false-positive sentence, with `used_by`/`calls` populated so the check is live; asserts zero
    notes.
  - `test_getPlayerParty_contradiction_still_fires_after_window_narrowing`,
    `test_getEnemyParty_contradiction_still_fires_after_window_narrowing`,
    `test_priority_queue_push_contradiction_still_fires_after_window_narrowing` — the three
    confirmed real pokerogue true positives from session 28's artifact, reusing their actual
    `why_it_exists` text; each asserts the self-contradiction note still fires.

No prompt.py/PROMPT_VERSION changes, no sidecar production code, no cache/API-surface/language-scope
changes — matches the session's explicit scope.

## Decisions made
- **Window narrowing (40 → 20 chars) instead of requiring a grammatical-subject anchor word
  (e.g. mandatory "have"/"has"/"any" between the negation trigger and "caller(s)").** The anchor
  approach was the literal suggestion in session 28's handoff, but it would have broken two
  pre-existing, already-passing unit tests that use bare adjacency ("A pure utility with no
  callers." — zero words between trigger and target, no anchor present) — those tests encode a
  real, legitimate self-contradiction shape that must keep firing. Measured char gaps directly:
  every confirmed true positive (3 real pokerogue examples + 2 pre-existing unit tests) sits within
  16 chars of its trigger; the confirmed false positive sits at 24 chars. A window of 20 cleanly
  separates the two groups with margin on both sides, verified empirically with a standalone regex
  script before editing the production file (see Test status).
- **Did not add a positive/negative lookahead for noun-continuation (e.g. blocking "caller
  behavior"/"caller code"/"caller logic").** Considered this as a more "grammatically principled"
  alternative, but it requires either a curated whitelist of allowed continuations after
  caller(s)/callee(s) (risk: rejecting genuine true positives phrased in an unanticipated way) or a
  blacklist of disallowed continuation nouns (risk: overfitting to the one observed false-positive
  word "behavior" without addressing the general class). The window-narrowing fix is honest about
  being distance-based, not true parsing, and documents the residual gap directly in the code
  comment (a short adjectival phrase closer than 20 chars to a trigger could still slip through) —
  same "known, accepted, notes-only" tradeoff philosophy as every other heuristic in this file.

## Deviations from spec
None — implemented as specified in the session prompt (narrow the detector, add regression tests,
re-run both fixture regressions, re-run the targeted pokerogue functions). The one departure from
session 28's *handoff suggestion* (anchor-word requirement vs. window narrowing) is explained above
under Decisions made, with the reasoning for why the alternate approach was chosen instead.

## Test status
- **Standalone regex verification** (before editing production code): built the exact regex at
  windows 16/18/20/22/23/24/26 against the 3 real true-positive strings, the false-positive string,
  and the 2 pre-existing unit-test strings. Window 20 is the first value where all true positives
  match and the false positive does not (false positive starts matching again at window 26).
- `python -m pytest sidecar/tests/test_acceptance_test.py -v`: **21/21 passed** (17 pre-existing +
  4 new), confirmed via `test-runner` agent. All pre-existing "fires" tests
  (`test_callees_contradiction_is_a_note_not_an_issue`, `test_callers_contradiction_is_a_note_not_an_issue`)
  still pass unchanged at the narrower window.
- `python -m pytest sidecar/tests/ -q`: **97 passed** (up from session 28's 93-test baseline; +4 for
  this session), confirmed via `test-runner` agent.
- `code-reviewer` pass: **no violations found** against the 12 core rules (pure heuristic-filter
  code, no cache/sidecar/prompt/API-surface/language-scope changes). Independently reproduced the
  char-gap math, confirmed the two pre-existing "fires" tests still pass, confirmed the two `push`
  test cases (false positive vs. true positive) are correctly distinct real pokerogue
  functions/files, not conflated.
- **Fixture regression, JavaScript** (`fixtures/javascript/repomap`, `qwen2.5-coder:1.5b`,
  `--limit 15`): 15/15 passed automated schema checks. 7/15 rows carried a note, all pre-existing
  caller/callee-mention notes — identical count and category to session 28's baseline. Zero new
  false positives, zero lost true positives.
- **Fixture regression, TypeScript** (`fixtures/typescript/repomap`, `qwen2.5-coder:1.5b`,
  `--limit 15`): 15/15 passed automated schema checks. 8 notes across 7 rows (one row carried 2),
  all pre-existing caller/callee-mention or weak-placeholder ("unknown") notes — same count and
  category mix as session 28's baseline. `updateUser`'s session-28 contradiction note did not
  reproduce this run (expected LLM non-determinism, same as `recordNamespaced` not reproducing in
  session 28's own TypeScript regression) — not a regression, the detector is structurally
  unchanged for that phrasing (confirmed by the unit tests using the exact stored text).
- **Targeted pokerogue re-run** (`B:\pokerogue`, `qwen2.5-coder:1.5b`,
  `--functions getPlayerParty,getEnemyParty,push`): name filter matched 6 functions across the repo
  (2 non-test-helper + 2 test-helper duplicates + 2 `push` implementations in different files).
  Confirmed live:
  - `getPlayerParty` (`src/battle-scene.ts:729`) — fresh generation reproduced the same
    self-contradiction shape ("It does not have any callers or callees...") and the note **still
    fired**.
  - `push` (`src/queues/post-summon-phase-priority-queue.ts:17`) — fresh generation reproduced the
    **exact same false-positive idiom text** as session 28 ("There are no missing checks or risky
    caller behavior visible here, so no risk to flag") and **zero notes fired** — direct live
    confirmation the fix works, not just a unit-test result.
  - `getEnemyParty` and `push` (`src/queues/priority-queue.ts:36`) — fresh generations this run
    did not reproduce their respective session-28 contradiction shapes (different LLM output this
    time); 0 notes each, expected non-determinism, not evidence against the fix (their exact
    session-28 text is separately locked in by unit tests and confirmed to still fire there).
  - All 6/6 passed automated schema checks with 0 issues.

## Blockers / open questions
None blocking.

## Handoff for next session
- The contradiction detector is now a distance-based heuristic tuned to the specific measured
  true/false-positive examples collected so far (session 28 + this session), not a grammatical
  parser. A future false positive with a *shorter* adjectival gap than 24 chars (e.g. "no risky
  caller behavior" without the "missing checks or" preamble, gap ~6 chars) would still slip through
  the 20-char window undetected — this is a known, documented, accepted tradeoff for a notes-only,
  human-reviewed heuristic, not a bug. If this recurs in a future real-repo audit, the next step
  would likely be a noun-continuation guard (reject when caller(s)/callee(s) is immediately followed
  by another content word like "behavior"/"code"/"logic") rather than shrinking the window further,
  since further shrinking risks losing the "does not have any known callers" true-positive shape
  (currently at 16 chars, only 4 chars of margin below the 20-char window).
- The underlying prompt-level hallucination (the model reciting prompt.py's `_EXAMPLE_4` risk-note
  idiom near-verbatim, and separately claiming zero callers/callees when the given context lists
  several) remains unfixed by design — this session's scope was detector narrowing only, per the
  session prompt's explicit out-of-scope note. Session 28's handoff already flagged the
  `SYSTEM_INSTRUCTION` illustrative-example wording in `prompt.py` as the place a future
  prompt-quality session would look; that remains open and would need a `PROMPT_VERSION` bump.
