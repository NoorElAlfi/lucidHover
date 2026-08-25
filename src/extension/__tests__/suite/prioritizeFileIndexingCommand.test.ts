/**
 * Session 54: no real sidecar process or Ollama needed -- `sidecar.request`/
 * `waitForInteractiveIdle` are stubbed directly on a real (but never
 * `.start()`ed) `SidecarManager` instance, same "stub the instance method,
 * don't spawn a real process" approach `backgroundIndex.test.ts` uses for the
 * identical class of pass (a generate loop over several resolved functions).
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
import { prioritizeFileIndexing } from '../../prioritizeFileIndexingCommand';
import { SidecarManager } from '../../sidecar/sidecarManager';

suite('prioritizeFileIndexingCommand (Session 54)', () => {
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
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-prioritize-'));
        fs.writeFileSync(path.join(tempDir, 'file.js'), fileContent, 'utf8');
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'file.js'));
        await waitForSymbols(document);
        output = vscode.window.createOutputChannel('LucidHover Prioritize File Test');
    });

    suiteTeardown(function () {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-prioritize-cache-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);
        sidecar = new SidecarManager(tempDir, findExtensionRoot(), '', 'all-minilm', 'http://localhost:11434', output);
    });

    teardown(() => {
        cache.dispose();
        sandbox.restore();
    });

    test('generates only the uncached functions, skipping ones already cached', async function () {
        this.timeout(20_000);

        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'file.js'));
        const functions = await resolveAllFunctions(document, tempDir);
        const a = functions.find((f) => f.name === 'a');
        const b = functions.find((f) => f.name === 'b');
        const c = functions.find((f) => f.name === 'c');
        assert.ok(a && b && c, 'expected to resolve a(), b(), c()');

        // Seed a cached row for b() only -- a() and c() are uncached.
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

        const idleStub = sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('generate_explanation').callsFake(async (_method: string, rawParams: unknown) => {
            const params = rawParams as { name: string };
            return {
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: `explained ${params.name}` },
            };
        });

        await prioritizeFileIndexing(() => tempDir, () => cache, () => sidecar, output, document);

        const generateCalls = requestStub.getCalls().filter((call) => call.args[0] === 'generate_explanation');
        assert.strictEqual(generateCalls.length, 2, 'expected exactly 2 generate_explanation calls (a and c, not b)');
        const generatedNames = generateCalls.map((call) => (call.args[1] as { name: string }).name).sort();
        assert.deepStrictEqual(generatedNames, ['a', 'c']);

        assert.strictEqual(
            idleStub.callCount,
            2,
            'expected waitForInteractiveIdle before each of the 2 generations, same deference the main background pass gives interactive traffic'
        );

        const lookup = (fn: { fnId: string; fnHash: string }) =>
            cache.lookup({
                fnId: fn.fnId,
                fnHash: fn.fnHash,
                modelId: resolveModelId(),
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: PROMPT_VERSION,
            });
        assert.ok(lookup(a!), 'expected a() to now be cached');
        assert.ok(lookup(c!), 'expected c() to now be cached');
    });

    test('is a no-op (no generate_explanation calls) when every function is already cached', async function () {
        this.timeout(20_000);

        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'file.js'));
        const functions = await resolveAllFunctions(document, tempDir);
        for (const fn of functions) {
            cache.write({
                cache_key: `test-key-${fn.name}`,
                fn_id: fn.fnId,
                explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: `Explains ${fn.name}.` }),
                fn_hash: fn.fnHash,
                context_hash: 'ctx',
                model_id: resolveModelId(),
                embedding_model_id: EMBEDDING_MODEL_ID,
                prompt_version: PROMPT_VERSION,
                context_tier: 'call_graph_only',
                generated_at: new Date().toISOString(),
            });
        }

        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        const requestStub = sandbox.stub(sidecar, 'request');

        await prioritizeFileIndexing(() => tempDir, () => cache, () => sidecar, output, document);

        assert.strictEqual(
            requestStub.getCalls().filter((call) => call.args[0] === 'generate_explanation').length,
            0,
            'expected zero generate_explanation calls when everything is already cached'
        );
    });

    test('is a no-op when indexing is not ready (no cache/sidecar)', async function () {
        this.timeout(20_000);

        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'file.js'));
        // Should not throw even though workspaceRoot/cache/sidecar all resolve to undefined.
        await prioritizeFileIndexing(() => undefined, () => undefined, () => undefined, output, document);
    });

    test('is a no-op for an unsupported language', async function () {
        this.timeout(20_000);

        const plainTextPath = path.join(tempDir, 'notes.txt');
        fs.writeFileSync(plainTextPath, 'just some notes', 'utf8');
        const document = await vscode.workspace.openTextDocument(plainTextPath);

        const requestStub = sandbox.stub(sidecar, 'request');
        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();

        await prioritizeFileIndexing(() => tempDir, () => cache, () => sidecar, output, document);

        assert.strictEqual(
            requestStub.getCalls().filter((call) => call.args[0] === 'generate_explanation').length,
            0,
            'expected zero generate_explanation calls for an unsupported language document'
        );
    });
});
