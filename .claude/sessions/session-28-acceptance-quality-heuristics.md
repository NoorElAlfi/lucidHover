# Session 28: Acceptance-script quality heuristics + real-repo hallucination measurement

**Date:** 2026-08-22
**Build-order step(s) completed:** None — measurement/tooling session on `scripts/acceptance_test.py`, not a Core Build Order step.
**Status:** complete

## Files touched
- [scripts/acceptance_test.py](../../scripts/acceptance_test.py) — added two heuristic detectors to
  `_check_schema`, both appending only to `notes` (never `issues`), same "note not issue" split as
  every existing heuristic in the file:
  - **Contradiction detector**: flags when `why_it_exists` contains a negation phrase within ~40
    chars of "call"/"callee(s)" while `calls` is non-empty, or of "caller(s)" while `used_by` is
    non-empty (`_CALLEES_NEGATION_PATTERN`, `_CALLERS_NEGATION_PATTERN`).
  - **Boilerplate-triad detector**: flags when 2+ of prompt.py's own illustrative `side_effects`
    category phrases ("reads/writes a file", "sends a message or notification", "mutates a
    parameter or global") appear together, near-verbatim, in one explanation's `side_effects`
    array (`_BOILERPLATE_PATTERNS`).
  Also expanded the `_check_schema` docstring to document both new checks alongside the
  pre-existing ones (comma-join, weak-placeholder, caller/callee-mention — none of which were
  previously documented there either).
- [sidecar/tests/test_acceptance_test.py](../../sidecar/tests/test_acceptance_test.py) — 6 new unit
  tests mirroring `test_comma_joined_side_effects_is_a_note_not_an_issue`'s structure exactly (fake
  explanation dict via the existing `_explanation()` helper, no live model): a fires/doesn't-fire
  pair for each new detector, plus a case proving the contradiction check needs a genuinely
  non-empty array (an accurate "no callees" claim next to an empty `calls` array must not fire) and
  a case proving a consistent explanation produces no note.

No sidecar production files touched; no prompt/schema changes; `PROMPT_VERSION` unchanged (this
session is measurement + detection tooling only, per its own explicit scope).

## Decisions made
- **Regex design for the contradiction detector uses a shared negation-trigger group
  (`_NEGATION_TRIGGER`) reused by two separate field-specific patterns** rather than one combined
  pattern, so a negation near "callee"-vocabulary only ever gates on `calls`, and a negation near
  "caller"-vocabulary only ever gates on `used_by` — confirmed by the code-reviewer that `call`'s
  optional-suffix group (`s|ees?|ing`) does not accidentally match "caller"/"callers" (the
  mandatory `\b` immediately after the suffix fails because "call" is followed by a non-boundary
  `e` in "caller" with no alternative that consumes it), so the two checks don't cross-trigger on
  each other's vocabulary.
- **Both detectors gate on the corresponding array being genuinely non-empty**, not just on the
  negation phrase appearing — an explanation that accurately says "no callees" next to an empty
  `calls` array must never be flagged. Verified directly against real repo data (see below): this
  gate is load-bearing, not theoretical — it's what keeps the check from firing on every trivial
  zero-caller utility function in a real codebase.
- **Boilerplate detector matches across the whole joined `side_effects` list, not per-element** —
  the real defect (see session-25) is one array *containing* 2+ of the phrases across its elements,
  not one element containing all of them, and the phrases can also span a comma-joined single
  element (e.g. "reading or writing a file" contains "writing a file" as an exact substring match
  for the file pattern) or multiple separate elements.
- **A single matching boilerplate phrase never fires** (verified by
  `test_single_boilerplate_phrase_produces_no_note`) — a function can genuinely do exactly one of
  the three things (e.g. "writes a file to disk"); 2+ appearing together is the actual signal, per
  the session brief's own reasoning.

## Deviations from spec
None — implemented as specified. One thing not literally in the session brief but done in its
spirit: expanded `_check_schema`'s docstring to document all five heuristic notes (the three
pre-existing ones plus the two new ones), since the two new bullets would have looked inconsistent
sitting next to zero documentation of the ones already there.

## Test status
- `python -m pytest sidecar/tests/test_acceptance_test.py -q`: **17 passed** (11 pre-existing + 6
  new), confirmed directly and again via `test-runner` agent as part of the full suite.
- `python -m pytest sidecar/tests/ -q`: **93 passed** (up from session 24's 87-test baseline; +6 for
  this session), confirmed via `test-runner` agent.
- `code-reviewer` pass: **no violations found** against the 12 core rules (pure heuristic-filter
  code, no cache/sidecar/prompt/API-surface/language-scope changes). Traced both regexes by hand,
  confirmed the callees-pattern doesn't cross-match "caller"/"callers" vocabulary, confirmed the
  array-emptiness gate is a genuine short-circuit, confirmed the new tests assert precise
  issue/note counts and spot-check message content rather than just presence/absence. Reviewed the
  known false-positive class (below) and, per the review prompt's own framing, did not re-flag it
  as a new finding — a notes-only heuristic with human review as the backstop, same tradeoff as the
  existing "unknown" weak-placeholder note.
- **Fixture regression, JavaScript** (`fixtures/javascript/repomap`, `qwen2.5-coder:1.5b`,
  `--limit 15`): 15/15 passed automated schema checks, **0 new false positives** — every note that
  fired was the pre-existing caller/callee-mention note (7 of 15 rows), identical in kind to
  session 19's known-clean baseline.
- **Fixture regression, TypeScript** (`fixtures/typescript/repomap`, `qwen2.5-coder:1.5b`,
  `--limit 15`): 15/15 passed automated schema checks. 8 rows carried a note; all but one were the
  pre-existing caller/callee-mention or weak-placeholder ("unknown") notes. The one new-detector
  note, on `updateUser`, is a genuine true positive (see below), not a false positive — the
  detector caught a real instance of the exact session-25 defect class that this session's fixture
  run happened to reproduce fresh. `recordNamespaced` (session-25's original contradiction example)
  did **not** reproduce this run — 0 notes, 0 issues — consistent with model output being
  non-deterministic run to run.

## Real-repo hallucination measurement (`B:\pokerogue`, `qwen2.5-coder:1.5b`)

Two independent runs against the real, non-fixture pokerogue repo (6,633 indexed functions total;
sampled by importance ranking, never generated against the whole repo): a 15-function run, then a
separate, independently-generated 50-function run (the first 15 functions were re-generated fresh
in the second run — a different LLM call each time — giving two independent samples for those 15).

**Contradiction detector: 4/50 unique sampled functions flagged (8%), 3 of 4 confirmed true
positives.**

True positives (literal self-contradiction — narrative text claims zero callers/callees while the
model's own `used_by`/`calls` arrays name several):
- `getPlayerParty` (`src/battle-scene.ts:729`) — a one-line getter (`return this.party;`) with 15
  real callers. `why_it_exists`: *"It does not have any callers or callees, so it is a standalone
  utility method..."* while `used_by` lists all 15 names.
- `getEnemyParty` (`src/battle-scene.ts:765`) — same shape, 15 real callers. Identical
  self-contradiction pattern.
- `push` (`src/queues/priority-queue.ts:36`) — `why_it_exists`: *"The function does not have any
  known callers or callees, so its role in the codebase cannot be determined here"* despite the
  same paragraph naming `applySingleAbAttrs`/`add`/`end` as callers one sentence earlier, and
  `calls`/`used_by` both non-empty.

One confirmed **false positive**, found only by reading the flagged output (exactly the kind of
signal this measurement was for): `push` (`src/queues/post-summon-phase-priority-queue.ts:17`) —
`why_it_exists` never claims zero callers; the flagged text is *"There are no missing checks or
risky caller behavior visible here, so no risk to flag"* — a risk-note idiom the model is
reproducing near-verbatim from `prompt.py`'s own `_EXAMPLE_4` reasoning text (*"No missing checks
or risky caller behavior is visible here, so no risk to flag"*), not a claim about the function's
caller count. The negation trigger ("no") falls within the 40-char window of "caller" here purely
because "risky caller behavior" is an adjective phrase, not a subject-negation. This is the
detector's known, accepted conservative-regex tradeoff (notes-only, human reads and judges) — not
fixed this session, see Handoff.

**Boilerplate-triad detector: 0/50 in the 50-function run, but fired once in the independent
15-function run — on the same function (`getPlayerParty`), a different LLM generation.** That
run's `side_effects` was `["reading or writing a file", "sending a message or notification",
"mutating a parameter or global"]` — all three prompt.py category phrases, near-verbatim, for a
function whose entire body is `return this.party;`. The 50-run's independently-regenerated
`getPlayerParty` did not reproduce this (its `side_effects` happened to come back differently that
run) — confirms the defect is real and recurs on this exact function shape (zero-argument,
zero-callee "pure getter") but is generation-dependent, consistent with session-25's own framing of
this as model flakiness on trivial/pure functions rather than a deterministic failure.

**Concrete example (contradiction + boilerplate together, from the first 15-function run) —
`getPlayerParty`:**
```json
{
  "why_it_exists": "...It does not have any callers or callees, so it is a standalone utility method that does not interact with the rest of the codebase...",
  "used_by": ["getPlayerParty", "getPlayerField", "getPokemonById", "getPokemon", "getParty", "generateModifierType", "reset", "updateModifiers", "select", "catch", "getEligibleMoves", "selectPokemonForOption", "pokemonAndMoveChosen", "callback", "switchOutLogic"],
  "calls": [],
  "side_effects": ["reading or writing a file", "sending a message or notification", "mutating a parameter or global"]
}
```
Both new detectors fired on this single row — a real, human-verifiable double-hallucination on a
one-line getter, exactly the class of defect session 25 first identified on the TypeScript fixture
and this session confirms recurs on unrelated real-world code.

## Blockers / open questions
None blocking.

## Handoff for next session
- **The contradiction detector's known false-positive class (the "risky caller behavior" idiom)
  is real and was found in this session's own data**, not hypothetical — see the post-summon
  `push` example above. It is not fixed here (notes-only heuristic, human reviews it, and this
  session's scope was measurement + detection, not detector refinement) but a future tightening
  pass could narrow `_CALLERS_NEGATION_PATTERN` to require "caller(s)" to be the grammatical
  subject of the negation (e.g. require a "has"/"have"/"any" word between the negation trigger and
  "caller(s)") rather than any word within 40 chars, which would exclude adjectival uses like
  "risky caller behavior" while still catching "no callers", "doesn't have callers", "does not have
  any callers or callees", etc.
- **The boilerplate-triad hallucination is confirmed to recur on real, non-fixture code** (not just
  the TypeScript fixture's `isEmpty<T>`/`handleLoginRoute`), specifically on the same
  "zero-argument pure getter" function shape session 25 flagged. Per this session's explicit
  out-of-scope boundary, no prompt fix was attempted. A future prompt-quality session has real
  cross-repo evidence now (this artifact) to act on, in addition to session 25's fixture evidence —
  worth revisiting the field rule's own illustrative example list in `prompt.py`'s
  `SYSTEM_INSTRUCTION` (the exact phrases it's flagged for the model copying), which would need a
  `PROMPT_VERSION` bump per Core Rule 10.
- **`recordNamespaced`'s specific session-25 contradiction did not reproduce in this session's
  TypeScript fixture regression run** (0 issues, 0 notes) — expected model nondeterminism, not a
  regression; the detector would have caught it had it recurred (confirmed structurally sound
  against the exact recorded session-25 text via the new unit tests).
- Sample sizes here (15 + 50 functions, one real repo) are a measurement, not a statistically
  rigorous rate — a future session wanting a firmer recurrence-rate number would need multiple
  repos and/or multiple generations per function (temperature/seed held reasonably constant here at
  whatever `generate_explanation`'s defaults are).
