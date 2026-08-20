import * as vscode from 'vscode';

/** Current Workspace Trust state. Hover/CodeLens registration must not depend on this; only sidecar/indexing/generation may. */
export function isWorkspaceTrusted(): boolean {
    return vscode.workspace.isTrusted;
}

/**
 * Registers a callback to run once trust is granted during this session, so callers
 * can start indexing without requiring a window reload. Returns the underlying
 * Disposable for the caller to add to extension subscriptions.
 */
export function onDidGrantWorkspaceTrust(callback: () => void): vscode.Disposable {
    return vscode.workspace.onDidGrantWorkspaceTrust(callback);
}
