/**
 * Session 58: regression coverage for a real user report -- clicking a
 * used-by/calls row in the panel (which forwards to
 * `lucidhover.navigateToFunction`, registered by
 * `registerNavigateToFunctionCommand`) navigated the editor correctly but
 * sometimes left the docked panel showing the previous explanation. Root
 * cause: this command sets `editor.selection` directly, and the panel's
 * cursor-sync relies on `onDidChangeTextEditorSelection` firing -- which VS
 * Code does not do when the selection it's given happens to already match
 * what the editor had (e.g. the cursor already sitting at, or having
 * recently visited, the navigation target). The fix threads a `refreshPanel`
 * callback into the command, called explicitly after every successful
 * navigation instead of relying on that event.
 *
 * This suite doesn't attempt to reproduce the exact no-op-selection VS Code
 * behavior itself (already reproduced and confirmed once for the sibling
 * "Back to caller" fix in explanationPanelProvider.test.ts) -- it locks in
 * the simpler, directly-testable contract: a successful navigation, via
 * either resolution branch, always calls `refreshPanel()` exactly once.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { navigateToFunction } from '../../panel/explanationPanelProvider';

suite('navigateToFunction refreshPanel callback (Session 58)', () => {
    let tempDir: string;
    let output: vscode.OutputChannel;

    async function waitForSymbols(document: vscode.TextDocument): Promise<void> {
        for (let attempt = 0; attempt < 40; attempt++) {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );
            if (symbols && symbols.length > 0) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.fail(`document symbol provider never returned symbols for ${document.uri.fsPath}`);
    }

    const targetContent = 'function caller() {\n  return target();\n}\n\nfunction target() {\n  return 1;\n}\n';

    suiteSetup(async function () {
        this.timeout(30_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-navigate-refresh-'));
        fs.writeFileSync(path.join(tempDir, 'target.js'), targetContent, 'utf8');
        output = vscode.window.createOutputChannel('LucidHover Navigate Refresh Test');
    });

    suiteTeardown(function () {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('refreshPanel is called after a successful navigation via the workspace-symbol fallback (no sidecar)', async () => {
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        await waitForSymbols(document);
        await vscode.window.showTextDocument(document);

        const refreshPanel = sinon.stub();
        // No sidecar -- forces the workspace-symbol-provider fallback branch.
        await navigateToFunction('target', () => tempDir, () => undefined, refreshPanel, output);

        assert.strictEqual(refreshPanel.calledOnce, true, 'expected refreshPanel to be called exactly once after a successful navigation');
    });

    test('refreshPanel is NOT called when no matching symbol is found', async () => {
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        await waitForSymbols(document);
        await vscode.window.showTextDocument(document);

        const refreshPanel = sinon.stub();
        await navigateToFunction('thisFunctionDoesNotExistAnywhere', () => tempDir, () => undefined, refreshPanel, output);

        assert.strictEqual(refreshPanel.called, false, 'expected refreshPanel not to be called when navigation fails to resolve');
    });
});
