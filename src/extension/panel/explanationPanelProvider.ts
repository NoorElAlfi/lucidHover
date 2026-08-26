import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExplanationCache, CacheRow } from '../cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../cache/config';
import { DirtyTracker } from '../dirtyTracking';
import { resolveEnclosingFunction, ResolvedFunction } from '../functionResolution';
import { isSupportedLanguageId } from '../languages';
import { SidecarManager } from '../sidecar/sidecarManager';
import { StaleTracker } from '../staleTracking';

export const EXPLANATION_PANEL_VIEW_ID = 'lucidhover.explanationPanel';
export const SHOW_MORE_COMMAND_ID = 'lucidhover.showMore';
// Owned here, not blastRadiusCommand.ts, so that file can import it (and the
// graph-view types below) without a circular import back to this one.
export const SHOW_BLAST_RADIUS_COMMAND_ID = 'lucidhover.showBlastRadius';
// Session 46: same reasoning as SHOW_BLAST_RADIUS_COMMAND_ID above -- owned
// here so callTraceCommand.ts can import it without a circular import.
export const SHOW_CALL_TRACE_COMMAND_ID = 'lucidhover.traceExecutionPath';
// Session 55: same reasoning again -- owned here (moved from
// refreshExplanationCommand.ts, which already imports this file for
// `ExplanationPanelProvider`) so the panel's new "Regenerate" button can
// forward its tracked `currentFunction` without a circular import.
export const REFRESH_COMMAND_ID = 'lucidhover.refreshExplanation';
// Session 58: exported (previously module-private) so
// explanationPanelProvider.test.ts's "Back to caller" coverage can assert
// on it directly, same as the other command ids above.
export const NAVIGATE_COMMAND_ID = 'lucidhover.navigateToFunction';

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

/** The `relFile` half of a fn_id (see fnNameFromFnId's doc comment for the `${relFile}::${qualifiedName}` shape). */
function relFileFromFnId(fnId: string): string {
    const separatorIndex = fnId.indexOf('::');
    return separatorIndex === -1 ? fnId : fnId.slice(0, separatorIndex);
}

/**
 * Session 58 header redesign: the header meta row's kind label. Neither
 * `ResolvedFunction` nor `CacheRow` carries the real `vscode.SymbolKind` the
 * resolving document symbol had -- adding that would mean threading a new
 * field through every cache row, including rows written before this
 * session, and would still be unavailable for `showRow`'s push from hover's
 * "Show more" link (no live `ResolvedFunction` there at all, see
 * `currentFunction`'s own doc comment).
 *
 * An earlier version of this tried to infer "Method" vs "Function" from
 * whether the fn_id's qualified name is dotted (nested in an enclosing
 * scope). code-reviewer caught that this is wrong for a case this codebase
 * actually resolves: `flattenWithQualifiedNames` (functionResolution.ts)
 * builds the qualified name from every enclosing *symbol*, not just class
 * ancestors -- a named function nested inside another function (a closure)
 * gets a dotted qualified name too, and VS Code's built-in JS/TS
 * `DocumentSymbolProvider` genuinely nests such symbols (visible in the
 * Outline view), so that case would have been mislabeled "Method". Always
 * "Function" until real `SymbolKind` plumbing is worth doing.
 */
const KIND_LABEL = 'Function';

/**
 * Session 58: how long a "Back to caller" target stays valid for the
 * bare-name match in `postRow` -- see `backTarget`'s own doc comment for
 * why this exists (bounds a same-name-collision false-positive window,
 * doesn't eliminate it). Generous relative to how long navigation actually
 * takes (sidecar resolve or symbol search + document open, well under a
 * second in practice), so it never expires before a genuine "Back to
 * caller" click's own render arrives.
 */
const BACK_TARGET_TTL_MS = 15_000;

/**
 * Mirrors `functionHoverProvider.ts`'s own `freshnessOf`/`FreshnessState`
 * exactly (dirty takes precedence over stale) -- not imported from there to
 * avoid a circular import (that module already imports
 * `SHOW_MORE_COMMAND_ID` from this one). Session 58: previously unused here:
 * the panel is cache-only (Core Rule 4) but had never actually read
 * `DirtyTracker`/`StaleTracker`, so its footer had no way to reflect a stale
 * cache entry -- see the doc's P7.
 */
type FreshnessState = 'fresh' | 'dirty' | 'stale';
function freshnessOf(dirty: boolean, stale: boolean): FreshnessState {
    if (dirty) {
        return 'dirty';
    }
    if (stale) {
        return 'stale';
    }
    return 'fresh';
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
    /**
     * Session 58 ("Back to caller"): set right before forwarding a clicked
     * used-by/calls row's navigation, from whatever function was on screen
     * at the time (`currentFunction`, same cursor-sync-only availability as
     * that field -- no backTarget gets set from a hover-pushed row, since
     * there's no live location to remember). `targetName` is the bare name
     * that was clicked, i.e. the function we expect to land on; `postRow`
     * only surfaces this as a "Back to X" affordance when the row it's
     * about to render actually matches `targetName` (see postRow). Deliberately
     * a single slot, not a history stack: one hop back, not a full
     * breadcrumb trail.
     *
     * code-reviewer finding: matching on bare name alone (via
     * `fnNameFromFnId`, which strips file and enclosing-scope qualification)
     * means a *different* function that happens to share that bare name --
     * elsewhere in the same file, a different class, or even a real
     * `assignFnIds` `#n` duplicate -- would incorrectly surface "Back to X"
     * if the user navigated to it independently while a stale backTarget
     * was still sitting here unconsumed. The link would still navigate
     * somewhere real and coherent if clicked (the exact relFile+line is
     * what's stored), so this is a mislabeling risk, not a broken action or
     * data issue -- but resolving it precisely would mean plumbing the
     * navigation command's actual resolved destination back into the panel
     * (`navigateToFunction` currently only forwards a bare name string, by
     * design -- it's a separately-registered, fire-and-forget VS Code
     * command). `BACK_TARGET_TTL_MS` bounds the exposure window instead:
     * navigation (sidecar resolve or symbol search + document open) is
     * effectively instant in practice, so requiring the match to also be
     * recent makes an unrelated same-named function coincidentally being
     * visited in that split-second window the only way to hit the false
     * positive, rather than "any time before the next real navigate click."
     */
    private backTarget: { relFile: string; line: number; callerName: string; targetName: string; setAt: number } | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly getWorkspaceRoot: () => string | undefined,
        private readonly getCache: () => ExplanationCache | undefined,
        private readonly getDirtyTracker: () => DirtyTracker | undefined,
        private readonly getStaleTracker: () => StaleTracker | undefined,
        private readonly output: vscode.OutputChannel
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            // Session 58: codicon.css/codicon.ttf load from the extension's
            // own node_modules via asWebviewUri (renderHtml below) -- must be
            // explicitly allowlisted, unlike the fully-inline HTML/CSS/JS
            // this webview used before.
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')],
        };
        webviewView.webview.html = this.renderHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((message: { type?: string; name?: string }) => {
            if (message?.type === 'navigate' && message.name) {
                // Session 58 ("Back to caller"): remember where we're
                // navigating FROM, keyed to the name we're navigating TO,
                // before forwarding the navigation itself -- see
                // backTarget's own doc comment for why this is a single
                // slot, not a stack, and how it self-invalidates.
                if (this.currentFunction) {
                    this.backTarget = {
                        relFile: this.currentFunction.relFile,
                        line: this.currentFunction.range.start.line,
                        callerName: this.currentFunction.name,
                        targetName: message.name,
                        setAt: Date.now(),
                    };
                }
                void vscode.commands.executeCommand(NAVIGATE_COMMAND_ID, message.name);
            } else if (message?.type === 'showBlastRadius') {
                void vscode.commands.executeCommand(SHOW_BLAST_RADIUS_COMMAND_ID, this.currentFunction);
            } else if (message?.type === 'traceExecutionPath') {
                void vscode.commands.executeCommand(SHOW_CALL_TRACE_COMMAND_ID, this.currentFunction);
            } else if (message?.type === 'regenerate') {
                void vscode.commands.executeCommand(REFRESH_COMMAND_ID, this.currentFunction);
            } else if (message?.type === 'copy' && typeof (message as { text?: unknown }).text === 'string') {
                void vscode.env.clipboard.writeText((message as { text: string }).text);
            } else if (message?.type === 'backToCaller') {
                const target = this.backTarget;
                this.backTarget = undefined;
                if (target) {
                    void this.navigateToLocation(target.relFile, target.line);
                }
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

    /**
     * Session 58, code-reviewer finding: `refreshExplanation`'s catch block
     * calls this after a failed regenerate so the card's Regenerate/Copy
     * buttons don't stay stuck disabled with a spinning icon forever -- the
     * only other thing that clears that busy state is a fresh 'render'/
     * 'empty' message, which a failure never sends. A no-op if there's no
     * view to post to; harmless if the panel has since moved on to a
     * different function or a graph view, since the webview only touches
     * the specific button references it tracked when it last rendered a
     * card (see the webview script's activeRegenerateBtn/activeCopyBtn).
     */
    notifyRegenerateFailed(): void {
        if (!this.view) {
            return;
        }
        void this.view.webview.postMessage({ type: 'regenerateFailed' });
    }

    /**
     * Session 58: forces a cursor-sync refresh from whatever the active
     * editor is right now, the same fix `navigateToLocation` applies to its
     * own selection-setting -- `onDidChangeTextEditorSelection` doesn't fire
     * when the selection a caller sets happens to already match what the
     * editor had, so anything that navigates by setting `editor.selection`
     * directly (rather than going through this class) can't rely on that
     * event alone to refresh the panel. Exposed for
     * `registerNavigateToFunctionCommand` below, which sets selection itself
     * and has no other way to guarantee the panel picks up the change --
     * confirmed via a real user report that clicking a used-by/calls row
     * for a function whose location the cursor was already sitting at (or
     * had recently visited) left the panel showing the previous
     * explanation. A no-op if there's nothing to refresh from (not pinned
     * to a graph, a real active editor exists); harmless if a real
     * selection-changed event also fires for the same navigation.
     */
    refreshNow(): void {
        if (this.pinned) {
            return;
        }
        this.refreshFromActiveEditor();
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
        const relFile = relFileFromFnId(row.fn_id);
        // Works for both refreshFor's cursor-synced path and showRow's push
        // from hover's "Show more" link, since both give us a fn_id and this
        // doesn't need a live ResolvedFunction -- see currentFunction's own
        // doc comment on why showRow can't provide one.
        const dirty = this.getDirtyTracker()?.dirtyFnIdsFor(relFile)?.has(row.fn_id) ?? false;
        const stale = this.getStaleTracker()?.isStale(relFile, row.fn_id) ?? false;
        // "Back to caller" only surfaces when this row is actually the
        // function the last navigate click targeted, AND recent (see
        // BACK_TARGET_TTL_MS's own doc comment -- name alone can't fully
        // rule out an unrelated same-named function, so recency bounds that
        // window instead of eliminating it).
        const fnName = fnNameFromFnId(row.fn_id);
        const backTo =
            this.backTarget?.targetName === fnName && Date.now() - this.backTarget.setAt < BACK_TARGET_TTL_MS
                ? this.backTarget.callerName
                : undefined;
        void this.view.webview.postMessage({
            type: 'render',
            fnName,
            kind: KIND_LABEL,
            relFile,
            explanation,
            generatedAt: row.generated_at,
            freshness: freshnessOf(dirty, stale),
            backTo,
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

    /**
     * Session 58 ("Back to caller"): navigates directly to a remembered
     * exact location (relFile + line) rather than going through
     * `NAVIGATE_COMMAND_ID`'s bare-name resolution -- we already know
     * precisely where the caller was (captured from a live
     * `ResolvedFunction` at click time), so there's no ambiguity to
     * resolve. Mirrors `registerNavigateToFunctionCommand`'s own
     * open-reveal-select sequence below, plus an explicit `refreshNow()`
     * call at the end -- a real user report found the panel sometimes
     * stayed on the old function after a same-file "Back to caller" jump,
     * because `onDidChangeTextEditorSelection` doesn't fire when the editor
     * already happens to be showing that exact selection (e.g. reusing an
     * already-open, already-positioned tab), so `onSelectionChanged`'s
     * event-driven refresh never ran. This makes the panel update
     * unconditional instead of depending on that event firing; see
     * `refreshNow`'s own doc comment.
     */
    private async navigateToLocation(relFile: string, line: number): Promise<void> {
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            return;
        }
        const uri = vscode.Uri.file(path.join(workspaceRoot, relFile));
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const position = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        this.refreshNow();
    }

    private renderHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        const codiconUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
        );
        const csp = [
            "default-src 'none'",
            // 'unsafe-inline' for this file's own inline <style> block;
            // webview.cspSource additionally for the codicon.css stylesheet
            // link below, which loads from the extension itself, not inline.
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            // codicon.css's own @font-face rule points at codicon.ttf,
            // served from the same extension origin.
            `font-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${codiconUri}">
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
    .graph-node-location {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        margin-left: 4px;
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
    .branch-toggle .lh-graph-row {
        margin: 8px 0 0 0;
    }
    .timestamp {
        color: var(--vscode-descriptionForeground);
        font-size: 0.85em;
        margin-bottom: 8px;
    }
    .disclaimer {
        color: var(--vscode-descriptionForeground);
        font-size: 0.85em;
        font-style: italic;
        margin-top: 16px;
        padding-top: 8px;
        border-top: 1px solid var(--vscode-widget-border, transparent);
    }

    /* ── Session 58 card redesign ──────────────────────────────────────
       Ported from lucidhover-ui-improvements.md / lucidhover-card-redesign.html
       for the single-explanation view (renderExplanation), per the doc's
       own title. Session 59 extended the same .lh-card/.lh-section system
       to renderGraph (blast radius) -- see the .lh-graph-* rules below.
       renderTrace/renderBranchPoint (execution trace) remain untouched,
       a separate follow-up. Deliberately no .lh-card max-width cap here
       (the reference file's 460px is sized for a hover-tooltip-shaped
       card; this is the always-visible docked panel, which should use
       whatever width the user's sidebar actually gives it). */
    .lh-card {
        background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
        border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-editorWidget-border));
        border-radius: 6px;
        overflow: hidden;
    }
    .lh-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 8px;
        padding: 10px 12px 8px;
    }
    .lh-title-row {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
    }
    .lh-kind-icon {
        font-size: 16px;
        /* Always the function icon today (see KIND_LABEL's doc comment) --
           functionForeground first, methodForeground as fallback in case
           SymbolKind plumbing gets added back later. */
        color: var(--vscode-symbolIcon-functionForeground, var(--vscode-symbolIcon-methodForeground, inherit));
        flex-shrink: 0;
    }
    .lh-name {
        font-family: var(--vscode-editor-font-family);
        font-size: calc(var(--vscode-font-size) + 1px);
        font-weight: 600;
        background: var(--vscode-textCodeBlock-background);
        padding: 1px 6px;
        border-radius: 4px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .lh-meta {
        margin-top: 4px;
        margin-left: 23px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
    }
    .lh-meta .lh-file { color: var(--vscode-textLink-foreground); }
    .lh-actions { display: flex; gap: 4px; flex-shrink: 0; margin-left: auto; }
    .lh-btn {
        appearance: none;
        border: none;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-family: var(--vscode-font-family);
        font-size: calc(var(--vscode-font-size) - 1px);
        line-height: 18px;
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
    }
    .lh-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .lh-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .lh-btn .codicon { font-size: 13px; }
    .lh-btn.is-busy { opacity: 0.7; cursor: default; }
    .lh-btn.is-busy .codicon-sync { animation: lh-spin 1s linear infinite; }
    @keyframes lh-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
        .lh-btn.is-busy .codicon-sync { animation: none; }
        .lh-nav .codicon { transition: none; }
    }
    .lh-section { padding: 8px 12px 10px; }
    .lh-section + .lh-section {
        border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
    }
    .lh-section-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
        margin-bottom: 6px;
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .lh-count {
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        border-radius: 8px;
        padding: 0 6px;
        font-size: 10px;
        font-weight: 400;
        line-height: 16px;
        text-transform: none;
        letter-spacing: 0;
    }
    .lh-body { max-width: 60ch; }
    .lh-body code {
        font-family: var(--vscode-editor-font-family);
        font-size: 0.92em;
        background: var(--vscode-textCodeBlock-background);
        padding: 0 4px;
        border-radius: 3px;
    }
    .lh-refs { list-style: none; }
    .lh-refs button.lh-ref-row {
        appearance: none;
        border: none;
        width: 100%;
        text-align: left;
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 3px 6px;
        margin: 0 -6px;
        border-radius: 4px;
        color: var(--vscode-foreground);
        background: transparent;
        font: inherit;
        cursor: pointer;
    }
    .lh-refs button.lh-ref-row:hover { background: var(--vscode-list-hoverBackground); }
    .lh-refs button.lh-ref-row:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
    }
    .lh-refs .codicon { color: var(--vscode-symbolIcon-methodForeground, inherit); flex-shrink: 0; }
    /* ── Session 59: graph-view (blast radius) node rows ──────────────
       Visually matches .lh-refs/.lh-ref-row (used-by/calls rows above),
       but defined standalone rather than sharing those ancestor-scoped
       selectors: renderGraphNode() is also reused by execution trace's
       renderBranchPoint() (out of this session's scope), whose <details>
       container isn't a .lh-refs ancestor -- coupling the button's own
       look to that class would leave branch-alternate rows unstyled. */
    .lh-graph-list { display: flex; flex-direction: column; gap: 6px; }
    .lh-graph-row { min-width: 0; }
    .lh-graph-btn {
        appearance: none;
        border: none;
        width: 100%;
        text-align: left;
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 3px 6px;
        margin: 0 -6px;
        border-radius: 4px;
        color: var(--vscode-foreground);
        background: transparent;
        font: inherit;
        cursor: pointer;
    }
    .lh-graph-btn:hover { background: var(--vscode-list-hoverBackground); }
    .lh-graph-btn:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
    }
    .lh-graph-btn .codicon { color: var(--vscode-symbolIcon-methodForeground, inherit); flex-shrink: 0; }
    .lh-graph-name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .lh-graph-loc {
        margin-left: auto;
        padding-left: 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 0.85em;
        flex-shrink: 0;
    }
    /* Same selector wins over the base .empty-state rule's margin-top
       (single-class vs. single-class, later in the sheet), so the
       "Not yet indexed." variant needs no separate override. */
    .lh-graph-desc {
        margin: 2px 0 0 27px;
        color: var(--vscode-foreground);
    }
    /* Omission ("+N more not shown") notes nested inside a Level-N
       .lh-section -- tighter top margin than the base .empty-state rule
       (12px, sized for standalone top-level notes like "no callers
       found"), since here it always follows a .lh-graph-list directly. */
    .lh-section .empty-state {
        margin-top: 6px;
    }
    .lh-nav-list { margin-top: 6px; display: flex; flex-direction: column; gap: 1px; }
    .lh-nav {
        appearance: none;
        border: none;
        background: transparent;
        padding: 2px 0;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--vscode-textLink-foreground);
        text-decoration: none;
        font: inherit;
        cursor: pointer;
    }
    .lh-nav:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .lh-nav:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .lh-nav .codicon { font-size: 12px; transition: transform 80ms ease; }
    .lh-nav:hover .codicon { transform: translateX(2px); }
    /* "Back to caller" -- sits above .lh-card, not inside it, so it reads
       as a breadcrumb rather than another card action. */
    .lh-back {
        appearance: none;
        border: none;
        background: transparent;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-bottom: 6px;
        padding: 2px 0;
        color: var(--vscode-textLink-foreground);
        text-decoration: none;
        font: inherit;
        cursor: pointer;
    }
    .lh-back:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .lh-back:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .lh-back .codicon { font-size: 12px; }
    .lh-empty {
        display: flex;
        align-items: center;
        gap: 7px;
        color: var(--vscode-descriptionForeground);
        font-size: calc(var(--vscode-font-size) - 1px);
    }
    .lh-empty .codicon-check { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
    .lh-flags { list-style: none; display: flex; flex-direction: column; gap: 4px; }
    .lh-flags li { display: flex; gap: 7px; align-items: baseline; }
    .lh-flags .codicon {
        font-size: 12px;
        color: var(--vscode-problemsWarningIcon-foreground, var(--vscode-editorWarning-foreground));
        position: relative;
        top: 1px;
    }
    .lh-footer {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 6px 12px;
        border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }
    .lh-footer .codicon {
        color: var(--vscode-problemsWarningIcon-foreground, var(--vscode-editorWarning-foreground));
        flex-shrink: 0;
    }
    /* Stale/dirty state: explanation may not reflect the file's current
       content -- session 58 extends the doc's P7 (which only names "stale")
       to also cover "dirty" (an unsaved in-memory edit), since the panel now
       has access to the same DirtyTracker/StaleTracker hover already reads
       (see freshnessOf's doc comment). */
    .lh-footer.is-stale, .lh-footer.is-dirty { color: var(--vscode-editorWarning-foreground, inherit); }
</style>
</head>
<body>
<div id="content"></div>
<script nonce="${nonce}">
(function () {
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');
    // Session 58: tracks the currently-rendered card's Regenerate/Copy
    // buttons so a 'regenerateFailed' message (see the extension-host side's
    // notifyRegenerateFailed) can clear the busy state left behind by a
    // failed regeneration without discarding the still-valid old
    // explanation already on screen. Reset to undefined by every render
    // path that replaces the card (renderEmpty/renderGraph/renderTrace),
    // not just renderExplanation, so a stale reference from a since-replaced
    // card is never touched.
    let activeRegenerateBtn;
    let activeCopyBtn;

    function clear() {
        activeRegenerateBtn = undefined;
        activeCopyBtn = undefined;
        while (content.firstChild) {
            content.removeChild(content.firstChild);
        }
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

    // Session 55: plain relative-time text ("3 days ago") for the
    // single-explanation view's generated_at timestamp -- coarse buckets
    // are enough here, no need for a library.
    function relativeTime(isoString) {
        const then = new Date(isoString).getTime();
        if (Number.isNaN(then)) {
            return null;
        }
        const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
        const units = [
            ['year', 31536000],
            ['month', 2592000],
            ['day', 86400],
            ['hour', 3600],
            ['minute', 60],
        ];
        for (const [name, secondsPerUnit] of units) {
            const value = Math.floor(seconds / secondsPerUnit);
            if (value >= 1) {
                return value + ' ' + name + (value === 1 ? '' : 's') + ' ago';
            }
        }
        return 'just now';
    }

    // Session 58: the same timestamp's absolute form, for the meta row's
    // title tooltip (doc section 5.1) -- locale-formatted rather than raw
    // ISO, since this is the human-facing tooltip, not a machine value.
    function absoluteTime(isoString) {
        const then = new Date(isoString);
        return Number.isNaN(then.getTime()) ? '' : then.toLocaleString();
    }

    // Session 55: plain-text rendering of the currently-displayed explanation
    // for the "Copy" button -- mirrors renderExplanation's own section order
    // and its "omit empty fields" rule, so the copied text matches what's on
    // screen.
    function explanationAsText(fnName, explanation) {
        const lines = [fnName];
        if (explanation.why_it_exists) {
            lines.push('', 'Why it exists:', explanation.why_it_exists);
        }
        if (Array.isArray(explanation.used_by) && explanation.used_by.length > 0) {
            lines.push('', 'Used by:', explanation.used_by.join(', '));
        }
        if (Array.isArray(explanation.calls) && explanation.calls.length > 0) {
            lines.push('', 'Calls:', explanation.calls.join(', '));
        }
        if (Array.isArray(explanation.side_effects) && explanation.side_effects.length > 0) {
            lines.push('', 'Side effects:', explanation.side_effects.map((s) => '- ' + s).join('\\n'));
        } else {
            lines.push('', 'Side effects:', 'None detected -- pure function');
        }
        if (explanation.risk_note) {
            lines.push('', 'Risk:', explanation.risk_note);
        }
        return lines.join('\\n');
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

    function codicon(name) {
        const s = document.createElement('span');
        s.className = 'codicon codicon-' + name;
        s.setAttribute('aria-hidden', 'true');
        return s;
    }

    function sectionTitle(text, countBadge) {
        const h = document.createElement('h2');
        h.className = 'lh-section-title';
        h.appendChild(document.createTextNode(text));
        if (countBadge !== undefined) {
            const badge = document.createElement('span');
            badge.className = 'lh-count';
            badge.textContent = String(countBadge);
            h.appendChild(badge);
        }
        return h;
    }

    // A single "used by" / "calls" row -- a labeled button (not a link) so
    // it stays keyboard-focusable and works with no href/navigation target
    // of its own; clicking posts the same 'navigate' message the old
    // name-link buttons already used.
    function refRow(name) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = 'lh-ref-row';
        btn.appendChild(codicon('symbol-method'));
        btn.appendChild(document.createTextNode(name));
        btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'navigate', name: name });
        });
        li.appendChild(btn);
        return li;
    }

    function refList(names) {
        const ul = document.createElement('ul');
        ul.className = 'lh-refs';
        for (const name of names.slice(0, 3)) {
            ul.appendChild(refRow(name));
        }
        return ul;
    }

    function navButton(command, label) {
        const btn = document.createElement('button');
        btn.className = 'lh-nav';
        btn.appendChild(document.createTextNode(label + ' '));
        btn.appendChild(codicon('chevron-right'));
        btn.addEventListener('click', () => {
            vscode.postMessage({ type: command });
        });
        return btn;
    }

    // Session 58 card redesign (single-explanation view only -- see the CSS
    // block's own header comment). Ported from
    // lucidhover-ui-improvements.md / lucidhover-card-redesign.html, with
    // two content deviations documented in the session artifact: calls
    // and risk_note are real existing fields the doc's 5-zone target
    // structure doesn't mention at all (not one of its P1-P7 problems) --
    // kept and restyled to match the new system rather than silently
    // dropped, since removing working functionality wasn't asked for.
    function renderExplanation(fnName, kind, relFile, explanation, generatedAt, freshness, backTo) {
        clear();

        // Session 58 ("Back to caller"): a one-hop way back after clicking
        // a used-by/calls row, for the same-file case where VS Code's own
        // "Go Back" (Alt+Left) navigation doesn't help (no document change
        // to record). Sits above the card, not inside its header, so it
        // doesn't compete with Regenerate/Copy as another header action.
        if (backTo) {
            const backLink = document.createElement('button');
            backLink.className = 'lh-back';
            backLink.appendChild(codicon('chevron-left'));
            backLink.appendChild(document.createTextNode('Back to ' + backTo));
            backLink.addEventListener('click', () => {
                vscode.postMessage({ type: 'backToCaller' });
            });
            content.appendChild(backLink);
        }

        const card = document.createElement('div');
        card.className = 'lh-card';
        card.setAttribute('role', 'document');
        card.setAttribute('aria-label', 'Explanation of ' + fnName);

        // ── Header ──────────────────────────────────────────────
        const header = document.createElement('header');
        header.className = 'lh-header';

        const titleWrap = document.createElement('div');
        const titleRow = document.createElement('div');
        titleRow.className = 'lh-title-row';
        // 'kind' is currently always "Function" (see KIND_LABEL's doc
        // comment on why the Method/Function distinction was dropped);
        // kept as a param rather than hardcoded here so restoring the
        // distinction later, if real SymbolKind plumbing gets added, is a
        // caller-side change only.
        const kindIcon = codicon(kind === 'Method' ? 'symbol-method' : 'symbol-function');
        kindIcon.classList.add('lh-kind-icon');
        titleRow.appendChild(kindIcon);
        const nameSpan = document.createElement('span');
        nameSpan.className = 'lh-name';
        nameSpan.textContent = fnName;
        titleRow.appendChild(nameSpan);
        titleWrap.appendChild(titleRow);

        const meta = document.createElement('div');
        meta.className = 'lh-meta';
        const kindSpan = document.createElement('span');
        kindSpan.textContent = kind;
        meta.appendChild(kindSpan);
        if (relFile) {
            const dot1 = document.createElement('span');
            dot1.setAttribute('aria-hidden', 'true');
            dot1.textContent = '·';
            meta.appendChild(dot1);
            const fileSpan = document.createElement('span');
            fileSpan.className = 'lh-file';
            fileSpan.textContent = relFile;
            meta.appendChild(fileSpan);
        }
        const relTime = typeof generatedAt === 'string' ? relativeTime(generatedAt) : null;
        if (relTime) {
            const dot2 = document.createElement('span');
            dot2.setAttribute('aria-hidden', 'true');
            dot2.textContent = '·';
            meta.appendChild(dot2);
            const timeSpan = document.createElement('span');
            timeSpan.textContent = relTime;
            timeSpan.title = absoluteTime(generatedAt);
            meta.appendChild(timeSpan);
        }
        titleWrap.appendChild(meta);
        header.appendChild(titleWrap);

        const actions = document.createElement('div');
        actions.className = 'lh-actions';
        const regenerateBtn = document.createElement('button');
        regenerateBtn.className = 'lh-btn';
        regenerateBtn.title = 'Regenerate explanation';
        regenerateBtn.appendChild(codicon('sync'));
        regenerateBtn.appendChild(document.createTextNode('Regenerate'));
        const copyBtn = document.createElement('button');
        copyBtn.className = 'lh-btn';
        copyBtn.title = 'Copy explanation as Markdown';
        copyBtn.appendChild(codicon('copy'));
        copyBtn.appendChild(document.createTextNode('Copy'));
        regenerateBtn.addEventListener('click', () => {
            // Busy state clears itself: the next 'render'/'empty' message
            // this triggers rebuilds the whole card from scratch.
            regenerateBtn.classList.add('is-busy');
            regenerateBtn.disabled = true;
            copyBtn.disabled = true;
            vscode.postMessage({ type: 'regenerate' });
        });
        copyBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'copy', text: explanationAsText(fnName, explanation) });
        });
        actions.appendChild(regenerateBtn);
        actions.appendChild(copyBtn);
        header.appendChild(actions);
        activeRegenerateBtn = regenerateBtn;
        activeCopyBtn = copyBtn;

        card.appendChild(header);

        // ── Why it exists ───────────────────────────────────────
        if (explanation.why_it_exists) {
            const section = document.createElement('section');
            section.className = 'lh-section';
            section.appendChild(sectionTitle('Why it exists'));
            const body = document.createElement('p');
            body.className = 'lh-body';
            body.textContent = explanation.why_it_exists;
            section.appendChild(body);
            card.appendChild(section);
        }

        // ── Used by ─────────────────────────────────────────────
        const usedBy = Array.isArray(explanation.used_by) ? explanation.used_by : [];
        const usedBySection = document.createElement('section');
        usedBySection.className = 'lh-section';
        if (usedBy.length > 0) {
            usedBySection.appendChild(sectionTitle('Used by', usedBy.length));
            usedBySection.appendChild(refList(usedBy));
        }
        const navList = document.createElement('div');
        navList.className = 'lh-nav-list';
        navList.appendChild(navButton('showBlastRadius', 'See full blast radius'));
        navList.appendChild(navButton('traceExecutionPath', 'Trace execution from here'));
        usedBySection.appendChild(navList);
        card.appendChild(usedBySection);

        // ── Calls (kept -- see this function's own doc comment) ───
        const calls = Array.isArray(explanation.calls) ? explanation.calls : [];
        if (calls.length > 0) {
            const section = document.createElement('section');
            section.className = 'lh-section';
            section.appendChild(sectionTitle('Calls', calls.length));
            section.appendChild(refList(calls));
            card.appendChild(section);
        }

        // ── Side effects -- always exactly one of two states (P5) ─
        const sideEffects = Array.isArray(explanation.side_effects) ? explanation.side_effects : [];
        const seSection = document.createElement('section');
        seSection.className = 'lh-section';
        seSection.appendChild(sectionTitle('Side effects'));
        if (sideEffects.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'lh-empty';
            empty.appendChild(codicon('check'));
            empty.appendChild(document.createTextNode('None detected — pure function'));
            seSection.appendChild(empty);
        } else {
            const ul = document.createElement('ul');
            ul.className = 'lh-flags';
            for (const effect of sideEffects) {
                const li = document.createElement('li');
                li.appendChild(codicon('warning'));
                li.appendChild(document.createTextNode(effect));
                ul.appendChild(li);
            }
            seSection.appendChild(ul);
        }
        card.appendChild(seSection);

        // ── Risk (kept -- see this function's own doc comment) ────
        if (explanation.risk_note) {
            const section = document.createElement('section');
            section.className = 'lh-section';
            section.appendChild(sectionTitle('Risk'));
            const ul = document.createElement('ul');
            ul.className = 'lh-flags';
            const li = document.createElement('li');
            li.appendChild(codicon('warning'));
            li.appendChild(document.createTextNode(explanation.risk_note));
            ul.appendChild(li);
            section.appendChild(ul);
            card.appendChild(section);
        }

        // ── Footer ──────────────────────────────────────────────
        // Session 52's disclaimer, now extended (session 58) with the
        // doc's P7 stale indicator -- plus 'dirty' (an unsaved in-memory
        // edit), which the doc doesn't name but which this panel now has
        // the same DirtyTracker/StaleTracker access hover already had (see
        // freshnessOf's own doc comment for why this isn't imported from
        // there).
        const footer = document.createElement('footer');
        footer.className = 'lh-footer';
        footer.appendChild(codicon('warning'));
        const footerText = document.createElement('span');
        if (freshness === 'stale') {
            footer.classList.add('is-stale');
            footerText.textContent = 'Generated before the latest changes — consider regenerating.';
        } else if (freshness === 'dirty') {
            footer.classList.add('is-dirty');
            footerText.textContent = 'This function has unsaved changes — the explanation may be outdated.';
        } else {
            footerText.textContent = 'Generated by a local LLM — may be inaccurate, verify before relying on it.';
        }
        footer.appendChild(footerText);
        card.appendChild(footer);

        content.appendChild(card);
    }

    // Session 59: restyled to match .lh-back's "breadcrumb above the card"
    // treatment (renderExplanation's "Back to caller" link) -- same visual
    // role (a way back to whatever view preceded this one), so reusing the
    // class instead of keeping a near-identical sibling. Shared by both
    // renderGraph (blast radius) and renderTrace (execution trace, out of
    // this session's scope) -- restyling this one small shared helper isn't
    // part of either of those two functions' own bodies.
    function addBackLink() {
        const btn = document.createElement('button');
        btn.className = 'lh-back';
        btn.appendChild(codicon('chevron-left'));
        btn.appendChild(document.createTextNode('Back'));
        btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'back' });
        });
        content.appendChild(btn);
    }

    // Session 45: generic depth-grouped list renderer -- takes nodes + edges
    // + direction (payload.edges isn't used by this particular render mode
    // yet, but the data is here so a future mode, e.g. session 46's linear
    // execution-trace view, doesn't need a second RPC/enrichment round trip
    // to get it). Session 59: restyled to the card system's row look
    // (see the CSS block's own comment on why this uses standalone
    // .lh-graph-* classes rather than .lh-refs/.lh-ref-row directly) --
    // shared by renderGraph (blast radius, in scope) and renderBranchPoint
    // (execution trace, out of scope); the shared restyle also uplifts
    // trace/branch node rows for free, which is expected, not accidental.
    function renderGraphNode(node, container) {
        container = container || content;
        const wrap = document.createElement('div');
        wrap.className = 'lh-graph-row';

        const btn = document.createElement('button');
        btn.className = 'lh-graph-btn';
        btn.appendChild(codicon('symbol-method'));
        const nameSpan = document.createElement('span');
        nameSpan.className = 'lh-graph-name';
        nameSpan.textContent = node.name;
        btn.appendChild(nameSpan);
        const locSpan = document.createElement('span');
        locSpan.className = 'lh-graph-loc';
        locSpan.textContent = node.relFname + ':' + (node.line + 1);
        btn.appendChild(locSpan);
        btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'navigate', name: node.name });
        });
        wrap.appendChild(btn);

        const desc = document.createElement('p');
        if (node.roleTag || node.oneLiner) {
            desc.className = 'lh-graph-desc';
            desc.textContent = [node.roleTag, node.oneLiner].filter(Boolean).join(' — ');
        } else {
            desc.className = 'lh-graph-desc empty-state';
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

    // Session 59: restyled to the card system -- each depth becomes an
    // .lh-section (matching Used By/Calls' own section treatment) inside a
    // single .lh-card, with a count badge on the "Level N" title (same
    // sectionTitle() helper renderExplanation uses) and node rows via the
    // restyled renderGraphNode. Out of scope: renderTrace/renderBranchPoint
    // (execution trace) below, untouched.
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

        const card = document.createElement('div');
        card.className = 'lh-card';

        const maxDepth = payload.nodes.reduce((max, n) => Math.max(max, n.depth), 0);
        for (let depth = 1; depth <= maxDepth; depth++) {
            const atDepth = payload.nodes.filter((n) => n.depth === depth);
            if (atDepth.length === 0) {
                continue;
            }
            const section = document.createElement('section');
            section.className = 'lh-section';
            section.appendChild(sectionTitle('Level ' + depth, atDepth.length));

            const list = document.createElement('div');
            list.className = 'lh-graph-list';
            for (const node of atDepth) {
                renderGraphNode(node, list);
            }
            section.appendChild(list);

            // Session 47: the per-level fan-out cap omits nodes rather than
            // silently truncating -- surface that as a plain note under the
            // level it applies to, not a new UI affordance.
            const omission = payload.omissions.find((o) => o.depth === depth);
            if (omission) {
                const note = document.createElement('p');
                note.className = 'empty-state';
                note.textContent = '+' + omission.omittedCount + ' more not shown';
                section.appendChild(note);
            }

            card.appendChild(section);
        }
        content.appendChild(card);
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
            renderExplanation(
                message.fnName,
                message.kind,
                message.relFile,
                message.explanation,
                message.generatedAt,
                message.freshness,
                message.backTo
            );
        } else if (message.type === 'empty') {
            renderEmpty(message.fnName);
        } else if (message.type === 'regenerateFailed') {
            // code-reviewer finding: a failed regeneration previously left
            // Regenerate/Copy stuck disabled with a spinning icon forever,
            // since only a fresh 'render'/'empty' message (which a failure
            // never sends) cleared busy state. The still-valid old
            // explanation stays on screen untouched -- only the two buttons
            // are re-enabled.
            if (activeRegenerateBtn) {
                activeRegenerateBtn.classList.remove('is-busy');
                activeRegenerateBtn.disabled = false;
            }
            if (activeCopyBtn) {
                activeCopyBtn.disabled = false;
            }
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
 *
 * `refreshPanel` (Session 58): called after every successful navigation --
 * a real user report found that clicking a used-by/calls row for a function
 * the cursor was already at (or had recently visited) navigated the editor
 * correctly but left the panel showing the previous explanation, because
 * this function sets `editor.selection` directly and `onSelectionChanged`'s
 * event-driven refresh depends on `onDidChangeTextEditorSelection` actually
 * firing, which it doesn't for a no-op selection change. See
 * `ExplanationPanelProvider.refreshNow`'s own doc comment for the full
 * mechanism (the same fix already applied to `navigateToLocation` there).
 *
 * Exported as a standalone function (Session 58), not just the inline
 * `registerCommand` callback below, so tests can call it directly --
 * matching session 45's `showBlastRadius`/`registerShowBlastRadiusCommand`
 * split, for the identical reason: `registerCommand` throws "command
 * already exists" inside this test harness, where the real extension is
 * genuinely activated and has already registered `NAVIGATE_COMMAND_ID`.
 */
export async function navigateToFunction(
    name: string,
    getWorkspaceRoot: () => string | undefined,
    getSidecar: () => SidecarManager | undefined,
    refreshPanel: () => void,
    output: vscode.OutputChannel
): Promise<void> {
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
                refreshPanel();
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
    refreshPanel();
}

export function registerNavigateToFunctionCommand(
    getWorkspaceRoot: () => string | undefined,
    getSidecar: () => SidecarManager | undefined,
    refreshPanel: () => void,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(NAVIGATE_COMMAND_ID, (name: string) =>
        navigateToFunction(name, getWorkspaceRoot, getSidecar, refreshPanel, output)
    );
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
