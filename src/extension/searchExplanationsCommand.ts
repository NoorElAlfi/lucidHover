import * as path from 'path';
import * as vscode from 'vscode';
import { ExplanationCache } from './cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from './cache/config';
import { resolveFunctionsInFile } from './functionResolution';

export const SEARCH_EXPLANATIONS_COMMAND_ID = 'lucidhover.searchExplanations';

interface SearchExplanationItem extends vscode.QuickPickItem {
    fnId: string;
    relFname: string;
}

/**
 * `fn_id` is `"${relFname}::${qualifiedName}"` (cache/hash.ts's
 * `computeFnId`), not a hash -- reversible without a sidecar round trip or a
 * full-repo resolve. Used here to recover a search result's file and
 * (enclosing-scope-qualified) display name straight from the cache row.
 */
function parseFnId(fnId: string): { relFname: string; qualifiedName: string } {
    const idx = fnId.indexOf('::');
    if (idx === -1) {
        return { relFname: fnId, qualifiedName: fnId };
    }
    return { relFname: fnId.slice(0, idx), qualifiedName: fnId.slice(idx + 2) };
}

/**
 * "LucidHover: Search Explanations" (Session 56) -- fuzzy-searches every
 * cached explanation by name or one-liner via a `QuickPick` (VS Code filters
 * both `label`/`description`/`detail` natively; no hand-rolled matching
 * needed).
 *
 * Backed by `ExplanationCache.listCurrentRows()`, a new read-only query
 * following the exact "current row" definition Session 39 established
 * (`currentRowForFnIdStmt`: `ORDER BY generated_at DESC, rowid DESC`, one row
 * per fn_id under the live model/embedding/prompt tuple) so a function with
 * more than one cached generation only ever shows its live row, never a
 * superseded duplicate.
 *
 * Pure cache read -- no sidecar call at all, unlike
 * `showMostImportantFunctionsCommand.ts`'s `list_ranked_functions` call. The
 * listing itself needs no per-row resolve (role_tag/one_liner come straight
 * from `explanation_json`); resolving a real location only happens once, for
 * whichever single result the user actually picks, via
 * `resolveFunctionsInFile` + an exact `fnId` match (not the nearest-line
 * tolerance `blastRadiusCommand.ts`'s `closestResolved` needs for the
 * sidecar's bare tree-sitter coordinates -- a cache row's `fn_id` already
 * came from this same extension host's own `computeFnId`, so it either
 * matches exactly or the function has moved/been removed since).
 *
 * `refreshPanel` (found by session 58's code-reviewer pass, fixed here): the
 * same explicit-refresh-after-setting-selection fix session 58 applied to
 * `navigateToFunction`/`navigateToLocation` in explanationPanelProvider.ts --
 * `onDidChangeTextEditorSelection` doesn't fire when the selection this
 * function sets already matches what the editor had, so the docked panel's
 * cursor-sync refresh can't be relied on alone after picking a function whose
 * location the cursor was already at (or had recently visited).
 */
export async function searchExplanations(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    refreshPanel: () => void,
    output: vscode.OutputChannel
): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    const cache = getCache();
    if (!workspaceRoot || !cache) {
        vscode.window.setStatusBarMessage('LucidHover: indexing not ready yet', 3000);
        return;
    }

    const rows = cache.listCurrentRows({
        modelId: resolveModelId(),
        embeddingModelId: EMBEDDING_MODEL_ID,
        promptVersion: PROMPT_VERSION,
    });
    if (rows.length === 0) {
        vscode.window.setStatusBarMessage('LucidHover: no cached explanations yet', 3000);
        return;
    }

    const items: SearchExplanationItem[] = rows.map((row) => {
        const { relFname, qualifiedName } = parseFnId(row.fn_id);
        const explanation = JSON.parse(row.explanation_json) as { role_tag?: unknown; one_liner?: unknown };
        const roleTag = typeof explanation.role_tag === 'string' ? explanation.role_tag : undefined;
        const oneLiner = typeof explanation.one_liner === 'string' ? explanation.one_liner : undefined;
        return {
            label: qualifiedName,
            description: relFname,
            detail: [roleTag, oneLiner].filter(Boolean).join(' — ') || undefined,
            fnId: row.fn_id,
            relFname,
        };
    });
    items.sort((a, b) => a.label.localeCompare(b.label));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Search cached explanations by name or description',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!picked) {
        return;
    }

    const candidates = await resolveFunctionsInFile(workspaceRoot, picked.relFname, output);
    const match = candidates.find((c) => c.fnId === picked.fnId);
    if (!match) {
        vscode.window.showWarningMessage(
            `LucidHover: couldn't find ${picked.label} in ${picked.relFname} anymore -- it may have moved or been removed.`
        );
        return;
    }

    const uri = vscode.Uri.file(path.join(workspaceRoot, picked.relFname));
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = match.range.start;
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(match.range, vscode.TextEditorRevealType.InCenter);
    refreshPanel();
}

export function registerSearchExplanationsCommand(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    refreshPanel: () => void,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(SEARCH_EXPLANATIONS_COMMAND_ID, () =>
        searchExplanations(getWorkspaceRoot, getCache, refreshPanel, output)
    );
}
