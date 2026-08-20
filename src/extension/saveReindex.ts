import * as vscode from 'vscode';
import { ExplanationCache } from './cache/explanationCache';
import { EMBEDDING_MODEL_ID, MODEL_ID, PROMPT_VERSION } from './cache/config';
import { KeyedDebouncer } from './debounce';
import { relFileFor, resolveAllFunctions } from './functionResolution';
import { generateAndCache } from './generation';
import { SidecarManager } from './sidecar/sidecarManager';

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
        private readonly output: vscode.OutputChannel
    ) {
        this.saveSubscription = vscode.workspace.onDidSaveTextDocument((document) => this.onSave(document));
    }

    private onSave(document: vscode.TextDocument): void {
        if (document.languageId !== 'javascript') {
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
        let regenerated = 0;
        let skipped = 0;

        for (const fn of functions) {
            const cached = cache.lookup({
                fnId: fn.fnId,
                fnHash: fn.fnHash,
                modelId: MODEL_ID,
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

            try {
                await generateAndCache(sidecar, cache, fn);
                regenerated++;
            } catch (err) {
                this.output.appendLine(
                    `save-reindex: generate_explanation failed for ${fn.fnId}: ${String(err)}`
                );
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
