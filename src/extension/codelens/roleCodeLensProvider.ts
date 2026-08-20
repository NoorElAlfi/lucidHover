import * as vscode from 'vscode';
import { ExplanationCache } from '../cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../cache/config';
import { resolveAllFunctions } from '../functionResolution';
import { categoryEmoji, classifyRoleTag, PENDING_CODELENS_TITLE } from './roleCategory';

interface Level0Fields {
    role_tag?: unknown;
}

/**
 * CodeLens role badge (Build Order step 10): one read-only lens per function,
 * showing the same `role_tag` hover already shows, reused from the one
 * cached JSON object per function (Core Design Decision #8). Never
 * generates -- a cache miss renders a neutral placeholder lens instead of
 * calling the sidecar (Core Rule 4 applies to this surface exactly as it
 * does to hover and the docked panel).
 *
 * Every lens uses `command: ''` (a command id of the empty string) rather
 * than an actual registered command -- the standard VS Code idiom for
 * label-only, non-clickable CodeLens text. This matches the spec's "zero
 * interaction" requirement for the role badge without needing a no-op
 * command registration.
 */
export class RoleCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.changeEmitter.event;

    constructor(
        private readonly getWorkspaceRoot: () => string | undefined,
        private readonly getCache: () => ExplanationCache | undefined,
        private readonly output: vscode.OutputChannel
    ) {}

    /** Called when a cache write may affect a visible document (Session 10 design question 3). */
    refresh(): void {
        this.changeEmitter.fire();
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }

    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        const workspaceRoot = this.getWorkspaceRoot();
        const cache = this.getCache();
        if (!workspaceRoot || !cache) {
            // Untrusted workspace, or sidecar/cache not yet started -- render
            // nothing (Core Rule 6), same as hover/panel before indexing starts.
            return [];
        }

        let functions;
        try {
            functions = await resolveAllFunctions(document, workspaceRoot);
        } catch (err) {
            this.output.appendLine(`codelens: failed to resolve functions in ${document.uri.fsPath}: ${String(err)}`);
            return [];
        }

        return functions.map((fn) => {
            const lensRange = new vscode.Range(fn.range.start, fn.range.start);
            const row = cache.lookup({
                fnId: fn.fnId,
                fnHash: fn.fnHash,
                modelId: resolveModelId(),
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: PROMPT_VERSION,
            });

            if (!row) {
                // Resolved by VS Code's own symbol provider, but no row for
                // it yet -- distinct placeholder, not silence, per design
                // question 2. A function the symbol provider can't resolve
                // at all never reaches this map() in the first place, so it
                // gets no lens at all -- that's the other half of the
                // distinction: "pending" only ever describes a function we
                // *can* see.
                return new vscode.CodeLens(lensRange, { title: PENDING_CODELENS_TITLE, command: '' });
            }

            const explanation = JSON.parse(row.explanation_json) as Level0Fields;
            const roleTag = typeof explanation.role_tag === 'string' && explanation.role_tag.trim() ? explanation.role_tag : 'Unknown';
            const emoji = categoryEmoji(classifyRoleTag(roleTag));
            return new vscode.CodeLens(lensRange, { title: `${emoji} ${roleTag}`, command: '' });
        });
    }
}
