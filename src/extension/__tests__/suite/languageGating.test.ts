import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Session 22 item 4: a file whose language has no adapter (languages.json
 * originally had exactly one entry, "javascript" -- everything else was "no
 * adapter", including "python") must get nothing from every provider -- not
 * an empty/placeholder hover or lens, no invocation at all.
 *
 * Session 91: python gained a real adapter, so it can no longer serve as
 * this test's "unsupported language" probe -- ruby (still absent from
 * languages.json) takes over. Every fixture directory carries its own
 * `sample.rb` copy (same content, see fixtures/REQUIREMENTS.md), the same
 * convention `sample.py` followed before this session.
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
        document = await vscode.workspace.openTextDocument(path.join(workspaceRoot, 'sample.rb'));
        assert.strictEqual(document.languageId, 'ruby', 'expected VS Code to assign the ruby language id to sample.rb');
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
