import * as vscode from 'vscode';
import {
    CLUSTER_SUMMARY_PROMPT_VERSION,
    EMBEDDING_MODEL_ID,
    PROMPT_VERSION,
    resolveAutoEvictSupersededCache,
    resolveModelId,
} from '../cache/config';
import { CacheRow, ExplanationCache } from '../cache/explanationCache';
import { computeCacheKey, computeClusterSummaryFnHash } from '../cache/hash';
import { resolveEnclosingFunction, resolveFunctionsInFile, ResolvedFunction } from '../functionResolution';
import { SidecarManager } from '../sidecar/sidecarManager';
import {
    ExplanationPanelProvider,
    GraphViewEdge,
    GraphViewNode,
    GraphViewOmission,
    GraphViewPayload,
    SHOW_CLUSTER_SUMMARY_COMMAND_ID,
    SYNTHESIZE_CLUSTER_SUMMARY_COMMAND_ID,
} from './explanationPanelProvider';

// Graph-only RPC, no LLM call -- same reasoning and budget as
// blastRadiusCommand.ts's BLAST_RADIUS_TIMEOUT_MS (this command reuses
// get_blast_radius as-is for cluster selection, see this file's own doc
// comment).
const CLUSTER_BLAST_RADIUS_TIMEOUT_MS = 15_000;

// Same call class as generateAndCache's generate_explanation / summaryDocGenerator's
// generate_file_summary (an Ollama round trip, not a near-instant RPC method).
const CLUSTER_SYNTHESIS_TIMEOUT_MS = 120_000;

// Reserved suffix for a cluster's synthetic cache row, appended directly to
// the root function's own real fn_id (`${relFile}::${qualifiedName}`,
// possibly `#n`-suffixed -- see cache/hash.ts's computeFnId doc comment).
// A real fn_id only ever contains exactly one "::" separator (between
// relFile and qualifiedName -- confirmed against functionResolution.ts's
// assignFnIds/computeFnId, which never join on "::" themselves), so
// appending a second "::" plus this reserved name can never collide with a
// real resolved function's fn_id, the same reasoning
// summaryDocGenerator.ts's SYNTHETIC_FILE_SUMMARY_NAME relies on for its own
// synthetic row. Per-root-function granularity (not per-file, since a
// cluster is anchored on one specific function, not a whole file) is why
// this appends directly rather than going through computeFnId(relFname, name)
// like the file-summary row does.
const CLUSTER_SUMMARY_FN_ID_SUFFIX = '::__cluster_summary__';

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

/**
 * One cluster member (a blast-radius node) enriched from the cache, plus
 * (unlike GraphViewNode) the matched row's own `cache_key` -- needed to
 * build the cluster's synthetic-row invalidation hash below (see
 * `buildClusterFnId`/`lookupClusterPurpose`'s doc comments for why
 * `cache_key`, not just `fn_hash`), but not part of what the panel renders.
 */
interface EnrichedMember {
    node: GraphViewNode;
    cacheKey?: string;
    roleTag?: string;
    oneLiner?: string;
}

/** Same nearest-line tolerance blastRadiusCommand.ts's own `closestResolved` already uses for this identical "bare rel_fname/name/line -> real ResolvedFunction" problem. */
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
 * Enriches each bare blast-radius node from the cache -- identical
 * enrichment rule to blastRadiusCommand.ts's own `enrichNodes` (Core Rule 9:
 * the sidecar's `get_blast_radius` only ever returns bare graph facts, never
 * cache data; this never generates to fill a gap). Also threads back each
 * matched node's own row `cache_key` (blastRadiusCommand.ts's `GraphViewNode`
 * has no such field -- this command additionally needs it to build the
 * cluster's own synthetic-row invalidation hash below).
 */
async function enrichMembers(
    workspaceRoot: string,
    cache: ExplanationCache,
    nodes: readonly RawBlastRadiusNode[],
    output: vscode.OutputChannel
): Promise<EnrichedMember[]> {
    const resolvedByFile = new Map<string, ResolvedFunction[]>();
    async function resolvedFor(relFname: string): Promise<ResolvedFunction[]> {
        let resolved = resolvedByFile.get(relFname);
        if (!resolved) {
            resolved = await resolveFunctionsInFile(workspaceRoot, relFname, output);
            resolvedByFile.set(relFname, resolved);
        }
        return resolved;
    }

    const result: EnrichedMember[] = [];
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
            node: {
                relFname: node.rel_fname,
                name: node.name,
                line: node.line,
                depth: node.depth,
                importance: node.importance,
                roleTag,
                oneLiner,
            },
            cacheKey: row?.cache_key,
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

interface RootCacheInfo {
    row: CacheRow | undefined;
    roleTag?: string;
    oneLiner?: string;
}

function lookupRoot(cache: ExplanationCache, modelId: string, root: ResolvedFunction): RootCacheInfo {
    const row = cache.lookup({
        fnId: root.fnId,
        fnHash: root.fnHash,
        modelId,
        embeddingModelId: EMBEDDING_MODEL_ID,
        promptVersion: PROMPT_VERSION,
    });
    if (!row) {
        return { row: undefined };
    }
    const explanation = JSON.parse(row.explanation_json) as { role_tag?: unknown; one_liner?: unknown };
    return {
        row,
        roleTag: typeof explanation.role_tag === 'string' ? explanation.role_tag : undefined,
        oneLiner: typeof explanation.one_liner === 'string' ? explanation.one_liner : undefined,
    };
}

/**
 * The synthetic cluster-summary row's identity: `fn_id` and the `fn_hash`
 * slot its cache key is built over. Deliberately hashes each cached
 * member's own row `cache_key` (Core Design Decision #2's full
 * fn_source+context_hash+model_id+embedding_model_id+prompt_version tuple
 * for that row), not just its `fn_hash` -- a code-reviewer finding on this
 * session's first draft: hashing only `fn_hash` misses the case where a
 * member regenerates with new `role_tag`/`one_liner` text (e.g. after a
 * `PROMPT_VERSION` bump) while its *source* is unchanged, so `fn_hash`
 * itself doesn't change even though the actual text fed into
 * `generate_cluster_summary`'s prompt did. `cache_key` changes whenever any
 * of that row's real generation inputs change, so this closes that gap
 * without needing to separately track `prompt_version`/`model_id` here too.
 */
function clusterIdentity(
    root: ResolvedFunction,
    rootCache: RootCacheInfo,
    cachedMembers: readonly (EnrichedMember & { cacheKey: string })[]
): { fnId: string; fnHash: string; totalCached: number } {
    const fnId = `${root.fnId}${CLUSTER_SUMMARY_FN_ID_SUFFIX}`;
    const cacheKeyInputs = [...(rootCache.row ? [rootCache.row.cache_key] : []), ...cachedMembers.map((m) => m.cacheKey)];
    const fnHash = computeClusterSummaryFnHash(cacheKeyInputs);
    const totalCached = (rootCache.row ? 1 : 0) + cachedMembers.length;
    return { fnId, fnHash, totalCached };
}

interface ClusterPurposeResult {
    purpose: string | undefined;
    /**
     * True when the cluster has at least one cached member (root or a
     * caller) but no synthesized paragraph cached yet -- the panel shows a
     * "Synthesize summary" affordance only in this state (Core Rule 4: the
     * panel's own render/lookup path must never generate to fill this in
     * itself; synthesis only ever happens via the separate, explicit
     * `synthesizeClusterSummary` command below, the same "explicit action,
     * not the panel's own render path" precedent `refreshExplanationCommand.ts`'s
     * "Regenerate" already established for per-function explanations).
     */
    canSynthesize: boolean;
}

/**
 * Pure cache lookup (Core Rule 4/9 -- no RPC call of any kind, exactly like
 * `enrichMembers` above): resolves the cluster's already-synthesized purpose
 * paragraph from the cache, if one exists. Used by `showClusterSummary`,
 * which -- like blast radius's and execution trace's own render paths --
 * must never generate to populate the panel.
 */
function lookupClusterPurpose(
    cache: ExplanationCache,
    modelId: string,
    root: ResolvedFunction,
    rootCache: RootCacheInfo,
    members: readonly EnrichedMember[]
): ClusterPurposeResult {
    const cachedMembers = members.filter((m): m is EnrichedMember & { cacheKey: string } => m.cacheKey !== undefined);
    const { fnId, fnHash, totalCached } = clusterIdentity(root, rootCache, cachedMembers);
    if (totalCached === 0) {
        return { purpose: undefined, canSynthesize: false };
    }

    const cached = cache.lookup({
        fnId,
        fnHash,
        modelId,
        embeddingModelId: EMBEDDING_MODEL_ID,
        promptVersion: CLUSTER_SUMMARY_PROMPT_VERSION,
    });
    if (cached) {
        try {
            const parsed = JSON.parse(cached.explanation_json) as { purpose?: string };
            if (parsed.purpose) {
                return { purpose: parsed.purpose, canSynthesize: false };
            }
        } catch {
            // Fall through -- treat as not yet synthesized.
        }
    }
    return { purpose: undefined, canSynthesize: true };
}

/**
 * The one path in this feature that actually calls the LLM
 * (`generate_cluster_summary`) and writes the resulting paragraph to cache.
 * Only ever invoked by the explicit, separate `synthesizeClusterSummary`
 * command below -- never by `showClusterSummary`/`lookupClusterPurpose`,
 * which must stay a pure cache lookup (see `ClusterPurposeResult.canSynthesize`'s
 * own doc comment for why). Synthesizes only from the cluster's already-cached
 * members (root plus cached callers) -- mirrors `summaryDocGenerator.ts`'s own
 * per-function skip rule exactly; an uncached member is never itself
 * generated to fill a gap in.
 *
 * A synthesis failure (Ollama error) is caught and logged, same per-item
 * failure handling as `summaryDocGenerator.ts`'s own `resolveFileSummaryParagraph`
 * -- the caller still gets a result (a placeholder string), not an
 * exception, so the panel always has something to render.
 */
async function synthesizeAndCacheClusterPurpose(
    sidecar: SidecarManager,
    cache: ExplanationCache,
    modelId: string,
    root: ResolvedFunction,
    rootCache: RootCacheInfo,
    members: readonly EnrichedMember[],
    output: vscode.OutputChannel
): Promise<string | undefined> {
    const cachedMembers = members.filter((m): m is EnrichedMember & { cacheKey: string } => m.cacheKey !== undefined);
    const { fnId, fnHash, totalCached } = clusterIdentity(root, rootCache, cachedMembers);
    if (totalCached === 0) {
        // Defensive only -- the "Synthesize" affordance never renders in
        // this state (see lookupClusterPurpose), so a real UI click can't
        // reach here with nothing cached. Guards direct callers (e.g. a
        // Command Palette invocation right as the last cache row is
        // evicted) from wasting an Ollama call on an empty cluster.
        return undefined;
    }

    try {
        const result = await sidecar.request<{ summary: string }>(
            'generate_cluster_summary',
            {
                root_name: root.name,
                root_role: rootCache.roleTag ?? null,
                root_one_liner: rootCache.oneLiner ?? null,
                callers: cachedMembers.map((m) => ({
                    name: m.node.name,
                    role_tag: m.roleTag ?? null,
                    one_liner: m.oneLiner ?? null,
                    depth: m.node.depth,
                })),
                model_id: modelId,
            },
            CLUSTER_SYNTHESIS_TIMEOUT_MS
        );

        const row: CacheRow = {
            cache_key: computeCacheKey({
                fnSource: fnHash,
                contextHash: '',
                modelId,
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: CLUSTER_SUMMARY_PROMPT_VERSION,
            }),
            fn_id: fnId,
            explanation_json: JSON.stringify({ purpose: result.summary }),
            fn_hash: fnHash,
            context_hash: '',
            model_id: modelId,
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: CLUSTER_SUMMARY_PROMPT_VERSION,
            context_tier: 'cluster-summary',
            generated_at: new Date().toISOString(),
        };
        cache.write(row, resolveAutoEvictSupersededCache());
        return result.summary;
    } catch (err) {
        output.appendLine(`cluster summary: generate_cluster_summary failed for ${root.fnId}: ${String(err)}`);
        return '_(purpose paragraph unavailable -- see the LucidHover output channel)_';
    }
}

async function resolveClusterTarget(
    getWorkspaceRoot: () => string | undefined,
    target: ResolvedFunction | undefined
): Promise<{ workspaceRoot: string; resolved: ResolvedFunction } | undefined> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return undefined;
    }
    let resolved = target;
    if (!resolved) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return undefined;
        }
        resolved = await resolveEnclosingFunction(editor.document, editor.selection.active, workspaceRoot);
        if (!resolved) {
            return undefined;
        }
    }
    return { workspaceRoot, resolved };
}

async function computeClusterMembers(
    sidecar: SidecarManager,
    workspaceRoot: string,
    cache: ExplanationCache,
    resolved: ResolvedFunction,
    output: vscode.OutputChannel
): Promise<{ raw: RawBlastRadiusResult; members: EnrichedMember[] }> {
    const raw = await sidecar.request<RawBlastRadiusResult>(
        'get_blast_radius',
        { file_path: resolved.relFile, name: resolved.name, line: resolved.range.start.line },
        CLUSTER_BLAST_RADIUS_TIMEOUT_MS
    );
    const members = await enrichMembers(workspaceRoot, cache, raw.nodes, output);
    return { raw, members };
}

/**
 * Call-graph-clustered rollup summary (Session 68): "what is this cluster of
 * related functions for" -- selects a cluster by call-graph proximity via
 * the sidecar's existing `get_blast_radius` walk (the function under the
 * cursor, plus its transitive upstream callers, unchanged ranking/walk logic
 * -- reused read-only), then shows whatever purpose paragraph is already
 * cached for it. This is a pure cache lookup end to end -- Core Rule 4 gives
 * the docked panel's render path no exception (unlike hover's cache-miss
 * fallback), so unlike `summaryDocGenerator.ts`'s per-file synthesis (which
 * writes to disk, never to this panel), this command never calls
 * `generate_cluster_summary` itself. When nothing's cached yet, the panel
 * shows a bare member list plus (if at least one member IS cached) a
 * "Synthesize summary" affordance that fires the separate
 * `synthesizeClusterSummary` command below -- the same "explicit action can
 * generate, the panel's own render path never does" split
 * `refreshExplanationCommand.ts`'s "Regenerate" button already established.
 *
 * Default `'interactive'` priority (Session 32's scheduling hint): an
 * on-demand user action, same shape as the existing blast-radius/
 * execution-trace commands.
 *
 * Exported separately from `registerShowClusterSummaryCommand` below for the
 * same reason `showBlastRadius`/`showCallTrace` are: tests call this
 * function directly rather than through the global command registry, since
 * `extension.ts`'s own activation already registers the real command id once
 * in the Extension Development Host every integration test runs inside.
 *
 * `target` (mirrors `showBlastRadius`/`showCallTrace`'s own param): used
 * as-is instead of re-resolving from the live cursor when supplied --
 * `ExplanationPanelProvider` passes its tracked `currentFunction` here when
 * the webview's "Show cluster summary" button fires.
 */
export async function showClusterSummary(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    panel: ExplanationPanelProvider,
    output: vscode.OutputChannel,
    target?: ResolvedFunction
): Promise<void> {
    const cache = getCache();
    const sidecar = getSidecar();
    if (!cache || !sidecar) {
        vscode.window.setStatusBarMessage('LucidHover: indexing not ready yet', 3000);
        return;
    }

    const resolvedTarget = await resolveClusterTarget(getWorkspaceRoot, target);
    if (!resolvedTarget) {
        vscode.window.setStatusBarMessage('LucidHover: no function under the cursor', 3000);
        return;
    }
    const { workspaceRoot, resolved } = resolvedTarget;

    vscode.window.setStatusBarMessage(`LucidHover: looking up cluster summary for ${resolved.name}...`, 3000);
    try {
        const { raw, members } = await computeClusterMembers(sidecar, workspaceRoot, cache, resolved, output);
        const modelId = resolveModelId();
        const rootCache = lookupRoot(cache, modelId, resolved);
        const { purpose, canSynthesize } = lookupClusterPurpose(cache, modelId, resolved, rootCache, members);

        const payload: GraphViewPayload = {
            title: `Cluster summary for ${resolved.name}`,
            direction: 'cluster',
            rootName: resolved.name,
            nodes: members.map((m) => m.node),
            edges: toGraphViewEdges(raw.edges),
            omissions: toGraphViewOmissions(raw.omissions),
            branches: [],
            purpose,
            canSynthesize,
        };
        await panel.reveal();
        panel.showGraph(payload, resolved);
    } catch (err) {
        output.appendLine(`cluster summary failed for ${resolved.fnId}: ${String(err)}`);
        vscode.window.showErrorMessage(
            `LucidHover: couldn't compute the cluster for ${resolved.name}. See the LucidHover output channel.`
        );
    }
}

/**
 * The explicit "Synthesize summary" action (Session 68, following the
 * code-reviewer's finding that generation must never happen inside
 * `showClusterSummary`'s own panel-render path): recomputes the cluster,
 * synthesizes and caches a purpose paragraph from its already-cached members
 * via `synthesizeAndCacheClusterPurpose`, then re-renders the panel with the
 * result. This IS allowed to call the LLM -- it's a separate, explicitly
 * user-triggered action, not the panel's own automatic render/lookup path,
 * the same category `refreshExplanationCommand.ts`'s "Regenerate" command
 * already occupies for per-function explanations.
 *
 * `target` -- same contract as `showClusterSummary`'s own param.
 */
export async function synthesizeClusterSummary(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    panel: ExplanationPanelProvider,
    output: vscode.OutputChannel,
    target?: ResolvedFunction
): Promise<void> {
    const cache = getCache();
    const sidecar = getSidecar();
    if (!cache || !sidecar) {
        vscode.window.setStatusBarMessage('LucidHover: indexing not ready yet', 3000);
        return;
    }

    const resolvedTarget = await resolveClusterTarget(getWorkspaceRoot, target);
    if (!resolvedTarget) {
        vscode.window.setStatusBarMessage('LucidHover: no function under the cursor', 3000);
        return;
    }
    const { workspaceRoot, resolved } = resolvedTarget;

    vscode.window.setStatusBarMessage(`LucidHover: synthesizing cluster summary for ${resolved.name}...`, 3000);
    try {
        const { raw, members } = await computeClusterMembers(sidecar, workspaceRoot, cache, resolved, output);
        const modelId = resolveModelId();
        const rootCache = lookupRoot(cache, modelId, resolved);
        const purpose = await synthesizeAndCacheClusterPurpose(sidecar, cache, modelId, resolved, rootCache, members, output);

        const payload: GraphViewPayload = {
            title: `Cluster summary for ${resolved.name}`,
            direction: 'cluster',
            rootName: resolved.name,
            nodes: members.map((m) => m.node),
            edges: toGraphViewEdges(raw.edges),
            omissions: toGraphViewOmissions(raw.omissions),
            branches: [],
            purpose,
            canSynthesize: purpose === undefined,
        };
        await panel.reveal();
        panel.showGraph(payload, resolved);
    } catch (err) {
        output.appendLine(`cluster summary synthesis failed for ${resolved.fnId}: ${String(err)}`);
        vscode.window.showErrorMessage(
            `LucidHover: couldn't synthesize the cluster summary for ${resolved.name}. See the LucidHover output channel.`
        );
        // Session 68, mirroring session 58's identical Regenerate-button
        // finding: without this, a failure here (e.g. the get_blast_radius
        // recompute, not the synthesis call itself, which always resolves
        // to a string) would leave the webview's "Synthesize summary"
        // button stuck disabled with no fresh render message to reset it.
        panel.notifySynthesizeFailed();
    }
}

export function registerShowClusterSummaryCommand(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    panel: ExplanationPanelProvider,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(SHOW_CLUSTER_SUMMARY_COMMAND_ID, (target?: ResolvedFunction) =>
        showClusterSummary(getWorkspaceRoot, getCache, getSidecar, panel, output, target)
    );
}

export function registerSynthesizeClusterSummaryCommand(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    panel: ExplanationPanelProvider,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(SYNTHESIZE_CLUSTER_SUMMARY_COMMAND_ID, (target?: ResolvedFunction) =>
        synthesizeClusterSummary(getWorkspaceRoot, getCache, getSidecar, panel, output, target)
    );
}
