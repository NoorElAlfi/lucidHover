# LucidHover — Session Briefs: Graph-View Follow-Ups (Fan-out cap, Branching trace, Cross-language validation, Manual smoke test)

*Paste-ready Claude Code session prompts. The log is currently at session 46 ("Execution trace,"
committed pending). These four sessions close out loose ends session 46's own artifact flagged as
real, not-yet-built follow-up work on the two graph-view features (blast radius, session 45;
execution trace, session 46) — not new scope invented here. `lucidhover-session-briefs-47-50_1.md`
(dashboard + Python adapter) is unchanged and still valid; per this repo's own numbering
convention, whichever batch of sessions actually runs next becomes 47 onward, in order. These four
are written assuming they run before the dashboard/Python track, the same way 45–46 were
prioritized ahead of it — reusing already-built graph machinery is cheap, and closing a session's
own documented gaps is lower-risk than opening new breadth. If the dashboard/Python track runs
first instead, renumber these four to follow it; nothing about their content depends on the number.

## Source-material note — read before using these

Every item below traces to a specific, already-recorded gap, not a new idea introduced here:

- **Fan-out cap** — session 45's own artifact ("Handoff for next session") flagged that
  `get_blast_radius` has no cap analogous to `get_function_context`'s `CALLER_CALLEE_CAP`, and
  session 45's `code-reviewer` pass raised the same point independently. Not observed as an actual
  problem against any real repo as of session 45; still open, unmeasured, as of session 46.
- **Branching execution trace** — session 46's own brief made the single-primary-path limitation an
  explicit, named scope cut ("Explicitly out of scope: Branching/alternate-path exploration UI —
  v1 is single-primary-path only... a real follow-up idea, not this session's job"). This is that
  follow-up.
- **Cross-language validation** — both session 45 and session 46's briefs explicitly scoped out
  "any second-language testing — JS/TS fixtures only." Sessions 24/25 already validated the core
  hover/CodeLens/panel surfaces on TypeScript; the two new graph-view enrichment paths
  (`blastRadiusCommand.ts`'s and `callTraceCommand.ts`'s `enrichNodes`/`closestResolved`) have not
  been run against the TypeScript fixture at all yet.
- **Manual GUI smoke test** — both session 45 and session 46's artifacts note the same recurring,
  documented gap: no interactive VS Code GUI is available in the environment these sessions ran in
  (same gap noted since session 43), so the panel's actual on-screen behavior (trigger buttons,
  pin/back state, placeholder rendering) has only ever been exercised through the automated
  integration test, never eyeballed by a human. Session 40 is this project's own precedent for how
  to close a gap like this — a real human driving a real Extension Development Host, with Claude
  guiding and independently verifying via direct DB/output-channel reads.
- **Sequencing reasoning**: the fan-out cap session is scoped to blast radius only and placed
  first, since it's small, independent, and already-flagged debt. The branching-trace session
  deliberately reuses whatever cap mechanism that session lands on, rather than the two sessions
  inventing two different caps for what's structurally the same problem (a graph walk whose
  per-node fan-out isn't bounded). The cross-language validation session runs after both feature
  changes land, so it validates the surfaces in their final shape, not a shape that's about to
  change again. The manual smoke test runs last, exercising everything built across the other
  three.

---

## Session 47 — Blast-radius fan-out cap

- **Kind:** fix · **Track:** Core
- **Owns:** `sidecar/repomap/context.py` (`get_blast_radius`), `sidecar/rpc_server.py`
  (`_handle_get_blast_radius`, if the omitted-count needs surfacing there), `src/extension/panel/blastRadiusCommand.ts`,
  `src/extension/panel/explanationPanelProvider.ts` (graph-view rendering, if an omitted-count
  needs displaying)
- **Subagents:** `test-runner`, `code-reviewer`

```text
Session 47 — Blast-radius fan-out cap.

Read only: the session-45 and session-46 artifacts, plus context.py's `_cap()` /
`CALLER_CALLEE_CAP` and `get_blast_radius()` as they exist today.

Goal: close session 45's own carried-forward gap -- `get_blast_radius` has no per-level
fan-out cap the way `get_function_context` has `CALLER_CALLEE_CAP`, so a high-fan-in real
function (session 44's own motivating example, `setVisible`, had 9+ colliding callers) could
in principle return a very large node/edge list at some depth. Not confirmed as an actual
live problem yet -- measure first, per sessions 28/29/33's evidence-based precedent, rather
than assuming a number.

1. Measure against a real repo (pokerogue, same fixture-of-convenience sessions 28/29/33/40
   already used) before deciding anything: pick a handful of real high-fan-in functions and
   run get_blast_radius against them at the existing max_depth=3, recording actual node/edge
   counts per level in the artifact. If nothing comes back large, say so plainly and still
   decide whether a cap is worth adding defensively (cheap insurance) or genuinely
   unnecessary (nothing to protect against) -- don't cap reflexively without recording the
   reasoning either way.

2. If a cap is warranted: add it in context.py's get_blast_radius, applied per-level (cap how
   many callers are expanded *at each depth*, not a single global cap on the whole walk --
   a global cap would silently bias toward whichever depth happens to be visited first).
   Reuse the existing CALLER_CALLEE_CAP constant/value unless your session-47 measurement
   shows a different number is actually justified for a multi-hop walk (a single-hop cap of
   15 applied at every one of 3 levels could still yield ~45 nodes -- decide if that's fine
   or if a smaller per-level number is warranted, and say why).

3. Report the omitted count the same way FunctionContext already does
   (callers_omitted/callees_omitted) -- BlastRadiusNode or a new field on BlastRadius itself
   should let the caller know "N more at this level were omitted," not silently truncate.

4. Thread the omitted count through _handle_get_blast_radius's response, blastRadiusCommand.ts,
   and the panel's existing depth-grouped renderGraph() -- an omitted count should render as a
   plain note under the relevant "Level N" section (e.g. "+3 more not shown"), not a new UI
   affordance.

Explicitly out of scope:
  - Execution trace / get_call_trace -- unaffected today (single-primary-path, one node per
    depth, nothing to cap yet). Session 48 (branching trace) is where this becomes relevant
    for that feature, and should reuse whatever mechanism this session builds rather than
    inventing a second one.
  - Any change to CALLER_CALLEE_CAP's existing single-hop behavior in get_function_context.
  - Any new setting/configuration -- same "measure first, don't add a knob preemptively"
    reasoning session 45's own MAX_DEPTH constant already used, unless your measurement in
    step 1 shows real variance across repos that a fixed default can't serve.

Done when: a real measurement against pokerogue is recorded in the artifact, a decision
(cap or no cap, and why) is made and implemented, and -- if a cap was added -- an omitted
node is verified live to surface an explicit "+N more" note rather than disappearing
silently.

Run test-runner, then code-reviewer, then write the artifact.
```

---

## Session 48 — Branching execution trace

- **Kind:** milestone · **Track:** Core
- **Owns:** `sidecar/repomap/context.py` (`get_call_trace` or a new sibling method),
  `sidecar/rpc_server.py`, `src/extension/panel/callTraceCommand.ts`,
  `src/extension/panel/explanationPanelProvider.ts` (`renderTrace()` or a new render mode)
- **Requires:** Session 47 complete — reuses its fan-out-cap-and-omitted-count mechanism rather
  than inventing a second one for the newly-branching trace.
- **Subagents:** `test-runner`, `code-reviewer`

```text
Session 48 — Branching execution trace.

Read only: the session-46 and session-47 artifacts.

Goal: close session 46's own named scope cut -- v1 execution trace follows only the single
highest-importance confident callee at each hop, silently swallowing every other real
downstream call. This session lets the user see the alternate branches too.

0. Real design decision, put to the user via AskUserQuestion before writing any code --
   this changes the RPC response shape and the panel's render code meaningfully, so don't
   default silently (same reasoning session 39/44 already used AskUserQuestion for a
   similarly shape-changing policy call):
     a. Keep the existing linear timeline as the default view, but let the user expand an
        inline "+N other calls from here" at any hop to see the non-primary confident
        callees, without leaving the timeline.
     b. Replace the linear timeline with a full downstream tree at every hop (mirroring
        session 45's blast-radius depth-grouped list, but over successors instead of
        predecessors) -- every confident callee shown, not just the top-ranked one, with the
        "primary path" no longer a distinct concept.
     c. Keep today's "Trace execution from here" trigger exactly as-is (primary path only),
        and add a second, independent trigger ("Explore all downstream calls") that opens a
        full-tree view via a separate RPC call.
   Record the choice and reasoning in the artifact.

1. Sidecar: extend get_call_trace (option a) or add a new method (options b/c) to expose
   every confident callee at each hop, not just the top-ranked one -- still depth-capped,
   still cycle-safe (same visited-node discipline as today), still confident-edges-only
   (Session 44's filter, unchanged). If a full-tree shape is chosen (b/c), mirror
   get_blast_radius's existing BFS-over-all-confident-edges shape onto successors instead of
   predecessors, rather than inventing a third graph-walk pattern from scratch.

2. Apply session 47's fan-out-cap-and-omitted-count mechanism to whatever new fan-out this
   session introduces -- a branching downstream walk has exactly the same "a high-fan-out
   node could return a lot of siblings" shape session 47 just measured and (maybe) capped for
   blast radius. Reuse the same constant/pattern; don't pick a new number without the same
   kind of real-repo measurement session 47 did.

3. RPC: extend or add a handler in rpc_server.py matching the shape chosen in step 0/1, same
   read_lock()/_find_def_tag pattern as every existing handler.

4. Extension host: extend callTraceCommand.ts's enrichment (or add a new command file,
   depending on the step-0 direction) -- same never-generate-on-a-cache-miss rule as today
   (Core Rule 4/9), no exception invented for branches. Every node shown, primary or
   alternate, goes through the identical enrichNodes path.

5. Panel: extend renderTrace() (or add a new render mode per the step-0 decision) to show the
   additional branches, reusing renderGraphNode()'s existing cached/uncached-placeholder
   rendering for every node -- branch nodes get the same "Not yet indexed." treatment primary
   nodes already do, no separate code path.

Explicitly out of scope:
  - Blast radius (upstream) -- already a full multi-caller BFS since session 45, this session
    only touches the downstream trace's single-primary-path limitation.
  - Any new LLM/generation call, under any circumstance -- same undodgeable rule as session 46.
  - Any second-language testing -- session 49.

Done when: for at least one real hop in a real indexed workspace where a function calls more
than one thing downstream, the user can see and inspect the non-primary branch(es) via
whatever UI direction step 0 chose -- not just the highest-importance one silently swallowing
the rest -- and the fan-out cap from session 47 is confirmed to apply to the new branching
data too.

Run test-runner, then code-reviewer, then write the artifact.
```

---

## Session 49 — Graph-view cross-language validation pass (TypeScript)

- **Kind:** audit · **Track:** Core
- **Owns:** `src/extension/__tests__/`, potentially `fixtures/typescript/` if a gap in fixture
  coverage is found (extending, not replacing — see step 1)
- **Requires:** Sessions 47–48 complete — validates the graph-view features in their final
  shape, not a shape about to change again.
- **Subagents:** `test-runner`, `code-reviewer`

```text
Session 49 — Graph-view cross-language validation pass (TypeScript).

Read only: the session-25 artifact (the last cross-language validation pass, for its
methodology), plus the session-45/46/47/48 artifacts.

Goal: sessions 45/46/47/48 all explicitly scoped out "any second-language testing" -- this
is that follow-up, applied specifically to the two graph-view features (blast radius,
execution trace, and its branching mode if session 48 built one), not a re-validation of
already-covered surfaces (hover/CodeLens/gutter were already validated on TypeScript by
sessions 24/25).

1. Check fixtures/typescript/ for a real multi-hop call chain (both upstream fan-in and
   downstream fan-out, ideally spanning a class method, an arrow-const, and a free function --
   the three shapes session 25 found real fnId/resolution differences between) suitable for
   exercising both graph views. If the existing fixture doesn't have one, extend it (don't
   replace fixtures/REQUIREMENTS.md's existing structural counts) with the minimum needed.

2. Run get_blast_radius and get_call_trace (sidecar-side) against the TypeScript fixture
   directly -- confirm confident-edge resolution, depth-capping, and (session 47/48-dependent)
   fan-out-cap behavior all produce correct results on TS-specific def shapes the JS fixture
   doesn't exercise (arrow-const assignments in particular, per session 25's own found bug in
   isFunctionLike -- confirm that fix's coverage extends to the graph-walk paths, not just
   the original single-hop context path it was found in).

3. Run blastRadiusCommand.ts's and callTraceCommand.ts's enrichment path
   (enrichNodes/closestResolved/resolveFunctionsInFile) against the TypeScript fixture inside
   a real Extension Development Host integration test (same shape as the existing
   blastRadiusCommand.test.ts/callTraceCommand.test.ts, parameterized for TS or a new sibling
   file) -- confirm nearest-line resolution and fnId/fnHash matching work correctly on TS
   node shapes, not just JS ones.

4. If session 48 built a branching trace UI, include at least one TS-fixture case with a
   real multi-callee hop to confirm the branching data enriches and renders correctly there
   too, not just on the JS fixture used to build it.

Explicitly out of scope:
  - Any third-plus language.
  - Re-validating hover/CodeLens/gutter/panel's single-hop surfaces on TypeScript -- already
    covered by sessions 24/25, not this session's job.
  - Any prompt/few-shot change -- these features are graph-only, no LLM call, so there is
    nothing few-shot-shaped to validate here.

Done when: both graph views (and branching, if applicable) are confirmed correct against a
real TypeScript call chain via both a sidecar-level test and a real-Extension-Development-Host
integration test, with any TS-specific bug found and fixed (not just documented) before the
session is called complete.

Run test-runner, then code-reviewer, then write the artifact.
```

---

## Session 50 — Manual GUI smoke test: graph views

- **Kind:** audit · **Track:** Core
- **Requires:** Sessions 47–49 complete, plus a real interactive VS Code GUI (a real Extension
  Development Host window) — not available in every environment these sessions run in. If no GUI
  is available, this session cannot proceed; say so plainly rather than substituting another
  automated test pass for it (that's what sessions 47–49 already did).
- **Subagents:** none — this is a human-in-the-loop session, same shape as session 40.

```text
Session 50 — Manual GUI smoke test: graph views.

Read only: the session-40 artifact (this project's own precedent for how to run a manual
smoke test), plus the session-45/46/47/48/49 artifacts.

Goal: close the recurring, explicitly-documented gap noted since session 43 and repeated in
every graph-view session since -- the blast-radius and execution-trace panel UI has only ever
been exercised through automated integration tests inside a headless-ish Extension
Development Host, never actually looked at by a human. Confirm it looks and behaves right,
not just that the underlying data is correct.

Drive a real Extension Development Host against a real indexed workspace (fixtures/javascript
or a real repo, your choice) with the user, and independently verify each step's claimed
result via a real DB/output-channel read where applicable -- same rigor session 40 used.
State the expected result for every step before performing it (label each step "Expected:"),
per this project's own established convention for manual-test instructions, so the user can
tell a pass from a fail without guessing.

Steps to cover, each with a stated Expected result:
  1. Hover a function with a cached explanation; confirm the "See full blast radius ->" and
     "Trace execution from here ->" triggers both render in the docked panel.
  2. Click "See full blast radius ->"; confirm the panel pins to a depth-grouped upstream
     list and does NOT change when the cursor moves to a different function.
  3. Click "<- Back"; confirm the panel un-pins and resumes cursor-synced behavior.
  4. Click "Trace execution from here ->" from a function with a real multi-hop downstream
     chain; confirm the panel pins to a linear timeline (not a depth-grouped list) showing
     "root (start)" followed by "-> calls" connectors.
  5. Find or create (in a scratch file) a function whose downstream/upstream chain includes
     at least one not-yet-indexed function (e.g. edit a file, add a new function, and
     immediately trigger blast radius or trace before background indexing reaches it);
     confirm that function renders as an explicit "Not yet indexed." placeholder, and --
     checked via the LucidHover output channel or an ExplanationCache row count before/after
     -- confirm no generate_explanation call fired as a result of viewing it.
  6. If session 48 built a branching-trace UI: exercise it on a function with more than one
     confident downstream callee; confirm the non-primary branch(es) are visible and
     enrich/render correctly.
  7. If session 47 added a fan-out cap: find or construct a function with enough callers to
     exceed the cap at some depth; confirm the panel shows an explicit "+N more" note rather
     than silently truncating.

Explicitly out of scope:
  - Any code change -- this is a verification-only session. If a real bug is found, record it
    plainly in the artifact as a new, separate follow-up rather than fixing it inline (same
    "audit sessions don't also become fix sessions" convention this project already follows,
    e.g. sessions 28/29/33/40).

Done when: every step above has been performed against a real Extension Development Host with
its Expected result confirmed or a real discrepancy recorded, not skipped for lack of a GUI.

No test-runner/code-reviewer subagents needed -- this session produces no code. Write the
artifact directly, recording pass/fail per step.
```
