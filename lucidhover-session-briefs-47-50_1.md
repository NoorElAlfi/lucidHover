# LucidHover — Session Briefs 47–50 (Dashboard + Python adapter)

*Paste-ready Claude Code session prompts. Originally drafted as sessions 45–48; renumbered to
47–50 after a later planning pass decided two new sessions — blast radius and vertical slice
(`lucidhover-session-briefs-45-46-graph-features_1.md`) — should run first as the real 45–46,
since they're cheaper (reusing session 37/38/44's already-built graph machinery) and add new
understanding-power rather than breadth (Python) or ops polish (dashboard). Nothing about the
four sessions below changed except their numbers — read them in that light: whichever of these
four actually runs first becomes session 47, in order, same convention as before.*

## Source-material note — read before using these

I could not locate three things the source items (originally handed to me as Build Order items
26–29) referenced, in this repo:

- **`§1.4`** (session 47, "read cache stats directly from explanationCache.ts... (§1.4)") — no
  file in this repo uses that section-numbering scheme. I've written session 47 against the
  *actual current state* of `explanationCache.ts`/`backgroundIndex.ts` instead (checked live, not
  guessed): neither file exposes any stats/count/progress method today, so this is real,
  un-shortcuttable scope, not a thin wrapper around something that already exists.
- **"the roadmap's own undecided design note"** for the dashboard's panel-vs-status-bar choice
  (session 48) — not found anywhere in this repo either. Session 48 below treats this as a literal
  blocking pre-req, per the item's own instruction, rather than picking one on your behalf.
- **A "dogfooding gate" session artifact** — `lucidhover-session-briefs-20-25_1.md`'s own plan
  called for a dedicated two-week-friction-log gate session (also numbered 26 in *that* doc's
  numbering — a coincidence, not the same "26" as anything here) before any post-gate work,
  including dashboard/Python, could be scoped. I see no session artifact for a dedicated gate. You
  may consider it informally satisfied — sessions 26–43 in the real log include multiple real-repo
  audits against pokerogue (28, 29, 33, 40) that function as de facto dogfooding — but I'm flagging
  the gap rather than silently assuming that's equivalent, since the original plan treated the gate
  as a hard prerequisite, not optional.

**One correction I made to the source text rather than carrying it forward verbatim:** the
original item 26 text says "the sidecar's RPC dispatch is strictly one-request-at-a-time." That
was true through session 36 but is no longer true — session 37 made dispatch concurrent (each
request gets its own worker thread, gated by a readers-writer lock, Core Rule 11). The conclusion
it draws from that premise ("piggyback on the existing heartbeat rather than polling") is still
correct, just for a different, still-current reason: Core Rule 11 says exactly this already
("piggyback on the existing heartbeat rather than adding a polling loop, and keep background work
throttled and client-side-priority-gated"). Session 47 below cites Core Rule 11, not the stale
one-at-a-time framing.

**One thing I *did* find, that materially changes session 48's pre-req:** "Open Question 11" is
cache GC, recorded in `lucidhover-session-briefs-20-25_1.md`'s "Known post-gate work" section:
*"On index completion, drop rows whose fnId isn't in the current symbol set or whose
prompt_version/model_id don't match current config. Separate from the dashboard's user-facing
'clear cache' button, which stays a blunt delete-all."* This is **partially built**: session 39
shipped a narrower auto-evict (same fnId/model/embedding/prompt tuple, superseded-row-only) plus a
manual purge command, but its own artifact documents the gap Q11 actually asks about as a known,
undone limitation — *"cross-tuple orphans from a version bump are never auto-cleaned, by design."*
The "drop rows whose fnId isn't in the current symbol set" half (a function renamed/deleted) doesn't
exist at all yet. Session 48 below treats Q11 as **not yet fully resolved** and says so explicitly,
rather than assuming session 39 already closed it.

**Also now current:** session 44 (this repo's most recent) fixed the sidecar's call-graph
resolver so an ambiguous name only counts as a confident caller/callee if it's unambiguous or has
a same-file match (`sidecar/repomap/graph.py`'s `confident` edge flag). That machinery is
language-generic — session 49 (Python adapter) inherits it automatically once Python tags flow
through the same `graph.py`/`context.py` path JS/TS already use. No extra work needed there; noted
so session 49 doesn't waste time re-diagnosing a since-fixed issue if it shows up in Python
call-graph output during validation.

---

## Session 47 — Dashboard data collection

- **Kind:** milestone · **Track:** Core
- **Owns:** `src/extension/cache/explanationCache.ts`, `src/extension/backgroundIndex.ts`,
  `src/extension/sidecar/sidecarManager.ts` (heartbeat path), `sidecar/rpc_server.py` (`status`
  handler)
- **Subagents:** `test-runner`, `code-reviewer`

```text
Session 47 — Dashboard data collection.

Read only: this brief's "Source-material note" above, plus explanationCache.ts,
backgroundIndex.ts, and sidecarManager.ts's heartbeatTick() as they exist today.

Goal: give session 48's (not-yet-built) dashboard UI real numbers to render. No UI in this
session -- this is pure data plumbing, extension-host-owned per Core Rule 9 (the sidecar
generates and returns data; it never reports cache state itself).

1. ExplanationCache.getStats(): a new method, pure SQLite query against the existing cache
   DB (no schema change). At minimum: total row count, DB file size on disk, and a
   breakdown by (model_id, embedding_model_id, prompt_version) tuple -- that breakdown is
   what will make Session 39's known, documented gap visible (cross-tuple orphans from a
   prompt/model version bump are never auto-cleaned; see this brief's source-material note
   on Open Question 11). This session surfaces that number. It does not fix it.

2. BackgroundIndexManager currently exposes only `running: boolean` -- no progress at all.
   Add remaining-vs-total function count tracking (you'll need the ranked function list's
   length as "total" and a running counter as indexing proceeds).

3. Wire indexing-backlog reporting onto the EXISTING heartbeat cadence
   (sidecarManager.ts's heartbeatTick(), sidecar/rpc_server.py's "status" handler) as one
   additional field on the existing response. Do not add a new RPC verb and do not add a
   new poll loop -- Core Rule 11 is explicit that anything new competes for the same real
   resource (Ollama's own concurrency, or lack of it) as existing interactive/background
   traffic, and says to piggyback on the heartbeat specifically.

4. Expose {cache stats, indexing backlog} as a plain object obtainable on demand plus an
   event for change -- mirror explanationCache.ts's existing onDidWrite listener pattern
   rather than inventing a new subscription shape.

Explicitly out of scope:
  - Any UI. Session 48 renders this; this session only makes the numbers obtainable.
  - The clear-cache / force-reindex actions themselves -- operational actions, session 48.
  - Fully resolving Open Question 11 (cache GC on index completion for orphaned fnIds and
    cross-tuple rows). This session surfaces the number via stats; building the actual GC
    is a separate, smaller session per the original plan's own framing ("its own small
    session"), not a silent side effect of adding a stats method.

Done when: a stats object with real numbers is obtainable from explanationCache.ts, and
indexing-backlog numbers ride the existing heartbeat, both verified against a real indexed
workspace (not a mocked count) -- no new RPC verb, no new polling loop.

Run test-runner, then code-reviewer, then write the artifact.
```

---

## Session 48 — Dashboard UI, clear-cache, force-reindex

- **Kind:** milestone · **Track:** Core
- **Owns:** new UI surface (path depends on the pre-req decision below — likely a new
  `src/extension/dashboard/` if panel, or an addition to an existing status-bar owner if not),
  `package.json` (new view/command contributions), `src/extension/cache/explanationCache.ts`
  (delete-all path), `src/extension/backgroundIndex.ts` (force-reindex entry point)
- **Requires:** Session 47 complete. **Two pre-reqs this session's own source item names as
  blocking, not to be decided mid-session** — resolve both *before* starting:
  1. Panel vs. status-bar item for the dashboard surface. I could not find "the roadmap's own
     undecided design note" this was meant to be resolved against in this repo — if you have it
     elsewhere, resolve against it; otherwise this needs a real decision first (an `AskUserQuestion`
     at the start of the session is the right tool, matching session 39's precedent for an
     un-guessable policy call, not a coin flip baked into the session).
  2. Open Question 11 (cache GC) is **not** fully resolved — see this doc's source-material note.
     Decide explicitly whether the smarter GC (orphaned-fnId + cross-tuple cleanup on index
     completion) is (a) built as its own small session *before* this one, (b) deferred and this
     session's "Clear Cache" stays the only cleanup lever for now, or (c) something else. Don't let
     the answer default silently to (b) just because it's the path of least resistance.
- **Subagents:** `test-runner`, `code-reviewer`

```text
Session 48 — Dashboard UI, clear-cache, force-reindex.

Read only: the session-47 artifact, plus this brief's two pre-req decisions above -- both
must already be resolved before this session starts, not during it.

Goal: a real, visible dashboard surface rendering session 47's data, plus the two
operational actions.

1. Build the UI surface per the resolved panel-vs-status-bar decision, rendering session
   47's cache stats + indexing backlog. Pure display -- no new data collection here;
   if you find yourself computing a number session 47 didn't already expose, that's a
   session-47 gap, not something to silently patch here.

2. "Clear Cache": a blunt delete-all against the cache DB, per the original design's own
   explicit framing -- deliberately NOT the smarter Open-Question-11 GC (that's narrower,
   automatic, and either already handled per your pre-req decision above or explicitly
   still open). This is a destructive, irreversible action -- require an explicit
   confirmation step in the UI itself before it runs, not a single click.

3. "Force Reindex": trigger BackgroundIndexManager on demand. Must still gate on Workspace
   Trust (Core Rule 6) and respect the existing interactive/background priority gate
   (sessions 32/36's SidecarManager.waitForInteractiveIdle) rather than bypassing it just
   because the user explicitly asked for it -- a forced reindex is still background-
   priority work competing for the same sidecar/Ollama resource as everything else.

Explicitly out of scope:
  - Any new cache-stats or backlog computation -- session 47 already built it.
  - Building out Open Question 11's smarter auto-GC, unless your pre-req decision above
    chose to fold it in here explicitly.
  - Any change to explanationCache.ts's write()/purgeSupersededRows() logic beyond adding
    the delete-all path.

Done when: the dashboard surface renders real numbers from a real indexed workspace, Clear
Cache empties the DB after confirmation, and Force Reindex actually re-runs indexing
without starving a concurrent interactive request.

Run test-runner, then code-reviewer, then write the artifact.
```

---

## Session 49 — Python adapter

- **Kind:** milestone · **Track:** language
- **Owns:** `sidecar/repomap/adapters/`, `languages.json`, `package.json` — same ownership shape
  as session 24's TypeScript adapter
- **Subagents:** `repo-researcher`, `test-runner`, `code-reviewer`

```text
Session 49 — Python adapter.

Read only: the session-25 artifact (last language-track session), and
docs/language-surface-audit.md Section 4 ("[Decided -- Q3] Evidence: how
functionResolution.ts obtains symbols"). Also worth knowing going in: session 44 fixed the
sidecar's call-graph resolver so ambiguous same-named refs no longer fan out to every
unrelated match (sidecar/repomap/graph.py's `confident` edge flag) -- this applies
generically to any language using graph.py/context.py, including Python, with no extra
work needed here.

Goal: Python as a supported language, end to end -- manifest entry, sidecar adapter, AND
the document-symbol-provider decision Section 4 explicitly left open. Correction to how
this was originally scoped: session 20 did not conclude "require the Python extension" --
it declined to decide at all and named this session as the one that has to. Don't treat
"require Pylance" as a given; it's one of (at least) three real options, decide among them
here.

1. Manifest: add the Python entry to languages.json -- extensions (.py), grammar,
   tag-query file, exclusion patterns (__pycache__, .venv, venv -- already anticipated in
   docs/language-surface-audit.md's exclusions.dirs discussion).

2. Sidecar: the Python adapter. Delegate to repo-researcher first: "What does Aider's
   Python tag-query file capture, and how does it differ from JavaScript/TypeScript's?"
   Reuse rather than rewrite where the two overlap, per Core Rule 3.

3. The document-symbol-provider decision (the actual open item, not a formality): VS Code
   ships no built-in document/workspace symbol provider for Python -- functionResolution.ts
   and explanationPanelProvider.ts's navigation fallback both depend on
   executeDocumentSymbolProvider / executeWorkspaceSymbolProvider, which return nothing for
   Python unless a provider (Pylance or equivalent) is registered. Decide, explicitly, one
   of:
     a. Require the Python extension -- if chosen, build the missing-dependency UX: detect
        no provider is registered for a .py document and surface a clear message (not a
        silent empty hover), per docs/language-surface-audit.md Section 4's own framing of
        the risk ("no error, no fallback, no way to distinguish 'genuinely no function
        here' from 'no symbol provider registered at all'").
     b. Degrade gracefully without it -- define concretely what "degrade" means for each of
        hover/CodeLens/gutter/panel, not just "does nothing."
     c. Make it conditional per the `resolutionStrategy` manifest field session 20/21
        already designed a hook for.
   Record the decision and reasoning in the artifact; this is the actual deliverable this
   session was named for, not a side note.

4. Extension host: add the matching package.json activationEvents entry. Per session 24's
   own precedent, if extension-host code needs more than the manifest entry + the
   activationEvents line + whatever the symbol-provider decision above requires, say so
   plainly in the artifact rather than working around it silently.

Explicitly out of scope:
  - Running the Tier 2 acceptance pass and judging quality -- session 50.
  - Any prompt or few-shot changes -- session 50, if TS's precedent holds.
  - Rust, Go, or any further language.
  - Building real LSP-wrapped cross-file resolution (Core Rule 3's post-MVP tier) even if
    option (c) above is chosen -- conditional-per-manifest just needs the hook wired, not
    the LSP client itself.

Done when: the manifest-agreement test passes with Python added, the sidecar produces a
ranked call graph over a real Python source tree, and the document-symbol-provider
question has a recorded decision with real reasoning, not a placeholder.

Run test-runner, then code-reviewer, then write the artifact.
```

---

## Session 50 — Python fixture and validation pass

- **Kind:** milestone · **Track:** language
- **Owns:** `fixtures/python/`, `sidecar/generation/`, `src/extension/cache/config.ts`,
  `src/extension/__tests__/`
- **Subagents:** `test-runner`, `code-reviewer`
- **Requires Ollama running with the model pulled.** If session 49 chose option (a) (require
  Pylance), also requires the Python extension installed and active in whatever environment runs
  the acceptance/integration checks — a new external test-harness dependency worth confirming is
  actually available before this session starts, not discovered mid-session.

```text
Session 50 — Python fixture and validation pass.

Read only: the session-49 artifact and fixtures/REQUIREMENTS.md.

Goal: decide whether Python support is actually good, not just wired up -- same bar as
session 25's TypeScript validation pass.

1. Fixture: fixtures/python/, built to every requirement in fixtures/REQUIREMENTS.md, with
   Python-specific constructs the JS/TS fixtures cannot exercise: decorators (including at
   least one that wraps a function meaningfully, not just @staticmethod), async/await
   (async def + await call sites), and a deliberate class-methods-vs-free-functions split
   (instance methods, @classmethod, @staticmethod, and module-level functions all present,
   since fnId derivation and the call graph need to handle all four identically).

2. If session 49 chose to require Pylance (or any symbol-provider dependency): verify the
   missing-dependency UX actually fires correctly when the dependency is absent, not just
   that the happy path works when it's installed. This is real coverage, not a formality --
   it's the exact gap Section 4 flagged as currently undetectable.

3. Tier 2 acceptance pass: run scripts/acceptance_test.py against the Python fixture at the
   standard bar (8/10-15 hovers correct and non-obvious). Record the actual hovers and
   per-hover judgment in the artifact, same as session 25.

4. fnId stability on Python shapes. Session 18's relFile::enclosingScopeQualifiedName
   scheme was validated on JS, stress-tested on TS by session 25 -- Python is the next
   stress test. Verify identity is stable across line-shifting edits for: decorated
   functions (does the decorator line count toward the qualified name or not -- pick one,
   document it, test it), async functions, and nested class methods. Write these as unit
   tests, not a manual check.

5. Few-shot transfer, same shape as session 25 check 3: does the model describe Python
   idioms correctly (decorators, context managers, comprehensions) or default to
   JS/TS-flavored phrasing? If it does not transfer cleanly, add one Python-specific
   few-shot pair (not a rewrite) and bump the global PROMPT_VERSION, recording the version
   transition the way sessions 19/25/42 did. Re-run check 3 after the change.

Explicitly out of scope: any third-plus language; touching the adapter interface or
manifest schema; any cache-key composition change beyond the expected PROMPT_VERSION bump
if the few-shot check requires one.

Done when: the acceptance result is recorded with per-hover judgments against the final
prompt, the fnId tests exist and pass, the few-shot question is closed either way, and (if
applicable) the missing-symbol-provider UX has real test coverage, not just the happy path.

Run test-runner, then code-reviewer, then write the artifact.
```
