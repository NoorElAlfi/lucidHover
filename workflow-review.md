# LucidHover — AI Workflow Review (CLAUDE.md + subagents)

*Reviewed against `lucidhover-current-state.md` (Session 19) and the reconciled Build Order.
Companion to `lucidhover-session-briefs-20-25.md` and the three replacement agent files.*

The setup is well-built. The session-artifact pattern, the "read only the most recent artifact"
rule, the file-ownership table, and three read-only reporting subagents that never write are all
doing real work — that last one especially: **no subagent has `Write` or `Edit`, so every mutation
flows through the main session, which is what keeps the file-ownership table meaningful.** Keep that
invariant.

What follows is drift. Nineteen sessions changed the architecture; the instructions changed with it
in some places and not others.

---

## 1. The one that's actively costing you: `code-reviewer` contradicts Core Rule 4

`code-reviewer.md` rule 2:

> Hover provider path must never call an LLM synchronously — cache lookup only.

`CLAUDE.md` Core Rule 4:

> On a cache miss, hover falls through to a synchronous `generate_explanation` call as a deliberate,
> narrow fallback (decided in Session 9, confirmed still in effect in Session 17)

These cannot both be followed. Core Rule 4 was amended twice to track what session 9 actually built;
the reviewer's rule 2 still holds the pre-session-9 wording. So the compliance gate you run at the
end of every session flags your deliberate, twice-confirmed architecture as a violation — every
time it touches hover code. That trains you to discount the reviewer's output, which is the worst
possible failure mode for a gate.

The correct invariant is narrower, and you already have it encoded in a test — current-state
describes an integration test for "hover's cache-hit-never-touches-sidecar guarantee." Two rules,
not one:

- On a **cache hit**, hover renders from the cached row and must not touch the sidecar.
- The **docked panel** render path has no fallback at all, ever — pure cache lookup.

Fixed in the replacement `code-reviewer.md`.

**Second drift in the same file, rule 5:** "File-watcher-triggered re-indexing must be debounced
(~500ms-1s), not immediate." Session 12 replaced save-debouncing-only with a five-layer trigger model
(dirty-tracking → debounced save → 25s periodic flush → git hooks → manual). A git-hook-triggered
reindex is immediate *by design*. Rule 5 as written flags it.

---

## 2. CLAUDE.md Core Rule 7 now instructs the opposite of what you want

> 7. **Respect the v0/post-MVP split.** Sessions 1-8 build only what's in the v0 Definition of Done
>    table. Do not pull forward post-MVP scope (embeddings retrieval, custom Ollama tier, full
>    layered triggers, CodeLens/gutter icons, etc.)

Every item in that "do not pull forward" list shipped in sessions 11, 14, 12, and 10 respectively.
A session-20 agent reading this rule literally would treat existing, shipped subsystems as forbidden
future scope. The rule's *intent* — don't pull scope forward — is still exactly right and is the
thing that kept 19 sessions honest. It just needs a referent that isn't a completed milestone.

**Replacement text for rule 7:**

```markdown
7. **Respect the current milestone boundary.** Build Order steps 1-17 are complete; the current
   plan is the reconciled Build Order continuing from session 20. Each session prompt names its
   step and its explicit out-of-scope list. Do not pull forward work from a later step even if it
   seems like a small addition — the out-of-scope list in the session prompt is binding, and
   anything you notice but don't build goes in the artifact's "Handoff for next session".
```

Same for the "What this project is" section, which still says the v0 Definition of Done "defines
the current milestone scope until it passes its acceptance test." It passed, at session 8.

**Replacement text:**

```markdown
## What this project is

See `codebase-explainer-vscode-extension.md` (v7) for the full spec, and
`lucidhover-current-state.md` for what actually exists today — where the two disagree about the
present, current-state wins. Do not re-read either in full every session; the session prompt names
the relevant section, and the most recent artifact in `.claude/sessions/` carries the live handoff.
```

---

## 3. Three architectural facts that are load-bearing but written down nowhere

Each of these is a constraint a session agent can violate while following every existing rule. One
of them was already violated in planning — the health-dashboard draft proposed having the sidecar
report cache stats, which it cannot do.

**Add as Core Rules 9-11:**

```markdown
9. **The SQLite cache is owned by the extension host, not the sidecar.** The sidecar generates and
   returns explanation JSON; the extension host computes the cache key and performs every read and
   write. Never add a code path that has the sidecar open, read, or write the cache database, and
   never design a feature that expects the sidecar to report cache state.

10. **Any change to prompt text bumps `PROMPT_VERSION`.** It flows into the cache key, so a prompt
    edit without a version bump silently serves stale explanations generated by the old prompt.
    This includes few-shot examples, not just the instruction body. Say in the artifact what the
    version went from and to (precedent: session 19, `few-shot-v3` → `few-shot-v4`) and note that a
    bump means a full re-index.

11. **The sidecar's RPC dispatch loop is strictly one request at a time.** Anything that adds a new
    RPC — background work, status polling, a new feature's lookup — competes with interactive hover,
    save, and refresh requests. Piggyback on the existing heartbeat rather than adding a polling
    loop, and keep background work throttled the way background indexing already is.
```

---

## 4. Session log: add a `Kind` column

The table already carries this information as inline prose — sessions 18 and 19 both end with a
parenthetical explaining they aren't build-order milestones. That's a column trying to exist. It
also settles the numbering question current-state raised, without inventing a second scheme:

```markdown
| # | Kind | Milestone | Status | Artifact |
|---|---|---|---|---|
```

`Kind` ∈ `milestone` | `fix` | `audit` | `gate`. Numbering stays global and monotonic — one line of
work, one counter — and "was this a Build Order step?" becomes a column lookup instead of a reading
comprehension exercise. Backfill 18 and 19 as `fix`. The dogfooding period gets a `gate` row with a
number so it can't be skipped silently.

---

## 5. File-ownership table: missing lanes

Directories in the current module map with no owner row, several of which sessions 20-25 touch
directly:

```markdown
| CodeLens + gutter providers | `src/extension/codelens/` |
| Sidecar supervision (spawn/heartbeat/recovery) | `src/extension/sidecar/` |
| Prompt, schema, generation | `sidecar/generation/` |
| Embeddings + retrieval | `sidecar/retrieval/` |
| Language adapters + registry (from session 21) | `sidecar/repomap/adapters/` |
| Extension-host language registration (from session 22) | `src/extension/languages.ts` |
| Activation + contributed language surface | `package.json` |
| Fixture repos | `fixtures/` (one subdirectory per language) |
| Acceptance + utility scripts | `scripts/` |
```

`package.json` is the important one. It is the single most contended file in the whole language
track — activation events, contributed commands, settings, and provider registration all land there
— and it currently belongs to nobody.

---

## 6. `test-runner` doesn't know two of your four test suites

Its instructions name "unit tests for hashing/cache-key logic, or `@vscode/test-electron`
integration tests." Current-state lists four suites: those two, plus the **79-test pytest suite in
`sidecar/tests/`** and `scripts/acceptance_test.py`.

Sessions 21, 23, 24, and 28-30 are all substantially Python sidecar work. As written, this agent
would run the TypeScript suites, report green, and never touch the Python tests covering the code
that just changed. On a haiku model with a vague "depending on what changed," that's not a judgment
call it can be expected to get right.

The replacement gives it a deterministic path-to-suite mapping it reads off `git diff --name-only`
rather than inferring, and tells it explicitly **not** to run `acceptance_test.py` — that one needs
Ollama running with the model pulled and takes real time, so it should be surfaced as "required, not
run" for you to trigger deliberately.

Haiku is still the right model for it once the routing is a table lookup instead of a judgment.

---

## 7. `repo-researcher` needs a fourth topic for the language work

It's the best-designed of the three — "never dump full file contents back to the main session" is
exactly the right context-hygiene rule, and it's why this agent exists at all. But its topic list
covers Aider's `repomap.py`, Continue.dev's indexing, and Serena's LSP wrapping. Sessions 21, 24,
and 28 all need something not on that list: **how Aider structures its per-language tag-query files**
— the `.scm` query file convention, how queries map to the tag types the ranker consumes, and which
languages ship with usable queries. Added in the replacement.

Worth noting it has `WebFetch` but no `Bash`, so it can read cloned repos but cannot clone one. If
the `reference/` clones from earlier sessions are still on disk that's fine; if they were cleaned up
along with the worktrees at session 19, re-cloning is a main-session step before you delegate.

---

## 8. Two smaller notes

**`code-reviewer` holds `Bash` while described as read-only.** It only needs it for `git diff`, and
in practice that's what it does — but the grant is wider than the contract. If you want the contract
enforced rather than trusted, the main session can run `git diff > /tmp/session-diff.patch` and hand
the reviewer `Read` only. Minor; noted rather than recommended.

**`code-reviewer` is your only gate on the non-negotiable rules**, and it runs on sonnet. That's a
defensible cost tradeoff, not an error. But it's the one place in the loop where a miss ships, so
it's the first place worth spending a stronger model if you ever want to.

---

## 9. What I did *not* change

- The artifact template. It's good, it's been followed 19 times, and its "Handoff for next session"
  field is what makes the one-session-one-milestone rule survivable.
- Core Rules 1-6 and 8. All still accurate, all still load-bearing. Rule 4's history — amended in
  session 17 to match what session 9 built, with both session numbers cited inline — is the model
  for how the rest of this file should be maintained.
- The read-only, no-write subagent design.
