import * as path from 'path';
import * as vscode from 'vscode';
import { ExplanationCache } from './cache/explanationCache';
import {
    EMBEDDING_MODEL_ID,
    PROMPT_VERSION,
    resolveBackgroundIndexScope,
    resolveBackgroundIndexTopN,
    resolveModelId,
} from './cache/config';
import { resolveAllFunctions, ResolvedFunction } from './functionResolution';
import { generateAndCache } from './generation';
import { SidecarManager } from './sidecar/sidecarManager';

export const TOGGLE_BACKGROUND_INDEX_COMMAND_ID = 'lucidhover.toggleBackgroundIndexing';

/**
 * Session 52: the observable lifecycle of a background-indexing pass, driving
 * the status-bar item's text/tooltip/icon (same shape as
 * `sidecarManager.ts`'s own status-bar-item pattern). `pausing` exists as its
 * own state, distinct from `paused`, because cancellation here is
 * cooperative -- an already-in-flight `generate_explanation` call (up to
 * `GENERATE_TIMEOUT_MS`, 120s) still has to finish before the loop reaches a
 * checkpoint that honors the token, so the status bar shouldn't claim
 * "paused" before that's actually true.
 */
type BackgroundIndexPhase = 'idle' | 'running' | 'pausing' | 'paused';

// Gap between generations, not a request timeout. Each worker (see
// BACKGROUND_INDEX_CONCURRENCY below) awaits its own generate_explanation
// fully before claiming its next item, and this delay opens a window for a
// hover-miss/save-reindex/refresh request to be issued and registered as
// pending before that worker's next `waitForInteractiveIdle()` check --
// Session 9's original reasoning (an unbroken run of back-to-back background
// sends leaving no gap for interactive work to jump the queue) still holds
// per-worker even though Session 37 made sidecar dispatch itself concurrent.
const DELAY_BETWEEN_GENERATIONS_MS = 1000;

/**
 * Session 71: reverted to `1` -- back to a strictly-one-at-a-time
 * background loop, closing the collision-frequency follow-up sessions
 * 67/69/70 all carried forward. Session 67 shipped `2` on severity data
 * alone (added interactive latency once a collision occurs); session 70
 * then measured that a real collision at the actual shipped pool size 2
 * costs a mean +2.29s, well over session 36's <1s bar, but stopped short of
 * a change because it had no data on how often a real collision actually
 * happens. Session 71 supplied that missing half: a real, continuous
 * 241s run of the shipped 2-worker/1s-delay schedule against real Ollama
 * found both workers simultaneously busy 75.7% of wall-clock time, one busy
 * 22.5%, and idle only 1.9% -- meaning that whenever a background pass is
 * actually running, the large majority of any interactive request
 * (hover-miss/save-reindex/refresh) lands in the *severe* (+2.29s) state,
 * not the mild (+0.6s, at pool size 1) one. That active window is real and
 * measured too: `list_ranked_functions`/the default `topN=200` scope
 * finishes in ~12.6 minutes at this throughput, running exactly once per
 * trusted-workspace-open (see `run()`'s single call site in `extension.ts`)
 * -- squarely the window when a user is most likely opening files and
 * hovering to understand a codebase they just opened, not a rare edge case.
 * A candidate `DELAY_BETWEEN_GENERATIONS_MS = 3000` was also live-measured
 * as a possible fix instead of reverting concurrency: it only knocked the
 * severe-state probability from 75.7% to 60.4% while stretching the active
 * window ~25% longer (12.6 -> 15.8 min) -- a real but too-weak lever to
 * rely on alone. Put to the user via `AskUserQuestion` with all of the
 * above (frequency and severity together, not severity alone, per session
 * 70's own explicit reasoning for not deciding unilaterally); the user
 * chose this revert over leaving `2` as-is or raising the delay instead.
 * `1` restores the well-under-bar ~0.6s single-collision floor session
 * 36/37 already characterized as pre-existing and unavoidable, for every
 * collision, at the cost of the real measured 1.74x-3.25x background
 * throughput gain session 67 found (pass duration roughly doubles). The
 * worker-pool machinery itself (`claimNext()`/`fileSymbolPromises`/the
 * injectable `concurrency` param) is untouched -- still exercised by the
 * "concurrent worker pool (Session 67)" test suite at higher pool sizes,
 * available again if a future session's data supports raising this back up.
 */
const BACKGROUND_INDEX_CONCURRENCY = 1;

/**
 * Session 64: how many of the most recent successful-generation completion
 * timestamps feed the rolling throughput rate behind the tooltip's ETA.
 * Deliberately small and fixed rather than configurable -- this is a rough
 * "still going" indicator, not a scheduling guarantee.
 *
 * Session 67: with `BACKGROUND_INDEX_CONCURRENCY` workers running, per-item
 * *duration* is no longer a valid proxy for pace -- several generations can
 * be in flight at once, so "how long did the last one take" understates
 * throughput by up to ~`BACKGROUND_INDEX_CONCURRENCY`x. `recordGenerationCompletion()`
 * below now tracks wall-clock completion *timestamps* instead of per-call
 * durations and derives a completions-per-ms rate from the window, which is
 * agnostic to how much overlap those completions actually had -- it reads
 * the real observed throughput rather than assuming either a linear stream
 * or a fixed multiplier on it.
 */
const ETA_WINDOW_SIZE = 5;

/** Snapshot of a pass's progress, tracked as `run()`'s loop advances and frozen into 'pausing'/'paused' status-bar text so pausing doesn't lose the count (Session 64). `failed` (Session 65) counts a `generate_explanation` call that threw -- it's "done" for percentage/ETA purposes (nothing more will happen for that function this pass) but distinct from `generated`/`skipped`/`unresolved` since it's the one outcome that means the function still has no explanation. `currentFunctionName` (Session 72) is the most-recently-claimed function awaiting/undergoing generation -- a single field, not a per-worker set, per the user's explicit choice (`AskUserQuestion`): at today's `BACKGROUND_INDEX_CONCURRENCY = 1` it's always exactly the one in-flight function, and if concurrency is ever raised again it degrades to "the latest of however many are actually running" rather than a full list, which was judged simple enough to not need its own bookkeeping structure. */
interface ProgressSnapshot {
    total: number;
    generated: number;
    skipped: number;
    unresolved: number;
    failed: number;
    etaMs: number | undefined;
    currentFunctionName: string | undefined;
}

interface RankedFunction {
    rel_fname: string;
    name: string;
    line: number;
    importance: number;
}

/** How many of `total` this pass has finished handling, whatever the outcome -- generated, already cached, unresolved, or failed (Session 65 added `failed` here so a pass with real failures can still reach 100% instead of undercounting forever). */
function doneCount(p: ProgressSnapshot): number {
    return p.generated + p.skipped + p.unresolved + p.failed;
}

/** Formats a millisecond duration for the tooltip's ETA line -- "under a minute", "~3 min", or "~1h 20m" (Session 64). */
function formatDuration(ms: number): string {
    const totalMinutes = Math.round(ms / 60_000);
    if (totalMinutes < 1) {
        return 'under a minute';
    }
    if (totalMinutes < 60) {
        return `${totalMinutes} min`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Background/startup pre-generation indexing (Session 9 / Build Order step
 * 9): closes the Core Rule 4 gap where hover's cache-miss path is the only
 * thing that ever generates an explanation for a function nobody has saved
 * or refreshed this session. Walks the sidecar's whole-repo PageRank ranking
 * (`list_ranked_functions` -- no new ranker) and pre-generates anything not
 * already cached, most-important functions first.
 *
 * Started once per trusted workspace open, right after the sidecar/cache are
 * ready (mirrors Session 2's trust gating). Re-running it on every open is
 * cheap even on an already-fully-indexed repo: every entry does a local
 * `cache.lookup()` first (same skip pattern `SaveReindexManager` already
 * uses) and only calls the sidecar on an actual miss.
 */
export class BackgroundIndexManager implements vscode.Disposable {
    private cancellationSource: vscode.CancellationTokenSource | undefined;
    private phase: BackgroundIndexPhase = 'idle';
    private readonly statusBarItem: vscode.StatusBarItem;
    /**
     * Guards `updateStatusBar()` against a stray call after `dispose()` has
     * already torn down `statusBarItem` (Session 52, code-reviewer finding).
     * `start()`'s `run()` is fire-and-forget (`void this.run()`, never
     * awaited) and can be suspended at an `await` -- `waitForInteractiveIdle`,
     * `generateAndCache`, or `delay()` -- when `dispose()` fires (extension
     * deactivation / window close mid-pass, a real scenario, not just
     * hypothetical). When that suspended call resumes, it still reaches
     * `finish()` -> `updateStatusBar()`, which would otherwise touch an
     * already-disposed `vscode.StatusBarItem`. Same guard, same rationale,
     * as `sidecarManager.ts`'s own `disposed` flag (see its `updateStatusBar`/
     * `log` methods, added there after an identical late-async-callback bug
     * found in session 27).
     */
    private disposed = false;

    /** Current pass's progress, read by `updateStatusBar()`; `undefined` outside a running/pausing/paused pass (Session 64). */
    private progress: ProgressSnapshot | undefined;

    /**
     * Session 72: coverage snapshot from the most recent *fully completed*
     * pass (`run()` reaching `status === 'done'`, i.e. every entry in scope
     * was claimed -- not a pass that ended early via pause or cancellation),
     * shown in the idle-phase status bar so a user can tell how much of the
     * codebase has a cached explanation without needing a pass to be
     * actively running. `total` is `ranked.length` -- the same
     * scope-sliced (topN or fullRepo, per `resolveBackgroundIndexScope()`)
     * count `ProgressSnapshot.total` used during the pass itself, per the
     * user's explicit choice (`AskUserQuestion`) that this stat should read
     * against the configured background-index scope, not the whole repo
     * unconditionally -- a topN user should see it approach 100%, not stall
     * forever short of the repo's real total. `covered` is
     * `generated + skipped` -- both mean the function has a cache entry
     * now; `unresolved`/`failed` don't. `undefined` until a pass has fully
     * completed at least once (idle state stays hidden until then, same as
     * before this session).
     */
    private lastCoverage: { covered: number; total: number } | undefined;

    /**
     * Rolling window of successful-generation completion timestamps
     * (`Date.now()`, oldest first, capped at `ETA_WINDOW_SIZE + 1` entries),
     * seeded with the pass's own start time so a rate is available after
     * just one completion (Session 64's original "ETA only once at least one
     * generation has completed" behavior, preserved). Session 67: replaced
     * `generationDurations` (per-call durations, meaningless once several
     * calls can be in flight at once) -- see `ETA_WINDOW_SIZE`'s doc comment.
     */
    private generationCompletionTimestamps: number[] = [];

    /** Concurrent `generate_explanation` workers this pass runs (Session 67); injectable purely for tests that need single-item precision (pause-mid-item, exact call ordering) -- production always uses `BACKGROUND_INDEX_CONCURRENCY`, same injection precedent as `sidecarManager.ts`'s `spawnFn`/`connectFn`. */
    private readonly concurrency: number;

    constructor(
        private readonly getWorkspaceRoot: () => string | undefined,
        private readonly getCache: () => ExplanationCache | undefined,
        private readonly getSidecar: () => SidecarManager | undefined,
        private readonly output: vscode.OutputChannel,
        concurrency: number = BACKGROUND_INDEX_CONCURRENCY
    ) {
        this.concurrency = concurrency;
        // Same left-aligned/priority-100/click-to-act pattern as
        // sidecarManager.ts's own statusBarItem -- hidden while idle (nothing
        // actionable), same "hidden until it needs to say something"
        // convention.
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = TOGGLE_BACKGROUND_INDEX_COMMAND_ID;
        this.updateStatusBar();
    }

    /**
     * Guards against `'pausing'` as well as `'running'` (Session 69 fix) --
     * `toggle()`'s own `phase === 'paused'` check happens to keep a plain
     * status-bar click from ever calling `resume()`/`start()` while a pause
     * is still draining its in-flight workers, but `start()` is public and
     * was previously safe only by accident of its one caller's care, not by
     * its own guard: a second, direct `start()`/`resume()` call made while
     * `'pausing'` (before the drain reaches `'paused'`) would kick off a
     * second, fully concurrent `run()` on top of the first pass's own
     * still-finishing workers -- up to `BACKGROUND_INDEX_CONCURRENCY + 1`
     * concurrent `generate_explanation` calls instead of at most
     * `BACKGROUND_INDEX_CONCURRENCY` (flagged by Session 67's code-reviewer,
     * not fixed there since raising the pool size was that session's actual
     * scope). A call made mid-pause is now a silent no-op, exactly like
     * calling `start()` while already `'running'` -- the user chose this
     * over a queued auto-resume (AskUserQuestion, Session 69): simpler, no
     * new state, and matches `pause()`'s own no-op-if-nothing-to-do shape.
     */
    start(): void {
        if (this.phase === 'running' || this.phase === 'pausing') {
            return;
        }
        void this.run();
    }

    /**
     * Thin wrapper around `start()` (Session 52) -- `start()` already treats
     * "not currently running or draining a pause" uniformly whether that's
     * because a pass never started, is still finishing its pause, or the
     * user paused a previous one to completion, and every entry's own
     * `cache.lookup()` inside `run()` already makes re-running skip whatever
     * finished before the pause, so a plain re-`start()` already is a real
     * resume, not a restart-from-scratch. Kept as its own named method
     * purely so the pause/resume pairing is discoverable in the public API.
     */
    resume(): void {
        this.start();
    }

    /** Pauses a running pass so `resume()` can pick it back up later; a no-op with a status message if nothing is running. */
    pause(): void {
        if (this.phase !== 'running' || !this.cancellationSource) {
            vscode.window.setStatusBarMessage('LucidHover: no background indexing running', 3000);
            return;
        }
        this.phase = 'pausing';
        this.updateStatusBar();
        this.cancellationSource.cancel();
        vscode.window.setStatusBarMessage('LucidHover: pausing background indexing...', 3000);
    }

    /** Status-bar item's `.command` target -- pauses a running pass, resumes a paused one, and is a no-op otherwise ('idle': nothing running; 'pausing': already mid-transition). */
    toggle(): void {
        if (this.phase === 'running') {
            this.pause();
        } else if (this.phase === 'paused') {
            this.resume();
        }
    }

    /** Exposed for tests -- the phase driving the status-bar item's current text/tooltip. */
    getPhase(): BackgroundIndexPhase {
        return this.phase;
    }

    dispose(): void {
        this.disposed = true;
        this.cancellationSource?.cancel();
        this.cancellationSource?.dispose();
        this.statusBarItem.dispose();
    }

    /**
     * Builds the tooltip's progress/breakdown/ETA block, shared by the
     * 'running'/'pausing'/'paused' cases below so pausing (which stops
     * calling `updateStatusBar()` from the loop) still shows the same
     * frozen numbers `paused` renders from `this.progress` (Session 64).
     */
    private progressDetail(): string {
        const p = this.progress;
        if (!p) {
            return '';
        }
        const pct = p.total > 0 ? Math.round((doneCount(p) / p.total) * 100) : 0;
        let breakdown = `${p.generated} generated, ${p.skipped} already cached, ${p.unresolved} unresolved`;
        if (p.failed > 0) {
            breakdown += `, ${p.failed} failed`;
        }
        breakdown += ` (${pct}% of ${p.total})`;
        // "Last claimed" rather than "now processing" -- this same block
        // renders for 'running', 'pausing', AND 'paused' (Session 64's
        // frozen-snapshot precedent), and by the time a pause finishes
        // draining, the item this names has already finished (or is the one
        // that was in flight when pause was requested), not something still
        // actively running.
        const lines: string[] = [];
        if (p.currentFunctionName) {
            lines.push(`Last claimed: ${p.currentFunctionName}`);
        }
        lines.push(breakdown);
        if (p.etaMs !== undefined) {
            lines.push(`~${formatDuration(p.etaMs)} remaining`);
        }
        return '\n' + lines.join('\n');
    }

    private progressFraction(): string {
        const p = this.progress;
        if (!p || p.total === 0) {
            return '';
        }
        return ` ${doneCount(p)}/${p.total}`;
    }

    private updateStatusBar(): void {
        if (this.disposed) {
            return;
        }
        switch (this.phase) {
            case 'running':
                this.statusBarItem.text = `$(sync~spin) LucidHover: indexing${this.progressFraction()}`;
                this.statusBarItem.tooltip = `Background indexing is in progress. Click to pause.${this.progressDetail()}`;
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.show();
                break;
            case 'pausing':
                this.statusBarItem.text = `$(sync~spin) LucidHover: pausing${this.progressFraction()}`;
                this.statusBarItem.tooltip = `Background indexing is finishing its current function before pausing.${this.progressDetail()}`;
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.show();
                break;
            case 'paused':
                this.statusBarItem.text = `$(debug-pause) LucidHover: indexing paused${this.progressFraction()}`;
                this.statusBarItem.tooltip = `Background indexing is paused. Click to resume.${this.progressDetail()}`;
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                this.statusBarItem.show();
                break;
            case 'idle':
                // Session 72: show repo-wide coverage from the last fully
                // completed pass, if any, instead of always hiding -- still
                // hidden with nothing to say if no pass has ever completed
                // (untrusted workspace, first activation before a pass
                // finishes, etc).
                if (this.lastCoverage) {
                    const { covered, total } = this.lastCoverage;
                    const pct = total > 0 ? Math.round((covered / total) * 100) : 0;
                    this.statusBarItem.text = `$(check) LucidHover: ${covered}/${total} explained`;
                    this.statusBarItem.tooltip = `Background indexing coverage (${covered}/${total}, ${pct}%) as of the last completed pass, against the configured background-index scope.`;
                    this.statusBarItem.backgroundColor = undefined;
                    this.statusBarItem.show();
                } else {
                    this.statusBarItem.hide();
                }
                break;
        }
    }

    private async run(): Promise<void> {
        const workspaceRoot = this.getWorkspaceRoot();
        const cache = this.getCache();
        const sidecar = this.getSidecar();
        if (!workspaceRoot || !cache || !sidecar) {
            // Untrusted workspace, or sidecar/cache not yet started.
            return;
        }

        this.phase = 'running';
        // Cleared here, not just at the fresh-snapshot assignment further
        // down (Session 64) -- a resumed pass otherwise briefly displays the
        // *previous* pass's frozen count/ETA under the 'running' phase's "in
        // progress" wording for as long as `waitForInteractiveIdle` and the
        // `list_ranked_functions` round-trip below take (code-reviewer
        // finding), directly contradicting `finish()`'s own stated intent
        // that a resumed pass shouldn't inherit stale data from before the
        // pause.
        this.progress = undefined;
        this.generationCompletionTimestamps = [];
        this.updateStatusBar();
        const source = new vscode.CancellationTokenSource();
        this.cancellationSource = source;
        const token = source.token;

        // Session 36: this one-shot call is autonomous background work (this
        // pass's own startup, not a direct user action) just like the
        // per-function generate_explanation calls below, but was left at
        // implicit 'interactive' priority and ungated when session 32 first
        // added the gate -- found by this session's own RPC-call-site audit.
        await sidecar.waitForInteractiveIdle(token);
        if (token.isCancellationRequested) {
            this.finish(source);
            return;
        }

        let ranked: RankedFunction[];
        let totalRanked: number;
        try {
            const result = await sidecar.request<{ functions: RankedFunction[] }>(
                'list_ranked_functions',
                {},
                undefined,
                'background'
            );
            ranked = result.functions;
            totalRanked = ranked.length;
        } catch (err) {
            this.output.appendLine(`background-index: list_ranked_functions failed: ${String(err)}`);
            this.finish(source);
            return;
        }

        // Session 66: narrows the default pass from the whole repo (Session
        // 9's original behavior, ~16 hours projected on a real 6,633-
        // function repo) down to the highest-importance slice -- Core Rule 4's
        // cache-miss hover fallback covers whatever this pass doesn't reach.
        // `ranked` is already importance-descending
        // (`_handle_list_ranked_functions` sorts it sidecar-side), so this is
        // a plain slice, not a re-sort. `'fullRepo'` (opt-in) keeps the old
        // behavior by skipping the slice entirely.
        const scope = resolveBackgroundIndexScope();
        if (scope === 'topN') {
            ranked = ranked.slice(0, resolveBackgroundIndexTopN());
        }

        const startingNote =
            ranked.length < totalRanked
                ? `top ${ranked.length} of ${totalRanked} ranked functions`
                : `${ranked.length} functions ranked`;
        this.output.appendLine(`background-index: starting (${startingNote})`);
        vscode.window.setStatusBarMessage(`LucidHover: background indexing ${ranked.length} functions...`, 5000);

        // Lazily resolved per file (VS Code's own document-symbol provider,
        // same path resolveEnclosingFunction/resolveAllFunctions already
        // use) so a file with several ranked functions is only opened and
        // symbol-resolved once, not once per function -- a `Promise` map
        // (Session 67), not a resolved-value map, so two workers reaching
        // the same file around the same time share the one in-flight
        // resolution instead of duplicating it (the `Map.get`/`.set` pair
        // below has no `await` between them, so this is race-free despite
        // running from several concurrent workers -- JS has no true thread
        // parallelism, only interleaving at `await` points).
        const fileSymbolPromises = new Map<string, Promise<ResolvedFunction[]>>();
        const getFileSymbols = (relFname: string): Promise<ResolvedFunction[]> => {
            let promise = fileSymbolPromises.get(relFname);
            if (!promise) {
                promise = this.resolveFileSymbols(workspaceRoot, relFname);
                fileSymbolPromises.set(relFname, promise);
            }
            return promise;
        };

        let generated = 0;
        let skipped = 0;
        let unresolved = 0;
        let failed = 0;
        this.progress = {
            total: ranked.length,
            generated,
            skipped,
            unresolved,
            failed,
            etaMs: undefined,
            currentFunctionName: undefined,
        };
        this.generationCompletionTimestamps = [Date.now()];
        this.updateStatusBar();

        // Session 67: `ranked` is a shared work queue, claimed one entry at a
        // time by up to `this.concurrency` workers below -- `nextIndex` is
        // safe to mutate from several concurrent `worker()` calls for the
        // same reason `fileSymbolPromises` is above (no `await` inside
        // `claimNext` itself).
        let nextIndex = 0;
        const claimNext = (): RankedFunction | undefined => {
            if (token.isCancellationRequested || nextIndex >= ranked.length) {
                return undefined;
            }
            return ranked[nextIndex++];
        };

        const worker = async (): Promise<void> => {
            for (;;) {
                const entry = claimNext();
                if (!entry) {
                    return;
                }

                const symbols = await getFileSymbols(entry.rel_fname);
                const resolved = this.matchRankedEntry(entry, symbols);
                if (!resolved) {
                    // A def tree-sitter saw but VS Code's document-symbol
                    // provider didn't (or vice versa) -- same tolerance gap
                    // sidecar/rpc_server.py's _find_def_tag already accepts
                    // for hover; nothing to generate against without a
                    // resolved symbol, so skip rather than error the whole
                    // pass.
                    unresolved++;
                    this.progress!.unresolved = unresolved;
                    this.updateStatusBar();
                    continue;
                }

                const cached = cache.lookup({
                    fnId: resolved.fnId,
                    fnHash: resolved.fnHash,
                    modelId: resolveModelId(),
                    embeddingModelId: EMBEDDING_MODEL_ID,
                    promptVersion: PROMPT_VERSION,
                });
                if (cached) {
                    skipped++;
                    this.progress!.skipped = skipped;
                    this.updateStatusBar();
                    continue;
                }

                // Session 32: defer to any hover-miss/save-reindex/refresh
                // request that's pending or arrives in the settle window --
                // every worker awaits this immediately before its own
                // generate_explanation call, so interactive traffic keeps
                // identical priority regardless of how many background
                // workers are running (Session 67). See
                // SidecarManager.waitForInteractiveIdle's doc comment.
                //
                // Passing `token` lets `waitForInteractiveIdle` itself
                // resolve early on cancellation (Session 36) -- without it,
                // a steady stream of interactive activity could otherwise
                // leave this worker parked for an extended, unbounded
                // stretch, during which pausing would silently have no
                // effect (found by code-reviewer during session 32).
                //
                // Session 72: set as soon as this entry is claimed for
                // generation (not just once generateAndCache actually
                // starts) so the tooltip's "Last claimed" line reflects
                // what a worker is about to work on through the idle-wait
                // too, not only the generation call itself -- "most
                // recently claimed", matching the field's own doc comment.
                this.progress!.currentFunctionName = `${entry.rel_fname}: ${resolved.name}`;
                this.updateStatusBar();
                await sidecar.waitForInteractiveIdle(token);
                if (token.isCancellationRequested) {
                    return;
                }

                try {
                    await generateAndCache(sidecar, cache, resolved, 'background');
                    generated++;
                    this.progress!.generated = generated;
                    this.recordGenerationCompletion();
                    this.output.appendLine(`background-index: generated ${resolved.fnId}`);
                } catch (err) {
                    failed++;
                    this.progress!.failed = failed;
                    this.output.appendLine(
                        `background-index: generate_explanation failed for ${resolved.fnId}: ${String(err)}`
                    );
                }
                this.updateStatusBar();

                await this.delay(DELAY_BETWEEN_GENERATIONS_MS, token);
            }
        };

        const workerCount = Math.max(1, this.concurrency);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));

        const status = token.isCancellationRequested ? (this.getPhase() === 'pausing' ? 'paused' : 'canceled') : 'done';
        if (status === 'done') {
            this.lastCoverage = { covered: generated + skipped, total: ranked.length };
        }
        let summary = `${generated} generated, ${skipped} already cached, ${unresolved} unresolved`;
        if (failed > 0) {
            summary += `, ${failed} failed`;
        }
        this.output.appendLine(`background-index: ${status} -- ${summary}`);
        vscode.window.setStatusBarMessage(`LucidHover: background indexing ${status} -- ${summary}`, 5000);
        this.finish(source);
    }

    /**
     * Feeds `this.progress.etaMs` from the observed completions-per-ms rate
     * over the last `ETA_WINDOW_SIZE` successful generations (Session 67 --
     * see `ETA_WINDOW_SIZE`'s doc comment for why this replaced per-call
     * duration averaging once several `generate_explanation` calls can be in
     * flight at once). Only successful generations are sampled -- a
     * cache-hit skip took no generation time, and a failed call isn't
     * representative of real generation pace. `this.progress` and
     * `generationCompletionTimestamps`'s seed are always set before this is
     * called (from inside `run()`'s worker loop, after the loop's own
     * `this.progress = {...}`/seed assignment).
     */
    private recordGenerationCompletion(): void {
        const now = Date.now();
        this.generationCompletionTimestamps.push(now);
        if (this.generationCompletionTimestamps.length > ETA_WINDOW_SIZE + 1) {
            this.generationCompletionTimestamps.shift();
        }
        const first = this.generationCompletionTimestamps[0];
        const completions = this.generationCompletionTimestamps.length - 1;
        const elapsedMs = now - first;
        if (completions <= 0 || elapsedMs <= 0) {
            return;
        }
        const rate = completions / elapsedMs;
        const remaining = this.progress!.total - doneCount(this.progress!);
        this.progress!.etaMs = Math.max(0, remaining) / rate;
    }

    /** `this.phase === 'pausing'` distinguishes a user-initiated `pause()` from a plain teardown cancel (`dispose()`) -- only the former should leave the pass resumable. */
    private finish(source: vscode.CancellationTokenSource): void {
        source.dispose();
        this.cancellationSource = undefined;
        this.phase = this.phase === 'pausing' ? 'paused' : 'idle';
        // 'paused' still needs `this.progress` for `updateStatusBar()`'s
        // frozen count/ETA (Session 64) -- only clear it once the pass is
        // truly done (idle), so a resumed pass starts its own fresh
        // snapshot instead of inheriting a stale one across an unrelated
        // later run.
        if (this.phase === 'idle') {
            this.progress = undefined;
            this.generationCompletionTimestamps = [];
        }
        this.updateStatusBar();
    }

    private async resolveFileSymbols(workspaceRoot: string, relFile: string): Promise<ResolvedFunction[]> {
        try {
            const uri = vscode.Uri.file(path.join(workspaceRoot, relFile));
            const document = await vscode.workspace.openTextDocument(uri);
            return await resolveAllFunctions(document, workspaceRoot);
        } catch (err) {
            this.output.appendLine(`background-index: failed to open ${relFile}: ${String(err)}`);
            return [];
        }
    }

    /**
     * Reconciles the sidecar's tree-sitter def line against VS Code's own
     * document-symbol line for the same function -- the two providers don't
     * always agree exactly (e.g. `const foo = () => {}` arrow-function
     * assignment spans), same drift sidecar/rpc_server.py's _find_def_tag
     * already tolerates on the sidecar side for hover resolution. Matches by
     * name first, then nearest start line.
     */
    private matchRankedEntry(entry: RankedFunction, symbols: ResolvedFunction[]): ResolvedFunction | undefined {
        const candidates = symbols.filter((s) => s.name === entry.name);
        if (candidates.length === 0) {
            return undefined;
        }
        return candidates.reduce((closest, candidate) =>
            Math.abs(candidate.range.start.line - entry.line) < Math.abs(closest.range.start.line - entry.line)
                ? candidate
                : closest
        );
    }

    /** Resolves early if canceled, instead of always waiting out the full delay. */
    private delay(ms: number, token: vscode.CancellationToken): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                subscription.dispose();
                resolve();
            }, ms);
            const subscription = token.onCancellationRequested(() => {
                clearTimeout(timer);
                subscription.dispose();
                resolve();
            });
        });
    }
}

export function registerToggleBackgroundIndexingCommand(manager: BackgroundIndexManager): vscode.Disposable {
    return vscode.commands.registerCommand(TOGGLE_BACKGROUND_INDEX_COMMAND_ID, () => manager.toggle());
}
