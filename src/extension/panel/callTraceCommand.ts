import * as vscode from 'vscode';
import { ExplanationCache } from '../cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../cache/config';
import { resolveEnclosingFunction, resolveFunctionsInFile, ResolvedFunction } from '../functionResolution';
import { SidecarManager } from '../sidecar/sidecarManager';
import {
    ExplanationPanelProvider,
    GraphViewBranchPoint,
    GraphViewEdge,
    GraphViewNode,
    GraphViewPayload,
    SHOW_CALL_TRACE_COMMAND_ID,
} from './explanationPanelProvider';

// Graph-only, no LLM call (Session 46) -- same reasoning and same budget as
// blastRadiusCommand.ts's BLAST_RADIUS_TIMEOUT_MS.
const CALL_TRACE_TIMEOUT_MS = 15_000;

interface RawCallTraceNode {
    rel_fname: string;
    name: string;
    line: number;
    importance: number;
    depth: number;
}

interface RawCallTraceEdge {
    caller_rel_fname: string;
    caller_name: string;
    caller_line: number;
    callee_rel_fname: string;
    callee_name: string;
    callee_line: number;
}

/** A branch alternate (session 48) -- bare graph facts, no `depth` of its own; it shares its `CallTraceBranchPoint`'s depth (see sidecar/repomap/context.py's `CallTraceBranchPoint` docstring). */
interface RawCallTraceAlternate {
    rel_fname: string;
    name: string;
    line: number;
    importance: number;
}

interface RawCallTraceBranchPoint {
    depth: number;
    alternates: RawCallTraceAlternate[];
    omitted_count: number;
}

interface RawCallTraceResult {
    rel_fname: string;
    name: string;
    line: number;
    nodes: RawCallTraceNode[];
    edges: RawCallTraceEdge[];
    branches: RawCallTraceBranchPoint[];
}

/** Same nearest-line tolerance blastRadiusCommand.ts's `closestResolved` already uses for this identical "bare rel_fname/name/line -> real ResolvedFunction" problem. */
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
 * Memoized "bare (rel_fname, name, line) -> real ResolvedFunction[]"
 * resolver, shared by `enrichNodes` and `enrichBranches` below so a file
 * touched by both the primary path and its branch alternates (a common
 * case -- siblings often live next to each other) is only resolved once
 * per `showCallTrace` call, not once per caller.
 */
function makeResolvedFor(
    workspaceRoot: string,
    output: vscode.OutputChannel
): (relFname: string) => Promise<ResolvedFunction[]> {
    const resolvedByFile = new Map<string, ResolvedFunction[]>();
    return async (relFname: string): Promise<ResolvedFunction[]> => {
        let resolved = resolvedByFile.get(relFname);
        if (!resolved) {
            resolved = await resolveFunctionsInFile(workspaceRoot, relFname, output);
            resolvedByFile.set(relFname, resolved);
        }
        return resolved;
    };
}

/**
 * Attaches cached role_tag/one_liner to one bare graph fact the sidecar
 * returned -- identical enrichment rule to blastRadiusCommand.ts's
 * `enrichNodes` (Core Rule 9: the sidecar's `get_call_trace` only ever
 * returns bare graph facts, never cache data). A fact with no cache row
 * (not yet hovered, or background indexing hasn't reached it) renders with
 * `roleTag`/`oneLiner` left undefined -- the panel's existing
 * `renderGraphNode` already shows that as an explicit "Not yet indexed."
 * placeholder. This function never falls back to generation to fill the
 * gap, and the walk that produced the fact was never gated on cache state
 * to begin with.
 *
 * Shared by `enrichNodes` (primary-path nodes, which carry their own
 * `depth`) and `enrichBranches` (session 48's branch alternates, which
 * don't -- they take their `CallTraceBranchPoint`'s depth instead, passed
 * in explicitly by the caller).
 */
async function enrichOne(
    cache: ExplanationCache,
    resolvedFor: (relFname: string) => Promise<ResolvedFunction[]>,
    relFname: string,
    name: string,
    line: number,
    depth: number,
    importance: number
): Promise<GraphViewNode> {
    const candidates = await resolvedFor(relFname);
    const match = closestResolved(candidates, name, line);
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

    return { relFname, name, line, depth, importance, roleTag, oneLiner };
}

async function enrichNodes(
    cache: ExplanationCache,
    nodes: readonly RawCallTraceNode[],
    resolvedFor: (relFname: string) => Promise<ResolvedFunction[]>
): Promise<GraphViewNode[]> {
    const result: GraphViewNode[] = [];
    for (const node of nodes) {
        result.push(await enrichOne(cache, resolvedFor, node.rel_fname, node.name, node.line, node.depth, node.importance));
    }
    return result;
}

/**
 * Enriches session 48's non-primary branch alternates the same way
 * `enrichNodes` enriches primary-path nodes -- every node shown, primary or
 * alternate, goes through the identical `enrichOne` path, so an uncached
 * alternate gets the same "Not yet indexed." placeholder a primary node
 * would. Each alternate is stamped with its `CallTraceBranchPoint`'s own
 * `depth` (it has none of its own -- see `RawCallTraceAlternate`'s doc
 * comment), matching the primary-path node the branch point sits next to.
 */
async function enrichBranches(
    cache: ExplanationCache,
    branches: readonly RawCallTraceBranchPoint[],
    resolvedFor: (relFname: string) => Promise<ResolvedFunction[]>
): Promise<GraphViewBranchPoint[]> {
    const result: GraphViewBranchPoint[] = [];
    for (const branchPoint of branches) {
        const alternates: GraphViewNode[] = [];
        for (const alt of branchPoint.alternates) {
            alternates.push(await enrichOne(cache, resolvedFor, alt.rel_fname, alt.name, alt.line, branchPoint.depth, alt.importance));
        }
        result.push({ depth: branchPoint.depth, alternates, omittedCount: branchPoint.omitted_count });
    }
    return result;
}

function toGraphViewEdges(edges: readonly RawCallTraceEdge[]): GraphViewEdge[] {
    return edges.map((e) => ({
        callerRelFname: e.caller_rel_fname,
        callerName: e.caller_name,
        callerLine: e.caller_line,
        calleeRelFname: e.callee_rel_fname,
        calleeName: e.callee_name,
        calleeLine: e.callee_line,
    }));
}

/**
 * "Follow this one call chain end-to-end" (Session 46) -- calls the
 * sidecar's `get_call_trace` for the function under the cursor, enriches
 * the result from the cache, and pins it in the docked panel as a linear
 * downstream chain. Default `'interactive'` priority (Session 32's
 * scheduling hint), same reasoning as `showBlastRadius`.
 *
 * Exported separately from `registerShowCallTraceCommand` below for the
 * same reason `showBlastRadius` is: tests call this function directly
 * rather than through the global command registry, since `extension.ts`'s
 * own activation already registers the real command id once in the
 * Extension Development Host every integration test runs inside.
 */
export async function showCallTrace(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    panel: ExplanationPanelProvider,
    output: vscode.OutputChannel
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const workspaceRoot = getWorkspaceRoot();
    const cache = getCache();
    const sidecar = getSidecar();

    if (!editor) {
        vscode.window.setStatusBarMessage('LucidHover: no active editor', 3000);
        return;
    }
    if (!workspaceRoot || !cache || !sidecar) {
        vscode.window.setStatusBarMessage('LucidHover: indexing not ready yet', 3000);
        return;
    }

    const resolved = await resolveEnclosingFunction(editor.document, editor.selection.active, workspaceRoot);
    if (!resolved) {
        vscode.window.setStatusBarMessage('LucidHover: no function under the cursor', 3000);
        return;
    }

    vscode.window.setStatusBarMessage(`LucidHover: tracing execution from ${resolved.name}...`, 3000);
    try {
        const raw = await sidecar.request<RawCallTraceResult>(
            'get_call_trace',
            { file_path: resolved.relFile, name: resolved.name, line: resolved.range.start.line },
            CALL_TRACE_TIMEOUT_MS
        );
        const resolvedFor = makeResolvedFor(workspaceRoot, output);
        const nodes = await enrichNodes(cache, raw.nodes, resolvedFor);
        const branches = await enrichBranches(cache, raw.branches, resolvedFor);
        const payload: GraphViewPayload = {
            title: `Execution trace from ${resolved.name}`,
            direction: 'downstream',
            rootName: resolved.name,
            nodes,
            edges: toGraphViewEdges(raw.edges),
            // Session 47's per-level fan-out cap only applies to blast
            // radius's branching upstream walk -- a single-primary-path
            // downstream trace has exactly one node per depth, so there's
            // never anything to omit here.
            omissions: [],
            branches,
        };
        await panel.reveal();
        panel.showGraph(payload);
    } catch (err) {
        output.appendLine(`call trace failed for ${resolved.fnId}: ${String(err)}`);
        vscode.window.showErrorMessage(
            `LucidHover: couldn't trace execution from ${resolved.name}. See the LucidHover output channel.`
        );
    }
}

export function registerShowCallTraceCommand(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    panel: ExplanationPanelProvider,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(SHOW_CALL_TRACE_COMMAND_ID, () =>
        showCallTrace(getWorkspaceRoot, getCache, getSidecar, panel, output)
    );
}
