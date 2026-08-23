/**
 * Session 49: cross-language validation of the graph-view features (blast
 * radius, session 45; execution trace + branching, sessions 46/48) against
 * real TypeScript node shapes -- sessions 45-48 only ever exercised these
 * against plain JavaScript functions (`blastRadiusCommand.test.ts`/
 * `callTraceCommand.test.ts`). This mirrors those two files' structure and
 * rationale closely (real spawned sidecar, no Ollama needed -- both RPCs are
 * graph-only; standalone synthetic temp workspace, not `fixtures/typescript/
 * repomap`, so the graph shape is small, controlled, and not coupled to that
 * fixture's future edits), but with a synthetic call graph built out of a TS
 * class method, a top-level arrow-const, and a plain free function -- the
 * three def shapes session 25 found real fnId/resolution differences
 * between (arrow-const in particular was a real, previously-silent
 * `isFunctionLike` exclusion bug, fixed that session). The point here is
 * end-to-end: that `resolveEnclosingFunction`/`resolveAllFunctions`/
 * `resolveFunctionsInFile`'s nearest-line fnId/fnHash matching (the
 * `closestResolved`/`enrichOne` machinery in blastRadiusCommand.ts/
 * callTraceCommand.ts) works correctly when fed these TS-specific shapes,
 * not just JS ones.
 *
 * Call graph (verified directly against a real `RepoMap` before writing this
 * test, same as blastRadiusCommand.test.ts's own precedent):
 *
 *   RootService.run() (class method)
 *     -> helper()      (top-level arrow-const, primary path -- boosted to
 *                        higher importance than otherHelper via an extra
 *                        caller, extraCallerOfHelper, same technique
 *                        session 46 used for x() over y())
 *     -> otherHelper()  (free function, non-primary -- session 48 branch
 *                        alternate at depth 1)
 *   helper() -> target() (free function, primary path continues)
 *   helperTwo() -> target() (arrow-const, second depth-1 caller of target)
 *   extraCallerOfHelper() -> helper() (free function, depth-2 caller of
 *                        target via helper)
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
import { showCallTrace } from '../../panel/callTraceCommand';
import { ExplanationPanelProvider, GraphViewPayload } from '../../panel/explanationPanelProvider';
import { SidecarManager } from '../../sidecar/sidecarManager';

suite('graph views on TypeScript shapes (Session 49, real sidecar, no Ollama needed -- graph-only)', () => {
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

    const rootServiceContent = 'export class RootService {\n  run(): void {\n    helper();\n    otherHelper();\n  }\n}\n';
    const helperContent = 'export const helper = (): void => {\n  target();\n};\n';
    const helperTwoContent = 'export const helperTwo = (): void => {\n  target();\n};\n';
    const otherHelperContent = 'export function otherHelper(): void {\n  return;\n}\n';
    const targetContent = 'export function target(): number {\n  return 1;\n}\n';
    const extraCallerOfHelperContent = 'export function extraCallerOfHelper(): void {\n  helper();\n}\n';

    suiteSetup(async function () {
        // Real process spawn + real repomap indexing + real socket connect --
        // same generous-but-bounded budget blastRadiusCommand.test.ts/
        // callTraceCommand.test.ts use for the identical class of setup cost.
        this.timeout(120_000);

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-graphview-ts-'));
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-graphview-ts-storage-'));
        fs.writeFileSync(path.join(tempDir, 'rootService.ts'), rootServiceContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'helper.ts'), helperContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'helperTwo.ts'), helperTwoContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'otherHelper.ts'), otherHelperContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'target.ts'), targetContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'extraCallerOfHelper.ts'), extraCallerOfHelperContent, 'utf8');

        const rootServiceDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'rootService.ts'));
        await waitForSymbols(rootServiceDocument);

        output = vscode.window.createOutputChannel('LucidHover Graph View TS Test (sidecar log)');
        sidecar = new SidecarManager(tempDir, findExtensionRoot(), storageDir, 'all-minilm', 'http://localhost:11434', output);
        await sidecar.start();
    });

    suiteTeardown(function () {
        sidecar?.dispose();
        // Deliberately does NOT dispose `output` -- see
        // blastRadiusCommand.test.ts's own suiteTeardown comment: a real
        // child process's stdout/stderr listeners can still fire after
        // teardown() kills it but before it actually exits.
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(storageDir, { recursive: true, force: true });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-graphview-ts-cache-')), 'cache.sqlite');
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

    async function seedCacheRowFor(relFile: string, name: string, roleTag: string, oneLiner: string): Promise<void> {
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, relFile));
        await waitForSymbols(document);
        const functions = await resolveAllFunctions(document, tempDir);
        const fn = functions.find((f) => f.name === name);
        assert.ok(fn, `expected to resolve ${name}() in ${relFile}`);

        const row: CacheRow = {
            cache_key: `test-key-${name}`,
            fn_id: fn!.fnId,
            explanation_json: JSON.stringify({ role_tag: roleTag, one_liner: oneLiner }),
            fn_hash: fn!.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
        cache.write(row);
    }

    test('blast radius resolves a real upstream chain spanning an arrow-const and a class method', async function () {
        this.timeout(20_000);

        // Seeds one arrow-const (helper) and the class method two hops up
        // (RootService.run) -- proves both non-plain-function shapes
        // resolve to the correct fnId/fnHash and enrich correctly.
        // helperTwo (arrow-const) and extraCallerOfHelper (free function)
        // are deliberately left uncached to prove they still render bare.
        await seedCacheRowFor('helper.ts', 'helper', 'utility', 'Calls target.');
        await seedCacheRowFor('rootService.ts', 'run', 'handler', 'Runs the two helpers.');

        const targetDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.ts'));
        const editor = await vscode.window.showTextDocument(targetDocument);
        const resolved = await resolveEnclosingFunction(targetDocument, new vscode.Position(0, 18), tempDir);
        assert.ok(resolved, 'expected to resolve target()');
        assert.strictEqual(resolved!.name, 'target');
        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);

        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        const requestSpy = sandbox.spy(sidecar, 'request');

        await showBlastRadius(() => tempDir, () => cache, () => sidecar, panel, output);

        assert.strictEqual(showGraphSpy.calledOnce, true, 'expected the panel to receive exactly one graph payload');
        const payload = showGraphSpy.firstCall.args[0] as GraphViewPayload;
        assert.strictEqual(payload.direction, 'upstream');
        assert.strictEqual(payload.rootName, 'target');

        const byName = new Map(payload.nodes.map((n) => [n.name, n]));
        assert.strictEqual(byName.size, 4, `expected 4 upstream nodes, got: ${[...byName.keys()].join(', ')}`);

        assert.strictEqual(byName.get('helper')?.depth, 1);
        assert.strictEqual(byName.get('helper')?.roleTag, 'utility');
        assert.strictEqual(byName.get('helper')?.oneLiner, 'Calls target.');

        assert.strictEqual(byName.get('helperTwo')?.depth, 1);
        assert.strictEqual(byName.get('helperTwo')?.roleTag, undefined);
        assert.strictEqual(byName.get('helperTwo')?.oneLiner, undefined);

        assert.strictEqual(byName.get('run')?.depth, 2);
        assert.strictEqual(byName.get('run')?.roleTag, 'handler');
        assert.strictEqual(byName.get('run')?.oneLiner, 'Runs the two helpers.');

        assert.strictEqual(byName.get('extraCallerOfHelper')?.depth, 2);
        assert.strictEqual(byName.get('extraCallerOfHelper')?.roleTag, undefined);
        assert.strictEqual(byName.get('extraCallerOfHelper')?.oneLiner, undefined);

        assert.deepStrictEqual(payload.omissions, []);
        assert.strictEqual(
            requestSpy.getCalls().some((c) => c.args[0] === 'generate_explanation'),
            false,
            'blast radius must never trigger generation to fill an uncached node in (Core Rule 9)'
        );
    });

    test('execution trace follows a real class-method -> arrow-const -> free-function primary path, with a branch alternate', async function () {
        this.timeout(20_000);

        // Seeds the arrow-const primary node (helper) and the branch
        // alternate at the same hop (otherHelper, a free function) -- proves
        // branch alternates get identical enrichment treatment regardless of
        // def shape. target (the depth-2 primary node, also a free function)
        // is deliberately left uncached to prove it still renders bare.
        await seedCacheRowFor('helper.ts', 'helper', 'dispatcher', 'Calls target.');
        await seedCacheRowFor('otherHelper.ts', 'otherHelper', 'noop', 'Does nothing.');

        const rootServiceDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'rootService.ts'));
        const editor = await vscode.window.showTextDocument(rootServiceDocument);
        const resolved = await resolveEnclosingFunction(rootServiceDocument, new vscode.Position(1, 4), tempDir);
        assert.ok(resolved, 'expected to resolve RootService.run()');
        assert.strictEqual(resolved!.name, 'run');
        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);

        const showGraphSpy = sandbox.stub(panel, 'showGraph');
        const requestSpy = sandbox.spy(sidecar, 'request');

        await showCallTrace(() => tempDir, () => cache, () => sidecar, panel, output);

        assert.strictEqual(showGraphSpy.calledOnce, true, 'expected the panel to receive exactly one graph payload');
        const payload = showGraphSpy.firstCall.args[0] as GraphViewPayload;
        assert.strictEqual(payload.direction, 'downstream');
        assert.strictEqual(payload.rootName, 'run');

        assert.strictEqual(payload.nodes.length, 2, `expected a 2-hop trace, got: ${payload.nodes.map((n) => n.name).join(', ')}`);
        const byName = new Map(payload.nodes.map((n) => [n.name, n]));

        assert.strictEqual(byName.get('helper')?.depth, 1);
        assert.strictEqual(byName.get('helper')?.roleTag, 'dispatcher');
        assert.strictEqual(byName.get('helper')?.oneLiner, 'Calls target.');

        assert.strictEqual(byName.get('target')?.depth, 2);
        assert.strictEqual(byName.get('target')?.roleTag, undefined);
        assert.strictEqual(byName.get('target')?.oneLiner, undefined);

        assert.strictEqual(payload.branches.length, 1, `expected exactly 1 branch point, got: ${JSON.stringify(payload.branches)}`);
        const branch = payload.branches[0];
        assert.strictEqual(branch.depth, 1, 'expected the branch point to sit at the same depth as helper, its primary-node sibling');
        assert.strictEqual(branch.alternates.length, 1);
        assert.strictEqual(branch.alternates[0].name, 'otherHelper');
        assert.strictEqual(branch.alternates[0].roleTag, 'noop');
        assert.strictEqual(branch.alternates[0].oneLiner, 'Does nothing.');
        assert.strictEqual(branch.omittedCount, 0);

        // The branch alternate must never itself become a trace node.
        assert.strictEqual(payload.nodes.some((n) => n.name === 'otherHelper'), false);

        assert.strictEqual(
            requestSpy.getCalls().some((c) => c.args[0] === 'generate_explanation'),
            false,
            'call trace must never trigger generation to fill an uncached node in (Core Rule 4/9)'
        );
    });
});
