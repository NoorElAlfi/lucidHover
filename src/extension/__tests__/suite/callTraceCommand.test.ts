/**
 * Session 46: live verification against a real spawned sidecar (no Ollama
 * needed -- `get_call_trace` is graph-only, no LLM call) that
 * callTraceCommand.ts's `showCallTrace` computes a real single-primary-path
 * downstream chain, enriches cached nodes from `ExplanationCache`, leaves
 * an uncached node bare (so the panel renders it as a "not yet indexed"
 * placeholder), and never calls `generate_explanation` to fill a cache gap
 * in (Core Rule 9/Core Rule 4 -- the panel's graph-view render path gets no
 * exception just because it's new). Mirrors
 * blastRadiusCommand.test.ts's structure closely -- same rationale for
 * calling `showCallTrace` directly instead of through
 * `vscode.commands.executeCommand`, same standalone-temp-workspace choice.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../../cache/config';
import { CacheRow, ExplanationCache } from '../../cache/explanationCache';
import { resolveAllFunctions, resolveEnclosingFunction } from '../../functionResolution';
import { showCallTrace } from '../../panel/callTraceCommand';
import { ExplanationPanelProvider, GraphViewPayload } from '../../panel/explanationPanelProvider';
import { SidecarManager } from '../../sidecar/sidecarManager';

suite('panel/callTraceCommand (Session 46, real sidecar, no Ollama needed -- graph-only)', () => {
    let tempDir: string;
    let storageDir: string;
    let output: vscode.OutputChannel;
    let sidecar: SidecarManager;

    let sandbox: sinon.SinonSandbox;
    let cache: ExplanationCache;
    let panel: ExplanationPanelProvider;

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

    // root() -> x() (depth 1) -> p() (depth 2). x is made higher-importance
    // than root's other callee y() via two extra callers (other1/other2);
    // p is likewise made higher-importance than x's other callee q() via
    // its own extra caller (pCaller). p has no callees, so the walk
    // terminates there, not because of the depth cap.
    const rootContent = 'function root() {\n  x();\n  y();\n}\n';
    const otherContent = 'function other1() {\n  x();\n}\nfunction other2() {\n  x();\n}\n';
    const xContent = 'function x() {\n  p();\n  q();\n}\n';
    const pCallerContent = 'function pCaller() {\n  p();\n}\n';
    const pContent = 'function p() {\n  return 1;\n}\n';
    const qContent = 'function q() {\n  return 2;\n}\n';
    const yContent = 'function y() {\n  return 3;\n}\n';

    suiteSetup(async function () {
        // Real process spawn + real repomap indexing + real socket connect --
        // same generous-but-bounded budget blastRadiusCommand.test.ts uses
        // for the identical class of setup cost.
        this.timeout(120_000);

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-call-trace-'));
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-call-trace-storage-'));
        fs.writeFileSync(path.join(tempDir, 'root.js'), rootContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'other.js'), otherContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'x.js'), xContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'pcaller.js'), pCallerContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'p.js'), pContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'q.js'), qContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'y.js'), yContent, 'utf8');

        const rootDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'root.js'));
        await waitForSymbols(rootDocument);

        output = vscode.window.createOutputChannel('LucidHover Call Trace Test (sidecar log)');
        sidecar = new SidecarManager(tempDir, findExtensionRoot(), storageDir, 'all-minilm', 'http://localhost:11434', output);
        await sidecar.start();
    });

    suiteTeardown(function () {
        sidecar?.dispose();
        // Deliberately does NOT dispose `output` -- see
        // blastRadiusCommand.test.ts's own suiteTeardown comment.
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(storageDir, { recursive: true, force: true });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-call-trace-cache-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);
        panel = new ExplanationPanelProvider(
            () => tempDir,
            () => cache,
            output
        );
    });

    teardown(() => {
        cache.dispose();
        sandbox.restore();
    });

    test('computes the real single-primary-path downstream chain, enriches only the cached node, and never triggers generation', async function () {
        this.timeout(20_000);

        const rootDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'root.js'));
        const editor = await vscode.window.showTextDocument(rootDocument);
        const resolved = await resolveEnclosingFunction(rootDocument, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve root()');
        assert.strictEqual(resolved!.name, 'root');
        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);

        // Seed a cached row for x only -- p is deliberately left uncached to
        // prove enrichment leaves it bare rather than filling the gap in
        // with a synchronous generation call.
        const xDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'x.js'));
        await waitForSymbols(xDocument);
        const xFunctions = await resolveAllFunctions(xDocument, tempDir);
        const x = xFunctions.find((f) => f.name === 'x');
        assert.ok(x, 'expected to resolve x()');

        const row: CacheRow = {
            cache_key: 'test-key-x',
            fn_id: x!.fnId,
            explanation_json: JSON.stringify({ role_tag: 'dispatcher', one_liner: 'Calls p and q.' }),
            fn_hash: x!.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
        cache.write(row);

        // Session 48: root's other callee (y, root's depth-1 branch
        // alternate) also gets a cache row, so this same test proves branch
        // alternates go through the identical enrichment path primary nodes
        // do -- q (x's depth-2 branch alternate) is left uncached, same
        // "prove it renders bare" role p already plays for the primary path.
        const yDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'y.js'));
        await waitForSymbols(yDocument);
        const yFunctions = await resolveAllFunctions(yDocument, tempDir);
        const y = yFunctions.find((f) => f.name === 'y');
        assert.ok(y, 'expected to resolve y()');

        const yRow: CacheRow = {
            cache_key: 'test-key-y',
            fn_id: y!.fnId,
            explanation_json: JSON.stringify({ role_tag: 'constant', one_liner: 'Returns 3.' }),
            fn_hash: y!.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
        cache.write(yRow);

        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        const requestSpy = sandbox.spy(sidecar, 'request');

        await showCallTrace(() => tempDir, () => cache, () => sidecar, panel, output);

        assert.strictEqual(showGraphSpy.calledOnce, true, 'expected the panel to receive exactly one graph payload');
        const payload = showGraphSpy.firstCall.args[0] as GraphViewPayload;
        assert.strictEqual(payload.direction, 'downstream');
        assert.strictEqual(payload.rootName, 'root');

        assert.strictEqual(payload.nodes.length, 2, `expected a 2-hop trace, got: ${payload.nodes.map((n) => n.name).join(', ')}`);

        const byName = new Map(payload.nodes.map((n) => [n.name, n]));
        assert.strictEqual(byName.get('x')?.depth, 1);
        assert.strictEqual(byName.get('x')?.roleTag, 'dispatcher');
        assert.strictEqual(byName.get('x')?.oneLiner, 'Calls p and q.');

        assert.strictEqual(byName.get('p')?.depth, 2);
        assert.strictEqual(byName.get('p')?.roleTag, undefined);
        assert.strictEqual(byName.get('p')?.oneLiner, undefined);

        // Session 48: root's un-chosen callee (y) and x's un-chosen callee
        // (q) must both surface as branch points, at the depth of the
        // primary node the choice was made alongside (1 and 2
        // respectively) -- not walked any further themselves.
        assert.strictEqual(payload.branches.length, 2, `expected 2 branch points, got: ${JSON.stringify(payload.branches)}`);
        const branchByDepth = new Map(payload.branches.map((b) => [b.depth, b]));

        const depth1Branch = branchByDepth.get(1);
        assert.ok(depth1Branch, 'expected a depth-1 branch point for root -> y');
        assert.strictEqual(depth1Branch!.alternates.length, 1);
        assert.strictEqual(depth1Branch!.alternates[0].name, 'y');
        assert.strictEqual(depth1Branch!.alternates[0].roleTag, 'constant');
        assert.strictEqual(depth1Branch!.alternates[0].oneLiner, 'Returns 3.');
        assert.strictEqual(depth1Branch!.omittedCount, 0);

        const depth2Branch = branchByDepth.get(2);
        assert.ok(depth2Branch, 'expected a depth-2 branch point for x -> q');
        assert.strictEqual(depth2Branch!.alternates.length, 1);
        assert.strictEqual(depth2Branch!.alternates[0].name, 'q');
        assert.strictEqual(depth2Branch!.alternates[0].roleTag, undefined);
        assert.strictEqual(depth2Branch!.alternates[0].oneLiner, undefined);
        assert.strictEqual(depth2Branch!.omittedCount, 0);

        // Branch alternates must never themselves become trace nodes or get
        // walked further.
        assert.strictEqual(payload.nodes.some((n) => n.name === 'y' || n.name === 'q'), false);

        assert.strictEqual(
            requestSpy.getCalls().some((c) => c.args[0] === 'generate_explanation'),
            false,
            'call trace must never trigger generation to fill an uncached node in (Core Rule 4/9)'
        );
    });
});
