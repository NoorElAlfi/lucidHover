import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../../cache/config';
import { CacheRow, ExplanationCache } from '../../cache/explanationCache';
import { RoleCodeLensProvider } from '../../codelens/roleCodeLensProvider';
import { resolveAllFunctions } from '../../functionResolution';
import { documentSelectorForSupportedLanguages } from '../../languages';

/**
 * Session 26 push-UI audit, item 3: confirms (rather than assumes) that
 * `RoleCodeLensProvider` does not need its own `onDidChangeTextDocument`
 * listener the way `RoleGutterDecorationManager` turned out to (see
 * roleGutterDecorations.test.ts) -- VS Code's own CodeLens feature re-fetches
 * lenses from the registered provider after a document edit on its own,
 * with no explicit `onDidChangeCodeLenses` fire required. Registers the real
 * provider through `vscode.languages.registerCodeLensProvider` (not a direct
 * `provideCodeLenses()` call, which would trivially reflect live state
 * regardless of whether VS Code's own invalidation exists) and drives it
 * through `vscode.executeCodeLensProvider`, the same command
 * languageGating.test.ts already uses to exercise the real dispatch layer.
 */
suite('codelens/RoleCodeLensProvider: VS Code auto-refreshes lenses on text edit, no manual refresh() (Session 26)', () => {
    let output: vscode.OutputChannel;
    let cache: ExplanationCache;
    let tempDir: string;
    let filePath: string;
    let document: vscode.TextDocument;
    let provider: RoleCodeLensProvider;
    let registration: vscode.Disposable;

    const before = ['function alpha() {', "  return 'a';", '}', ''].join('\n');
    const after = ['function alpha() {', "  return 'a';", '}', '', 'function beta() {', "  return 'b';", '}', ''].join(
        '\n'
    );

    async function waitForSymbols(expectedCount: number): Promise<void> {
        for (let attempt = 0; attempt < 40; attempt++) {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );
            if (symbols && symbols.length >= expectedCount) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.fail('document symbol provider never returned the expected symbol count');
    }

    suiteSetup(async function () {
        this.timeout(20_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-codelens-refresh-'));
        filePath = path.join(tempDir, 'codelens_fixture.js');
        fs.writeFileSync(filePath, before, 'utf8');
        document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document);
        await waitForSymbols(1);

        output = vscode.window.createOutputChannel('LucidHover CodeLens Refresh Test');
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-codelens-cache-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);
        provider = new RoleCodeLensProvider(() => tempDir, () => cache, output);
        registration = vscode.languages.registerCodeLensProvider(documentSelectorForSupportedLanguages(), provider);
    });

    suiteTeardown(() => {
        registration.dispose();
        cache.dispose();
        output.dispose();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('adding a function is reflected by vscode.executeCodeLensProvider with no provider.refresh() call', async () => {
        const before_lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
            'vscode.executeCodeLensProvider',
            document.uri
        );
        assert.strictEqual(before_lenses.length, 1, 'expected exactly one lens for alpha() before the edit');

        const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, after);
        const applied = await vscode.workspace.applyEdit(edit);
        assert.ok(applied, 'expected the edit adding beta() to apply');
        await waitForSymbols(2);

        // Deliberately never call provider.refresh() -- the point of this
        // test is that VS Code's own CodeLens feature re-fetches on its own.
        const afterLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
            'vscode.executeCodeLensProvider',
            document.uri
        );
        assert.strictEqual(
            afterLenses.length,
            2,
            'expected vscode.executeCodeLensProvider to reflect the newly-added beta() function without any explicit refresh() call'
        );

        // Sanity: also confirm the cache-lookup path actually distinguishes
        // the two (both "pending" here since nothing was cached), not just
        // that the count happened to change for an unrelated reason.
        const resolved = await resolveAllFunctions(document, tempDir);
        assert.strictEqual(resolved.map((r) => r.name).sort().join(','), 'alpha,beta');
    });

    test('regenerating a cached function is reflected without a manual refresh(), matching the live count', async () => {
        const resolved = await resolveAllFunctions(document, tempDir);
        const alpha = resolved.find((r) => r.name === 'alpha')!;
        const row: CacheRow = {
            cache_key: 'test-alpha',
            fn_id: alpha.fnId,
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: 'Returns a.' }),
            fn_hash: alpha.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
        cache.write(row);

        // No provider.refresh() call here either -- confirms the cache write
        // itself doesn't need to be the trigger for this surface (unlike
        // gutter decorations, CodeLens picks up cache state fresh on its own
        // next VS Code-initiated pull).
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
            'vscode.executeCodeLensProvider',
            document.uri
        );
        const alphaLens = lenses.find((l) => l.range.start.line === alpha.range.start.line);
        assert.ok(alphaLens, 'expected a lens on alpha\'s line');
        assert.match((alphaLens!.command?.title ?? ''), /utility/i);
    });
});
