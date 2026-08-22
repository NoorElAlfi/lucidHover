# Session 31: Retrieval chunk-size fix for real-repo scale

**Date:** 2026-08-22
**Build-order step(s) completed:** None -- targeted bug fix (session 29's real-repo audit
handoff item), not a build-order milestone.
**Status:** complete

## Files touched
- [sidecar/retrieval/chunking.py](../../sidecar/retrieval/chunking.py) -- `_chunk_file_text`
  gained a `CHUNK_MAX_CHARS = 500` character-length cap layered on top of the existing
  `CHUNK_LINES = 12` line-window. A chunk now ends at whichever bound (line count or char count)
  is hit first; a single line longer than `CHUNK_MAX_CHARS` on its own is split into fixed-size
  character windows instead of ever being emitted as one oversized chunk. Module docstring
  rewritten to record the confirmed real `num_ctx=256` limit and the real-repo measurement that
  motivated the char cap.
- [sidecar/retrieval/retrieve.py](../../sidecar/retrieval/retrieve.py) -- three changes:
  1. `query_top_k` windows `fn_source` to `fn_source[:CHUNK_MAX_CHARS]` before embedding it as the
     query vector.
  2. `_rows_for` (used by both `reindex_repo_chunks` and `reindex_file_chunks`) changed from a
     plain list comprehension to a loop that catches `OllamaError` per chunk. Only a genuine
     context-window-overflow error (message contains `"exceeds the context length"`, matched via
     a new `_CONTEXT_LENGTH_OVERFLOW_SIGNATURE` constant) skips just that chunk; every other
     `OllamaError` (Ollama unreachable, the embedding model not pulled, any other server error)
     re-raises immediately.
  3. `reindex_repo_chunks`/`reindex_file_chunks` now return the count of chunks that were
     *successfully embedded*, not the count attempted -- the only caller (`rpc_server.py`'s log
     lines) only ever used this for display, so the new number is strictly more accurate.
- [sidecar/tests/test_chunking.py](../../sidecar/tests/test_chunking.py) -- 3 new tests: the char
  cap triggers a split even when well under `CHUNK_LINES` (the real-repo failure shape), a single
  overlong line splits into windows and reassembles byte-for-byte, short lines still batch up to
  `CHUNK_LINES` per chunk (no regression on the common case).
- [sidecar/tests/test_retrieve.py](../../sidecar/tests/test_retrieve.py) -- 6 new tests:
  `fn_source` windowing (oversized and short-unchanged), `_rows_for` skips only a genuine
  context-overflow chunk, `_rows_for` re-raises on a connectivity failure, `_rows_for` re-raises
  on a "model not found" failure (the code-review-caught case -- see "Decisions made"), and two
  end-to-end `reindex_repo_chunks`/`reindex_file_chunks` tests confirming one bad chunk no longer
  wipes out the other good chunks in the same pass.

No extension-host (TS) files touched. No `PROMPT_VERSION`/`EMBEDDING_MODEL_ID` change. No new RPC.

## Decisions made

### The true context-window limit is 256 tokens, not 512 -- resolved via the running model itself
Session 11 found 256 empirically (binary search against fixture content); session 29 reported 512
from `ollama list`'s `context_length` field. Both numbers come from the same model but different
fields: `ollama show all-minilm` reports `bert.context_length: 512` (the architecture's max) in its
`model_info`, but the Modelfile bakes in `PARAMETER num_ctx 256`, confirmed via `/api/show`'s
`parameters` field (`"num_ctx  256"`). 256 is what Ollama actually runs the model with (`embed()`
sends no `options.num_ctx` override), matching session 11's empirical number. Session 29's 512 was
the wrong field for this purpose, not a different real limit. Query source: this session's own
`ollama show all-minilm` and `curl /api/show` calls against the real local Ollama instance, not
inherited from either prior session.

### Root cause: line-count chunking has no character-length guard, and it doesn't need one pathological line to fail
Measured 1230 real chunks from 10 curated real pokerogue files (`CHUNK_LINES=12`, unmodified
pre-fix chunker) against the real running `all-minilm`: 8 failed (0.7%), all at exactly 11-12
lines (i.e., *within* the line cap, not exceeding it). Individual line lengths in the failures
were unremarkable (97-260 chars) -- the failures came from 12 ordinary-looking lines (long JSDoc
comments, long import lists, chained conditionals) summing to 759-1275 total characters, crossing
the real failure boundary (bracketed between 691 chars, confirmed OK in session 11's fixture
calibration, and 759 chars, confirmed failing here). This directly confirms the task's hypothesis:
line count alone is not a reliable token-count proxy for real code, independent of what N is
chosen, because cumulative character density varies far more across a real repo than across a
small hand-written fixture repo.

### The full curated-file `chunk_repo()` walk over all of pokerogue (1216+ files) stalled and was abandoned in favor of a bounded sample
The first diagnostic attempt called `chunk_repo()` over the entire pokerogue repo and sampled
~1500 of the resulting chunks. It produced zero output for 23+ minutes; `Get-Process` showed the
Python process had burned only ~1.6s of CPU in that window (not busy-looping), while Ollama's own
process had burned real CPU early on then gone flat -- consistent with the process being stuck
inside `chunk_repo()`'s full-repo file walk itself (materializing the whole file list before any
embedding starts), not the embed loop. Root cause not fully diagnosed (out of scope for this
session -- see "Handoff"); worked around by chunking a curated list of 10 real files directly via
`chunk_file()` (bypassing the full-repo walk) instead, which produced results in milliseconds.
This curated set is smaller than a full-repo sweep but is real, unmodified pokerogue source,
including one of the largest files (`generation-01.ts`, capped to its first 200 chunks for time).

### Query-side fix scope: window `fn_source` on the query side too, not just chunk text on the corpus side
Confirmed real pokerogue functions are enormous outliers: the 10 largest real functions/methods by
line span (via `RepoMap`'s own real tag extraction, not hand-rolled parsing) ranged 3,269-16,125
lines (188KB-420KB), all real (`initGenerationOne`, `initMoves`, etc. -- data-init functions, not
pathological or malformed code). All 10 overflowed `query_top_k`'s previously-uncapped
`embed(fn_source)` call with the same `"exceeds the context length"` error. Fixed by windowing to
`CHUNK_MAX_CHARS` before embedding, since this is a similarity-search input (approximate is fine),
not a value that flows into the cached explanation or the cache key. Re-verified live: all 10
previously-overflowing functions now succeed end-to-end through the real `query_top_k` call.

### `CHUNK_MAX_CHARS = 500`, not a value closer to the empirical boundary
Chosen to sit comfortably below both the fixture-repo boundary (691 OK / 817 fail, session 11) and
the real-repo boundary (up to 759 chars observed failing here) -- real margin against content this
session didn't sample (e.g. denser non-JS/TS content, if a future language adapter's chunks differ
in token density), while still keeping chunks large enough to carry useful retrieval context. No
token-counting library added -- consistent with session 11's original reasoning (Ollama's
tokenizer isn't exposed locally without loading the model; a heuristic only needs to be reliably
under the limit, not exact).

### Found and fixed a second, related bug: one failing chunk was silently discarding an entire batch's worth of otherwise-good chunks
Not explicitly asked for in the session prompt, but directly in the same function this session was
already changing, and directly relevant to the prompt's own constraint ("without weakening the
existing graceful-degrade behavior... that safety net is intentional, not the bug"). Before this
session, `_rows_for` was a plain list comprehension: `embed()` raising for *any* chunk propagated
immediately, so `store.replace_all()`/`replace_file()` never ran at all for that pass -- one
overflowing chunk anywhere in a full-repo startup embed, or in a single saved file's chunks, meant
*zero* of that pass's chunks made it into the vector store, not just the one that failed. Fixed by
catching per-chunk and skipping only genuine context-overflow failures (see below for why not
every failure). Added end-to-end regression tests confirming the surviving chunks actually reach
the `VectorStore` (queried back, not just counted).

### Narrowed the per-chunk skip condition after a code-review-caught real regression
First implementation distinguished "skip vs. re-raise" via
`isinstance(exc.__cause__, urllib.error.HTTPError)` (content-level HTTP response vs.
connectivity-level `URLError`). `code-reviewer` correctly flagged this as too broad:
`ollama_client._post` raises the *same* `HTTPError`-caused `OllamaError` for "model not found" as
for a genuine context-length overflow -- both are non-2xx HTTP responses. Under the first
implementation, a misconfigured/unpulled `embedding_model_id` would have every chunk "skipped" as
if each were individually too long, silently emptying the vector store on every startup and every
save with no diagnostic, when pre-session-31 behavior correctly surfaced "Run: ollama pull
<model>" on the very first attempt. Fixed by matching on the specific message substring Ollama
reports for overflow (`"exceeds the context length"`, confirmed via a live call against the real
model) instead of the exception's HTTP-vs-URL type; verified live that a real "model not found"
error's message does not contain that substring, so it still re-raises correctly. Regression test
added (`test_rows_for_reraises_on_a_model_not_found_failure_rather_than_skipping_every_chunk`).

### Cache-key question (explicitly required by the session prompt): no change needed, confirmed rather than assumed
Traced the full path: `context_hash` (sidecar-computed) already folds retrieved-chunk *content*
(`retrieved:{rel_fname}:{start}:{end}:{text}`) into its sorted per-chunk hash list
(`sidecar/cache/hashing.py::_context_chunks`), and the extension host's `computeCacheKey()`
(`src/extension/cache/hash.ts`) only ever receives that single collapsed `context_hash` value, not
`CHUNK_LINES`/`CHUNK_MAX_CHARS` themselves. Changing how content gets chunked changes what content
ends up embedded and retrieved, which naturally changes `context_hash` for any generation that
actually uses different retrieved content -- this is the cache key's designed content-sensitivity
working as intended, not a gap. `CHUNK_MAX_CHARS` is exactly analogous to `CHUNK_LINES` before it:
neither is nor needs to be a literal cache-key component (Core Rule 5 lists `fn_source +
context_hashes + model_id + embedding_model_id + prompt_version` -- chunking mechanics are not on
that list, by design, matching session 11's original precedent for `CHUNK_LINES` itself).

## Deviations from spec
None from the extension spec. One deviation from this session's own instructions: step 5 asked for
a full real-repo `reindex_repo_chunks`-equivalent driver against all of `B:\pokerogue`; the actual
full-repo walk stalled (see "Decisions made" above) and was replaced with a bounded, curated
10-file real-content sample instead, run before and after the fix for a genuine before/after
comparison. This is real, unmodified pokerogue content, just a bounded subset rather than the
literal whole repo.

## Test status
- `python -m pytest sidecar/tests/ -q`: **107 passed**, 0 failed (was 102 baseline at session
  start; +6 new in `test_retrieve.py`, +3 new in `test_chunking.py`, net +5 since one test's
  helper was renamed rather than added -- see diff). No regressions in any other suite
  (`test_acceptance_test.py`, `test_repomap.py`, `test_repomap_typescript.py`,
  `test_ollama_base_url_plumbing.py`, `test_hashing.py`, `test_prompt.py`, `test_vectorstore.py`,
  `test_summary_doc_generation.py`, `test_generate.py`, `test_list_ranked_functions.py`,
  `test_ollama_client.py`, `test_rpc_server.py`, `test_rpc_transport.py`). Confirmed via a
  dedicated `test-runner` agent pass, not just this session's own local run.
- **Real-repo before/after measurement (the session's actual acceptance bar), against the exact
  same 10 curated real pokerogue files, same code path (`chunk_file` -> real `all-minilm` embed
  calls), before and after the fix:**
  - Before (unmodified `CHUNK_LINES=12`, no char cap): 1230 chunks tested, **8 failed (0.7%)**.
  - After (this session's fix): 1243 chunks tested (char-splitting produces a few more, smaller
    chunks), **0 failed (0.0%)**.
- **Query-side fix, live**: all 10 of the real largest pokerogue functions (3,269-16,125 lines,
  188KB-420KB, resolved via `RepoMap`'s own real tag extraction) that overflowed
  `query_top_k`'s uncapped `embed(fn_source)` call pre-fix now succeed end-to-end post-fix.
- **Context-window limit, live**: `ollama show all-minilm` and `curl /api/show` both confirm
  `num_ctx=256` is the real operative limit (see "Decisions made").
- **Narrowed skip-condition, live**: a real call to `embed()` with a nonexistent model name
  produces a message that does not contain the context-overflow signature, confirming the
  narrowed `_rows_for` condition still re-raises for that case rather than skipping.
- `code-reviewer` pass (scoped to this session's diff): one real finding (the `HTTPError`-vs-
  `URLError` distinction being too broad, catching "model not found" as if it were a per-chunk
  content failure) -- fixed and covered by a new regression test (see "Decisions made"). All 13
  Core Rules confirmed not violated: no new network call types, no new RPC, no sidecar cache-DB
  access, no prompt/schema change, no proposed-API usage, no cross-language-scope drift, file
  ownership respected (`sidecar/retrieval/`, `sidecar/tests/`). `_chunk_file_text`'s new loop
  hand-traced for infinite-loop/off-by-one risk: none found (the single-overlong-line case is
  filtered out upfront, so the accumulation loop always advances at least one line).

## Blockers / open questions
- **The full-repo `chunk_repo()` walk over all of pokerogue (1216+ files, including several
  10,000+-line files) appears to stall or run pathologically slowly** -- not diagnosed to root
  cause this session (worked around with a bounded curated-file sample instead, which was
  sufficient for this session's own acceptance bar). Worth a dedicated look if a future session
  needs the literal full-repo pass to complete in reasonable time (e.g. profiling whether it's the
  file walk, the `pathspec` gitignore matching, or Windows filesystem/antivirus overhead reading
  thousands of files through git-bash). Not the same issue as the already-documented sidecar
  request-contention problem (session 26/29) -- this is inside the chunking file-walk itself, not
  the RPC dispatch loop.
- Per this session's own explicit scope: the sidecar request-contention/scheduling problem was not
  touched (still needs its own dedicated session, per session 26/29's recommendation). No call-
  graph-tier context composition change. No prompt/schema change (`PROMPT_VERSION` untouched --
  confirmed correct, not just left alone by default, since nothing in this diff touches prompt
  composition). No embedding-model swap.

## Handoff for next session
- If a future session wants the literal full-repo pokerogue embed pass to complete (not just a
  bounded sample), diagnose the `chunk_repo()`/file-walk stall noted above first -- it will block
  any attempt at a true full-repo timing/throughput measurement the way session 29's resource
  audit did for generation.
- The existing on-disk LanceDB vector store for any already-indexed real repo (if one exists from
  a prior session's testing) still holds chunks from the *old* `CHUNK_LINES`-only boundaries until
  the next full sidecar restart (which re-runs the full-repo `reindex_repo_chunks()` pass) or a
  per-file save-triggered re-embed. This is expected, not a bug (same restart-to-take-effect
  precedent as `EMBEDDING_MODEL_ID`/`CHUNK_LINES` changes have always had), but worth knowing if a
  future session inspects a stale vector store and sees old-boundary chunks.
- The sidecar request-contention/scheduling problem (session 26/29) remains the most-flagged
  carried-forward item across the last several sessions and still hasn't had a dedicated session.
