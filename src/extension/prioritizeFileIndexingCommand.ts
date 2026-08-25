import * as vscode from 'vscode';
import { ExplanationCache } from './cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from './cache/config';
import { relFileFor, resolveAllFunctions } from './functionResolution';
import { generateAndCache } from './generation';
import { isSupportedLanguageId } from './languages';
import { SidecarManager } from './sidecar/sidecarManager';

export const PRIORITIZE_FILE_INDEXING_COMMAND_ID = 'lucidhover.prioritizeFileIndexing';

/**
 * Session 54: lets a user viewing a file jump its uncached functions to the
 * front of the indexing queue instead of waiting on `BackgroundIndexManager`'s
 * whole-repo PageRank walk to reach them. Deliberately does not touch or
 * reorder `BackgroundIndexManager.run()`'s own ranked array -- that's fixed
 * for the lifetime of one pass -- this is a separate, small, immediate,
 * file-scoped generate pass instead.
 *
 * Resolves the file's functions the same way `SaveReindexManager.reindex()`
 * does (`resolveAllFunctions`), but -- unlike `SaveReindexManager`, which
 * unconditionally regenerates everything in a saved file -- filters to only
 * functions where `cache.lookup()` finds nothing, the same skip-if-cached
 * pattern `BackgroundIndexManager`'s own loop uses. Each generation still
 * waits on `sidecar.waitForInteractiveIdle()` first, the same deference to
 * real interactive traffic (hover-miss/save-reindex/refresh) the main
 * background pass gives it, and passes `'background'` priority to
 * `generateAndCache` for the same reason `BackgroundIndexManager` does --
 * this is indexing work the user reordered, not a single-function
 * interactive action like "Refresh Explanation".
 *
 * This does NOT call `reindex_file` first -- unlike `SaveReindexManager`,
 * there's no changed source to re-parse into the call graph here, only
 * already-current functions the background pass hasn't reached yet.
 *
 * Not mutually exclusive with `BackgroundIndexManager`'s own pass: both are
 * `'background'` priority, so `waitForInteractiveIdle()` (which only tracks
 * *interactive* pending requests) does nothing to serialize them against each
 * other. If both reach the same function around the same time, it can be
 * redundantly generated twice -- the same accepted interactive-vs-background
 * race Core Rule 11 / session 37's artifact already documents, not a new
 * problem this command needs to solve.
 *
 * `document` (optional), when supplied, is used as-is instead of resolving
 * from the live active editor -- lets tests exercise this directly without
 * needing to make a document the active editor first. Left undefined for a
 * real command invocation (editor context menu or Command Palette), which
 * always operates on whatever's currently open.
 *
 * The `isSupportedLanguageId` check below is still needed even though
 * package.json's own `editor/context` menu entry is itself gated by
 * `resourceLangId` (kept in sync with languages.json by a drift test,
 * mirroring session-21's `activationEvents` precedent) -- Command Palette
 * invocation has no per-language `when` clause to filter on, so this is the
 * only gate a palette invocation against an unsupported file ever gets.
 */
export async function prioritizeFileIndexing(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    output: vscode.OutputChannel,
    document?: vscode.TextDocument
): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    const cache = getCache();
    const sidecar = getSidecar();
    if (!workspaceRoot || !cache || !sidecar) {
        vscode.window.setStatusBarMessage('LucidHover: indexing not ready yet', 3000);
        return;
    }

    const doc = document ?? vscode.window.activeTextEditor?.document;
    if (!doc) {
        vscode.window.setStatusBarMessage('LucidHover: no active editor', 3000);
        return;
    }
    if (!isSupportedLanguageId(doc.languageId)) {
        vscode.window.setStatusBarMessage('LucidHover: unsupported file type', 3000);
        return;
    }

    const relFile = relFileFor(doc, workspaceRoot);
    const functions = await resolveAllFunctions(doc, workspaceRoot);
    const targets = functions.filter(
        (fn) =>
            !cache.lookup({
                fnId: fn.fnId,
                fnHash: fn.fnHash,
                modelId: resolveModelId(),
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: PROMPT_VERSION,
            })
    );

    if (targets.length === 0) {
        vscode.window.setStatusBarMessage(`LucidHover: ${relFile} is already fully indexed`, 3000);
        return;
    }

    output.appendLine(`prioritize-file-indexing: ${relFile} -- ${targets.length} uncached function(s) to generate`);
    vscode.window.setStatusBarMessage(
        `LucidHover: prioritizing ${targets.length} function(s) in ${relFile}...`,
        3000
    );

    let generated = 0;
    for (const fn of targets) {
        await sidecar.waitForInteractiveIdle();
        try {
            await generateAndCache(sidecar, cache, fn, 'background');
            generated++;
        } catch (err) {
            output.appendLine(`prioritize-file-indexing: generate_explanation failed for ${fn.fnId}: ${String(err)}`);
        }
    }

    output.appendLine(`prioritize-file-indexing: ${relFile} done -- ${generated}/${targets.length} generated`);
    vscode.window.setStatusBarMessage(`LucidHover: prioritized indexing done for ${relFile}`, 3000);
}

export function registerPrioritizeFileIndexingCommand(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(PRIORITIZE_FILE_INDEXING_COMMAND_ID, () =>
        prioritizeFileIndexing(getWorkspaceRoot, getCache, getSidecar, output)
    );
}
