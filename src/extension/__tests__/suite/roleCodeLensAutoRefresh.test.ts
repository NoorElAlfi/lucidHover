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
 *
 * Session 34 fix: `vscode.executeCodeLensProvider` aggregates lenses from
 * *every* registered provider matching the document's language, not just
 * this suite's own instance. The real extension is active in this same
 * Extension Development Host (the test workspace is `fixtures/javascript`,
 * opened trusted -- see `runTest.ts`) and registers its own
 * `RoleCodeLensProvider` globally by language, with no path/workspace
 * scoping -- so once its own background indexing finishes, it *also*
 * matches this suite's temp-dir document and contributes its own lens per
 * resolved function. That real contribution is stable for the lifetime of
 * this test (indexing completes once, well before this suite runs, and
 * never regenerates for this unrelated fnId), so assertions here are
 * written relative to whatever baseline the real provider contributes,
 * never as fixed absolute totals.
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
        // Not asserted as a fixed absolute count -- see the Session 34 class
        // doc comment: the real extension's own globally-registered
        // provider may also be contributing a lens for alpha() here.
        assert.ok(before_lenses.length >= 1, 'expected at least one lens for alpha() before the edit');

        const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, after);
        const applied = await vscode.workspace.applyEdit(edit);
        assert.ok(applied, 'expected the edit adding beta() to apply');
        await waitForSymbols(2);

        // Also confirm the cache-lookup path actually distinguishes the two
        // (both "pending" here since nothing was cached), and get beta's
        // resolved line for the content-based check below.
        const resolved = await resolveAllFunctions(document, tempDir);
        assert.strictEqual(resolved.map((r) => r.name).sort().join(','), 'alpha,beta');
        const betaLine = resolved.find((r) => r.name === 'beta')!.range.start.line;
        assert.ok(
            !before_lenses.some((l) => l.range.start.line === betaLine),
            "precondition: no lens should exist on beta's line before the edit"
        );

        // Deliberately never call provider.refresh() -- the point of this
        // test is that VS Code's own CodeLens feature re-fetches on its own.
        const afterLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
            'vscode.executeCodeLensProvider',
            document.uri
        );
        // Content-based, not a fixed count or delta on the raw total -- see
        // the Session 34 class doc comment. The real extension's own
        // globally-registered provider detects beta() independently of this
        // suite's own provider, so the total can grow by more than one lens
        // (one per active provider) -- what matters is that a lens now
        // exists on beta's line where none did before, proving VS Code
        // re-fetched from the registered provider(s) without any explicit
        // refresh() call.
        assert.ok(
            afterLenses.some((l) => l.range.start.line === betaLine),
            'expected vscode.executeCodeLensProvider to reflect the newly-added beta() function without any explicit refresh() call'
        );
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
        // Filtered by line, then checked with .some() rather than .find() +
        // a single assertion -- the real extension's own globally-registered
        // provider (see the Session 34 class doc comment) may also produce a
        // lens on this exact line (its own cache has no row for this fnId,
        // so it would show the neutral "pending" title, not "utility").
        // .find() would flakily grab whichever of the two came first.
        const lensesOnAlphaLine = lenses.filter((l) => l.range.start.line === alpha.range.start.line);
        assert.ok(lensesOnAlphaLine.length > 0, "expected at least one lens on alpha's line");
        assert.ok(
            lensesOnAlphaLine.some((l) => /utility/i.test(l.command?.title ?? '')),
            'expected one of the lenses on alpha\'s line to reflect the newly-cached "utility" role'
        );
    });
});
