import * as vscode from 'vscode';
import { ExplanationCache } from './cache/explanationCache';
import { DirtyTracker } from './dirtyTracking';
import { resolveEnclosingFunction, ResolvedFunction } from './functionResolution';
import { generateAndCache } from './generation';
import { ExplanationPanelProvider, REFRESH_COMMAND_ID } from './panel/explanationPanelProvider';
import { SidecarManager } from './sidecar/sidecarManager';
import { StaleTracker } from './staleTracking';

export { REFRESH_COMMAND_ID };

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
 *
 * Session 13: this is also the "explicit refresh" the spec's dirty/stale
 * badge model names as the other way (besides a hash-invalidated
 * regeneration) a function's freshness state clears -- a successful refresh
 * clears both `dirty` (the function was just regenerated from its current,
 * live source) and `stale` (its own row is current again, whatever an
 * upstream dependency did).
 *
 * `target` (Session 55), when supplied, is used as-is instead of re-resolving
 * from the live cursor -- same `showBlastRadius`/`showCallTrace` pattern from
 * Session 52: `ExplanationPanelProvider` passes its own `currentFunction`
 * here when the webview's "Regenerate" button fires, so the refresh targets
 * whatever the panel is actually showing rather than wherever the cursor has
 * since moved to. Left undefined for a plain Command Palette invocation,
 * which still needs live-cursor resolution.
 */
export async function refreshExplanation(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    getDirtyTracker: () => DirtyTracker | undefined,
    getStaleTracker: () => StaleTracker | undefined,
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

    vscode.window.setStatusBarMessage(`LucidHover: refreshing ${resolved.name}...`, 3000);
    output.appendLine(`manual refresh: forcing regeneration for ${resolved.fnId}`);
    try {
        const row = await generateAndCache(sidecar, cache, resolved);
        vscode.window.setStatusBarMessage(`LucidHover: refreshed ${resolved.name}`, 3000);
        getDirtyTracker()?.clearFnId(resolved.relFile, resolved.fnId);
        getStaleTracker()?.clearFnId(resolved.relFile, resolved.fnId);
        // Convenience, not required by the spec: if the panel is
        // currently displaying this function, push the new row so it
        // doesn't show stale content until the next cursor move.
        panel.showRow(row);
    } catch (err) {
        output.appendLine(`manual refresh failed for ${resolved.fnId}: ${String(err)}`);
        vscode.window.showErrorMessage(`LucidHover: refresh failed for ${resolved.name}. See the LucidHover output channel.`);
        // Session 58, code-reviewer finding: without this, a regenerate
        // triggered from the panel's own Regenerate button left it stuck
        // disabled with a spinning icon on failure -- only a successful
        // regeneration's showRow() call above ever cleared that busy state.
        panel.notifyRegenerateFailed();
    }
}

export function registerRefreshExplanationCommand(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    getDirtyTracker: () => DirtyTracker | undefined,
    getStaleTracker: () => StaleTracker | undefined,
    panel: ExplanationPanelProvider,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(REFRESH_COMMAND_ID, (target?: ResolvedFunction) =>
        refreshExplanation(getWorkspaceRoot, getCache, getSidecar, getDirtyTracker, getStaleTracker, panel, output, target)
    );
}
