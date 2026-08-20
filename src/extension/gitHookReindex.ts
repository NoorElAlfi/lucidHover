import * as path from 'path';
import * as vscode from 'vscode';
import { ExplanationCache } from './cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from './cache/config';
import { KeyedDebouncer } from './debounce';
import { resolveFunctionsInFile, ResolvedFunction } from './functionResolution';
import { generateAndCache } from './generation';
import { hooksInstalled, installAllHooks, isRealGitRepo, readOptional } from './gitHookInstaller';
import { SidecarManager } from './sidecar/sidecarManager';
import { flagStaleDependents, StaleTracker } from './staleTracking';

export const INSTALL_GIT_HOOKS_COMMAND_ID = 'lucidhover.installGitHooks';

const DECLINED_STATE_KEY = 'lucidhover.gitHooksDeclined';
const MARKER_DEBOUNCE_MS = 300;
const REINDEX_TIMEOUT_MS = 15_000;
// Same reasoning as BackgroundIndexManager/BackgroundFlushManager: never
// burst generate_explanation calls, since a checkout/merge can touch many
// files at once and the sidecar's RPC loop is strictly one-at-a-time.
const DELAY_BETWEEN_GENERATIONS_MS = 1000;

/**
 * Git-aware hook install + re-index (Session 12 / Build Order step 12, third
 * of the three new change-detection layers): "Diff vs. previous HEAD,
 * re-index only changed files -- never full rebuild" per the spec's trigger
 * table. The hook itself runs outside the extension host as a plain shell
 * script (git hooks always do), so it can't call back into the running
 * extension directly -- it signals it by writing a marker file
 * (`.git/LUCIDHOVER_REINDEX`) that this class watches via
 * `FileSystemWatcher`, the same marker-file + watcher shape called out as
 * the plausible mechanism in the session brief.
 *
 * Install policy (explicitly confirmed with the user before writing anything
 * to `.git/hooks/`, per the session instructions): prompted opt-in on first
 * activation in a trusted git repo, matching the spec's own "Handling Active
 * Development" Notes line ("offered opt-in on first activation in a repo").
 * A decline is remembered per-workspace but not permanent -- the
 * "LucidHover: Install Git Hooks" command re-offers it any time.
 */
export class GitHookReindexManager implements vscode.Disposable {
    private watcher: vscode.FileSystemWatcher | undefined;
    private watcherSubscriptions: vscode.Disposable[] = [];
    private readonly debouncer = new KeyedDebouncer<string>(MARKER_DEBOUNCE_MS);
    private running = false;
    private cancellationSource: vscode.CancellationTokenSource | undefined;
    private currentWorkspaceRoot: string | undefined;

    constructor(
        private readonly getWorkspaceRoot: () => string | undefined,
        private readonly getCache: () => ExplanationCache | undefined,
        private readonly getSidecar: () => SidecarManager | undefined,
        private readonly getStaleTracker: () => StaleTracker | undefined,
        private readonly workspaceState: vscode.Memento,
        private readonly output: vscode.OutputChannel
    ) {}

    /**
     * Called once from `startIndexing()`, mirroring `BackgroundIndexManager`'s
     * explicit `start()` (Session 9) -- this needs a known, trusted
     * `workspaceRoot` to find `.git` and set up the watcher, so it can't just
     * run unconditionally from the constructor the way `DirtyTracker`/
     * `BackgroundFlushManager` do.
     */
    async start(): Promise<void> {
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            return;
        }
        this.currentWorkspaceRoot = workspaceRoot;

        if (!(await isRealGitRepo(workspaceRoot))) {
            this.output.appendLine('git-hook: no .git directory found -- skipping install offer and watcher');
            return;
        }

        this.setUpWatcher(workspaceRoot);

        if (await hooksInstalled(workspaceRoot)) {
            this.output.appendLine('git-hook: already installed');
            return;
        }

        const declined = this.workspaceState.get<boolean>(DECLINED_STATE_KEY, false);
        if (declined) {
            return;
        }

        const choice = await vscode.window.showInformationMessage(
            'LucidHover can install lightweight git hooks (post-checkout/post-merge/post-commit) to auto re-index files changed by checkout, merge, or pull. Hooks are appended, never overwritten.',
            'Install',
            'Not now',
            "Don't ask again"
        );
        if (choice === 'Install') {
            await this.installHooks();
        } else if (choice === "Don't ask again") {
            await this.workspaceState.update(DECLINED_STATE_KEY, true);
        }
    }

    /** Also the body of the `lucidhover.installGitHooks` command -- bypasses the decline flag, so a "Don't ask again" isn't permanent. */
    async installHooks(): Promise<void> {
        const workspaceRoot = this.currentWorkspaceRoot ?? this.getWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.setStatusBarMessage('LucidHover: indexing not ready yet', 3000);
            return;
        }
        if (!(await isRealGitRepo(workspaceRoot))) {
            vscode.window.showInformationMessage('LucidHover: no .git directory found in this workspace.');
            return;
        }

        await installAllHooks(workspaceRoot, this.output);
        vscode.window.setStatusBarMessage('LucidHover: git hooks installed', 3000);

        if (!this.watcher) {
            this.setUpWatcher(workspaceRoot);
        }
    }

    private setUpWatcher(workspaceRoot: string): void {
        const gitDirUri = vscode.Uri.file(path.join(workspaceRoot, '.git'));
        const pattern = new vscode.RelativePattern(gitDirUri, 'LUCIDHOVER_REINDEX');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.watcher = watcher;
        this.watcherSubscriptions = [
            watcher.onDidCreate(() => this.onMarkerChanged(workspaceRoot)),
            watcher.onDidChange(() => this.onMarkerChanged(workspaceRoot)),
            watcher,
        ];
    }

    private onMarkerChanged(workspaceRoot: string): void {
        // A single `git merge`/`checkout` can trigger create+change in quick
        // succession -- collapse to one read+reindex pass.
        this.debouncer.schedule('marker', () => void this.processMarker(workspaceRoot));
    }

    private async processMarker(workspaceRoot: string): Promise<void> {
        if (this.running) {
            // A previous marker read is still draining; the marker file will
            // simply be re-read (and any newer content picked up) the next
            // time it changes.
            return;
        }
        const cache = this.getCache();
        const sidecar = this.getSidecar();
        const staleTracker = this.getStaleTracker();
        if (!cache || !sidecar) {
            return;
        }

        const markerPath = path.join(workspaceRoot, '.git', 'LUCIDHOVER_REINDEX');
        const content = await readOptional(markerPath);
        if (!content) {
            return;
        }
        const relFiles = content
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.endsWith('.js'));
        if (relFiles.length === 0) {
            return;
        }

        this.running = true;
        const source = new vscode.CancellationTokenSource();
        this.cancellationSource = source;
        const token = source.token;

        this.output.appendLine(`git-hook: re-indexing ${relFiles.length} file(s) from ${markerPath}`);
        let regenerated = 0;
        let skipped = 0;
        // Same cross-file recursion guard as BackgroundFlushManager: every
        // {relFile, fnId} actually (re)generated across every file this
        // marker touched, cleared as a final pass after all
        // flagStaleDependents calls below.
        const regeneratedThisPass: { relFile: string; fnId: string }[] = [];

        try {
            for (const relFile of relFiles) {
                if (token.isCancellationRequested) {
                    break;
                }
                try {
                    await sidecar.request('reindex_file', { file_path: relFile }, REINDEX_TIMEOUT_MS);
                } catch (err) {
                    this.output.appendLine(`git-hook: reindex_file failed for ${relFile}: ${String(err)}`);
                    continue;
                }

                const functions = await resolveFunctionsInFile(workspaceRoot, relFile, this.output);
                const changedFunctions: ResolvedFunction[] = [];
                for (const fn of functions) {
                    if (token.isCancellationRequested) {
                        break;
                    }
                    const cached = cache.lookup({
                        fnId: fn.fnId,
                        fnHash: fn.fnHash,
                        modelId: resolveModelId(),
                        embeddingModelId: EMBEDDING_MODEL_ID,
                        promptVersion: PROMPT_VERSION,
                    });
                    if (cached) {
                        skipped++;
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
                        regenerated++;
                        regeneratedThisPass.push({ relFile, fnId: fn.fnId });
                        if (priorRow && priorRow.fn_hash !== row.fn_hash) {
                            changedFunctions.push(fn);
                        }
                    } catch (err) {
                        this.output.appendLine(`git-hook: generate_explanation failed for ${fn.fnId}: ${String(err)}`);
                    }
                    await this.delay(DELAY_BETWEEN_GENERATIONS_MS, token);
                }

                if (staleTracker && changedFunctions.length > 0) {
                    await flagStaleDependents(sidecar, workspaceRoot, relFile, changedFunctions, staleTracker, this.output);
                }
            }

            if (staleTracker) {
                for (const { relFile: regeneratedRelFile, fnId } of regeneratedThisPass) {
                    staleTracker.clearFnId(regeneratedRelFile, fnId);
                }
            }
        } finally {
            this.output.appendLine(`git-hook: done -- ${regenerated} regenerated, ${skipped} unchanged (skipped)`);
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
        this.debouncer.dispose();
        this.cancellationSource?.cancel();
        this.cancellationSource?.dispose();
        for (const sub of this.watcherSubscriptions) {
            sub.dispose();
        }
        this.watcherSubscriptions = [];
        this.watcher = undefined;
    }
}

export function registerInstallGitHooksCommand(manager: GitHookReindexManager): vscode.Disposable {
    return vscode.commands.registerCommand(INSTALL_GIT_HOOKS_COMMAND_ID, () => void manager.installHooks());
}
