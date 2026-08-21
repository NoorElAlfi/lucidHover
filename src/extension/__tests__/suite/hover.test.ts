/**
 * Core Rule 4 ("hover is a cache lookup only -- never call an LLM
 * synchronously from the hover provider path"): on a cache hit, the
 * provider must render straight from the cached row with zero sidecar
 * calls. On a cache miss it deliberately falls through to a synchronous
 * `generate_explanation` call -- an accepted, documented gap (session-09
 * artifact: background indexing narrows how often this path is hit, but
 * doesn't remove it) -- so this suite documents that behavior rather than
 * treating it as a violation.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../../cache/config';
import { CacheRow, ExplanationCache } from '../../cache/explanationCache';
import { resolveEnclosingFunction } from '../../functionResolution';
import { ExplanationHoverProvider } from '../../hover/functionHoverProvider';
import { SidecarManager } from '../../sidecar/sidecarManager';

suite('hover/ExplanationHoverProvider (Core Rule 4: cache-lookup-only on a hit)', () => {
    let sandbox: sinon.SinonSandbox;
    let output: vscode.OutputChannel;
    let cache: ExplanationCache;
    let sidecar: SidecarManager;
    let dbPath: string;
    let workspaceRoot: string;
    let document: vscode.TextDocument;

    suiteSetup(async function () {
        this.timeout(20_000);
        const folders = vscode.workspace.workspaceFolders;
        assert.ok(folders && folders.length > 0, 'expected the fixture repo to be open as the test workspace');
        workspaceRoot = folders[0].uri.fsPath;
        document = await vscode.workspace.openTextDocument(path.join(workspaceRoot, 'sample.js'));

        // The built-in JS language service needs a moment to analyze a
        // freshly-opened document before `vscode.executeDocumentSymbolProvider`
        // returns anything -- warm it up here (polling, not a fixed sleep) so
        // the first real test isn't the one that happens to eat that latency
        // and spuriously fail to resolve a function that's really there.
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
        assert.fail('document symbol provider never returned symbols for sample.js');
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        output = vscode.window.createOutputChannel('LucidHover Hover Test');
        dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-hover-test-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);
        sidecar = new SidecarManager(
            workspaceRoot,
            path.join(os.tmpdir(), 'lucidhover-test-extension'),
            path.join(os.tmpdir(), 'lucidhover-test-storage'),
            'all-minilm',
            'http://localhost:11434',
            output
        );
    });

    teardown(() => {
        cache.dispose();
        output.dispose();
        sandbox.restore();
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    });

    function makeProvider(): ExplanationHoverProvider {
        return new ExplanationHoverProvider(
            () => workspaceRoot,
            () => cache,
            () => sidecar,
            () => undefined,
            () => undefined,
            output
        );
    }

    test('cache hit: renders from the cached row without ever calling sidecar.request', async () => {
        const requestSpy = sandbox.stub(sidecar, 'request');

        // `add(a, b)` at sample.js:4 -- resolve it for real (same code path
        // production uses) so fn_id/fn_hash/relFile match exactly.
        const position = new vscode.Position(4, 10);
        const resolved = await resolveEnclosingFunction(document, position, workspaceRoot);
        assert.ok(resolved, 'expected to resolve the `add` function from the fixture repo');
        assert.strictEqual(resolved!.name, 'add');

        const row: CacheRow = {
            cache_key: 'test-cache-key',
            fn_id: resolved!.fnId,
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: 'Adds two numbers.' }),
            fn_hash: resolved!.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
        cache.write(row);

        const provider = makeProvider();
        const hover = await provider.provideHover(document, position);

        assert.ok(hover, 'expected a Hover to be returned on a cache hit');
        assert.strictEqual(requestSpy.called, false, 'a cache hit must never call sidecar.request');
        const rendered = (hover!.contents[0] as vscode.MarkdownString).value;
        assert.match(rendered, /Adds two numbers\./);
    });

    test('cache miss: falls through to a synchronous generate_explanation call (documented, accepted gap)', async () => {
        const requestStub = sandbox.stub(sidecar, 'request').resolves({
            context_hash: 'ctx-generated',
            context_tier: 'call_graph_only',
            explanation: { role_tag: 'utility', one_liner: 'Generated on demand.' },
        });

        const position = new vscode.Position(8, 10); // greet(name)
        const resolved = await resolveEnclosingFunction(document, position, workspaceRoot);
        assert.ok(resolved);
        assert.strictEqual(resolved!.name, 'greet');
        assert.strictEqual(
            cache.lookup({
                fnId: resolved!.fnId,
                fnHash: resolved!.fnHash,
                modelId: 'qwen2.5-coder:1.5b',
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: PROMPT_VERSION,
            }),
            undefined,
            'precondition: nothing cached yet for greet'
        );

        const provider = makeProvider();
        const hover = await provider.provideHover(document, position);

        assert.ok(hover);
        assert.strictEqual(requestStub.calledOnce, true);
        assert.strictEqual(requestStub.firstCall.args[0], 'generate_explanation');
        // The result must also have been written to cache -- generateAndCache's
        // contract, not just rendered transiently.
        const cached = cache.lookup({
            fnId: resolved!.fnId,
            fnHash: resolved!.fnHash,
            modelId: resolveModelId(),
            embeddingModelId: EMBEDDING_MODEL_ID,
            promptVersion: PROMPT_VERSION,
        });
        assert.ok(cached);
    });
});
