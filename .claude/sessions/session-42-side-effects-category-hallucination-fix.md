# Session 42: `side_effects` verbatim-category-list hallucination fix

**Date:** 2026-08-23
**Build-order step(s) completed:** None (targeted bug fix, not a build-order milestone step) — carried
forward from sessions 25/28's own findings.
**Status:** complete

## Files touched
- [sidecar/generation/prompt.py](../../sidecar/generation/prompt.py) — reworded the `side_effects`
  field rule to explicitly decouple caller count / codebase importance from side-effect likelihood
  ("a heavily-used function can be perfectly pure; judge this only from what the function's own
  body actually does"), and added a fifth few-shot example (`_EXAMPLE_5`, `getActiveUsers`) showing
  a pure getter with five real callers and an empty `side_effects` array — placed last in
  `FEW_SHOT_EXAMPLES`, closest to the real input slot, to maximize recency reinforcement.
- [src/extension/cache/config.ts](../../src/extension/cache/config.ts) — bumped `PROMPT_VERSION`
  from `few-shot-v4` to `few-shot-v5` per Core Rule 10, with a comment documenting why. A prompt
  bump means a full re-index (all cached explanations regenerate on next access).

No schema, cache-layer, or extension-host logic changes — this is a pure prompt-text/few-shot-set
change plus its required version bump.

## Decisions made
- **Concrete before-set gathered first, not paraphrased from memory** (per the session brief's own
  instruction). Read sessions 19, 25, and 28's artifacts directly and pulled the exact real
  examples: `getPlayerParty` (real pokerogue, `src/battle-scene.ts:729`, one-line getter with 15
  real callers, hallucinated `["reading or writing a file", "sending a message or notification",
  "mutating a parameter or global"]`), `isEmpty<T>` and `handleLoginRoute` (TS fixture, same
  verbatim triad), and `findUserByEmail` (TS fixture, fabricated `"Reading or writing a file"` /
  `"Sending a message or notification"` for a function that only logs and returns `null`).
- **Diagnosed the common shape as "many real callers, but the body itself is pure/trivial"** — the
  existing `_EXAMPLE_1` (`isValidPort`) already demonstrated an empty `side_effects` array, but only
  for a function with *zero* callers/callees. None of the four existing examples showed a function
  that is clearly used (real, sometimes many, callers) yet still has no side effects — the exact gap
  session 28's own handoff had flagged as worth investigating. `_EXAMPLE_5` fills that specific gap
  rather than duplicating `_EXAMPLE_1`'s already-covered "isolated function" shape.
- **No bracketed/literal `WRONG`/`RIGHT` snippet added, per session 19's own established finding**
  that such snippets get echoed back verbatim by this 1.5B model regardless of the real function
  body. The fix stays prose-only (field-rule wording) plus a full worked few-shot example, the same
  pattern session 19 already validated.
- **Example 5 placed last in `FEW_SHOT_EXAMPLES`, not first or interleaved.** Deliberate: the real
  input slot immediately follows the last example, so recency should work in the fix's favor for
  the exact "many callers, still pure" pattern being targeted.

## Deviations from spec
None — implemented within the session brief's own scope (prompt.py wording + few-shot set +
required `PROMPT_VERSION` bump). One thing the brief anticipated but didn't mandate: an additional
full 15-function regression sweep on both fixtures (beyond the four originally-flagged functions),
run after the targeted re-checks surfaced a residual case on JS `isEmpty` (see Test status) — done
to get a real regression/reduction picture, not just confirm the four original examples improved.

## Test status
- `python -m pytest sidecar/tests/ -q`: **116 passed** (no test coupled to the exact few-shot
  example count or text; confirmed via `test-runner` agent).
- `npx tsc -p ./ --noEmit`: clean (confirmed via `test-runner` agent — only a version-string
  constant and its comment changed on the TS side).
- **Live re-verification against the exact real functions sessions 25/28 documented as
  hallucinating**, all against local Ollama (`qwen2.5-coder:1.5b`, `temperature=0` — repeats are
  near-deterministic, confirming reproducibility rather than sampling luck):
  - `getPlayerParty` (real `B:\pokerogue\src\battle-scene.ts:729`, 15 real callers): **before**
    `side_effects` was exactly the 3-phrase verbatim triad. **After, 3 independent runs:**
    `side_effects: []` every time, 0/3 boilerplate-triad notes. Fixed and reproducible on the real
    repo this was originally found on.
  - `handleLoginRoute` (TS fixture): **before** verbatim triad. **After, 2 runs, identical:**
    `side_effects: ["Database read", "Password hashing", "Event logging"]` — all three grounded in
    the function's real callees (`findUserByEmail`, `hashPassword`, `logEvent`). No triad note.
    Fixed.
  - `findUserByEmail` (TS fixture): **before** fabricated file/message-send effects. **After, 2
    runs, identical:** `side_effects: ["database read", "logging"]` — no fabricated file/message
    effects, no triad note. Fixed (though "database read" for a function that only does a lookup
    and returns `null` is a small residual over-read, a different and lesser issue than the
    original fabrication).
  - `isEmpty<T>` (TS fixture): **before** verbatim triad. **After, 2 runs, identical:**
    `side_effects: ["returns a boolean value based on the input"]` — no triad note. Fixed, though
    this specific wording is itself a minor pre-existing quality issue (describing a return value as
    a "side effect") that session 19 already flagged as out-of-scope and unrelated to this fix.
  - `isEmpty` (**JS** fixture, targeted `--functions isEmpty` run, not part of the ranked-15
    sample): **before** (session 25) a *different* hallucination (fabricated caller claim +
    return-value-as-side-effect). **After:** the fabricated caller claim is gone (`used_by: []`,
    correct), but `side_effects` came back as the exact 3-phrase verbatim triad, and the
    acceptance-test's own boilerplate-triad detector correctly fired. This is a genuine residual
    instance of the exact pattern this fix targets, on a near-identical function to the now-fixed TS
    `isEmpty<T>` (same shape: zero callers, zero callees, one-line boolean predicate) — confirms the
    fix reduces but does not eliminate the pattern; see Blockers.
- **Full 15-function ranked-sample regression, both fixtures, after the fix** (to check whether the
  JS `isEmpty` residual is isolated or systemic, and to confirm no new regressions elsewhere):
  - TypeScript (`fixtures/typescript/repomap`, `--limit 15`): **15/15 passed automated schema
    checks, 0 boilerplate-triad notes** — both of session 25's originally-flagged TS functions
    (`isEmpty<T>`, `handleLoginRoute`) are inside this ranked sample and came back clean.
  - JavaScript (`fixtures/javascript/repomap`, `--limit 15`): **15/15 passed automated schema
    checks, 0 boilerplate-triad notes.** `isEmpty` itself is low-importance (zero callers/callees)
    and does not appear in the ranked-15 sample for either language — its triad reproduction above
    was only found because it was targeted directly, matching how session 25 originally found it.
    No other function in either 15-function sample showed the triad pattern.

**Net result: the hallucination is measurably reduced, not eliminated.** All 4 originally-documented
instances (1 real-repo, 3 fixture) are fixed and reproducible-clean; both full ranked-sample
regressions (15+15 functions) show zero triad notes; but a direct retest of `isEmpty`'s JS
counterpart — the one specific function shape (zero-context, one-line boolean predicate) already
flagged in session 25 as recurring across languages — still reproduces the triad deterministically.

## Blockers / open questions
None blocking — the fix's own before/after evidence meets the session's "gone or measurably
reduced" bar. The JS `isEmpty` residual (below) is a known, narrow limitation, not a regression.

## Handoff for next session
- **The verbatim-category-triad hallucination still recurs on at least one function shape:
  zero-caller/zero-callee, one-line boolean-predicate functions** (confirmed live on JS `isEmpty`,
  deterministically at `temperature=0`). `_EXAMPLE_1` (`isValidPort`) already covers this exact
  shape with the correct empty-array answer, and `_EXAMPLE_5` (added this session) covers the
  "pure but has real callers" shape — neither fully closes the "isolated pure predicate" case for
  this specific model. A future session could try a second isolated-predicate few-shot example with
  different surface wording (e.g. a string/type check rather than a numeric range check, closer to
  `isEmpty`'s actual shape), but should weigh that against prompt length/context-budget cost and the
  fact that this is documented, cross-language model flakiness on trivial functions (session 25's
  own framing), not a deterministically fixable defect via prompting alone for a 1.5B model — full
  elimination may not be achievable without a heavier technique (e.g. a post-generation consistency
  check or a larger default model), which would be a materially bigger change than a prompt-only
  session.
- Any future prompt.py change must bump `PROMPT_VERSION` again per Core Rule 10 (now at
  `few-shot-v5`).
