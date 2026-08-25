/**
 * Session 56: no real sidecar process needed -- `sidecar.request` is stubbed
 * directly on a real (but never `.start()`ed) `SidecarManager` instance, same
 * "stub the instance method, don't spawn a real process" approach
 * `prioritizeFileIndexingCommand.test.ts` uses for the identical class of
 * command (list_ranked_functions correctness itself is already covered by
 * `sidecar/tests/test_list_ranked_functions.py`; this only needs to prove the
 * extension-host side -- enrichment, ordering, and navigation).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../../cache/config';
import { CacheRow, ExplanationCache } from '../../cache/explanationCache';
import { resolveAllFunctions } from '../../functionResolution';
import { SidecarManager } from '../../sidecar/sidecarManager';
import { showMostImportantFunctions } from '../../showMostImportantFunctionsCommand';

suite('showMostImportantFunctionsCommand (Session 56)', () => {
    let tempDir: string;
    let output: vscode.OutputChannel;
    let sandbox: sinon.SinonSandbox;
    let cache: ExplanationCache;
    let sidecar: SidecarManager;

    function findExtensionRoot(): string {
        const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'lucidhover');
        assert.ok(ext, 'expected the lucidhover extension to be loaded under test');
        return ext!.extensionPath;
    }

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

    const fileContent = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n\nfunction c() {\n  return 3;\n}\n';

    suiteSetup(async function () {
        this.timeout(30_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-show-important-'));
        fs.writeFileSync(path.join(tempDir, 'file.js'), fileContent, 'utf8');
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'file.js'));
        await waitForSymbols(document);
        output = vscode.window.createOutputChannel('LucidHover Show Most Important Test');
    });

    suiteTeardown(function () {
        // maxRetries/retryDelay -- see searchExplanationsCommand.test.ts's
        // identical suiteTeardown comment: this suite's own tests open a
        // real (non-preview) editor via the command's showTextDocument call
        // too, and Windows can briefly hold the file handle open past the
        // test that opened it.
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-show-important-cache-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);
        sidecar = new SidecarManager(tempDir, findExtensionRoot(), '', 'all-minilm', 'http://localhost:11434', output);
    });

    teardown(() => {
        cache.dispose();
        sandbox.restore();
    });

    test('lists functions in list_ranked_functions order, enriches only the cached one, and navigates to the pick', async function () {
        this.timeout(20_000);

        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'file.js'));
        const functions = await resolveAllFunctions(document, tempDir);
        const a = functions.find((f) => f.name === 'a');
        const b = functions.find((f) => f.name === 'b');
        const c = functions.find((f) => f.name === 'c');
        assert.ok(a && b && c, 'expected to resolve a(), b(), c()');

        // Seed a cached row for b() only -- a() and c() are uncached, and
        // must never be generated on the fly to fill their entry in.
        const row: CacheRow = {
            cache_key: 'test-key-b',
            fn_id: b!.fnId,
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: 'Returns 2.' }),
            fn_hash: b!.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
        cache.write(row);

        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({
            functions: [
                { rel_fname: 'file.js', name: 'b', line: b!.range.start.line, importance: 3.0 },
                { rel_fname: 'file.js', name: 'a', line: a!.range.start.line, importance: 2.0 },
                { rel_fname: 'file.js', name: 'c', line: c!.range.start.line, importance: 1.0 },
            ],
        });

        let capturedItems: vscode.QuickPickItem[] = [];
        sandbox.stub(vscode.window, 'showQuickPick').callsFake(async (items) => {
            capturedItems = (await items) as vscode.QuickPickItem[];
            return capturedItems.find((i) => i.label === 'a');
        });

        await showMostImportantFunctions(() => tempDir, () => cache, () => sidecar, output);

        assert.deepStrictEqual(
            capturedItems.map((i) => i.label),
            ['b', 'a', 'c'],
            'expected the quick pick to preserve list_ranked_functions ranked (importance-descending) order'
        );
        assert.strictEqual(capturedItems[0].detail, 'utility — Returns 2.', "expected b's detail to show its cached role_tag/one_liner");
        assert.strictEqual(capturedItems[1].detail, 'not yet indexed', "expected a's detail to show the not-yet-indexed placeholder");
        assert.strictEqual(capturedItems[2].detail, 'not yet indexed', "expected c's detail to show the not-yet-indexed placeholder");

        assert.strictEqual(
            requestStub.getCalls().some((call) => call.args[0] === 'generate_explanation'),
            false,
            'must never generate to fill an uncached entry in (Core Rule 4/9)'
        );

        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'expected an editor to be opened for the picked function');
        assert.strictEqual(path.basename(editor!.document.uri.fsPath), 'file.js');
        assert.strictEqual(editor!.selection.active.line, a!.range.start.line, "expected the cursor at a()'s line");
    });

    test('is a no-op (status message, no throw) when indexing is not ready', async function () {
        this.timeout(20_000);
        await showMostImportantFunctions(() => undefined, () => undefined, () => undefined, output);
    });

    test('shows a status message and never opens the quick pick when the repo has no indexed functions', async function () {
        this.timeout(20_000);
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({ functions: [] });
        const quickPickStub = sandbox.stub(vscode.window, 'showQuickPick');

        await showMostImportantFunctions(() => tempDir, () => cache, () => sidecar, output);

        assert.strictEqual(quickPickStub.called, false, 'expected no quick pick for an empty ranking');
    });
});
