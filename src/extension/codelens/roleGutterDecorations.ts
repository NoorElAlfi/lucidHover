import * as vscode from 'vscode';
import { ExplanationCache } from '../cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../cache/config';
import { KeyedDebouncer } from '../debounce';
import { resolveAllFunctions } from '../functionResolution';
import { isSupportedLanguageId } from '../languages';
import { ALL_ROLE_CATEGORIES, categoryIconFile, classifyRoleTag, PENDING_ICON_FILE, RoleCategory } from './roleCategory';

type DecorationKey = RoleCategory | 'pending';

// Local, in-memory re-render only (resolveAllFunctions + cache lookups, no
// sidecar RPC) -- much cheaper than SaveReindexManager's 750ms debounce
// (saveReindex.ts), which gates a real generate_explanation call. Still
// debounced, not fired on every keystroke, so a burst of edits collapses to
// one re-render per document per window (same collapsing behavior
// DirtyTracker's own onDidChangeTextDocument listener relies on).
const CHANGE_REFRESH_DEBOUNCE_MS = 300;

/**
 * Gutter icon per role category (Build Order step 10, `TextEditorDecorationType.
 * gutterIconPath` per the spec). Same read-only, cache-only contract as
 * `RoleCodeLensProvider` -- reuses the identical resolve+lookup+classify path
 * so the two surfaces can never show different categories for the same
 * function, and never generates on a miss (Core Rule 4).
 *
 * Decorations are VS Code's own per-editor push mechanism (there is no
 * `DecorationProvider` analog to `CodeLensProvider`'s pull-on-demand model),
 * so this class owns redrawing every visible editor itself, on the same
 * triggers CodeLens redraws from (visibility changes, and Session 10's new
 * `ExplanationCache.onDidWrite` notification) plus a debounced
 * `onDidChangeTextDocument` listener (Session 26 fix, below): a decoration
 * set once by `refreshEditor` only ever auto-adjusts its *position* as VS
 * Code's own range-tracking follows edits -- it never gets recomputed
 * against the current source on a bare text edit the way `CodeLensProvider`
 * does (VS Code re-invokes `provideCodeLenses` itself on document changes).
 * Without this listener a deleted function's dot stays parked at its last
 * tracked position forever, and any transient bad resolution picked up by
 * an unrelated `refreshAll()` trigger mid-edit (e.g. a cache write for a
 * different file landing while this document is mid-keystroke) never
 * self-corrects either -- both are the same root cause, a missing
 * re-render trigger on edit.
 */
export class RoleGutterDecorationManager implements vscode.Disposable {
    private readonly decorationTypes: Map<DecorationKey, vscode.TextEditorDecorationType>;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly changeDebouncer = new KeyedDebouncer<string>(CHANGE_REFRESH_DEBOUNCE_MS);

    constructor(
        extensionUri: vscode.Uri,
        private readonly getWorkspaceRoot: () => string | undefined,
        private readonly getCache: () => ExplanationCache | undefined,
        private readonly output: vscode.OutputChannel
    ) {
        this.decorationTypes = new Map();
        for (const category of ALL_ROLE_CATEGORIES) {
            this.decorationTypes.set(
                category,
                vscode.window.createTextEditorDecorationType({
                    gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'roles', categoryIconFile(category)),
                    gutterIconSize: 'contain',
                })
            );
        }
        this.decorationTypes.set(
            'pending',
            vscode.window.createTextEditorDecorationType({
                gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'roles', PENDING_ICON_FILE),
                gutterIconSize: 'contain',
            })
        );

        this.subscriptions.push(
            vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor) {
                    void this.refreshEditor(editor);
                }
            }),
            vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e))
        );
    }

    /** Debounced per-document re-render on a bare text edit (Session 26 fix -- see class doc comment). */
    private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
        if (!isSupportedLanguageId(e.document.languageId) || e.contentChanges.length === 0) {
            return;
        }
        const uriKey = e.document.uri.toString();
        this.changeDebouncer.schedule(uriKey, () => {
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document.uri.toString() === uriKey) {
                    void this.refreshEditor(editor);
                }
            }
        });
    }

    /** Redraws every currently visible editor. Called on startup/trust-grant and on every cache write (design question 3). */
    refreshAll(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            void this.refreshEditor(editor);
        }
    }

    private async refreshEditor(editor: vscode.TextEditor): Promise<void> {
        if (!isSupportedLanguageId(editor.document.languageId)) {
            return;
        }

        const workspaceRoot = this.getWorkspaceRoot();
        const cache = this.getCache();
        if (!workspaceRoot || !cache) {
            // Untrusted workspace, or sidecar/cache not yet started -- render
            // nothing (Core Rule 6), same as hover/panel/CodeLens before
            // indexing starts.
            for (const type of this.decorationTypes.values()) {
                editor.setDecorations(type, []);
            }
            return;
        }

        let functions;
        try {
            functions = await resolveAllFunctions(editor.document, workspaceRoot);
        } catch (err) {
            this.output.appendLine(`gutter: failed to resolve functions in ${editor.document.uri.fsPath}: ${String(err)}`);
            return;
        }

        const rangesByKey = new Map<DecorationKey, vscode.Range[]>();
        for (const fn of functions) {
            const line = fn.range.start.line;
            const lineRange = new vscode.Range(line, 0, line, 0);

            const row = cache.lookup({
                fnId: fn.fnId,
                fnHash: fn.fnHash,
                modelId: resolveModelId(),
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: PROMPT_VERSION,
            });

            let key: DecorationKey;
            if (!row) {
                // Same "pending" distinction as the CodeLens provider: resolved
                // but not yet cached, not the same as unresolvable (which never
                // reaches this loop at all).
                key = 'pending';
            } else {
                const explanation = JSON.parse(row.explanation_json) as { role_tag?: unknown };
                const roleTag = typeof explanation.role_tag === 'string' ? explanation.role_tag : '';
                key = classifyRoleTag(roleTag);
            }

            const ranges = rangesByKey.get(key) ?? [];
            ranges.push(lineRange);
            rangesByKey.set(key, ranges);
        }

        for (const [key, type] of this.decorationTypes) {
            editor.setDecorations(type, rangesByKey.get(key) ?? []);
        }
    }

    dispose(): void {
        this.changeDebouncer.dispose();
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        for (const type of this.decorationTypes.values()) {
            type.dispose();
        }
    }
}
