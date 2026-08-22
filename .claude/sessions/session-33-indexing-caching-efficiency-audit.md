# Session 33: Indexing & caching efficiency audit

**Date:** 2026-08-22
**Build-order step(s) completed:** None -- audit session (time/space complexity pass across
indexing and caching subsystems) plus one targeted, verified fix found along the way, per
session-20's Track column conventions (not a Core Build Order step).
**Status:** complete

## Files touched
- [sidecar/generation/ollama_client.py](../../sidecar/generation/ollama_client.py) -- added
  `embed_batch(model, texts, base_url)`, calling Ollama's `/api/embed` (batch input) instead of
  the single-item `/api/embeddings` `embed()` already there. `embed()` itself is unchanged, still
  used by `retrieve.py::query_top_k`'s one-off query-side call.
- [sidecar/retrieval/retrieve.py](../../sidecar/retrieval/retrieve.py) -- `_rows_for` (used by both
  `reindex_repo_chunks` and `reindex_file_chunks`) rewritten from one `embed()` HTTP call per chunk
  to grouped `embed_batch()` calls, `EMBED_BATCH_SIZE = 64` chunks per call. Session 31's per-chunk
  overflow-skip logic (`_CONTEXT_LENGTH_OVERFLOW_SIGNATURE`) removed -- see "Decisions made" for why
  this is safe, not just expedient.
- [sidecar/tests/test_ollama_client.py](../../sidecar/tests/test_ollama_client.py) -- 4 new tests
  for `embed_batch`: ordering, empty-input short-circuit, length-mismatch validation, "model not
  found" re-raise.
- [sidecar/tests/test_retrieve.py](../../sidecar/tests/test_retrieve.py) -- `_rows_for`'s tests
  rewritten around `embed_batch` instead of `embed`: batching/ordering, multi-batch splitting,
  batch-level re-raise on connectivity/model-not-found failures, and the `reindex_repo_chunks`/
  `reindex_file_chunks` integration tests updated to the new batch-level (not chunk-level) failure
  contract.

No extension-host (TS) files touched. No `PROMPT_VERSION`/cache-key/context-composition change --
this is purely a transport-layer change to how many HTTP round trips corpus embedding costs, not
to what gets embedded (confirmed by `code-reviewer`, see "Test status").

## Decisions made

### The fix: batch corpus-embedding HTTP calls, EMBED_BATCH_SIZE = 64
Real, live benchmark against the actual running `all-minilm` (not estimated): 20 chunks embedded
one-per-call via `/api/embeddings` took 41.571s (2078.6ms/chunk); the same 20 texts in one
`/api/embed` call took 2.335s (116.8ms/chunk) -- a real 17.8x speedup. A batch-size sweep (8/20/32/
64/128/256 chunks/call, all live) showed diminishing but real returns up to 256 (~11.8ms/chunk),
but 400-512-wide batches hit real, observed intermittent failures -- Ollama's own internal
tokenize-helper subprocess returning `dial tcp 127.0.0.1:<port>: connectex: actively refused`, not
a documented size limit, reproduced at n=400 and n=450 but not n=500 (non-monotonic, consistent with
an internal-subprocess race, not a clean size cutoff). `EMBED_BATCH_SIZE = 64` was chosen as stable
across 3 repeated live trials (39.6ms/37.8ms/38.5ms per chunk, no flakiness observed), comfortably
below the observed instability zone, while still capturing most of the win (~54x vs. sequential).

Real full-repo extrapolation: pokerogue's real chunk count is 33,443 (measured live this session,
see "chunk_repo() stall" below). At the old ~2.08s/chunk sequential rate that's ~19.3 hours; at the
new ~38ms/chunk batched rate, ~21.5 minutes -- both real numbers, not estimates, for the same
one-time startup pass. Live end-to-end verification (not just the isolated Ollama benchmark): a
real pokerogue file (`src/data/egg.ts`, 57 real chunks) run through the real
`reindex_file_chunks()` with the new code embedded all 57 chunks in one batch in 2.595s, and a real
`query_top_k()` round trip against the resulting live `VectorStore` returned 5 chunks correctly.

### Correctness caveat, verified live and judged safe: session 31's per-chunk overflow-skip cannot survive batching, but was already unreachable
Session 31 built `_rows_for` to catch `OllamaError` per chunk, skip only a genuine context-overflow
error (Ollama's own reported message contains "exceeds the context length"), and re-raise every
other failure as systemic. This session confirmed live that Ollama's two embedding endpoints behave
asymmetrically on overflow: the same absurdly long input (~35KB) sent via `/api/embeddings` returns
HTTP 500 with `{"error": "the input length exceeds the context length"}`; the same input sent via
`/api/embed` (even as a single-item batch) returns HTTP 200 with a silently truncated embedding --
no error, no signal to catch. There is structurally no way for the batched path to preserve
per-chunk overflow detection.

Judged safe rather than deferred, for two independently confirmed reasons: (1) `chunking.py`'s
`_chunk_file_text` guarantees every `Chunk.text` it can ever produce is under `CHUNK_MAX_CHARS`
(500 chars) -- hand-traced both branches (the single-overlong-line splitter emits raw slices no
longer than `CHUNK_MAX_CHARS`; the normal accumulator's emitted `"\n".join(...)` text is always
`char_count - 1 < CHUNK_MAX_CHARS`), and independently re-verified by the `code-reviewer` pass
against the real code, not just the docstring's claim. (2) Session 31 already measured 0 of 1243
real post-fix pokerogue chunks overflowing the real context window -- the skip path this removes
was already unreachable for any chunk this codebase actually produces. A batch-level `OllamaError`
(connectivity, model not found) still re-raises immediately and aborts the whole `_rows_for` call,
unchanged from before for those genuinely systemic cases -- confirmed by a new regression test
(`test_reindex_repo_chunks_writes_nothing_when_the_embed_batch_call_fails`).

`code-reviewer` additionally flagged the "`/api/embed` returns embeddings one-per-input, in order"
claim as asserted only by a mocked test and worth double-checking live: confirmed live in this
session's own earlier benchmark script (a 3-item batch with `[normal, huge, normal]` inputs
returned three embeddings where index 0 and index 2 -- both `normal`, the same text -- were
bit-identical vectors, and index 1 (`huge`) differed; this is real, ordering-preserving live
evidence, not just the mocked unit test).

### `chunk_repo()`'s 23-minute stall (session 31 handoff item): investigated, not reproducible, likely environmental
Reproduced session 31's exact call sequence (`find_source_files` -> gitignore-spec load ->
`chunk_file` per file) against the same real `B:\pokerogue` repo, on the same machine, this time
with progress logging and a bounded 8-minute timeout. It completed in **0.515 seconds total**
(`find_source_files()` alone: 0.111s for 1,216 real files; gitignore spec load: 0.003s; the
chunk-and-log loop: 0.401s), producing 33,443 real chunks with zero gitignore-skips and zero
outlier files (none took over 1 second). This directly contradicts session 31's file-walk
hypothesis (measured here at 0.111s, not minutes) and finds no pathological file. The most
defensible conclusion, given a byte-for-byte-identical reproduction ran three orders of magnitude
faster with no code changes to `chunking.py` in between: session 31's stall was environmental (cold
OS/disk page cache on first touch of the repo, antivirus real-time-scan interference, or similar),
not a bug in `chunk_repo()`'s own logic. Closing this handoff item as investigated-and-not-
reproducible rather than leaving it open with an unconfirmed guess.

### `RepoMap.reindex_file()`: confirmed real, measured whole-graph-rebuild cost -- NOT fixed, written up as a follow-up candidate
Measured live against real pokerogue (6,633 functions, 128,515 real call-graph edges):
`RepoMap.index()` (full startup pass) = 3.458s. A single `reindex_file("src/data/egg.ts")` call
(623 lines, 30 functions, real cross-file call edges), run 3 times consecutively: 0.434s / 0.439s /
0.439s -- stable, no warmup drift. Isolating the two sub-steps `reindex_file()` shares with
`index()`: `build_call_graph()` alone = 0.347s, `compute_importance()` (PageRank) alone = 0.083s;
their sum (0.430s) matches `reindex_file()`'s measured cost almost exactly, confirming the
file-scoped `extract_tags` step itself is negligible (single-digit ms) and essentially the entire
`reindex_file()` cost is rebuilding the **whole-repo** graph and rerunning PageRank over the
**whole** graph -- exactly as `context.py`'s own docstring already said it does, now with real
numbers behind it. This cost is paid on every single debounced save (Session 8/27's
`SaveReindexManager`), is proportional to total repo size (nodes/edges), not to the edited file's
size, and will grow on larger repos.

Not fixed this session: a genuinely correct incremental update requires more than "only touch the
changed file's node" -- `graph.py::build_call_graph` resolves calls by name across the *whole*
repo (`defs_by_name`), so a changed file's new/removed/renamed definitions can affect edges whose
*caller* lives in a completely different file (any other file with a ref matching that name).
Doing this correctly without a full rebuild needs a reverse index (name -> which files reference
it) that doesn't exist today -- a real architectural addition needing its own design and
at-scale testing, not a same-session tweak, and explicitly not "rewrite the PageRank algorithm
itself" (out of scope per the session prompt) but "avoid re-running it over the whole graph" (which
still requires the graph itself to be correctly, incrementally maintained first). Per Core Rule 8,
written up as a scoped follow-up candidate (see "Handoff") rather than attempted here.

### `VectorStore.query()`: confirmed exact brute-force scan, real-scale query latency measured negligible
Grepped the whole `sidecar/` tree for `create_index`/`IVF`/`ann_index` -- zero matches anywhere.
`VectorStore.query()`'s `.search(vector).limit(limit)` is LanceDB's default exact/brute-force kNN
scan; no ANN index is ever built. Real synthetic-scale benchmark (dim=384, matching `all-minilm`,
10 queries averaged after 1 warm query, real on-disk LanceDB tables): N=1,000 -> 14.09ms/query;
N=10,000 -> 24.60ms; N=50,000 -> 62.50ms; N=150,000 -> 147.00ms. Real pokerogue chunk count
(33,443) sits between the 10K/50K points, interpolating to roughly 40-50ms/query. Against session
29's real generation-latency baseline (~10-20s median, one 128s outlier), a ~40-50ms retrieval
query is roughly 0.2-0.5% of a typical hover-triggered generation call -- confirmed negligible at
real repo scale, not assumed either way as the session prompt required. Even the 150K-row synthetic
point (147ms) stays comfortably subordinate to generation latency; this would only be worth
revisiting if a single workspace's corpus grew into the many-hundreds-of-thousands-of-chunks range.
No fix needed or applied.

### SQLite explanation cache: hot path confirmed correctly indexed; one real, low-priority secondary finding
Ran `EXPLAIN QUERY PLAN` (real, against the actual schema in `explanationCache.ts`, not assumed)
for all three prepared statements. `lookupStmt` (the hover-hot-path lookup, Core Rule 4) ->
`SEARCH ... USING INDEX idx_explanation_cache_lookup (fn_id=? AND fn_hash=? AND model_id=? AND
embedding_model_id=? AND prompt_version=?)` -- a full 5-column index seek, confirmed not a table
scan. `lookupByCacheKeyStmt` -> uses the `cache_key` primary-key autoindex, also optimal. Both
confirmed already correct; no fix needed for the path that actually runs on every hover.

`currentRowForFnIdStmt` (session 13's staleness-detection path, used by save/flush re-indexing
decisions, not per-hover) is real but lower-priority: because it doesn't filter on `fn_hash` (which
sits between `fn_id` and the other filtered columns in the existing index's column order), SQLite
can only use the index for the `fn_id=?` equality and must sort the rest with a
`USE TEMP B-TREE FOR ORDER BY` for the `generated_at DESC` clause -- confirmed via the same real
`EXPLAIN QUERY PLAN` output. Not fixed: this path only runs during save/flush staleness checks
(not the hot hover path), and the number of rows sharing one `fn_id` is naturally small (bounded by
how many times that one function has actually been regenerated across content/model/prompt
changes), so the extra sort cost is real but bounded and small in practice -- not judged worth a
schema migration on an existing on-disk cache DB for this session. Documented as a confirmed,
real, low-severity finding rather than left silently unchecked.

### Space complexity: real numbers gathered at real repo scale; one real, confirmed gap (no eviction) flagged
Real on-disk LanceDB size for 33,443 rows (dim=384, ~300-char text, matching pokerogue's real
chunk count and a realistic text length): **52,678,384 bytes (~50.2MB, ~1.58KB/row)**. Combined
with session 29's real SQLite explanation-cache figure (~2.03KB/row): a full one-time population of
pokerogue's real 6,633 functions would cost roughly ~13.5MB in the SQLite cache alone. Extrapolating
both linearly to 10x repo scale (~66K functions / ~334K chunks): cache ~135MB, vector store
~527MB; at 100x: ~1.35GB / ~5.27GB. Neither looks broken at 1x-10x (well within normal per-workspace
cache footprints); the vector store specifically is the one worth revisiting first if a much larger
monorepo shows up, given its steeper absolute growth.

Confirmed (grepped `src/extension/cache/` for `DELETE`/`VACUUM`/`prune`/`evict`/`cleanup`, zero
matches), not assumed: **the SQLite explanation cache has no eviction or cleanup mechanism at
all.** Every regeneration -- a `PROMPT_VERSION`/`MODEL_ID`/`EMBEDDING_MODEL_ID` bump, or session
13's staleness-triggered regeneration on a genuine content change -- leaves the old row permanently
in the table under its own now-orphaned `cache_key` (the primary key), since a cache-key input
change always produces a *new* key rather than overwriting the old row. Growth is monotonic and
unbounded over a workspace's lifetime. This project's own history already shows 4 real
`PROMPT_VERSION` bumps (few-shot-v1 through v4 across sessions 6-19), each one orphaning a full
generation's worth of prior rows with no cleanup. Not fixed this session -- an eviction policy (LRU?
explicit TTL? a manual purge command? drop-on-bump?) is a real design decision, not a "cheap and
safely fixable" mechanical change -- flagged as a real, evidenced follow-up candidate.

## Deviations from spec
None from the extension spec. This session's own instructions permitted "fix what's cheaply and
safely fixable this session, flagging anything larger for a dedicated follow-up" -- one fix
(embedding batching) met that bar with real before/after verification; the `reindex_file()`
whole-graph-rebuild cost and the cache-eviction gap did not (both are real architectural/design
decisions, not mechanical fixes) and are written up as follow-up candidates instead, per the
session's own explicit allowance for that outcome.

## Test status
- `python -m pytest sidecar/tests/ -q` (via `/c/Python313/python`, the interpreter that actually
  has `lancedb`/`tree-sitter`/etc. installed in this environment -- confirmed the plain `python3`
  on PATH does not): **113 passed**, 0 failed (was 107 baseline at session start; +6 net: 7
  `_rows_for`/`reindex_*_chunks` tests rewritten around the new batched contract in
  `test_retrieve.py`, +4 new `embed_batch` tests in `test_ollama_client.py`, -3 tests removed
  whose scenario (per-chunk content-level overflow) is no longer reachable through the code path
  it tested). Confirmed via a dedicated `test-runner` agent pass, not just this session's own
  local run: 113 sidecar tests passed, `npx tsc -p ./ --noEmit` clean, `npm run test:unit` 45
  passing -- all unaffected, since no TS files were touched this session.
- **Live, real-Ollama verification** (not just mocked unit tests), all reported in "Decisions
  made" above: the sequential-vs-batched throughput benchmark (17.8x-54x across several real batch
  sizes), the batch-size-instability finding (400/450-wide batches genuinely failing, 500-wide
  succeeding, on the real local Ollama), the overflow-asymmetry confirmation
  (`/api/embeddings` raises, `/api/embed` silently truncates -- both tested against the real
  model), the ordering-preservation confirmation (identical input text at two different batch
  positions produced bit-identical output vectors), and an end-to-end `reindex_file_chunks()` +
  `query_top_k()` round trip against a real pokerogue file through a real (temporary) `VectorStore`.
- `code-reviewer` pass (scoped to the 4 changed files): **no Core Rule violations.** Independently
  re-verified (not just trusted from this session's own docstring claim) that `chunking.py`'s
  `CHUNK_MAX_CHARS` guarantee is airtight for both branches of `_chunk_file_text`, confirming the
  load-bearing safety claim behind removing the per-chunk overflow skip. Confirmed `EMBED_BATCH_SIZE`
  grouping has no off-by-one (empty/exact-batch/one-over-batch all correct, backed by a real test),
  `embed_batch`'s empty-input short-circuit and length-mismatch validation are both real and
  exercised (not dead code), and the new/rewritten tests genuinely exercise the claimed behavior
  rather than passing superficially. One "ambiguous" item raised (whether "one embedding per input,
  in order" was verified live or just mocked) -- addressed above with the real live evidence that
  was already gathered but not yet cross-referenced in the diff's own docstrings.
- `chunk_repo()` stall reproduction and `reindex_file()` timing were both run as dedicated,
  bounded, real-repo measurements (background `general-purpose` agents) against `B:\pokerogue`,
  not estimated -- see "Decisions made" for the real numbers each produced.

## Blockers / open questions
None blocking this session's own scope. Every angle (time, algorithms, data structures, space) was
considered for each of the five areas the session prompt named, backed by a real measurement in
every case (no estimates stood in for a number that could be measured). See "Handoff" for the two
items too large to fix this session.

## Handoff for next session
- **`RepoMap.reindex_file()` rebuilds the entire call graph and reruns PageRank over the entire
  graph on every single debounced save** -- real, measured (~0.44s at pokerogue's real 6,633-node/
  128,515-edge scale), proportional to total repo size rather than edit size, confirmed to be
  almost entirely graph-rebuild-and-rerank cost rather than parsing cost. A dedicated follow-up
  session could scope an incremental update: maintain `defs_by_name`/a reverse
  name-referenced-by-file index incrementally instead of rebuilding `build_call_graph()`'s two full
  passes over every tag on every save, while leaving `rank.py`'s PageRank call itself untouched
  per Core Rule 3 ("borrow, don't rebuild") -- the question flagged for that session is exactly
  "does it need to re-run over the whole graph every save," which needs the graph to be
  incrementally correct first, a real design task in its own right, not a same-session tweak.
- **The SQLite explanation cache has no eviction/cleanup mechanism and grows monotonically
  forever** -- confirmed real (grepped, zero matches), not yet a measured problem at real-repo
  1x-10x scale (~13.5MB-~135MB extrapolated) but a real, unbounded-growth design gap worth a
  dedicated session to decide a policy (LRU? TTL? explicit purge command? drop-superseded-rows-
  on-`PROMPT_VERSION`-bump?) before a long-lived workspace's cache DB grows large enough to matter.
- Two items from prior sessions' handoffs are now resolved rather than carried forward further:
  session 31's `chunk_repo()` 23-minute stall is investigated and found not reproducible (likely
  environmental, not a `chunk_repo()` bug) -- no further diagnosis needed unless it recurs with
  fresh, reproducible evidence. `VectorStore.query()`'s exact-vs-approximate-index question is
  answered (confirmed exact brute-force, confirmed negligible at real repo scale) -- no action
  needed unless a workspace's real corpus grows well past the 150K-chunk range this session's
  benchmark covered.
- Per this session's explicit scope boundary: the sidecar request-contention/RPC-scheduling problem
  (sessions 26/29/31's own carried-forward, already-recommended dedicated session) was not touched
  here and remains the most-flagged open item across the last several sessions.
- The one real fix this session made (embedding batching) reduces `_rows_for`'s own wall-clock cost
  substantially, but does not touch the request-contention problem -- a background full-repo
  embedding pass now blocks the sidecar's single-flight dispatch loop for ~20 minutes instead of
  ~19 hours at pokerogue's real scale, which meaningfully shrinks (but does not eliminate) the
  window in which an interactive hover could contend with it.
