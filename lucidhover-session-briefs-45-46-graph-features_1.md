# LucidHover — Session Briefs 45–46 (Blast radius + Vertical slice)

*Paste-ready Claude Code session prompts, matching the format of
`lucidhover-session-briefs-45-48_1.md`. The log is currently at session 44 ("Ambiguous
caller/callee confidence fix," committed `d72c583`). A brainstorming/planning conversation
concluded these two — not the already-drafted dashboard/Python work — should run next: they're
cheaper (mostly reusing session 37/38/44's already-built and live-verified graph machinery), and
they add genuinely new understanding-power rather than more breadth (Python) or ops polish
(dashboard). `lucidhover-session-briefs-45-48_1.md` is unchanged and still valid — its four
sessions simply become 47–50 whenever they run, per this repo's own numbering convention
("whichever ... runs first becomes session 45, in order").*

## Source-material note — read before using these

These two sessions are new scope with no prior planning-doc source text to reconcile against
(unlike the 45–48 dashboard/Python briefs, which corrected a handed-down source document). Every
design decision below was checked live against the current repo, not guessed:

- **Both features are graph-only, no new LLM call.** Confirmed by reading `context.py` and
  `rpc_server.py`: `RepoMap.get_function_context()` already does exactly this shape of thing
  (a read-locked graph query, no Ollama call) for the existing `used_by`/`calls` fields. Blast
  radius and vertical slice extend that same pattern to a multi-hop walk instead of one hop.
- **Both must filter on the `confident` edge flag (session 44)**, the same way
  `get_function_context()` already does — without it, either feature would fan out through
  every name-collision false positive PageRank tolerates for ranking purposes but which session
  44 explicitly decided should never be shown as a specific function's asserted real
  caller/callee.
- **Core Rule 9 applies to both RPCs' return shape.** The sidecar owns graph facts
  (`rel_fname`/`name`/`line`/`importance`) only — it must never look up or return cached
  `role_tag`/`one_liner`/explanation data, since the cache is extension-host-owned. Both briefs
  below make this an explicit two-step design: sidecar returns bare graph structure; the
  extension host enriches each node from its own `ExplanationCache` afterward, rendering
  uncached nodes plainly rather than asking the sidecar to know about cache state.
- **Core Rule 4 applies to session 46 specifically.** The docked panel's render path must stay a
  pure cache lookup, always — no exception like hover's cache-miss fallback. A vertical-slice
  node with no cache row must render as "not yet indexed," never trigger a synchronous
  `generate_explanation` call. Session 46's brief below makes this the explicit, undodgeable
  design decision it deserves, rather than letting it default silently.
- **Depth is a hardcoded cap, not a new setting.** Deliberate: the project has real precedent for
  configurable knobs where there's a proven need (`backgroundFlushIntervalSeconds`), but nothing
  here yet establishes that a fixed, reasonable default (proposed: 3 hops) is insufficient. Add a
  setting later if real use surfaces a need, not preemptively.
- **`sidecar/tests/test_repomap.py`** is the existing home for `context.py`/`graph.py` tests
  (including session 38's incremental-update and session 44's `confident`-flag tests) — the
  natural place for both sessions' new traversal tests, not a new test file, unless it grows
  unwieldy. **`sidecar/tests/test_rpc_server.py`** is the equivalent for the two new RPC
  handlers. On the TS side, there is no dedicated `explanationPanelProvider` test file yet
  (`hover.test.ts` covers the hover surface, not the panel) — both sessions will need to decide
  whether to add one or extend an existing suite file; not prescribing which, since that's a real
  call the session should make looking at current test organization, not something to guess here.

---

## Session 45 — Blast radius

- **Kind:** milestone · **Track:** Core
- **Owns:** `sidecar/repomap/context.py` (new `RepoMap.get_blast_radius()` method),
  `sidecar/rpc_server.py` (new `get_blast_radius` handler + `_METHODS` entry), a new
  `src/extension/panel/blastRadiusCommand.ts` (RPC call + cache enrichment + command
  registration), `src/extension/panel/explanationPanelProvider.ts` (new pinned graph-view render
  mode), `package.json` (new command contribution)
- **Subagents:** `test-runner`, `code-reviewer`

```text
Session 45 — Blast radius.

Read only: this brief's "Source-material note" above, plus context.py, graph.py (module
docstring especially — session 44's `confident` flag reasoning), rpc_server.py, and
explanationPanelProvider.ts as they exist today.

Goal: "if I change this function, what's affected" — a transitive-upstream-caller walk,
reusing the graph machinery sessions 37/38/44 already built and live-verified, with zero new
LLM calls.

1. RepoMap.get_blast_radius(rel_fname, name, line, max_depth=3) in context.py: a BFS/DFS
   walk of `self.graph` predecessors (upstream = "who calls this, transitively"),
   confident-edges-only (same filter get_function_context() already applies -- see graph.py's
   module docstring), depth-capped, with visited-node tracking so a recursive/cyclic call
   chain terminates instead of looping. Return plain graph facts only (rel_fname/name/line/
   importance per node, edges as (caller, callee) pairs) -- no cache lookups, no
   role_tag/one_liner. Hold `repo_map.lock.read_lock()` for the whole walk, matching every
   other read-only handler in rpc_server.py.

2. New RPC "get_blast_radius" in rpc_server.py: params {file_path, name, line}, calls the
   above with the hardcoded depth cap. Add to _METHODS. No change to dispatch concurrency,
   priority handling, or the transport loop -- this fits the existing read-handler shape
   exactly (see _handle_resolve_function/_handle_list_ranked_functions for the pattern).

3. Extension host: blastRadiusCommand.ts calls the new RPC via
   SidecarManager.request('get_blast_radius', {...}) (default 'interactive' priority -- this
   is a user-triggered, on-demand action, same shape as the existing "navigate" command), then
   enriches each returned node by looking up its cache row (ExplanationCache, same
   fnId-construction convention functionResolution.ts/cache/hash.ts already use) to attach
   role_tag/one_liner where cached. A node with no cache row renders with its bare name/
   location only -- never trigger generation to fill it in (Core Rule 9: the sidecar doesn't
   know about cache state, and this command doesn't get a Core-Rule-4-style exception just
   because it's new).

4. Panel: add a "See full blast radius ->" trigger near the existing used_by section (visual
   style matching the existing name-link buttons), and a new pinned graph-view render mode in
   explanationPanelProvider.ts -- pinned meaning cursor movement does NOT overwrite it (unlike
   the existing cursor-synced explanation view), with an explicit "<- Back" control to return
   to normal cursor-synced mode. Render as a simple depth-grouped list (Level 1: ..., Level 2:
   ...), not a diagram -- keep the rendering code path generic enough (nodes + edges +
   direction as input) that session 46 can reuse it rather than building a second renderer
   from scratch.

5. package.json: new command "lucidhover.showBlastRadius" ("LucidHover: Show Blast Radius for
   Function Under Cursor"), matching the existing "... for Function Under Cursor" title
   convention (see lucidhover.refreshExplanation).

Explicitly out of scope:
  - Vertical slice / downstream tracing -- session 46.
  - Any new LLM/generation call, any PROMPT_VERSION or cache-key change -- none needed, this
    is graph-only.
  - A configurable depth setting -- hardcoded cap for now, see this brief's source-material
    note.
  - Changing the existing used_by/calls single-hop sections' own rendering or click-to-navigate
    behavior.
  - Any second-language testing -- JS/TS fixtures only, current language scope unchanged.

Done when: get_blast_radius returns a correct, confident-edges-only, depth-capped, cycle-safe
upstream graph against a real indexed workspace (not a mocked graph), the panel renders it in
a pinned view that survives cursor movement, and cache enrichment correctly leaves uncached
nodes bare rather than triggering generation -- verified live, not just by unit test.

Run test-runner, then code-reviewer, then write the artifact.
```

---

## Session 46 — Vertical slice / execution trace

- **Kind:** milestone · **Track:** Core
- **Owns:** `sidecar/repomap/context.py` (new `RepoMap.get_call_trace()` method),
  `sidecar/rpc_server.py` (new `get_call_trace` handler + `_METHODS` entry), a new
  `src/extension/panel/callTraceCommand.ts`, `src/extension/panel/explanationPanelProvider.ts`
  (second graph-view mode, reusing session 45's rendering plumbing), `package.json` (new
  command contribution)
- **Requires:** Session 45 complete — reuses its pinned graph-view render mode and RPC/
  enrichment pattern rather than duplicating them.
- **Subagents:** `test-runner`, `code-reviewer`

```text
Session 46 — Vertical slice / execution trace.

Read only: the session-45 artifact, plus this brief's "Source-material note" above (the Core
Rule 4 handling in particular -- this session's real, undodgeable design decision, not a
formality).

Goal: "follow this one call chain end-to-end" -- a downstream trace from a chosen entry-point
function, reusing session 45's graph/RPC/enrichment pattern in the opposite direction.

1. RepoMap.get_call_trace(rel_fname, name, line, max_depth=3) in context.py: walks `self.graph`
   successors (downstream = "what does this call, and what does that call"),
   confident-edges-only, cycle-safe via visited-node tracking like session 45. Branching
   decision (make this explicit, don't default silently): at each hop, follow only the
   single highest-importance confident callee as the "primary path" -- v1 returns one linear
   chain, not a branching tree. Record this as a deliberate scope cut in the artifact (Core
   Rule 8: one session, one milestone); alternate-path exploration is a real follow-up idea,
   not this session's job. Return plain graph facts only, same Core-Rule-9 split as session 45
   (no cache lookups inside the sidecar).

2. New RPC "get_call_trace" in rpc_server.py, same shape as session 45's "get_blast_radius"
   handler: params {file_path, name, line}, hardcoded depth cap, added to _METHODS, read-locked.

3. Extension host: callTraceCommand.ts calls the RPC, then enriches every node in the path from
   ExplanationCache exactly like session 45's blastRadiusCommand.ts. The actual design decision
   this session is named for: a node with no cache row renders as an explicit "not yet indexed"
   placeholder (name + location, a note to hover it or wait for background indexing) and the
   trace continues showing the rest of the already-computed structural path past it -- the
   sidecar's graph walk is not gated on cache state, only each node's *display* is. This must
   never fall through to a synchronous generate_explanation call from the panel's render path
   (Core Rule 4 has no exception for the panel, and this feature doesn't get to invent one).

4. Panel: second pinned graph-view mode reusing session 45's node/edge rendering plumbing,
   specialized for a linear chain (an ordered list/timeline rather than depth-grouped groups)
   -- each hop shows name, role_tag/one_liner if cached, or the "not yet indexed" placeholder.
   Trigger: a "Trace execution from here ->" control, same placement convention as session 45's
   blast-radius trigger.

5. package.json: new command "lucidhover.traceExecutionPath" ("LucidHover: Trace Execution
   Path from Function Under Cursor").

Explicitly out of scope:
  - Upstream/blast-radius tracing -- session 45 already built it, don't duplicate.
  - Branching/alternate-path exploration UI -- v1 is single-primary-path only, per this
    session's own explicit scope cut above.
  - Any new LLM/generation call triggered from the trace view, under any circumstance --
    this is the one thing this session must get right, not work around.
  - Any second-language testing -- JS/TS fixtures only.

Done when: get_call_trace returns a correct, confident-edges-only, cycle-safe, single-
primary-path downstream chain against a real indexed workspace, the panel renders it reusing
session 45's graph-view infrastructure, and an uncached hop is verified live to render as a
placeholder without ever triggering generation from the panel.

Run test-runner, then code-reviewer, then write the artifact.
```
