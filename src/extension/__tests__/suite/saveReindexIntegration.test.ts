import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../../cache/config';
import { CacheRow, ExplanationCache } from '../../cache/explanationCache';
import { resolveAllFunctions } from '../../functionResolution';
import { SaveReindexManager } from '../../saveReindex';
import { SidecarManager } from '../../sidecar/sidecarManager';
import { StaleTracker } from '../../staleTracking';

/**
 * Session 27: closes a confirmed zero-coverage gap -- neither
 * `SaveReindexManager` (Build Order step 8) nor `flagStaleDependents`
 * (Session 13) had any test anywhere in the repo before this suite. Also
 * closes session 23's own carried-forward handoff item ("the JS fixture's
 * own line-shift/reindex Tier 1 test never checked in").
 *
 * Deliberately a real `SidecarManager` (real `python -m sidecar.rpc_server`
 * process) against a real local Ollama endpoint (`qwen2.5-coder:1.5b` +
 * `all-minilm`, same defaults `hover.test.ts`/production use) -- unlike
 * every other integration test so far, which either stubs `sidecar.request`
 * entirely (`hover.test.ts`) or injects a fake `spawnFn`/`connectFn`
 * (`sidecarManager.test.ts`). `flagStaleDependents` needs real cross-file
 * call-graph edges from the sidecar's `index_file` response (Session 13),
 * which a mocked symbol tree/sidecar response can't produce -- this is a
 * genuine round trip through the real repomap module, not a unit test.
 *
 * Standalone temp workspace (not `fixtures/`), same rationale as
 * `functionResolutionTypeScript.test.ts`/`roleGutterDecorations.test.ts`:
 * this needs a small, controlled cross-file call graph, not
 * `fixtures/REQUIREMENTS.md`'s structural counts.
 */
suite('saveReindex/SaveReindexManager + staleTracking/flagStaleDependents (Session 27, real sidecar + Ollama)', () => {
    let tempDir: string;
    let storageDir: string;
    let sharedPath: string;
    let callerPath: string;
    let sharedDocument: vscode.TextDocument;
    let callerDocument: vscode.TextDocument;
    let sidecar: SidecarManager;
    let output: vscode.OutputChannel;

    let sandbox: sinon.SinonSandbox;
    let appendLineStub: sinon.SinonStub;
    let cache: ExplanationCache;
    let staleTracker: StaleTracker;
    let manager: SaveReindexManager;

    // Only `computeResult`'s body ever changes between versions -- same line
    // count each time, so line-shift is never a confound for the fnId/fnHash
    // assertions below, only content is.
    const sharedV0 = [
        'function computeResult(x) {',
        '  return x * 2;',
        '}',
        '',
        'function computeOther(y) {',
        '  return y * 3;',
        '}',
        '',
        'module.exports = { computeResult, computeOther };',
        '',
    ].join('\n');

    const sharedV1 = sharedV0.replace('return x * 2;', 'return x * 2 + 1;');
    const sharedV2 = sharedV0.replace('return x * 2;', 'return x * 2 + 2;');

    // `useResult` is the sole caller of `computeResult`, across files, via
    // `require` -- mirrors the "one callee, real caller(s)" shape
    // `fixtures/javascript/repomap/handlers.js`'s `validateAndPersistSignup`
    // establishes (there, both callers happen to live in the same file; here
    // the call crosses a file boundary, which is what `flagStaleDependents`
    // actually needs to prove).
    const callerContent = [
        "const { computeResult } = require('./shared');",
        '',
        'function useResult(x) {',
        '  return computeResult(x) + 1;',
        '}',
        '',
        'module.exports = { useResult };',
        '',
    ].join('\n');

    function findExtensionRoot(): string {
        const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'lucidhover');
        assert.ok(ext, 'expected the lucidhover extension to be loaded under test');
        return ext!.extensionPath;
    }

    function makeFakeOutputChannel(): vscode.OutputChannel {
        appendLineStub = sinon.stub();
        return {
            name: 'fake',
            append: () => undefined,
            appendLine: appendLineStub,
            replace: () => undefined,
            clear: () => undefined,
            show: () => undefined,
            hide: () => undefined,
            dispose: () => undefined,
        } as unknown as vscode.OutputChannel;
    }

    /** Polls appendLineStub's recorded calls for an exact line match, rather than a fixed sleep. */
    async function waitForLogLine(exactLine: string, timeoutMs: number): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (appendLineStub.getCalls().some((call) => call.args[0] === exactLine)) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const seen = appendLineStub.getCalls().map((call) => String(call.args[0]));
        assert.fail(`timed out waiting for log line ${JSON.stringify(exactLine)}. Lines seen:\n${seen.join('\n')}`);
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

    async function replaceContent(document: vscode.TextDocument, newContent: string): Promise<void> {
        const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, newContent);
        const applied = await vscode.workspace.applyEdit(edit);
        assert.ok(applied, 'expected the content edit to apply');
        await waitForSymbols(document);
    }

    function cacheRowFor(fn: Awaited<ReturnType<typeof resolveAllFunctions>>[number]): CacheRow {
        return {
            cache_key: `test-${fn.fnId}-${fn.fnHash}`,
            fn_id: fn.fnId,
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: `${fn.name} explained.` }),
            fn_hash: fn.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
    }

    suiteSetup(async function () {
        // Real process spawn + real repomap indexing + real socket connect --
        // generous but bounded (SidecarManager's own real CONNECT_RETRY budget
        // is ~30s worst case; a 2-file temp repo indexes far faster than that).
        this.timeout(120_000);

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-save-reindex-'));
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-save-reindex-storage-'));
        sharedPath = path.join(tempDir, 'shared.js');
        callerPath = path.join(tempDir, 'caller.js');
        fs.writeFileSync(sharedPath, sharedV0, 'utf8');
        fs.writeFileSync(callerPath, callerContent, 'utf8');

        sharedDocument = await vscode.workspace.openTextDocument(sharedPath);
        callerDocument = await vscode.workspace.openTextDocument(callerPath);
        await waitForSymbols(sharedDocument);
        await waitForSymbols(callerDocument);

        output = vscode.window.createOutputChannel('LucidHover Save-Reindex Test (sidecar log)');
        sidecar = new SidecarManager(tempDir, findExtensionRoot(), storageDir, 'all-minilm', 'http://localhost:11434', output);
        await sidecar.start();
    });

    suiteTeardown(function () {
        sidecar?.dispose();
        // Deliberately does NOT dispose `output`: unlike every other suite's
        // output channel (which only ever receives synchronous appendLine
        // calls from stubbed/fake sidecars), this one backs a REAL child
        // process. `SidecarManager.teardown()` kills the process but doesn't
        // wait for it to actually exit, so its stdout/stderr 'data' listeners
        // (registered in `start()`, with no `disposed` guard on `log()`) can
        // still fire after this hook returns and call `appendLine` on a
        // disposed channel, throwing "Channel has been closed" as an
        // uncaught exception that corrupts later suites in the same Mocha
        // run (confirmed empirically this session -- see the artifact).
        // Leaking one output channel for the life of the test process is a
        // fine trade against that.
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(storageDir, { recursive: true, force: true });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-save-reindex-cache-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);
        staleTracker = new StaleTracker();
        manager = new SaveReindexManager(
            () => tempDir,
            () => cache,
            () => sidecar,
            () => staleTracker,
            makeFakeOutputChannel()
        );
    });

    teardown(() => {
        manager.dispose();
        cache.dispose();
        staleTracker.dispose();
        sandbox.restore();
    });

    test(
        'save-reindex: editing one function in a file regenerates only that function, leaving the other cached row untouched',
        async function () {
            this.timeout(180_000);

            // Precondition: both functions in shared.js already cached under
            // their *current* (v0) content -- so after the edit below, only
            // computeResult's fn_hash should have changed.
            const before = await resolveAllFunctions(sharedDocument, tempDir);
            const computeResultBefore = before.find((f) => f.name === 'computeResult');
            const computeOtherBefore = before.find((f) => f.name === 'computeOther');
            assert.ok(computeResultBefore && computeOtherBefore, 'precondition: both functions resolve in shared.js');
            cache.write(cacheRowFor(computeResultBefore!));
            cache.write(cacheRowFor(computeOtherBefore!));

            await replaceContent(sharedDocument, sharedV1);
            const saved = await sharedDocument.save();
            assert.ok(saved, 'expected the edited document to save');

            await waitForLogLine('save-reindex: shared.js done -- 1 regenerated, 1 unchanged (skipped)', 150_000);

            const currentOther = cache.getCurrentRowForFnId({
                fnId: computeOtherBefore!.fnId,
                modelId: resolveModelId(),
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: PROMPT_VERSION,
            });
            assert.ok(currentOther, 'expected computeOther to still have a cached row');
            assert.strictEqual(
                currentOther!.fn_hash,
                computeOtherBefore!.fnHash,
                'expected the untouched function (computeOther) to keep its original fn_hash'
            );
        }
    );

    test(
        'staleness: editing the callee flags its cross-file caller stale via a real index_file call',
        async function () {
            this.timeout(180_000);

            // Document is currently at v1 content (left there by the previous
            // test) -- resolve fresh rather than assume, then prime the cache
            // for whatever's currently on disk so this edit is a genuine,
            // detected content change.
            const before = await resolveAllFunctions(sharedDocument, tempDir);
            const computeResultBefore = before.find((f) => f.name === 'computeResult');
            const computeOtherBefore = before.find((f) => f.name === 'computeOther');
            assert.ok(computeResultBefore && computeOtherBefore, 'precondition: both functions resolve in shared.js');
            cache.write(cacheRowFor(computeResultBefore!));
            cache.write(cacheRowFor(computeOtherBefore!));

            const callerFunctions = await resolveAllFunctions(callerDocument, tempDir);
            const useResult = callerFunctions.find((f) => f.name === 'useResult');
            assert.ok(useResult, 'precondition: useResult resolves in caller.js');
            assert.strictEqual(staleTracker.isStale('caller.js', useResult!.fnId), false, 'precondition: not yet stale');

            await replaceContent(sharedDocument, sharedV2);
            const saved = await sharedDocument.save();
            assert.ok(saved, 'expected the edited document to save');

            await waitForLogLine('staleness: flagged 1 dependent function(s) stale after changes in shared.js', 150_000);

            assert.strictEqual(
                staleTracker.isStale('caller.js', useResult!.fnId),
                true,
                "expected useResult (caller.js), the cross-file caller of the edited computeResult, to be flagged stale"
            );
        }
    );
});
