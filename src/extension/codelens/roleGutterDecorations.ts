import * as vscode from 'vscode';
import { ExplanationCache } from '../cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../cache/config';
import { resolveAllFunctions } from '../functionResolution';
import { isSupportedLanguageId } from '../languages';
import { ALL_ROLE_CATEGORIES, categoryIconFile, classifyRoleTag, PENDING_ICON_FILE, RoleCategory } from './roleCategory';

type DecorationKey = RoleCategory | 'pending';

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
 * `ExplanationCache.onDidWrite` notification).
 */
export class RoleGutterDecorationManager implements vscode.Disposable {
    private readonly decorationTypes: Map<DecorationKey, vscode.TextEditorDecorationType>;
    private readonly subscriptions: vscode.Disposable[] = [];

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
            })
        );
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
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        for (const type of this.decorationTypes.values()) {
            type.dispose();
        }
    }
}
