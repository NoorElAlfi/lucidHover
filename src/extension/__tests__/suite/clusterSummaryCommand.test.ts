/**
 * Session 68: live verification against a real spawned sidecar (no live
 * Ollama needed -- `generate_cluster_summary` is the only LLM-backed call
 * in this feature, and it's stubbed here the same way
 * `prioritizeFileIndexingCommand.test.ts` stubs `generate_explanation`) that
 * clusterSummaryCommand.ts's two commands correctly split "look up" from
 * "generate", per a code-reviewer finding on this session's first draft
 * (Core Rule 4: the docked panel's render/lookup path must never call the
 * LLM, unlike hover's cache-miss fallback):
 *   - `showClusterSummary` selects a cluster via the real sidecar's
 *     `get_blast_radius` walk (unstubbed -- graph-only, no LLM call, same
 *     real multi-hop graph `blastRadiusCommand.test.ts` already exercises)
 *     and shows whatever purpose paragraph is ALREADY cached -- it must
 *     never call `generate_cluster_summary` itself, even when the cluster
 *     has cached members that COULD be synthesized from,
 *   - `synthesizeClusterSummary` (the separate, explicit action fired by
 *     the panel's own "Synthesize summary" button) is the only path that
 *     calls `generate_cluster_summary`, and only synthesizes from the
 *     cluster's already-cached members (root + cached callers), never
 *     generating a per-function explanation to fill an uncached member in
 *     (Core Rule 9 -- same invariant `blastRadiusCommand.test.ts`/
 *     `callTraceCommand.test.ts` assert), and
 *   - the synthesized paragraph is cached under its own synthetic fn_id/
 *     `CLUSTER_SUMMARY_PROMPT_VERSION` so a later `showClusterSummary` call
 *     picks it up as a pure cache lookup, with no further RPC call.
 *
 * Calls both functions directly rather than through
 * `vscode.commands.executeCommand(...)` -- same reason `showBlastRadius`/
 * `showCallTrace` are called directly in their own test suites: the real
 * command ids are already registered once by `extension.ts`'s own
 * activation in the Extension Development Host every integration test runs
 * inside.
 *
 * Standalone temp workspace, not `fixtures/javascript/repomap` -- same
 * rationale as `blastRadiusCommand.test.ts`: a small, deliberately shaped
 * call graph, not the fixture's exact current shape.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CLUSTER_SUMMARY_PROMPT_VERSION, EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../../cache/config';
import { CacheRow, ExplanationCache } from '../../cache/explanationCache';
import { resolveAllFunctions, resolveEnclosingFunction } from '../../functionResolution';
import { showClusterSummary, synthesizeClusterSummary } from '../../panel/clusterSummaryCommand';
import { ExplanationPanelProvider, GraphViewPayload } from '../../panel/explanationPanelProvider';
import { SidecarManager } from '../../sidecar/sidecarManager';

suite('panel/clusterSummaryCommand (Session 68, real sidecar for get_blast_radius, stubbed LLM call)', () => {
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

    // target() <- callerA(), callerB() (both depth 1). callerA gets cached,
    // callerB is left uncached so the "not every member is cached" path is
    // real, not hypothetical.
    const targetContent = 'function target() {\n  return 1;\n}\n';
    const callerAContent = 'function callerA() {\n  target();\n}\n';
    const callerBContent = 'function callerB() {\n  target();\n}\n';

    function cacheRowFor(fnId: string, fnHash: string, roleTag: string, oneLiner: string): CacheRow {
        return {
            cache_key: `test-key-${fnId}`,
            fn_id: fnId,
            explanation_json: JSON.stringify({ role_tag: roleTag, one_liner: oneLiner }),
            fn_hash: fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
    }

    suiteSetup(async function () {
        this.timeout(120_000);

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-cluster-summary-'));
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-cluster-summary-storage-'));
        fs.writeFileSync(path.join(tempDir, 'target.js'), targetContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'callerA.js'), callerAContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'callerB.js'), callerBContent, 'utf8');

        const targetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        await waitForSymbols(targetDocument);

        output = vscode.window.createOutputChannel('LucidHover Cluster Summary Test (sidecar log)');
        sidecar = new SidecarManager(tempDir, findExtensionRoot(), storageDir, 'all-minilm', 'http://localhost:11434', output);
        await sidecar.start();
    });

    suiteTeardown(function () {
        sidecar?.dispose();
        // Deliberately does NOT dispose `output` -- see blastRadiusCommand.test.ts's
        // own suiteTeardown comment for why.
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(storageDir, { recursive: true, force: true });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-cluster-summary-cache-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);
        panel = new ExplanationPanelProvider(
            vscode.Uri.file(tempDir),
            () => tempDir,
            () => cache,
            () => undefined,
            () => undefined,
            output
        );
    });

    teardown(() => {
        cache.dispose();
        sandbox.restore();
    });

    test('showClusterSummary is a pure cache lookup: never calls generate_cluster_summary, even with cached members to synthesize from', async function () {
        this.timeout(20_000);

        const targetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        const editor = await vscode.window.showTextDocument(targetDocument);
        const resolved = await resolveEnclosingFunction(targetDocument, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve target()');
        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);

        cache.write(cacheRowFor(resolved!.fnId, resolved!.fnHash, 'Utility', 'Returns 1.'));

        const requestSpy = sandbox.spy(sidecar, 'request');
        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        await showClusterSummary(() => tempDir, () => cache, () => sidecar, panel, output);

        assert.strictEqual(showGraphSpy.calledOnce, true);
        const payload = showGraphSpy.firstCall.args[0] as GraphViewPayload;
        assert.strictEqual(payload.direction, 'cluster');
        assert.strictEqual(payload.purpose, undefined, 'nothing synthesized yet -- showClusterSummary must not synthesize on its own');
        assert.strictEqual(payload.canSynthesize, true, 'root is cached, so synthesis is available -- just not auto-triggered');

        assert.strictEqual(
            requestSpy.getCalls().some((c) => c.args[0] === 'generate_cluster_summary'),
            false,
            'showClusterSummary must never call generate_cluster_summary (Core Rule 4: the panel render/lookup path is a pure cache lookup)'
        );
    });

    test('showClusterSummary reports canSynthesize=false with no cached members anywhere in the cluster', async function () {
        this.timeout(20_000);

        const targetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        const editor = await vscode.window.showTextDocument(targetDocument);
        const resolved = await resolveEnclosingFunction(targetDocument, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve target()');
        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);

        const requestSpy = sandbox.spy(sidecar, 'request');
        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        await showClusterSummary(() => tempDir, () => cache, () => sidecar, panel, output);

        assert.strictEqual(showGraphSpy.calledOnce, true);
        const payload = showGraphSpy.firstCall.args[0] as GraphViewPayload;
        assert.strictEqual(payload.purpose, undefined);
        assert.strictEqual(payload.canSynthesize, false, 'nothing cached anywhere in the cluster -- there is nothing to synthesize from');
        assert.strictEqual(payload.nodes.length, 2, 'the bare member list should still be shown even with no purpose paragraph');

        assert.strictEqual(
            requestSpy.getCalls().some((c) => c.args[0] === 'generate_cluster_summary'),
            false
        );
    });

    test('synthesizeClusterSummary generates a purpose paragraph from only the cluster\'s cached members and caches it', async function () {
        this.timeout(20_000);

        const targetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        const editor = await vscode.window.showTextDocument(targetDocument);
        const resolved = await resolveEnclosingFunction(targetDocument, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve target()');
        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);

        cache.write(cacheRowFor(resolved!.fnId, resolved!.fnHash, 'Utility', 'Returns 1.'));

        const callerADocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'callerA.js'));
        await waitForSymbols(callerADocument);
        const callerAFunctions = await resolveAllFunctions(callerADocument, tempDir);
        const callerA = callerAFunctions.find((f) => f.name === 'callerA');
        assert.ok(callerA, 'expected to resolve callerA()');
        cache.write(cacheRowFor(callerA!.fnId, callerA!.fnHash, 'Handler', 'Calls target.'));

        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.callThrough();
        requestStub
            .withArgs('generate_cluster_summary')
            .callsFake(async () => ({ summary: 'Coordinates target() across two call sites.' }));

        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        await synthesizeClusterSummary(() => tempDir, () => cache, () => sidecar, panel, output);

        assert.strictEqual(showGraphSpy.calledOnce, true, 'expected the panel to receive exactly one graph payload');
        const payload = showGraphSpy.firstCall.args[0] as GraphViewPayload;
        assert.strictEqual(payload.direction, 'cluster');
        assert.strictEqual(payload.rootName, 'target');
        assert.strictEqual(payload.purpose, 'Coordinates target() across two call sites.');
        assert.strictEqual(payload.canSynthesize, false, 'already synthesized -- the button should not offer to synthesize again');

        const byName = new Map(payload.nodes.map((n) => [n.name, n]));
        assert.strictEqual(byName.size, 2);
        assert.strictEqual(byName.get('callerA')?.roleTag, 'Handler');
        assert.strictEqual(byName.get('callerB')?.roleTag, undefined, 'callerB is deliberately left uncached');

        const synthesisCalls = requestStub.getCalls().filter((c) => c.args[0] === 'generate_cluster_summary');
        assert.strictEqual(synthesisCalls.length, 1);
        const params = synthesisCalls[0].args[1] as { root_role: string; callers: { name: string }[] };
        assert.strictEqual(params.root_role, 'Utility');
        assert.deepStrictEqual(
            params.callers.map((c) => c.name),
            ['callerA'],
            'only the cached caller (callerA) should be fed to synthesis, never the uncached callerB'
        );

        assert.strictEqual(
            requestStub.getCalls().some((c) => c.args[0] === 'generate_explanation'),
            false,
            'cluster summary must never trigger per-function generation to fill an uncached member in (Core Rule 9)'
        );

        const cachedRow = cache.getCurrentRowForFnId({
            fnId: `${resolved!.fnId}::__cluster_summary__`,
            modelId: resolveModelId(),
            embeddingModelId: EMBEDDING_MODEL_ID,
            promptVersion: CLUSTER_SUMMARY_PROMPT_VERSION,
        });
        assert.ok(cachedRow, 'expected the synthesized paragraph to be written to a synthetic cluster-summary cache row');
        assert.strictEqual(JSON.parse(cachedRow!.explanation_json).purpose, 'Coordinates target() across two call sites.');
    });

    test('synthesizeClusterSummary skips the LLM call entirely when nothing in the cluster is cached yet', async function () {
        this.timeout(20_000);

        const targetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        const editor = await vscode.window.showTextDocument(targetDocument);
        const resolved = await resolveEnclosingFunction(targetDocument, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve target()');
        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);

        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.callThrough();
        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        await synthesizeClusterSummary(() => tempDir, () => cache, () => sidecar, panel, output);

        assert.strictEqual(showGraphSpy.calledOnce, true);
        const payload = showGraphSpy.firstCall.args[0] as GraphViewPayload;
        assert.strictEqual(payload.purpose, undefined, 'nothing cached to synthesize from -- defensive no-op, not a wasted LLM call');

        assert.strictEqual(
            requestStub.getCalls().some((c) => c.args[0] === 'generate_cluster_summary'),
            false
        );
    });

    test('after synthesizeClusterSummary runs once, showClusterSummary picks up the cached paragraph with no further RPC call', async function () {
        this.timeout(20_000);

        const targetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        const editor = await vscode.window.showTextDocument(targetDocument);
        const resolved = await resolveEnclosingFunction(targetDocument, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve target()');
        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);
        cache.write(cacheRowFor(resolved!.fnId, resolved!.fnHash, 'Utility', 'Returns 1.'));

        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.callThrough();
        requestStub.withArgs('generate_cluster_summary').callsFake(async () => ({ summary: 'First synthesis.' }));

        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        await synthesizeClusterSummary(() => tempDir, () => cache, () => sidecar, panel, output);
        await showClusterSummary(() => tempDir, () => cache, () => sidecar, panel, output);

        assert.strictEqual(showGraphSpy.callCount, 2);
        const secondPayload = showGraphSpy.secondCall.args[0] as GraphViewPayload;
        assert.strictEqual(secondPayload.purpose, 'First synthesis.');
        assert.strictEqual(secondPayload.canSynthesize, false);

        const synthesisCalls = requestStub.getCalls().filter((c) => c.args[0] === 'generate_cluster_summary');
        assert.strictEqual(synthesisCalls.length, 1, 'the later showClusterSummary call must hit the cached synthetic row, not call the LLM again');
    });

    test('an explicit target overrides the live cursor position (showClusterSummary)', async function () {
        this.timeout(20_000);

        // Cursor sits on callerA(), but an explicit `target` for target() is
        // passed in -- same override contract as showBlastRadius/showCallTrace.
        const callerADocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'callerA.js'));
        const editor = await vscode.window.showTextDocument(callerADocument);
        const callerAResolved = await resolveEnclosingFunction(callerADocument, new vscode.Position(0, 10), tempDir);
        assert.ok(callerAResolved, 'expected to resolve callerA()');
        editor.selection = new vscode.Selection(callerAResolved!.range.start, callerAResolved!.range.start);

        const targetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        const targetResolved = await resolveEnclosingFunction(targetDocument, new vscode.Position(0, 10), tempDir);
        assert.ok(targetResolved, 'expected to resolve target()');

        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        await showClusterSummary(() => tempDir, () => cache, () => sidecar, panel, output, targetResolved);

        assert.strictEqual(showGraphSpy.calledOnce, true);
        const payload = showGraphSpy.firstCall.args[0] as GraphViewPayload;
        assert.strictEqual(payload.rootName, 'target', 'expected the cluster to be computed for the explicit target, not the live cursor at callerA()');
    });

    test('an explicit target overrides the live cursor position (synthesizeClusterSummary)', async function () {
        this.timeout(20_000);

        const callerADocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'callerA.js'));
        const editor = await vscode.window.showTextDocument(callerADocument);
        const callerAResolved = await resolveEnclosingFunction(callerADocument, new vscode.Position(0, 10), tempDir);
        assert.ok(callerAResolved, 'expected to resolve callerA()');
        editor.selection = new vscode.Selection(callerAResolved!.range.start, callerAResolved!.range.start);

        const targetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        const targetResolved = await resolveEnclosingFunction(targetDocument, new vscode.Position(0, 10), tempDir);
        assert.ok(targetResolved, 'expected to resolve target()');

        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        await synthesizeClusterSummary(() => tempDir, () => cache, () => sidecar, panel, output, targetResolved);

        assert.strictEqual(showGraphSpy.calledOnce, true);
        const payload = showGraphSpy.firstCall.args[0] as GraphViewPayload;
        assert.strictEqual(payload.rootName, 'target', 'expected the cluster to be computed for the explicit target, not the live cursor at callerA()');
    });
});
