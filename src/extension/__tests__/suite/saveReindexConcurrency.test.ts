import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../../cache/config';
import { ExplanationCache } from '../../cache/explanationCache';
import { resolveAllFunctions } from '../../functionResolution';
import { SaveReindexManager } from '../../saveReindex';
import { SidecarManager } from '../../sidecar/sidecarManager';

/**
 * Session 41: reproduces and closes the race session 40's manual smoke test
 * surfaced incidentally (its "Blockers / open questions": two rapid
 * successive saves of the same function produced regenerated cache rows
 * inconsistent with the live buffer's actual content). Root cause: `reindex()`
 * (saveReindex.ts) had no in-flight guard -- `KeyedDebouncer` only cancels a
 * *pending timer*, not an already-running callback, so a second save whose
 * debounce timer fires while the first save's `reindex()` is still awaiting
 * `generate_explanation` (session-06: real generation can run up to
 * `GENERATE_TIMEOUT_MS` = 120s) starts a second, fully concurrent `reindex()`
 * for the same document. Each call's `fn.fnHash` is correct for whatever the
 * live buffer held at ITS OWN read time, but `ExplanationCache.write()`'s
 * default eviction (session 39, `evictSuperseded=true`) deletes whatever row
 * `getCurrentRowForFnId` reports as "current" -- keyed only by `generated_at`
 * recency, not content freshness. A slower call finishing after a faster one
 * therefore evicts the *correct, up-to-date* row and leaves only its own
 * *stale* one behind: real data loss, not just clutter (session 40 didn't hit
 * this exact symptom only because its step 4 had eviction toggled off).
 *
 * Uses a stubbed `sidecar.request` (like hover.test.ts), not a real sidecar
 * process: the race is purely about `SaveReindexManager`'s own concurrency
 * control, and a stub gives deterministic control over exactly when each
 * `generate_explanation` call resolves -- required to force the overlap
 * window deliberately rather than hope real Ollama latency lands right.
 */
suite('saveReindex/SaveReindexManager concurrency (Session 41: overlapping reindex() race)', () => {
    let sandbox: sinon.SinonSandbox;
    let output: vscode.OutputChannel;
    let cache: ExplanationCache;
    let sidecar: SidecarManager;
    let dbPath: string;
    let tempDir: string;
    let filePath: string;
    let document: vscode.TextDocument;
    let manager: SaveReindexManager;

    const originalContent = ['function target(x) {', '  return x * 2;', '}', '', 'module.exports = { target };', ''].join(
        '\n'
    );
    const v1Content = originalContent.replace('return x * 2;', 'return x * 2 + 1;');
    const v2Content = originalContent.replace('return x * 2;', 'return x * 2 + 2;');

    async function waitForSymbols(doc: vscode.TextDocument): Promise<void> {
        for (let attempt = 0; attempt < 40; attempt++) {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                doc.uri
            );
            if (symbols && symbols.length > 0) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.fail(`document symbol provider never returned symbols for ${doc.uri.fsPath}`);
    }

    async function replaceContent(doc: vscode.TextDocument, newContent: string): Promise<void> {
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, fullRange, newContent);
        const applied = await vscode.workspace.applyEdit(edit);
        assert.ok(applied, 'expected the content edit to apply');
        await waitForSymbols(doc);
    }

    async function pollUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (predicate()) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.fail(`timed out waiting for: ${description}`);
    }

    suiteSetup(async function () {
        this.timeout(20_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-save-reindex-concurrency-'));
        filePath = path.join(tempDir, 'target.js');
        fs.writeFileSync(filePath, originalContent, 'utf8');
        document = await vscode.workspace.openTextDocument(filePath);
        await waitForSymbols(document);
    });

    suiteTeardown(function () {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        output = vscode.window.createOutputChannel('LucidHover Save-Reindex Concurrency Test');
        dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-save-reindex-concurrency-cache-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);
        sidecar = new SidecarManager(
            tempDir,
            path.join(os.tmpdir(), 'lucidhover-test-extension'),
            path.join(os.tmpdir(), 'lucidhover-test-storage'),
            'all-minilm',
            'http://localhost:11434',
            output
        );
        manager = new SaveReindexManager(
            () => tempDir,
            () => cache,
            () => sidecar,
            () => undefined,
            output
        );
    });

    teardown(async () => {
        manager.dispose();
        cache.dispose();
        output.dispose();
        sandbox.restore();
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
        // Leave the document back at its original content so later tests in
        // the same suite run (if any share this temp file) start clean --
        // moot today since this suite owns filePath exclusively, but cheap.
        await replaceContent(document, originalContent);
    });

    test(
        'two saves spaced across a slow generate_explanation call never run reindex() concurrently, and the final cached row matches the live buffer',
        async function () {
            this.timeout(30_000);

            const before = await resolveAllFunctions(document, tempDir);
            const targetBefore = before.find((f) => f.name === 'target');
            assert.ok(targetBefore, 'precondition: target() resolves in the fixture file');
            cache.write({
                cache_key: `test-${targetBefore!.fnId}-${targetBefore!.fnHash}`,
                fn_id: targetBefore!.fnId,
                explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: 'Doubles x.' }),
                fn_hash: targetBefore!.fnHash,
                context_hash: 'ctx',
                model_id: resolveModelId(),
                embedding_model_id: EMBEDDING_MODEL_ID,
                prompt_version: PROMPT_VERSION,
                context_tier: 'call_graph_only',
                generated_at: new Date().toISOString(),
            });

            const generateCalls: { fn_source: string }[] = [];
            const pendingResolvers: Array<() => void> = [];
            sandbox.stub(sidecar, 'request').callsFake(async (method: string, params?: unknown) => {
                if (method === 'reindex_file') {
                    return {};
                }
                if (method === 'generate_explanation') {
                    const p = params as { fn_source: string };
                    generateCalls.push({ fn_source: p.fn_source });
                    return new Promise<unknown>((resolve) => {
                        pendingResolvers.push(() =>
                            resolve({
                                context_hash: 'ctx-generated',
                                context_tier: 'call_graph_only',
                                explanation: { role_tag: 'utility', one_liner: 'Regenerated.' },
                            })
                        );
                    });
                }
                throw new Error(`unexpected sidecar.request(${method}) in this test`);
            });

            // Save 1 (-> v1Content): after the 750ms debounce, reindex() reads
            // the buffer (currently v1Content), finds target()'s hash changed,
            // and calls generate_explanation -- which the stub above leaves
            // pending indefinitely until this test resolves it explicitly.
            await replaceContent(document, v1Content);
            assert.ok(await document.save(), 'expected save 1 to succeed');
            await pollUntil(() => generateCalls.length === 1, 10_000, 'first generate_explanation call to start');

            // Save 2 (-> v2Content) while save 1's reindex() is still stuck
            // awaiting that first generate_explanation call. Its own debounce
            // timer will fire ~750ms after this save. The bug (no in-flight
            // guard) would let this start a SECOND, fully concurrent
            // reindex() immediately; the fix must not let a second
            // generate_explanation call start until the first one's whole
            // reindex() pass has completed.
            await replaceContent(document, v2Content);
            assert.ok(await document.save(), 'expected save 2 to succeed');

            // Give save 2's debounce window (750ms) plenty of room to fire,
            // then assert no second reindex() snuck in while the first is
            // still in flight -- this is the actual regression assertion;
            // everything above just sets up the race.
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            assert.strictEqual(
                generateCalls.length,
                1,
                'a second save must not start a concurrent reindex() while one is already generating for the same document'
            );

            // Let save 1's generate_explanation resolve now. Its content
            // (v1Content) is stale relative to the buffer's current v2Content
            // -- the fix's guard must schedule a fresh rerun afterward rather
            // than treating save 1's stale result as the final word.
            pendingResolvers[0]();
            await pollUntil(() => generateCalls.length === 2, 10_000, 'the rerun\'s generate_explanation call to start');
            assert.match(
                generateCalls[1].fn_source,
                /x \* 2 \+ 2/,
                "expected the rerun to read the buffer's CURRENT content (v2Content), not stale content"
            );

            pendingResolvers[1]();

            const after = await resolveAllFunctions(document, tempDir);
            const targetAfter = after.find((f) => f.name === 'target');
            assert.ok(targetAfter, "expected target() to still resolve after the rerun's edits");

            await pollUntil(() => {
                const row = cache.getCurrentRowForFnId({
                    fnId: targetBefore!.fnId,
                    modelId: resolveModelId(),
                    embeddingModelId: EMBEDDING_MODEL_ID,
                    promptVersion: PROMPT_VERSION,
                });
                return row !== undefined && row.fn_hash === targetAfter!.fnHash;
            }, 10_000, "the cache's current row to converge on the live buffer's fn_hash");

            const finalRow = cache.getCurrentRowForFnId({
                fnId: targetBefore!.fnId,
                modelId: resolveModelId(),
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: PROMPT_VERSION,
            });
            assert.strictEqual(
                finalRow!.fn_hash,
                targetAfter!.fnHash,
                "the cache's current row for target() must match the live buffer's actual current content"
            );
        }
    );
});
