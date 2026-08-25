import * as path from 'path';
import * as vscode from 'vscode';
import { ExplanationCache } from './cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from './cache/config';
import { resolveFunctionsInFile, ResolvedFunction } from './functionResolution';
import { SidecarManager } from './sidecar/sidecarManager';

export const SHOW_MOST_IMPORTANT_FUNCTIONS_COMMAND_ID = 'lucidhover.showMostImportantFunctions';

/** How many of the whole-repo PageRank ranking to offer -- a reasonable
 * default browse size, not a hard architectural limit. */
const TOP_N = 20;

// Graph-only, no LLM call (same reasoning as blastRadiusCommand.ts's
// BLAST_RADIUS_TIMEOUT_MS) -- list_ranked_functions is a read over the
// already-indexed repo, but still more work than status/resolve_function on
// a real-sized repo, so it gets its own generous-but-bounded budget rather
// than the default 4s interactive timeout.
const LIST_RANKED_TIMEOUT_MS = 15_000;

interface RankedFunction {
    rel_fname: string;
    name: string;
    line: number;
    importance: number;
}

interface RankedFunctionItem extends vscode.QuickPickItem {
    relFname: string;
    line: number;
}

/** Same nearest-line tolerance blastRadiusCommand.ts's own `closestResolved`
 * uses for the identical "bare rel_fname/name/line -> real ResolvedFunction"
 * problem -- the sidecar's tree-sitter def line and VS Code's document-symbol
 * line don't always agree exactly. */
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
 * "LucidHover: Show Most Important Functions" (Session 56) -- browses the
 * sidecar's whole-repo PageRank ranking (`list_ranked_functions`, already
 * sorted by importance descending -- the same ranking
 * `BackgroundIndexManager`/`summaryDocGenerator.ts` already walk, no new
 * ranker) via a `QuickPick`, the first use of that API in this codebase.
 *
 * Each entry is enriched with its cached role_tag/one_liner if one exists,
 * using the same per-file-memoized `resolveFunctionsInFile` +
 * `closestResolved` cache-lookup pattern `blastRadiusCommand.ts`'s
 * `enrichNodes` already uses for turning a bare sidecar (rel_fname, name,
 * line) into a real fnId/fnHash -- never generates on a miss (Core Rule 4/9),
 * an unindexed entry just shows a "not yet indexed" detail line.
 *
 * Navigation on pick opens directly via `showTextDocument` + `revealRange` at
 * the sidecar's own exact rel_fname/line, rather than routing through
 * `lucidhover.navigateToFunction`'s bare-name `resolve_function` resolution
 * -- that command exists to disambiguate an arbitrary name string with no
 * known location (e.g. a caller/callee name from an explanation), which
 * isn't the situation here.
 */
export async function showMostImportantFunctions(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    output: vscode.OutputChannel
): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    const cache = getCache();
    const sidecar = getSidecar();
    if (!workspaceRoot || !cache || !sidecar) {
        vscode.window.setStatusBarMessage('LucidHover: indexing not ready yet', 3000);
        return;
    }

    let ranked: RankedFunction[];
    try {
        const result = await sidecar.request<{ functions: RankedFunction[] }>(
            'list_ranked_functions',
            {},
            LIST_RANKED_TIMEOUT_MS
        );
        ranked = result.functions;
    } catch (err) {
        output.appendLine(`show-most-important-functions: list_ranked_functions failed: ${String(err)}`);
        vscode.window.showErrorMessage(
            "LucidHover: couldn't list ranked functions. See the LucidHover output channel."
        );
        return;
    }

    const top = ranked.slice(0, TOP_N);
    if (top.length === 0) {
        vscode.window.setStatusBarMessage('LucidHover: no indexed functions found', 3000);
        return;
    }

    const root = workspaceRoot;
    const resolvedByFile = new Map<string, ResolvedFunction[]>();
    async function resolvedFor(relFname: string): Promise<ResolvedFunction[]> {
        let resolved = resolvedByFile.get(relFname);
        if (!resolved) {
            resolved = await resolveFunctionsInFile(root, relFname, output);
            resolvedByFile.set(relFname, resolved);
        }
        return resolved;
    }

    const items: RankedFunctionItem[] = [];
    for (const fn of top) {
        const candidates = await resolvedFor(fn.rel_fname);
        const match = closestResolved(candidates, fn.name, fn.line);
        let detail = 'not yet indexed';
        if (match) {
            const row = cache.lookup({
                fnId: match.fnId,
                fnHash: match.fnHash,
                modelId: resolveModelId(),
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: PROMPT_VERSION,
            });
            if (row) {
                const explanation = JSON.parse(row.explanation_json) as { role_tag?: unknown; one_liner?: unknown };
                const roleTag = typeof explanation.role_tag === 'string' ? explanation.role_tag : undefined;
                const oneLiner = typeof explanation.one_liner === 'string' ? explanation.one_liner : undefined;
                detail = [roleTag, oneLiner].filter(Boolean).join(' — ') || 'not yet indexed';
            }
        }
        items.push({
            label: fn.name,
            description: `${fn.rel_fname}:${fn.line + 1}`,
            detail,
            relFname: fn.rel_fname,
            line: fn.line,
        });
    }

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Most important functions in this workspace (by call-graph rank)',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!picked) {
        return;
    }

    const uri = vscode.Uri.file(path.join(workspaceRoot, picked.relFname));
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = new vscode.Position(picked.line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

export function registerShowMostImportantFunctionsCommand(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(SHOW_MOST_IMPORTANT_FUNCTIONS_COMMAND_ID, () =>
        showMostImportantFunctions(getWorkspaceRoot, getCache, getSidecar, output)
    );
}
