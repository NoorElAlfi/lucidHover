import * as path from 'path';
import * as vscode from 'vscode';
import { ExplanationCache } from './cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from './cache/config';
import { resolveAllFunctions, ResolvedFunction } from './functionResolution';
import { generateAndCache } from './generation';
import { SidecarManager } from './sidecar/sidecarManager';

export const CANCEL_BACKGROUND_INDEX_COMMAND_ID = 'lucidhover.cancelBackgroundIndexing';

// Gap between generations, not a request timeout. The pass awaits each
// generate_explanation fully before scheduling the next one (never more than
// one in flight), and this delay opens a real window for a hover-miss/
// save-reindex/refresh request to get its socket write in first -- the
// sidecar dispatches strictly in write order (Session 6's heartbeat-
// starvation bug is why this can't just fire requests back-to-back).
const DELAY_BETWEEN_GENERATIONS_MS = 1000;

interface RankedFunction {
    rel_fname: string;
    name: string;
    line: number;
    importance: number;
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
    private running = false;

    constructor(
        private readonly getWorkspaceRoot: () => string | undefined,
        private readonly getCache: () => ExplanationCache | undefined,
        private readonly getSidecar: () => SidecarManager | undefined,
        private readonly output: vscode.OutputChannel
    ) {}

    start(): void {
        if (this.running) {
            return;
        }
        void this.run();
    }

    cancel(): void {
        if (this.cancellationSource) {
            this.cancellationSource.cancel();
            vscode.window.setStatusBarMessage('LucidHover: canceling background indexing...', 3000);
        } else {
            vscode.window.setStatusBarMessage('LucidHover: no background indexing running', 3000);
        }
    }

    dispose(): void {
        this.cancellationSource?.cancel();
        this.cancellationSource?.dispose();
    }

    private async run(): Promise<void> {
        const workspaceRoot = this.getWorkspaceRoot();
        const cache = this.getCache();
        const sidecar = this.getSidecar();
        if (!workspaceRoot || !cache || !sidecar) {
            // Untrusted workspace, or sidecar/cache not yet started.
            return;
        }

        this.running = true;
        const source = new vscode.CancellationTokenSource();
        this.cancellationSource = source;
        const token = source.token;

        let ranked: RankedFunction[];
        try {
            const result = await sidecar.request<{ functions: RankedFunction[] }>('list_ranked_functions', {});
            ranked = result.functions;
        } catch (err) {
            this.output.appendLine(`background-index: list_ranked_functions failed: ${String(err)}`);
            this.finish(source);
            return;
        }

        this.output.appendLine(`background-index: starting (${ranked.length} functions ranked)`);
        vscode.window.setStatusBarMessage(`LucidHover: background indexing ${ranked.length} functions...`, 5000);

        // Lazily resolved per file (VS Code's own document-symbol provider,
        // same path resolveEnclosingFunction/resolveAllFunctions already
        // use) so a file with several ranked functions is only opened and
        // symbol-resolved once, not once per function.
        const fileSymbols = new Map<string, ResolvedFunction[]>();
        let generated = 0;
        let skipped = 0;
        let unresolved = 0;

        for (const entry of ranked) {
            if (token.isCancellationRequested) {
                break;
            }

            let symbols = fileSymbols.get(entry.rel_fname);
            if (!symbols) {
                symbols = await this.resolveFileSymbols(workspaceRoot, entry.rel_fname);
                fileSymbols.set(entry.rel_fname, symbols);
            }

            const resolved = this.matchRankedEntry(entry, symbols);
            if (!resolved) {
                // A def tree-sitter saw but VS Code's document-symbol
                // provider didn't (or vice versa) -- same tolerance gap
                // sidecar/rpc_server.py's _find_def_tag already accepts for
                // hover; nothing to generate against without a resolved
                // symbol, so skip rather than error the whole pass.
                unresolved++;
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
                continue;
            }

            // Session 32: defer to any hover-miss/save-reindex/refresh
            // request that's pending or arrives in the settle window --
            // once this generate_explanation call is actually sent, nothing
            // can preempt it (the sidecar dispatches strictly one request at
            // a time, Core Rule 11), so this is the only point that can
            // still avoid starting a new collision. See
            // SidecarManager.waitForInteractiveIdle's doc comment.
            //
            // Raced against `token`, not a bare `await` -- a steady stream of
            // interactive activity (exactly the scenario this session
            // targets) can otherwise leave `waitForInteractiveIdle()` parked
            // for an extended, unbounded stretch, during which "Cancel
            // Background Indexing" would silently have no effect (found by
            // code-reviewer during this session; same race-against-token
            // shape as `delay()` below, just against a caller-supplied
            // promise instead of a fixed timer).
            await this.raceAgainstCancellation(sidecar.waitForInteractiveIdle(), token);
            if (token.isCancellationRequested) {
                break;
            }

            try {
                await generateAndCache(sidecar, cache, resolved, 'background');
                generated++;
                this.output.appendLine(`background-index: generated ${resolved.fnId}`);
            } catch (err) {
                this.output.appendLine(
                    `background-index: generate_explanation failed for ${resolved.fnId}: ${String(err)}`
                );
            }

            await this.delay(DELAY_BETWEEN_GENERATIONS_MS, token);
        }

        const status = token.isCancellationRequested ? 'canceled' : 'done';
        this.output.appendLine(
            `background-index: ${status} -- ${generated} generated, ${skipped} already cached, ${unresolved} unresolved`
        );
        this.finish(source);
    }

    private finish(source: vscode.CancellationTokenSource): void {
        source.dispose();
        this.cancellationSource = undefined;
        this.running = false;
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

    /**
     * Session 32: same "resolve early on cancel" shape as `delay()` above,
     * for a caller-supplied promise (`sidecar.waitForInteractiveIdle()`)
     * instead of a fixed timer -- that wait has no cancellation token of its
     * own to pass through, and can legitimately run for an extended, open-
     * ended stretch while interactive activity keeps arriving, which
     * shouldn't leave "Cancel Background Indexing" unresponsive in the
     * meantime. Doesn't cancel `awaited` itself (it has no cancel handle);
     * just stops this loop from waiting on it further once `token` fires.
     */
    private raceAgainstCancellation(awaited: Promise<void>, token: vscode.CancellationToken): Promise<void> {
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                subscription.dispose();
                resolve();
            };
            const subscription = token.onCancellationRequested(finish);
            void awaited.then(finish);
        });
    }
}

export function registerCancelBackgroundIndexingCommand(manager: BackgroundIndexManager): vscode.Disposable {
    return vscode.commands.registerCommand(CANCEL_BACKGROUND_INDEX_COMMAND_ID, () => manager.cancel());
}
