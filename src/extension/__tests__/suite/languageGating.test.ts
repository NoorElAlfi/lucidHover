import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Session 22 item 4: a file whose language has no adapter (languages.json
 * has exactly one entry, "javascript" -- everything else is "no adapter"
 * today, including "python") must get nothing from every provider -- not an
 * empty/placeholder hover or lens, no invocation at all.
 *
 * Exercised through VS Code's own `vscode.execute*Provider` commands rather
 * than calling `ExplanationHoverProvider`/`RoleCodeLensProvider` directly,
 * so this proves the real `DocumentSelector` built from
 * `documentSelectorForSupportedLanguages()` (extension.ts) actually excludes
 * an unsupported language at VS Code's own dispatch layer, not merely that
 * the provider classes happen to return empty when called.
 */
suite('language gating: no adapter for an unsupported language (Session 22)', () => {
    let document: vscode.TextDocument;

    suiteSetup(async () => {
        const folders = vscode.workspace.workspaceFolders;
        assert.ok(folders && folders.length > 0, 'expected the fixture repo to be open as the test workspace');
        const workspaceRoot = folders[0].uri.fsPath;
        document = await vscode.workspace.openTextDocument(path.join(workspaceRoot, 'sample.py'));
        assert.strictEqual(document.languageId, 'python', 'expected VS Code to assign the python language id to sample.py');
    });

    test('hover: vscode.executeHoverProvider returns nothing', async () => {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            document.uri,
            new vscode.Position(4, 4)
        );
        assert.strictEqual(hovers.length, 0);
    });

    test('codelens: vscode.executeCodeLensProvider returns nothing', async () => {
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
            'vscode.executeCodeLensProvider',
            document.uri
        );
        assert.strictEqual(lenses.length, 0);
    });
});
