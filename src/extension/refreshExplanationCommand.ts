import * as vscode from 'vscode';
import { ExplanationCache } from './cache/explanationCache';
import { resolveEnclosingFunction } from './functionResolution';
import { generateAndCache } from './generation';
import { ExplanationPanelProvider } from './panel/explanationPanelProvider';
import { SidecarManager } from './sidecar/sidecarManager';

export const REFRESH_COMMAND_ID = 'lucidhover.refreshExplanation';

/**
 * Manual refresh (Session 8 / Build Order step 8): the safety-valve trigger
 * from the spec's "Handling Active Development" table ("Manual full
 * re-index | Command palette, rare | Full rebuild -- safety valve only").
 * v0 scopes it to the single function under the cursor, not a full repo
 * rebuild -- resolves the enclosing function and calls `generateAndCache`
 * *unconditionally*, skipping the `cache.lookup` hash check entirely, so it
 * regenerates even when `fn_hash` still matches the cached row. This is the
 * one path in the extension that deliberately bypasses hash-based
 * invalidation, matching Core Design Decision #5 ("never silently
 * regenerate -- only on hash invalidation or explicit refresh").
 */
export function registerRefreshExplanationCommand(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    panel: ExplanationPanelProvider,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(REFRESH_COMMAND_ID, async () => {
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

        vscode.window.setStatusBarMessage(`LucidHover: refreshing ${resolved.name}...`, 3000);
        output.appendLine(`manual refresh: forcing regeneration for ${resolved.fnId}`);
        try {
            const row = await generateAndCache(sidecar, cache, resolved);
            vscode.window.setStatusBarMessage(`LucidHover: refreshed ${resolved.name}`, 3000);
            // Convenience, not required by the spec: if the panel is
            // currently displaying this function, push the new row so it
            // doesn't show stale content until the next cursor move.
            panel.showRow(row);
        } catch (err) {
            output.appendLine(`manual refresh failed for ${resolved.fnId}: ${String(err)}`);
            vscode.window.showErrorMessage(`LucidHover: refresh failed for ${resolved.name}. See the LucidHover output channel.`);
        }
    });
}
