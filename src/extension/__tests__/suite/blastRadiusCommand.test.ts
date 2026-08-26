/**
 * Session 45: live verification against a real spawned sidecar (no Ollama
 * needed -- `get_blast_radius` is graph-only, no LLM call) that
 * blastRadiusCommand.ts's `showBlastRadius` computes a real multi-hop
 * upstream graph, enriches cached nodes from `ExplanationCache`, leaves
 * uncached nodes bare, and never calls `generate_explanation` to fill a
 * cache gap in (Core Rule 9 -- the panel's graph-view render path gets no
 * Core-Rule-4-style exception just because it's new).
 *
 * Calls `showBlastRadius` directly rather than through
 * `vscode.commands.executeCommand('lucidhover.showBlastRadius')`: the real
 * command id is already registered once by `extension.ts`'s own activation
 * in the Extension Development Host every integration test runs inside, so
 * registering it a second time here (to get a disposable to clean up after
 * the test) would throw. Calling the exported handler function directly
 * exercises the identical logic the real command invokes.
 *
 * Standalone temp workspace, not `fixtures/javascript/repomap` -- same
 * rationale as `saveReindexIntegration.test.ts`: this needs a small,
 * controlled, deliberately shaped call graph (one root with two depth-1
 * callers, one of which has its own depth-2 caller), not
 * `fixtures/REQUIREMENTS.md`'s structural counts, and it must not depend on
 * that fixture's exact current shape.
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
import { showBlastRadius } from '../../panel/blastRadiusCommand';
import { ExplanationPanelProvider, GraphViewPayload } from '../../panel/explanationPanelProvider';
import { SidecarManager } from '../../sidecar/sidecarManager';

suite('panel/blastRadiusCommand (Session 45, real sidecar, no Ollama needed -- graph-only)', () => {
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

    // target() <- callerA(), callerB() (depth 1); callerA() <- callerOfA() (depth 2).
    // callerB has no caller of its own, so it terminates the walk on that branch.
    const targetContent = 'function target() {\n  return 1;\n}\n';
    const callerAContent = 'function callerA() {\n  target();\n}\n';
    const callerBContent = 'function callerB() {\n  target();\n}\n';
    const callerOfAContent = 'function callerOfA() {\n  callerA();\n}\n';

    // Session 47: a separate root (manyTarget) with 16 direct callers --
    // one more than BLAST_RADIUS_LEVEL_CAP (15) -- so the per-level
    // fan-out cap actually triggers in a live end-to-end run through the
    // real command, not just at the sidecar/RepoMap layer.
    const manyTargetContent = 'function manyTarget() {\n  return 1;\n}\n';
    const MANY_CALLER_COUNT = 16;

    suiteSetup(async function () {
        // Real process spawn + real repomap indexing + real socket connect --
        // same generous-but-bounded budget saveReindexIntegration.test.ts
        // uses for the identical class of setup cost.
        this.timeout(120_000);

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-blast-radius-'));
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-blast-radius-storage-'));
        fs.writeFileSync(path.join(tempDir, 'target.js'), targetContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'callerA.js'), callerAContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'callerB.js'), callerBContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'callerOfA.js'), callerOfAContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'manyTarget.js'), manyTargetContent, 'utf8');
        for (let i = 1; i <= MANY_CALLER_COUNT; i++) {
            fs.writeFileSync(
                path.join(tempDir, `manyCaller${i}.js`),
                `function manyCaller${i}() {\n  manyTarget();\n}\n`,
                'utf8'
            );
        }

        const targetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        await waitForSymbols(targetDocument);

        output = vscode.window.createOutputChannel('LucidHover Blast Radius Test (sidecar log)');
        sidecar = new SidecarManager(tempDir, findExtensionRoot(), storageDir, 'all-minilm', 'http://localhost:11434', output);
        await sidecar.start();
    });

    suiteTeardown(function () {
        sidecar?.dispose();
        // Deliberately does NOT dispose `output` -- see
        // saveReindexIntegration.test.ts's own suiteTeardown comment: a real
        // child process's stdout/stderr listeners can still fire after
        // teardown() kills it but before it actually exits, and calling
        // appendLine on an already-disposed channel throws and corrupts
        // later suites in the same Mocha run.
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(storageDir, { recursive: true, force: true });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-blast-radius-cache-')), 'cache.sqlite');
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

    test('computes the real multi-hop upstream graph, enriches only the cached node, and never triggers generation', async function () {
        this.timeout(20_000);

        const targetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        const editor = await vscode.window.showTextDocument(targetDocument);
        const resolved = await resolveEnclosingFunction(targetDocument, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve target()');
        assert.strictEqual(resolved!.name, 'target');
        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);

        // Seed a cached row for callerA only -- callerB and callerOfA are
        // deliberately left uncached to prove enrichment leaves them bare
        // rather than filling the gap in with a synchronous generation call.
        const callerADocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'callerA.js'));
        await waitForSymbols(callerADocument);
        const callerAFunctions = await resolveAllFunctions(callerADocument, tempDir);
        const callerA = callerAFunctions.find((f) => f.name === 'callerA');
        assert.ok(callerA, 'expected to resolve callerA()');

        const row: CacheRow = {
            cache_key: 'test-key-callerA',
            fn_id: callerA!.fnId,
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: 'Calls target.' }),
            fn_hash: callerA!.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
        cache.write(row);

        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        const requestSpy = sandbox.spy(sidecar, 'request');

        await showBlastRadius(() => tempDir, () => cache, () => sidecar, panel, output);

        assert.strictEqual(showGraphSpy.calledOnce, true, 'expected the panel to receive exactly one graph payload');
        const payload = showGraphSpy.firstCall.args[0] as GraphViewPayload;
        assert.strictEqual(payload.direction, 'upstream');
        assert.strictEqual(payload.rootName, 'target');

        const byName = new Map(payload.nodes.map((n) => [n.name, n]));
        assert.strictEqual(byName.size, 3, `expected 3 upstream nodes, got: ${[...byName.keys()].join(', ')}`);

        assert.strictEqual(byName.get('callerA')?.depth, 1);
        assert.strictEqual(byName.get('callerA')?.roleTag, 'utility');
        assert.strictEqual(byName.get('callerA')?.oneLiner, 'Calls target.');

        assert.strictEqual(byName.get('callerB')?.depth, 1);
        assert.strictEqual(byName.get('callerB')?.roleTag, undefined);
        assert.strictEqual(byName.get('callerB')?.oneLiner, undefined);

        assert.strictEqual(byName.get('callerOfA')?.depth, 2);
        assert.strictEqual(byName.get('callerOfA')?.roleTag, undefined);
        assert.strictEqual(byName.get('callerOfA')?.oneLiner, undefined);

        // Session 47: this synthetic graph's fan-out is well under the
        // per-level cap, so nothing should be reported as omitted.
        assert.deepStrictEqual(payload.omissions, []);

        assert.strictEqual(
            requestSpy.getCalls().some((c) => c.args[0] === 'generate_explanation'),
            false,
            'blast radius must never trigger generation to fill an uncached node in (Core Rule 9)'
        );
    });

    test('caps fan-out at 15 per level and reports the omitted count on the payload (Session 47)', async function () {
        this.timeout(20_000);

        const manyTargetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'manyTarget.js'));
        const editor = await vscode.window.showTextDocument(manyTargetDocument);
        const resolved = await resolveEnclosingFunction(manyTargetDocument, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve manyTarget()');
        assert.strictEqual(resolved!.name, 'manyTarget');
        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);

        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        await showBlastRadius(() => tempDir, () => cache, () => sidecar, panel, output);

        assert.strictEqual(showGraphSpy.calledOnce, true, 'expected the panel to receive exactly one graph payload');
        const payload = showGraphSpy.firstCall.args[0] as GraphViewPayload;

        const depth1Nodes = payload.nodes.filter((n) => n.depth === 1);
        assert.strictEqual(
            depth1Nodes.length,
            15,
            `expected exactly 15 depth-1 nodes (the per-level cap), got ${depth1Nodes.length}: ${depth1Nodes.map((n) => n.name).join(', ')}`
        );
        // 16 real callers, capped at 15 -- exactly 1 must be reported omitted
        // rather than silently dropped, which is what the panel's
        // renderGraph() turns into a "+1 more not shown" note under Level 1.
        assert.deepStrictEqual(payload.omissions, [{ depth: 1, omittedCount: MANY_CALLER_COUNT - 15 }]);
    });

    test('an explicit target overrides the live cursor position (Session 52 fix)', async function () {
        this.timeout(20_000);

        // Cursor sits on manyTarget(), but an explicit `target` for target()
        // is passed in -- this is exactly what ExplanationPanelProvider now
        // does when its own tracked `currentFunction` differs from wherever
        // the text cursor has since moved to. The computed graph must be for
        // the explicit target, not the live cursor.
        const manyTargetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'manyTarget.js'));
        const editor = await vscode.window.showTextDocument(manyTargetDocument);
        const manyTargetResolved = await resolveEnclosingFunction(manyTargetDocument, new vscode.Position(0, 10), tempDir);
        assert.ok(manyTargetResolved, 'expected to resolve manyTarget()');
        editor.selection = new vscode.Selection(manyTargetResolved!.range.start, manyTargetResolved!.range.start);

        const targetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        const targetResolved = await resolveEnclosingFunction(targetDocument, new vscode.Position(0, 10), tempDir);
        assert.ok(targetResolved, 'expected to resolve target()');

        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        await showBlastRadius(() => tempDir, () => cache, () => sidecar, panel, output, targetResolved);

        assert.strictEqual(showGraphSpy.calledOnce, true);
        const payload = showGraphSpy.firstCall.args[0] as GraphViewPayload;
        assert.strictEqual(payload.rootName, 'target', 'expected the graph to be computed for the explicit target, not the live cursor at manyTarget()');
    });
});
