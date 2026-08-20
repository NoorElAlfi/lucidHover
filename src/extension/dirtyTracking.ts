import * as vscode from 'vscode';
import { relFileFor, resolveAllFunctions, ResolvedFunction } from './functionResolution';

/**
 * On-type dirty-tracking (Session 12 / Build Order step 12, first of the
 * three new change-detection layers from the spec's trigger table). Purely
 * in-memory bookkeeping this session -- no UI reads this yet (that's Session
 * 13's staleness badge); the only consumer right now is `BackgroundFlushManager`.
 *
 * Keyed by `fnId` (relFile + name + start line), NOT `fn_hash`. `fn_hash` is
 * a hash of the function's *current* source, so it changes on every
 * keystroke that touches the function -- flagging "this exact hash is dirty"
 * would be stale before the next keystroke even lands. `fnId` is the stable
 * slot the cache and every other trigger already key on.
 */
export class DirtyTracker implements vscode.Disposable {
    // relFile -> dirty fnIds in that file.
    private readonly dirtyByFile = new Map<string, Set<string>>();
    // document URI string -> last-resolved function ranges for that document,
    // used to map a keystroke's change range to an enclosing function without
    // a document-symbol round trip on every single edit.
    private readonly resolvedCache = new Map<string, ResolvedFunction[]>();
    private readonly subscriptions: vscode.Disposable[];

    constructor(
        private readonly getWorkspaceRoot: () => string | undefined,
        private readonly output: vscode.OutputChannel
    ) {
        this.subscriptions = [
            vscode.workspace.onDidChangeTextDocument((e) => void this.onChange(e)),
            // A save is about to be fully re-checked by SaveReindexManager
            // (every function in the file, not just the dirty ones), so any
            // backlog for this file is moot the moment the save-reindex pass
            // runs -- clearing it here avoids periodic flush redundantly
            // re-checking what save-reindex just handled. The stale cached
            // ranges are dropped too, since line numbers may have shifted.
            vscode.workspace.onDidSaveTextDocument((document) => this.onSave(document)),
            vscode.workspace.onDidCloseTextDocument((document) => {
                this.resolvedCache.delete(document.uri.toString());
            }),
        ];
    }

    private async onChange(e: vscode.TextDocumentChangeEvent): Promise<void> {
        if (e.document.languageId !== 'javascript' || e.contentChanges.length === 0) {
            return;
        }
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            // Untrusted workspace, or sidecar/cache not yet started -- nothing
            // downstream would act on a dirty flag yet anyway.
            return;
        }

        const uriKey = e.document.uri.toString();
        let functions = this.resolvedCache.get(uriKey);
        if (!functions) {
            functions = await resolveAllFunctions(e.document, workspaceRoot);
            this.resolvedCache.set(uriKey, functions);
        }

        const relFile = relFileFor(e.document, workspaceRoot);
        for (const change of e.contentChanges) {
            const enclosing = functions.find((fn) => fn.range.contains(change.range.start));
            if (enclosing) {
                const wasAlreadyDirty = this.dirtyByFile.get(relFile)?.has(enclosing.fnId) ?? false;
                this.markDirty(relFile, enclosing.fnId);
                if (!wasAlreadyDirty) {
                    this.output.appendLine(`dirty-tracking: ${enclosing.fnId} marked dirty`);
                }
            }
            // A change outside every known function range (e.g. a brand-new
            // function being typed, or a top-level edit) has nothing to key
            // a dirty flag against yet -- it'll be picked up as new/changed
            // by the next save or full re-index either way.
        }
    }

    private onSave(document: vscode.TextDocument): void {
        this.resolvedCache.delete(document.uri.toString());
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot || document.languageId !== 'javascript') {
            return;
        }
        this.clearFile(relFileFor(document, workspaceRoot));
    }

    private markDirty(relFile: string, fnId: string): void {
        let set = this.dirtyByFile.get(relFile);
        if (!set) {
            set = new Set();
            this.dirtyByFile.set(relFile, set);
        }
        set.add(fnId);
    }

    /** Files with at least one dirty function. */
    dirtyFiles(): string[] {
        return [...this.dirtyByFile.keys()];
    }

    dirtyFnIdsFor(relFile: string): Set<string> | undefined {
        return this.dirtyByFile.get(relFile);
    }

    clearFnId(relFile: string, fnId: string): void {
        const set = this.dirtyByFile.get(relFile);
        if (!set) {
            return;
        }
        set.delete(fnId);
        if (set.size === 0) {
            this.dirtyByFile.delete(relFile);
        }
    }

    clearFile(relFile: string): void {
        this.dirtyByFile.delete(relFile);
    }

    dispose(): void {
        for (const sub of this.subscriptions) {
            sub.dispose();
        }
        this.dirtyByFile.clear();
        this.resolvedCache.clear();
    }
}
