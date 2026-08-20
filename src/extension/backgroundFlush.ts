import * as vscode from 'vscode';
import { ExplanationCache } from './cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from './cache/config';
import { DirtyTracker } from './dirtyTracking';
import { resolveFunctionsInFile, ResolvedFunction } from './functionResolution';
import { generateAndCache } from './generation';
import { SidecarManager } from './sidecar/sidecarManager';
import { flagStaleDependents, StaleTracker } from './staleTracking';

const CONFIG_SECTION = 'lucidHover';
const FLUSH_INTERVAL_SETTING = 'backgroundFlushIntervalSeconds';
// Spec's "Handling Active Development" table: "Configurable, default ~20-30s".
// 25s is the midpoint of that range -- the Open Items list still called out
// the exact default as unresolved; this picks a concrete value within the
// range the spec already committed to, not new scope.
const DEFAULT_FLUSH_INTERVAL_SECONDS = 25;
const MIN_FLUSH_INTERVAL_SECONDS = 5;

const REINDEX_TIMEOUT_MS = 15_000;

// Same reasoning and same value as BackgroundIndexManager's
// DELAY_BETWEEN_GENERATIONS_MS (Session 9): never fire generate_explanation
// requests back-to-back, since the sidecar's RPC loop is strictly
// one-request-at-a-time and an unthrottled burst can starve a concurrent
// hover-miss/save/refresh request (Session 6's heartbeat-starvation bug).
const DELAY_BETWEEN_GENERATIONS_MS = 1000;

function flushIntervalMs(): number {
    const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>(FLUSH_INTERVAL_SETTING);
    const seconds =
        typeof configured === 'number' && configured >= MIN_FLUSH_INTERVAL_SECONDS
            ? configured
            : DEFAULT_FLUSH_INTERVAL_SECONDS;
    return seconds * 1000;
}

/**
 * Periodic background flush (Session 12 / Build Order step 12, second of the
 * three new change-detection layers): "Catches `dirty` functions with no
 * save event yet" per the spec's trigger table. Unlike `BackgroundIndexManager`
 * (Session 9), which walks the *entire* ranked call graph once at startup,
 * this walks *only* the files/functions `DirtyTracker` currently has flagged
 * -- a real recurring pass, but deliberately scoped so it never turns into a
 * second full-repo re-walk.
 *
 * Every flagged function still goes through the same `cache.lookup()`
 * hash-diff gate as every other trigger (Core Design Decision #4/#5) -- being
 * dirty is a hint to re-check, never a license to regenerate unconditionally.
 */
export class BackgroundFlushManager implements vscode.Disposable {
    private timer: ReturnType<typeof setInterval> | undefined;
    private running = false;
    private cancellationSource: vscode.CancellationTokenSource | undefined;

    constructor(
        private readonly getWorkspaceRoot: () => string | undefined,
        private readonly getCache: () => ExplanationCache | undefined,
        private readonly getSidecar: () => SidecarManager | undefined,
        private readonly getDirtyTracker: () => DirtyTracker | undefined,
        private readonly getStaleTracker: () => StaleTracker | undefined,
        private readonly output: vscode.OutputChannel
    ) {
        // Started unconditionally at construction (same "always registered,
        // readiness checked internally" pattern as SaveReindexManager/hover),
        // not gated behind an explicit start() call like BackgroundIndexManager
        // -- this is recurring bookkeeping, not a one-shot pass, so each tick
        // just no-ops cheaply until trust/sidecar/cache are ready.
        this.timer = setInterval(() => void this.tick(), flushIntervalMs());
    }

    private async tick(): Promise<void> {
        if (this.running) {
            // A previous cycle is still draining (e.g. a large dirty backlog,
            // or a slow sidecar) -- skip this tick rather than overlap two
            // flush passes hitting the sidecar's one-at-a-time RPC loop at once.
            return;
        }

        const workspaceRoot = this.getWorkspaceRoot();
        const cache = this.getCache();
        const sidecar = this.getSidecar();
        const dirtyTracker = this.getDirtyTracker();
        const staleTracker = this.getStaleTracker();
        if (!workspaceRoot || !cache || !sidecar || !dirtyTracker) {
            return;
        }

        const dirtyFiles = dirtyTracker.dirtyFiles();
        if (dirtyFiles.length === 0) {
            return;
        }

        this.running = true;
        const source = new vscode.CancellationTokenSource();
        this.cancellationSource = source;
        const token = source.token;

        let flushed = 0;
        let unchanged = 0;
        let failed = 0;
        // Every {relFile, fnId} actually (re)generated this tick, across
        // every dirty file processed below -- cleared as a final guard pass
        // after all flagStaleDependents calls, so a self- or cross-file
        // mutually-recursive edge can't leave one of them stuck stale
        // immediately after being regenerated fresh (see saveReindex.ts's
        // identical guard for the single-file case).
        const regeneratedThisTick: { relFile: string; fnId: string }[] = [];

        try {
            for (const relFile of dirtyFiles) {
                if (token.isCancellationRequested) {
                    break;
                }
                const fnIds = dirtyTracker.dirtyFnIdsFor(relFile);
                if (!fnIds || fnIds.size === 0) {
                    continue;
                }
                // Snapshot this file's dirty fnIds before processing -- any
                // edits that land *during* this pass add fresh entries to the
                // live tracker, which are left alone for the next cycle
                // rather than raced against here.
                const fnIdsToCheck = [...fnIds];

                try {
                    await sidecar.request('reindex_file', { file_path: relFile }, REINDEX_TIMEOUT_MS);
                } catch (err) {
                    this.output.appendLine(`background-flush: reindex_file failed for ${relFile}: ${String(err)}`);
                    // Leave every fnId in this file dirty -- retried next cycle.
                    continue;
                }

                const resolved = await resolveFunctionsInFile(workspaceRoot, relFile, this.output);
                const changedFunctions: ResolvedFunction[] = [];

                for (const fnId of fnIdsToCheck) {
                    if (token.isCancellationRequested) {
                        break;
                    }
                    const fn = resolved.find((f) => f.fnId === fnId);
                    if (!fn) {
                        // Function no longer resolves at this identity (renamed,
                        // deleted, or shifted enough that fnId's line no longer
                        // matches) -- nothing to regenerate against; the next
                        // save or background-index pass will pick up whatever
                        // replaced it.
                        dirtyTracker.clearFnId(relFile, fnId);
                        continue;
                    }

                    const cached = cache.lookup({
                        fnId: fn.fnId,
                        fnHash: fn.fnHash,
                        modelId: resolveModelId(),
                        embeddingModelId: EMBEDDING_MODEL_ID,
                        promptVersion: PROMPT_VERSION,
                    });
                    if (cached) {
                        // Per Core Design Decision #4: same fn_hash as the
                        // cached row means the edit(s) that made this dirty
                        // didn't actually change the function's content
                        // (e.g. undone, or just whitespace/comment churn that
                        // happened to hash the same) -- nothing to regenerate.
                        unchanged++;
                        dirtyTracker.clearFnId(relFile, fnId);
                        continue;
                    }

                    const priorRow = cache.getCurrentRowForFnId({
                        fnId: fn.fnId,
                        modelId: resolveModelId(),
                        embeddingModelId: EMBEDDING_MODEL_ID,
                        promptVersion: PROMPT_VERSION,
                    });

                    try {
                        const row = await generateAndCache(sidecar, cache, fn);
                        flushed++;
                        dirtyTracker.clearFnId(relFile, fnId);
                        regeneratedThisTick.push({ relFile, fnId });
                        if (priorRow && priorRow.fn_hash !== row.fn_hash) {
                            changedFunctions.push(fn);
                        }
                    } catch (err) {
                        failed++;
                        this.output.appendLine(`background-flush: generate_explanation failed for ${fnId}: ${String(err)}`);
                        // Deliberately NOT cleared: left dirty so the next
                        // flush cycle retries automatically once whatever
                        // caused this (e.g. sidecar/Ollama hiccup) clears up,
                        // rather than silently dropping the pending change.
                    }

                    await this.delay(DELAY_BETWEEN_GENERATIONS_MS, token);
                }

                if (staleTracker && changedFunctions.length > 0) {
                    await flagStaleDependents(sidecar, workspaceRoot, relFile, changedFunctions, staleTracker, this.output);
                }
            }

            if (staleTracker) {
                for (const { relFile: regeneratedRelFile, fnId } of regeneratedThisTick) {
                    staleTracker.clearFnId(regeneratedRelFile, fnId);
                }
            }
        } finally {
            if (flushed + unchanged + failed > 0) {
                this.output.appendLine(
                    `background-flush: ${flushed} regenerated, ${unchanged} unchanged, ${failed} failed (left dirty)`
                );
            }
            source.dispose();
            this.cancellationSource = undefined;
            this.running = false;
        }
    }

    private delay(ms: number, token: vscode.CancellationToken): Promise<void> {
        return new Promise((resolve) => {
            const t = setTimeout(() => {
                subscription.dispose();
                resolve();
            }, ms);
            const subscription = token.onCancellationRequested(() => {
                clearTimeout(t);
                subscription.dispose();
                resolve();
            });
        });
    }

    dispose(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.cancellationSource?.cancel();
        this.cancellationSource?.dispose();
    }
}
