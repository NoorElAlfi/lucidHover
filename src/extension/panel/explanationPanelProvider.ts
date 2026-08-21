import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExplanationCache, CacheRow } from '../cache/explanationCache';
import { EMBEDDING_MODEL_ID, MODEL_ID, PROMPT_VERSION } from '../cache/config';
import { resolveEnclosingFunction } from '../functionResolution';
import { SidecarManager } from '../sidecar/sidecarManager';

export const EXPLANATION_PANEL_VIEW_ID = 'lucidhover.explanationPanel';
export const SHOW_MORE_COMMAND_ID = 'lucidhover.showMore';
const NAVIGATE_COMMAND_ID = 'lucidhover.navigateToFunction';

interface ExplanationFields {
    why_it_exists?: string;
    used_by?: string[];
    calls?: string[];
    side_effects?: string[];
    risk_note?: string | null;
}

const NAVIGABLE_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
    vscode.SymbolKind.Variable,
]);

function fnNameFromFnId(fnId: string): string {
    // fn_id = `${relFile}::${qualifiedName}`, where qualifiedName is a
    // dot-joined enclosing-scope path optionally suffixed with `#n` for
    // duplicates (see cache/hash.ts computeFnId / functionResolution.ts
    // assignFnIds) -- take the last dot segment for a bare display name.
    const parts = fnId.split('::');
    const qualifiedName = parts.length >= 2 ? parts[parts.length - 1] : fnId;
    const withoutOrdinal = qualifiedName.replace(/#\d+$/, '');
    const segments = withoutOrdinal.split('.');
    return segments[segments.length - 1] || fnId;
}

/**
 * Docked WebviewView for explanation levels 1-2 (Session 7). Content syncs to
 * the function under the cursor, but is cache-only, same as hover -- it must
 * never trigger generation (Core Rule 4). Registered in its own Activity Bar
 * view container (not `viewsContainers.secondarySideBar`, which is still a
 * proposed-only API as of VS Code 1.106 -- see session-07 artifact); the user
 * can drag the view into the Secondary Side Bar themselves via VS Code's
 * native "Move View" action, no declarative placement API required.
 */
export class ExplanationPanelProvider implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;
    private pendingRow: CacheRow | undefined;

    constructor(
        private readonly getWorkspaceRoot: () => string | undefined,
        private readonly getCache: () => ExplanationCache | undefined,
        private readonly output: vscode.OutputChannel
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.renderHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((message: { type?: string; name?: string }) => {
            if (message?.type === 'navigate' && message.name) {
                void vscode.commands.executeCommand(NAVIGATE_COMMAND_ID, message.name);
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.refreshFromActiveEditor();
            }
        });

        webviewView.onDidDispose(() => {
            this.view = undefined;
        });

        if (this.pendingRow) {
            this.postRow(this.pendingRow);
            this.pendingRow = undefined;
        } else {
            this.refreshFromActiveEditor();
        }
    }

    /**
     * Explicit push for a specific row, independent of cursor position --
     * used by the hover's "Show more" link, since the function under the
     * mouse when hovering can differ from wherever the text cursor is.
     */
    showRow(row: CacheRow): void {
        if (this.view) {
            this.postRow(row);
        } else {
            // Not resolved yet -- the reveal command's `.focus` call will
            // trigger resolveWebviewView, which picks this up.
            this.pendingRow = row;
        }
    }

    /** Reveals/focuses the panel via the view's auto-generated `.focus` command (stable API). */
    async reveal(): Promise<void> {
        await vscode.commands.executeCommand(`${EXPLANATION_PANEL_VIEW_ID}.focus`);
    }

    /** Cursor-sync entry point. Only does work while the panel is actually visible. */
    onSelectionChanged(editor: vscode.TextEditor): void {
        if (!this.view?.visible) {
            return;
        }
        if (editor !== vscode.window.activeTextEditor) {
            return;
        }
        void this.refreshFor(editor);
    }

    private refreshFromActiveEditor(): void {
        void this.refreshFor(vscode.window.activeTextEditor);
    }

    private async refreshFor(editor: vscode.TextEditor | undefined): Promise<void> {
        const workspaceRoot = this.getWorkspaceRoot();
        const cache = this.getCache();
        if (!this.view || !workspaceRoot || !cache || !editor || editor.document.languageId !== 'javascript') {
            this.postEmpty();
            return;
        }

        const resolved = await resolveEnclosingFunction(editor.document, editor.selection.active, workspaceRoot);
        if (!resolved) {
            this.postEmpty();
            return;
        }

        // Panel is cache-only (Core Rule 4) -- never requests generation.
        const row = cache.lookup({
            fnId: resolved.fnId,
            fnHash: resolved.fnHash,
            modelId: MODEL_ID,
            embeddingModelId: EMBEDDING_MODEL_ID,
            promptVersion: PROMPT_VERSION,
        });

        if (!row) {
            this.postEmpty(resolved.name);
            return;
        }
        this.postRow(row);
    }

    private postRow(row: CacheRow): void {
        if (!this.view) {
            return;
        }
        const explanation = JSON.parse(row.explanation_json) as ExplanationFields;
        void this.view.webview.postMessage({
            type: 'render',
            fnName: fnNameFromFnId(row.fn_id),
            explanation,
        });
    }

    private postEmpty(fnName?: string): void {
        if (!this.view) {
            return;
        }
        void this.view.webview.postMessage({ type: 'empty', fnName });
    }

    private renderHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        const csp = [
            "default-src 'none'",
            "style-src 'unsafe-inline'",
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        padding: 0 12px 12px 12px;
    }
    h3 {
        font-weight: 600;
        margin-bottom: 4px;
        border-bottom: 1px solid var(--vscode-widget-border, transparent);
        padding-bottom: 6px;
    }
    h4 {
        margin: 16px 0 4px 0;
        font-size: 0.85em;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--vscode-descriptionForeground);
    }
    p { margin: 0; }
    ul { margin: 4px 0; padding-left: 18px; }
    .name-link {
        background: none;
        border: none;
        padding: 0;
        margin: 0 6px 4px 0;
        color: var(--vscode-textLink-foreground);
        cursor: pointer;
        font: inherit;
        text-decoration: none;
    }
    .name-link:hover { text-decoration: underline; }
    .name-list { display: block; }
    .empty-state {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        margin-top: 12px;
    }
    .risk-note {
        color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
    }
</style>
</head>
<body>
<div id="content"></div>
<script nonce="${nonce}">
(function () {
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');

    function clear() {
        while (content.firstChild) {
            content.removeChild(content.firstChild);
        }
    }

    function addSection(titleText) {
        const h = document.createElement('h4');
        h.textContent = titleText;
        content.appendChild(h);
    }

    function addParagraph(text, className) {
        const p = document.createElement('p');
        p.textContent = text;
        if (className) { p.className = className; }
        content.appendChild(p);
    }

    function addNameLinks(names) {
        const wrap = document.createElement('div');
        wrap.className = 'name-list';
        for (const name of names) {
            const btn = document.createElement('button');
            btn.className = 'name-link';
            btn.textContent = name;
            btn.addEventListener('click', () => {
                vscode.postMessage({ type: 'navigate', name: name });
            });
            wrap.appendChild(btn);
        }
        content.appendChild(wrap);
    }

    function addList(items) {
        const ul = document.createElement('ul');
        for (const item of items) {
            const li = document.createElement('li');
            li.textContent = item;
            ul.appendChild(li);
        }
        content.appendChild(ul);
    }

    function renderEmpty(fnName) {
        clear();
        const p = document.createElement('p');
        p.className = 'empty-state';
        p.textContent = fnName
            ? 'No cached explanation for "' + fnName + '" yet -- hover it to generate one.'
            : 'Place the cursor inside an indexed JavaScript function to see details here.';
        content.appendChild(p);
    }

    function renderExplanation(fnName, explanation) {
        clear();
        const h = document.createElement('h3');
        h.textContent = fnName;
        content.appendChild(h);

        // Empty/null fields render as nothing -- omit the whole section,
        // never a placeholder like "N/A" (silence means confirmed-none).
        if (explanation.why_it_exists) {
            addSection('Why it exists');
            addParagraph(explanation.why_it_exists);
        }
        if (Array.isArray(explanation.used_by) && explanation.used_by.length > 0) {
            addSection('Used by');
            addNameLinks(explanation.used_by);
        }
        if (Array.isArray(explanation.calls) && explanation.calls.length > 0) {
            addSection('Calls');
            addNameLinks(explanation.calls);
        }
        if (Array.isArray(explanation.side_effects) && explanation.side_effects.length > 0) {
            addSection('Side effects');
            addList(explanation.side_effects);
        }
        if (explanation.risk_note) {
            addSection('Risk');
            addParagraph(explanation.risk_note, 'risk-note');
        }
    }

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'render') {
            renderExplanation(message.fnName, message.explanation);
        } else if (message.type === 'empty') {
            renderEmpty(message.fnName);
        }
    });

    renderEmpty();
}());
</script>
</body>
</html>`;
    }
}

function isNavigableKind(kind: vscode.SymbolKind): boolean {
    return NAVIGABLE_SYMBOL_KINDS.has(kind);
}

interface ResolveFunctionResult {
    found: boolean;
    rel_fname?: string;
    line?: number;
}

/**
 * Resolves a bare function/variable name to a location and navigates there.
 *
 * Tries the sidecar's `resolve_function` first (Session 8 follow-up): the
 * sidecar's repomap already parsed the whole repo at startup/reindex, so it
 * knows the location of any real def regardless of whether VS Code's own
 * JS/TS language service has opened that file yet. Falls back to the
 * built-in workspace symbol search (the original v0 approach -- "no
 * separate lookup index needed yet") for anything the sidecar doesn't
 * track (e.g. a dotted external call like `db.getOrder`), or if the
 * sidecar isn't connected. This fixes a real dead-link case found via a
 * user report: a genuinely correct, real caller name failed to navigate
 * because its file had never been opened, so VS Code's own symbol search
 * didn't know about it yet -- the sidecar did.
 */
export function registerNavigateToFunctionCommand(
    getWorkspaceRoot: () => string | undefined,
    getSidecar: () => SidecarManager | undefined,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(NAVIGATE_COMMAND_ID, async (name: string) => {
        const workspaceRoot = getWorkspaceRoot();
        const sidecar = getSidecar();

        if (workspaceRoot && sidecar) {
            try {
                const resolved = await sidecar.request<ResolveFunctionResult>('resolve_function', { name });
                if (resolved.found && resolved.rel_fname !== undefined && resolved.line !== undefined) {
                    const uri = vscode.Uri.file(path.join(workspaceRoot, resolved.rel_fname));
                    const document = await vscode.workspace.openTextDocument(uri);
                    const editor = await vscode.window.showTextDocument(document, { preview: false });
                    const position = new vscode.Position(resolved.line, 0);
                    editor.selection = new vscode.Selection(position, position);
                    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                    return;
                }
            } catch (err) {
                output.appendLine(
                    `navigate: resolve_function failed for "${name}" (${String(err)}) -- ` +
                        'falling back to workspace symbol search'
                );
            }
        }

        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            name
        );
        // The built-in JS/TS workspace symbol provider names function-like
        // symbols with a trailing "(...)" (e.g. "handleSignupRoute()"), so a
        // bare-name exact match against `s.name` never matches -- strip it
        // before comparing.
        const match = symbols?.find((s) => s.name.split('(')[0] === name && isNavigableKind(s.kind));
        if (!match) {
            output.appendLine(`navigate: no symbol found for "${name}"`);
            vscode.window.setStatusBarMessage(`LucidHover: couldn't find "${name}"`, 3000);
            return;
        }

        const document = await vscode.workspace.openTextDocument(match.location.uri);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        editor.selection = new vscode.Selection(match.location.range.start, match.location.range.start);
        editor.revealRange(match.location.range, vscode.TextEditorRevealType.InCenter);
    });
}

/** Command handler for the hover's "Show more →" link: reveals the panel, then pushes the hovered row explicitly (independent of cursor position). */
export function registerShowMoreCommand(
    panel: ExplanationPanelProvider,
    getCache: () => ExplanationCache | undefined
): vscode.Disposable {
    return vscode.commands.registerCommand(SHOW_MORE_COMMAND_ID, async (cacheKey: string) => {
        await panel.reveal();
        const row = getCache()?.getByCacheKey(cacheKey);
        if (row) {
            panel.showRow(row);
        }
    });
}
