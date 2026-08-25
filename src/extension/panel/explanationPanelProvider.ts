import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExplanationCache, CacheRow } from '../cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../cache/config';
import { resolveEnclosingFunction, ResolvedFunction } from '../functionResolution';
import { isSupportedLanguageId } from '../languages';
import { SidecarManager } from '../sidecar/sidecarManager';

export const EXPLANATION_PANEL_VIEW_ID = 'lucidhover.explanationPanel';
export const SHOW_MORE_COMMAND_ID = 'lucidhover.showMore';
// Owned here, not blastRadiusCommand.ts, so that file can import it (and the
// graph-view types below) without a circular import back to this one.
export const SHOW_BLAST_RADIUS_COMMAND_ID = 'lucidhover.showBlastRadius';
// Session 46: same reasoning as SHOW_BLAST_RADIUS_COMMAND_ID above -- owned
// here so callTraceCommand.ts can import it without a circular import.
export const SHOW_CALL_TRACE_COMMAND_ID = 'lucidhover.traceExecutionPath';
const NAVIGATE_COMMAND_ID = 'lucidhover.navigateToFunction';

interface ExplanationFields {
    why_it_exists?: string;
    used_by?: string[];
    calls?: string[];
    side_effects?: string[];
    risk_note?: string | null;
}

/**
 * Session 45: one node in a pinned graph-view render (blast radius; session
 * 46's execution trace reuses the same shape). `roleTag`/`oneLiner` are
 * populated by the caller (blastRadiusCommand.ts / callTraceCommand.ts) from
 * its own `ExplanationCache` lookup, per Core Rule 9 -- the sidecar only
 * ever returns bare rel_fname/name/line/importance/depth graph facts, never
 * cache data. Left undefined for a node with no cache row yet; the renderer
 * shows those bare rather than treating undefined as an error state.
 */
export interface GraphViewNode {
    relFname: string;
    name: string;
    line: number;
    depth: number;
    importance: number;
    roleTag?: string;
    oneLiner?: string;
}

/** One caller->callee graph fact, independent of either endpoint's node-list entry (an endpoint outside the walk's depth cap still produces a real edge). */
export interface GraphViewEdge {
    callerRelFname: string;
    callerName: string;
    callerLine: number;
    calleeRelFname: string;
    calleeName: string;
    calleeLine: number;
}

/**
 * Session 47: how many *additional* new nodes existed at a given depth
 * beyond the walk's per-level fan-out cap (`BLAST_RADIUS_LEVEL_CAP` in
 * `sidecar/repomap/context.py`) -- one entry per depth that actually
 * omitted something, not a dense depth-indexed array. Currently only
 * populated for blast radius (`direction: 'upstream'`); execution trace's
 * single-primary-path walk has nothing to omit (one node per depth), so it
 * always sends an empty array.
 */
export interface GraphViewOmission {
    depth: number;
    omittedCount: number;
}

/**
 * Session 48: the non-primary confident callees passed over at a given hop
 * of an execution trace's primary path -- what session 46's v1 scope cut
 * silently dropped. `depth` matches the primary-path `GraphViewNode.depth`
 * whose hop produced this branch point, so the renderer can attach a
 * "+N other calls from here" expansion right after that node. `alternates`
 * are enriched the same way primary nodes are (`callTraceCommand.ts`'s
 * `enrichOne`) and rendered with the same cached/uncached treatment --
 * they're just never walked further (this session's v1 scope: one hop of
 * alternates, not a second recursive tree). `omittedCount` mirrors
 * `GraphViewOmission`'s cap-overflow count (same reused
 * `RepoMap._cap`/`CALLER_CALLEE_CAP` on the sidecar side, session 47's
 * pattern). Currently only populated for execution trace
 * (`direction: 'downstream'`); blast radius always sends an empty array.
 */
export interface GraphViewBranchPoint {
    depth: number;
    alternates: GraphViewNode[];
    omittedCount: number;
}

/**
 * Generic graph-view payload (Session 45): nodes + edges + direction, not
 * pre-grouped by depth -- so session 46's linear-chain execution-trace view
 * (`callTraceCommand.ts`) reuses this same shape and the same pinned-panel
 * plumbing rather than building a second renderer from scratch. `direction`
 * records which way the walk went ('upstream' = blast radius, "who calls
 * this, transitively"; 'downstream' = execution trace, "what does this
 * call, transitively") -- the webview's own message handler uses it to pick
 * between the depth-grouped renderer (`renderGraph`) and the linear-timeline
 * one (`renderTrace`).
 */
export interface GraphViewPayload {
    title: string;
    direction: 'upstream' | 'downstream';
    rootName: string;
    nodes: GraphViewNode[];
    edges: GraphViewEdge[];
    omissions: GraphViewOmission[];
    branches: GraphViewBranchPoint[];
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
    private pendingGraph: GraphViewPayload | undefined;
    /**
     * Session 52: the function whose explanation is currently rendered via
     * `postRow` (cursor-synced only -- `showRow`'s explicit push from
     * hover's "Show more" link has no `ResolvedFunction` to offer, only a
     * bare `CacheRow`, so it clears this instead of guessing). Read by the
     * webview's `showBlastRadius`/`traceExecutionPath` message handlers so
     * those commands target whatever the panel is actually showing, not
     * wherever the text cursor has since moved to -- fixes a real bug where
     * clicking "See full blast radius" after moving the cursor away (or off
     * any function) silently computed the graph for the wrong function, or
     * for nothing at all.
     */
    private currentFunction: ResolvedFunction | undefined;
    /**
     * Session 45: true while a graph view (blast radius, and later session
     * 46's execution trace) is pinned -- cursor movement must not overwrite
     * it, unlike the normal cursor-synced explanation view. Cleared only by
     * the webview's own "<- Back" control (a `back` message), never by a
     * timeout or an editor event, so the user's graph stays put until they
     * explicitly leave it.
     */
    private pinned = false;

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
            } else if (message?.type === 'showBlastRadius') {
                void vscode.commands.executeCommand(SHOW_BLAST_RADIUS_COMMAND_ID, this.currentFunction);
            } else if (message?.type === 'traceExecutionPath') {
                void vscode.commands.executeCommand(SHOW_CALL_TRACE_COMMAND_ID, this.currentFunction);
            } else if (message?.type === 'back') {
                this.pinned = false;
                this.refreshFromActiveEditor();
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && !this.pinned) {
                this.refreshFromActiveEditor();
            }
        });

        webviewView.onDidDispose(() => {
            this.view = undefined;
        });

        if (this.pendingGraph) {
            this.pinned = true;
            this.postGraph(this.pendingGraph);
            this.pendingGraph = undefined;
        } else if (this.pendingRow) {
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
        this.pinned = false;
        // No ResolvedFunction to offer here (see `currentFunction`'s doc
        // comment) -- the blast-radius/trace buttons fall back to live-
        // cursor resolution for a row pushed this way, same as an explicit
        // Command Palette invocation.
        this.currentFunction = undefined;
        if (this.view) {
            this.postRow(row);
        } else {
            // Not resolved yet -- the reveal command's `.focus` call will
            // trigger resolveWebviewView, which picks this up.
            this.pendingRow = row;
        }
    }

    /**
     * Pins a graph view (Session 45) in place, independent of cursor
     * position -- used by blastRadiusCommand.ts. Cursor movement won't
     * overwrite it until the user clicks the view's own "<- Back" control.
     */
    showGraph(payload: GraphViewPayload): void {
        this.pinned = true;
        if (this.view) {
            this.postGraph(payload);
        } else {
            this.pendingGraph = payload;
        }
    }

    /** Reveals/focuses the panel via the view's auto-generated `.focus` command (stable API). */
    async reveal(): Promise<void> {
        await vscode.commands.executeCommand(`${EXPLANATION_PANEL_VIEW_ID}.focus`);
    }

    /** Cursor-sync entry point. Only does work while the panel is actually visible and not pinned to a graph view. */
    onSelectionChanged(editor: vscode.TextEditor): void {
        if (!this.view?.visible || this.pinned) {
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
        if (!this.view || !workspaceRoot || !cache || !editor || !isSupportedLanguageId(editor.document.languageId)) {
            this.currentFunction = undefined;
            this.postEmpty();
            return;
        }

        const resolved = await resolveEnclosingFunction(editor.document, editor.selection.active, workspaceRoot);
        if (!resolved) {
            this.currentFunction = undefined;
            this.postEmpty();
            return;
        }

        // Panel is cache-only (Core Rule 4) -- never requests generation.
        const row = cache.lookup({
            fnId: resolved.fnId,
            fnHash: resolved.fnHash,
            modelId: resolveModelId(),
            embeddingModelId: EMBEDDING_MODEL_ID,
            promptVersion: PROMPT_VERSION,
        });

        if (!row) {
            this.currentFunction = undefined;
            this.postEmpty(resolved.name);
            return;
        }
        this.currentFunction = resolved;
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

    private postGraph(payload: GraphViewPayload): void {
        if (!this.view) {
            return;
        }
        void this.view.webview.postMessage({ type: 'renderGraph', payload });
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
    .back-link {
        margin: 0 0 12px 0;
    }
    .graph-node {
        margin: 0 0 10px 0;
    }
    .graph-node-location {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        margin-left: 4px;
    }
    .graph-node-desc {
        margin: 2px 0 0 0;
    }
    .branch-toggle {
        margin: 0 0 10px 18px;
    }
    .branch-toggle summary {
        cursor: pointer;
        color: var(--vscode-textLink-foreground);
    }
    .branch-toggle summary:hover {
        text-decoration: underline;
    }
    .branch-toggle .graph-node {
        margin: 8px 0 0 0;
    }
    .disclaimer {
        color: var(--vscode-descriptionForeground);
        font-size: 0.85em;
        font-style: italic;
        margin-top: 16px;
        padding-top: 8px;
        border-top: 1px solid var(--vscode-widget-border, transparent);
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
        const blastBtn = document.createElement('button');
        blastBtn.className = 'name-link';
        blastBtn.textContent = 'See full blast radius →';
        blastBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'showBlastRadius' });
        });
        content.appendChild(blastBtn);
        const traceBtn = document.createElement('button');
        traceBtn.className = 'name-link';
        traceBtn.textContent = 'Trace execution from here →';
        traceBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'traceExecutionPath' });
        });
        content.appendChild(traceBtn);
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
        // Session 52: persistent disclaimer -- every field above came from a
        // local LLM call (Core Rule 1), not a static analyzer, so it can be
        // wrong. Scoped to this single-explanation view only, not the graph
        // views (renderGraph/renderTrace): those already show many nodes'
        // explanations at once as compact one-line summaries, not a single
        // reading pane, so a repeated per-node disclaimer would be noise
        // rather than a one-time notice.
        addParagraph('Generated by a local LLM — may be inaccurate, verify before relying on it.', 'disclaimer');
    }

    function addBackLink() {
        const btn = document.createElement('button');
        btn.className = 'name-link back-link';
        btn.textContent = '← Back';
        btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'back' });
        });
        content.appendChild(btn);
    }

    // Session 45: generic depth-grouped list renderer -- takes nodes + edges
    // + direction (payload.edges isn't used by this particular render mode
    // yet, but the data is here so a future mode, e.g. session 46's linear
    // execution-trace view, doesn't need a second RPC/enrichment round trip
    // to get it).
    function renderGraphNode(node, container) {
        container = container || content;
        const wrap = document.createElement('div');
        wrap.className = 'graph-node';

        const btn = document.createElement('button');
        btn.className = 'name-link';
        btn.textContent = node.name;
        btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'navigate', name: node.name });
        });
        wrap.appendChild(btn);

        const loc = document.createElement('span');
        loc.className = 'graph-node-location';
        loc.textContent = node.relFname + ':' + (node.line + 1);
        wrap.appendChild(loc);

        const desc = document.createElement('p');
        if (node.roleTag || node.oneLiner) {
            desc.className = 'graph-node-desc';
            desc.textContent = [node.roleTag, node.oneLiner].filter(Boolean).join(' — ');
        } else {
            desc.className = 'graph-node-desc empty-state';
            desc.textContent = 'Not yet indexed.';
        }
        wrap.appendChild(desc);

        container.appendChild(wrap);
    }

    // Session 48: the inline "+N other calls from here" expansion for a
    // trace hop's non-primary confident callees -- a plain <details> so
    // expand/collapse needs no script-side event wiring beyond what the
    // browser gives <details>/<summary> natively. Each alternate renders
    // through the same renderGraphNode used for primary nodes, so an
    // uncached alternate gets the identical "Not yet indexed." placeholder.
    function renderBranchPoint(branchPoint) {
        const totalOther = branchPoint.alternates.length + branchPoint.omittedCount;
        if (totalOther === 0) {
            return;
        }
        const details = document.createElement('details');
        details.className = 'branch-toggle';

        const summary = document.createElement('summary');
        summary.textContent = '+' + totalOther + ' other call' + (totalOther === 1 ? '' : 's') + ' from here';
        details.appendChild(summary);

        for (const alt of branchPoint.alternates) {
            renderGraphNode(alt, details);
        }
        if (branchPoint.omittedCount > 0) {
            const omittedP = document.createElement('p');
            omittedP.className = 'empty-state';
            omittedP.textContent = '+' + branchPoint.omittedCount + ' more not shown';
            details.appendChild(omittedP);
        }

        content.appendChild(details);
    }

    function renderGraph(payload) {
        clear();
        addBackLink();

        const h = document.createElement('h3');
        h.textContent = payload.title;
        content.appendChild(h);

        if (payload.nodes.length === 0) {
            const noun = payload.direction === 'upstream' ? 'callers' : 'callees';
            addParagraph('No ' + noun + ' found within the search depth.', 'empty-state');
            return;
        }

        const maxDepth = payload.nodes.reduce((max, n) => Math.max(max, n.depth), 0);
        for (let depth = 1; depth <= maxDepth; depth++) {
            const atDepth = payload.nodes.filter((n) => n.depth === depth);
            if (atDepth.length === 0) {
                continue;
            }
            addSection('Level ' + depth);
            for (const node of atDepth) {
                renderGraphNode(node);
            }
            // Session 47: the per-level fan-out cap omits nodes rather than
            // silently truncating -- surface that as a plain note under the
            // level it applies to, not a new UI affordance.
            const omission = payload.omissions.find((o) => o.depth === depth);
            if (omission) {
                addParagraph('+' + omission.omittedCount + ' more not shown', 'empty-state');
            }
        }
    }

    // Session 46: a linear-chain timeline renderer, reusing renderGraphNode
    // (including its "Not yet indexed." placeholder for an uncached hop) but
    // laid out as an ordered sequence rather than session 45's depth-grouped
    // "Level N" sections -- a single-primary-path downstream trace has
    // exactly one node per depth, so grouping by depth would just be a list
    // of one-item groups.
    function renderTrace(payload) {
        clear();
        addBackLink();

        const h = document.createElement('h3');
        h.textContent = payload.title;
        content.appendChild(h);

        const start = document.createElement('p');
        start.textContent = payload.rootName + ' (start)';
        content.appendChild(start);

        if (payload.nodes.length === 0) {
            addParagraph('No confident downstream calls found from here.', 'empty-state');
            return;
        }

        const ordered = payload.nodes.slice().sort((a, b) => a.depth - b.depth);
        for (const node of ordered) {
            const arrow = document.createElement('p');
            arrow.className = 'graph-node-location';
            arrow.textContent = '↓ calls';
            content.appendChild(arrow);
            renderGraphNode(node);
            // Session 48: a branch point's depth matches the primary node
            // whose hop produced it (see GraphViewBranchPoint's own doc
            // comment) -- render it right after that node.
            const branchPoint = payload.branches.find((b) => b.depth === node.depth);
            if (branchPoint) {
                renderBranchPoint(branchPoint);
            }
        }
    }

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'render') {
            renderExplanation(message.fnName, message.explanation);
        } else if (message.type === 'empty') {
            renderEmpty(message.fnName);
        } else if (message.type === 'renderGraph') {
            if (message.payload.direction === 'downstream') {
                renderTrace(message.payload);
            } else {
                renderGraph(message.payload);
            }
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
