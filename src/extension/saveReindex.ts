import * as vscode from 'vscode';
import { ExplanationCache } from './cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from './cache/config';
import { KeyedDebouncer } from './debounce';
import { relFileFor, ResolvedFunction, resolveAllFunctions } from './functionResolution';
import { generateAndCache } from './generation';
import { isSupportedLanguageId } from './languages';
import { SidecarManager } from './sidecar/sidecarManager';
import { flagStaleDependents, StaleTracker } from './staleTracking';

// Spec's "Handling Active Development" table: debounced save fires "~500ms-1s
// after last edit, or blur/tab-switch". We trigger off `onDidSaveTextDocument`
// (see session-08 artifact for why, over FileSystemWatcher) and debounce on
// top of that so several rapid saves in this window collapse to one re-index.
const DEBOUNCE_MS = 750;

// `reindex_file` only re-parses one file and rebuilds the in-memory graph
// (Session 8) -- much cheaper than `generate_explanation`, but still gets
// more room than the 4s default meant for `status`/`index_file` pings.
const REINDEX_TIMEOUT_MS = 15_000;

/**
 * Debounced-save re-indexing (Session 8 / Build Order step 8): on a JS file
 * save, after the debounce window, re-runs the sidecar's repomap module
 * against the changed file only, then hash-diffs every function in that file
 * against the cache and regenerates only the ones whose `fn_hash` actually
 * changed (or that were never cached at all). Registration is unconditional
 * (Core Rule 6, same pattern as the hover provider and panel) -- the getters
 * resolve to undefined until Workspace Trust is granted and indexing has
 * started, at which point `onSave` becomes a no-op until then.
 */
export class SaveReindexManager implements vscode.Disposable {
    private readonly debouncer = new KeyedDebouncer<string>(DEBOUNCE_MS);
    private readonly saveSubscription: vscode.Disposable;

    constructor(
        private readonly getWorkspaceRoot: () => string | undefined,
        private readonly getCache: () => ExplanationCache | undefined,
        private readonly getSidecar: () => SidecarManager | undefined,
        private readonly getStaleTracker: () => StaleTracker | undefined,
        private readonly output: vscode.OutputChannel
    ) {
        this.saveSubscription = vscode.workspace.onDidSaveTextDocument((document) => this.onSave(document));
    }

    private onSave(document: vscode.TextDocument): void {
        if (!isSupportedLanguageId(document.languageId)) {
            return;
        }
        // Keyed per document so unrelated files debounce independently, and
        // repeated saves of the *same* file within the window collapse to
        // one trailing re-index instead of one per save.
        this.debouncer.schedule(document.uri.toString(), () => {
            void this.reindex(document);
        });
    }

    private async reindex(document: vscode.TextDocument): Promise<void> {
        const workspaceRoot = this.getWorkspaceRoot();
        const cache = this.getCache();
        const sidecar = this.getSidecar();
        if (!workspaceRoot || !cache || !sidecar) {
            // Untrusted workspace, or sidecar/cache not yet started.
            return;
        }

        const relFile = relFileFor(document, workspaceRoot);
        this.output.appendLine(`save-reindex: re-indexing ${relFile}`);

        try {
            await sidecar.request('reindex_file', { file_path: relFile }, REINDEX_TIMEOUT_MS);
        } catch (err) {
            this.output.appendLine(`save-reindex: reindex_file failed for ${relFile}: ${String(err)}`);
            return;
        }

        const functions = await resolveAllFunctions(document, workspaceRoot);
        const staleTracker = this.getStaleTracker();
        let regenerated = 0;
        let skipped = 0;
        // Functions that turned out to be a confirmed content change (a prior
        // row existed under a different fn_hash), not a first-ever
        // generation -- see ExplanationCache.getCurrentRowForFnId's doc
        // comment. Only these can make some *other* cached function's row
        // stale (Session 13), so it's tracked separately from `regenerated`.
        const changedFunctions: ResolvedFunction[] = [];
        // Every fnId actually (re)generated this pass, changed or brand new
        // -- guarded against below, since a self- or mutually-recursive
        // function can otherwise show up as its *own* caller/callee in
        // flagStaleDependents and get marked stale immediately after being
        // regenerated fresh.
        const regeneratedFnIds = new Set<string>();

        for (const fn of functions) {
            const cached = cache.lookup({
                fnId: fn.fnId,
                fnHash: fn.fnHash,
                modelId: resolveModelId(),
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: PROMPT_VERSION,
            });
            if (cached) {
                // Same fn_id + same fn_hash as an existing row: unchanged,
                // per Core Design Decision #4 ("invalidate on content hash,
                // never timestamps") -- skip regeneration entirely.
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
                regeneratedFnIds.add(fn.fnId);
                if (priorRow && priorRow.fn_hash !== row.fn_hash) {
                    changedFunctions.push(fn);
                }
            } catch (err) {
                this.output.appendLine(
                    `save-reindex: generate_explanation failed for ${fn.fnId}: ${String(err)}`
                );
            }
        }

        if (staleTracker && changedFunctions.length > 0) {
            await flagStaleDependents(sidecar, workspaceRoot, relFile, changedFunctions, staleTracker, this.output);
        }
        // This pass's own regenerated rows are current again, whatever their
        // freshness state was before (Core Design Decision #5: only an
        // actual regeneration clears it) -- applied last, after flagging, so
        // a self/mutually-recursive edge can't leave one of them stuck
        // showing stale immediately after being freshly regenerated.
        if (staleTracker) {
            for (const fnId of regeneratedFnIds) {
                staleTracker.clearFnId(relFile, fnId);
            }
        }

        this.output.appendLine(
            `save-reindex: ${relFile} done -- ${regenerated} regenerated, ${skipped} unchanged (skipped)`
        );
    }

    dispose(): void {
        this.debouncer.dispose();
        this.saveSubscription.dispose();
    }
}
