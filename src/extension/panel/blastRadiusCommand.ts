import * as vscode from 'vscode';
import { ExplanationCache } from '../cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../cache/config';
import { resolveEnclosingFunction, resolveFunctionsInFile, ResolvedFunction } from '../functionResolution';
import { SidecarManager } from '../sidecar/sidecarManager';
import { ExplanationPanelProvider, GraphViewEdge, GraphViewNode, GraphViewOmission, GraphViewPayload, SHOW_BLAST_RADIUS_COMMAND_ID } from './explanationPanelProvider';

// Graph-only, no LLM call (Session 45) -- the default 4s RPC timeout is
// tuned for near-instant calls like this one, but a real repo's upstream
// walk is still more work than `status`/`resolve_function`, so this gets
// its own generous-but-bounded budget, same reasoning as `generation.ts`'s
// GENERATE_TIMEOUT_MS just scaled down (no Ollama round trip to wait on).
const BLAST_RADIUS_TIMEOUT_MS = 15_000;

interface RawBlastRadiusNode {
    rel_fname: string;
    name: string;
    line: number;
    importance: number;
    depth: number;
}

interface RawBlastRadiusEdge {
    caller_rel_fname: string;
    caller_name: string;
    caller_line: number;
    callee_rel_fname: string;
    callee_name: string;
    callee_line: number;
}

interface RawBlastRadiusOmission {
    depth: number;
    omitted_count: number;
}

interface RawBlastRadiusResult {
    rel_fname: string;
    name: string;
    line: number;
    nodes: RawBlastRadiusNode[];
    edges: RawBlastRadiusEdge[];
    omissions: RawBlastRadiusOmission[];
}

/** Same nearest-line tolerance staleTracking.ts's `closestResolved` already uses for this identical "bare rel_fname/name/line -> real ResolvedFunction" problem -- the sidecar's tree-sitter def line and VS Code's document-symbol line don't always agree exactly. */
function closestResolved(candidates: readonly ResolvedFunction[], name: string, line: number): ResolvedFunction | undefined {
    const matches = candidates.filter((c) => c.name === name);
    if (matches.length === 0) {
        return undefined;
    }
    return matches.reduce((closest, candidate) =>
        Math.abs(candidate.range.start.line - line) < Math.abs(closest.range.start.line - line) ? candidate : closest
    );
}

/**
 * Attaches cached role_tag/one_liner to each bare graph node the sidecar
 * returned. Per Core Rule 9, the sidecar's `get_blast_radius` only ever
 * returns graph facts (rel_fname/name/line/importance/depth) -- it has no
 * idea what's cached. This is the one place that enriches them, and it must
 * never generate to fill a gap in: a node with no cache row (not yet
 * hovered, or background indexing hasn't reached it) simply keeps
 * `roleTag`/`oneLiner` undefined, same "render bare, don't trigger
 * generation" rule the docked panel's cursor-synced view already follows
 * (Core Rule 4 has no exception for this render path either).
 *
 * Resolves each distinct file's functions at most once via
 * `resolveFunctionsInFile` -- the same memoized-per-file pattern
 * staleTracking.ts's `flagStaleDependents`/`fnIdFor` already uses for the
 * identical problem of turning the sidecar's bare (rel_fname, name, line)
 * into a real fnId/fnHash.
 */
async function enrichNodes(
    workspaceRoot: string,
    cache: ExplanationCache,
    nodes: readonly RawBlastRadiusNode[],
    output: vscode.OutputChannel
): Promise<GraphViewNode[]> {
    const resolvedByFile = new Map<string, ResolvedFunction[]>();
    async function resolvedFor(relFname: string): Promise<ResolvedFunction[]> {
        let resolved = resolvedByFile.get(relFname);
        if (!resolved) {
            resolved = await resolveFunctionsInFile(workspaceRoot, relFname, output);
            resolvedByFile.set(relFname, resolved);
        }
        return resolved;
    }

    const result: GraphViewNode[] = [];
    for (const node of nodes) {
        const candidates = await resolvedFor(node.rel_fname);
        const match = closestResolved(candidates, node.name, node.line);
        const row = match
            ? cache.lookup({
                  fnId: match.fnId,
                  fnHash: match.fnHash,
                  modelId: resolveModelId(),
                  embeddingModelId: EMBEDDING_MODEL_ID,
                  promptVersion: PROMPT_VERSION,
              })
            : undefined;

        let roleTag: string | undefined;
        let oneLiner: string | undefined;
        if (row) {
            const explanation = JSON.parse(row.explanation_json) as { role_tag?: unknown; one_liner?: unknown };
            roleTag = typeof explanation.role_tag === 'string' ? explanation.role_tag : undefined;
            oneLiner = typeof explanation.one_liner === 'string' ? explanation.one_liner : undefined;
        }

        result.push({
            relFname: node.rel_fname,
            name: node.name,
            line: node.line,
            depth: node.depth,
            importance: node.importance,
            roleTag,
            oneLiner,
        });
    }
    return result;
}

function toGraphViewEdges(edges: readonly RawBlastRadiusEdge[]): GraphViewEdge[] {
    return edges.map((e) => ({
        callerRelFname: e.caller_rel_fname,
        callerName: e.caller_name,
        callerLine: e.caller_line,
        calleeRelFname: e.callee_rel_fname,
        calleeName: e.callee_name,
        calleeLine: e.callee_line,
    }));
}

function toGraphViewOmissions(omissions: readonly RawBlastRadiusOmission[]): GraphViewOmission[] {
    return omissions.map((o) => ({ depth: o.depth, omittedCount: o.omitted_count }));
}

/**
 * "If I change this function, what's affected" (Session 45) -- calls the
 * sidecar's `get_blast_radius` for the function under the cursor, enriches
 * the result from the cache, and pins it in the docked panel. Default
 * `'interactive'` priority (Session 32's scheduling hint): this is a direct,
 * on-demand user action, not autonomous background work, same shape as the
 * existing "navigate"/"refresh" commands.
 *
 * Exported separately from `registerShowBlastRadiusCommand` below (which is
 * just a thin `vscode.commands.registerCommand` wrapper around this) so
 * tests can call the actual logic directly instead of going through the
 * global command registry -- the real command id is already registered once
 * by `extension.ts`'s own activation in the Extension Development Host every
 * integration test runs inside, so a second `registerCommand` call for the
 * same id throws.
 *
 * `target` (Session 52), when supplied, is used as-is instead of re-resolving
 * from the live cursor -- `ExplanationPanelProvider` passes its own
 * `currentFunction` here when the webview's "See full blast radius →" button
 * fires, so the graph is computed for whatever the panel is actually
 * showing, not wherever the cursor has since moved to (a real bug: the
 * command previously always re-resolved from `activeTextEditor`, ignoring
 * the panel entirely). Left undefined for a plain Command Palette
 * invocation, which still needs live-cursor resolution -- there's no
 * "currently displayed" function to draw from there.
 */
export async function showBlastRadius(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    panel: ExplanationPanelProvider,
    output: vscode.OutputChannel,
    target?: ResolvedFunction
): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    const cache = getCache();
    const sidecar = getSidecar();

    if (!workspaceRoot || !cache || !sidecar) {
        vscode.window.setStatusBarMessage('LucidHover: indexing not ready yet', 3000);
        return;
    }

    let resolved = target;
    if (!resolved) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.setStatusBarMessage('LucidHover: no active editor', 3000);
            return;
        }
        resolved = await resolveEnclosingFunction(editor.document, editor.selection.active, workspaceRoot);
        if (!resolved) {
            vscode.window.setStatusBarMessage('LucidHover: no function under the cursor', 3000);
            return;
        }
    }

    vscode.window.setStatusBarMessage(`LucidHover: computing blast radius for ${resolved.name}...`, 3000);
    try {
        const raw = await sidecar.request<RawBlastRadiusResult>(
            'get_blast_radius',
            { file_path: resolved.relFile, name: resolved.name, line: resolved.range.start.line },
            BLAST_RADIUS_TIMEOUT_MS
        );
        const nodes = await enrichNodes(workspaceRoot, cache, raw.nodes, output);
        const payload: GraphViewPayload = {
            title: `Blast radius for ${resolved.name}`,
            direction: 'upstream',
            rootName: resolved.name,
            nodes,
            edges: toGraphViewEdges(raw.edges),
            omissions: toGraphViewOmissions(raw.omissions),
            // Session 48's branch expansion only applies to execution trace's
            // single-primary-path walk (`callTraceCommand.ts`) -- blast
            // radius's own upstream BFS already shows every confident caller
            // at each level (subject to session 47's fan-out cap), so there's
            // no "non-primary" concept here to branch from.
            branches: [],
        };
        await panel.reveal();
        panel.showGraph(payload);
    } catch (err) {
        output.appendLine(`blast radius failed for ${resolved.fnId}: ${String(err)}`);
        vscode.window.showErrorMessage(
            `LucidHover: couldn't compute blast radius for ${resolved.name}. See the LucidHover output channel.`
        );
    }
}

export function registerShowBlastRadiusCommand(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    panel: ExplanationPanelProvider,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(SHOW_BLAST_RADIUS_COMMAND_ID, (target?: ResolvedFunction) =>
        showBlastRadius(getWorkspaceRoot, getCache, getSidecar, panel, output, target)
    );
}
