/**
 * Session 52: regression coverage for pause/resume -- `BackgroundIndexManager`
 * already skipped anything cache-hit on a fresh `start()` (Session 9's own
 * design), which makes cancel-then-restart a de facto resume, but there was
 * no user-facing way to trigger a second `start()` and no state distinguishing
 * "paused by the user" from "finished naturally." This suite proves the new
 * `pause()`/`resume()`/`toggle()`/phase machinery actually behaves like a
 * pause+resume, not a restart-from-scratch: a paused pass leaves the
 * already-generated function cached and never regenerates it on resume, only
 * picking up the function it hadn't reached yet.
 *
 * No real sidecar process or Ollama needed -- `sidecar.request`/
 * `waitForInteractiveIdle` are stubbed directly on a real (but never
 * `.start()`ed) `SidecarManager` instance, same "stub the instance method,
 * don't spawn a real process" approach `sidecarManager.test.ts` uses for its
 * own injected-fake-transport tests.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { BackgroundIndexManager } from '../../backgroundIndex';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../../cache/config';
import { ExplanationCache } from '../../cache/explanationCache';
import { resolveAllFunctions } from '../../functionResolution';
// Namespace import alongside the named one above -- needed to `sandbox.spy`
// the module's exported `resolveAllFunctions` (Session 67's same-file dedup
// test below), same pattern explanationPanelProvider.test.ts already uses to
// stub `resolveEnclosingFunction`.
import * as functionResolution from '../../functionResolution';
import { SidecarManager } from '../../sidecar/sidecarManager';

suite('backgroundIndex pause/resume (Session 52)', () => {
    let tempDir: string;
    let output: vscode.OutputChannel;
    let sandbox: sinon.SinonSandbox;
    let cache: ExplanationCache;
    let sidecar: SidecarManager;
    let manager: BackgroundIndexManager;

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

    async function waitForPhase(phase: string, timeoutMs = 15_000): Promise<void> {
        const start = Date.now();
        while (manager.getPhase() !== phase) {
            if (Date.now() - start > timeoutMs) {
                assert.fail(`timed out waiting for phase "${phase}"; last phase was "${manager.getPhase()}"`);
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    const aContent = 'function a() {\n  return 1;\n}\n';
    const bContent = 'function b() {\n  return 2;\n}\n';

    suiteSetup(async function () {
        this.timeout(30_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-bg-index-'));
        fs.writeFileSync(path.join(tempDir, 'a.js'), aContent, 'utf8');
        fs.writeFileSync(path.join(tempDir, 'b.js'), bContent, 'utf8');

        const aDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'a.js'));
        await waitForSymbols(aDocument);
        const bDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'b.js'));
        await waitForSymbols(bDocument);

        output = vscode.window.createOutputChannel('LucidHover Background Index Test');
    });

    suiteTeardown(function () {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-bg-index-cache-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);
        // Never `.start()`ed -- no real process/socket, just an instance
        // whose `request`/`waitForInteractiveIdle` methods get stubbed
        // directly below.
        sidecar = new SidecarManager(tempDir, findExtensionRoot(), '', 'all-minilm', 'http://localhost:11434', output);
        // Session 67: `concurrency: 1` -- this suite's existing tests assert
        // exact single-item ordering (pause lands right after the first
        // item, progress advances 0/2 -> 1/2 in lockstep with a() finishing
        // before b() starts), which only holds with a single worker. The
        // real worker-pool default (`BACKGROUND_INDEX_CONCURRENCY`) is
        // exercised by the dedicated "concurrent worker pool" tests below,
        // which construct their own manager instance with a higher value.
        manager = new BackgroundIndexManager(() => tempDir, () => cache, () => sidecar, output, 1);
    });

    teardown(() => {
        manager.dispose();
        cache.dispose();
        sandbox.restore();
    });

    test('pausing mid-pass leaves the already-generated function cached; resuming generates only the remaining one, never regenerating the first', async function () {
        this.timeout(20_000);

        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        let pausedOnce = false;
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({
            functions: [
                { rel_fname: 'a.js', name: 'a', line: 0, importance: 2 },
                { rel_fname: 'b.js', name: 'b', line: 0, importance: 1 },
            ],
        });
        requestStub.withArgs('generate_explanation').callsFake(async (_method: string, rawParams: unknown) => {
            const params = rawParams as { name: string };
            if (params.name === 'a' && !pausedOnce) {
                pausedOnce = true;
                // Pauses mid-pass, right after a()'s own generation call is
                // already in flight -- deterministic (no reliance on the
                // real 1s inter-generation delay) since the cancellation
                // token is only checked at the loop's next checkpoint, after
                // this call resolves.
                manager.pause();
            }
            return {
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: `explained ${params.name}` },
            };
        });

        manager.start();
        assert.strictEqual(manager.getPhase(), 'running');

        await waitForPhase('paused');

        const aDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'a.js'));
        const aFunctions = await resolveAllFunctions(aDocument, tempDir);
        const a = aFunctions.find((f) => f.name === 'a');
        assert.ok(a, 'expected to resolve a()');
        const bDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'b.js'));
        const bFunctions = await resolveAllFunctions(bDocument, tempDir);
        const b = bFunctions.find((f) => f.name === 'b');
        assert.ok(b, 'expected to resolve b()');

        const lookup = (fn: { fnId: string; fnHash: string }) =>
            cache.lookup({
                fnId: fn.fnId,
                fnHash: fn.fnHash,
                modelId: resolveModelId(),
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: PROMPT_VERSION,
            });

        assert.ok(lookup(a!), 'expected a() to be cached after the pause');
        assert.strictEqual(lookup(b!), undefined, 'expected b() to be NOT yet cached -- the pass paused before reaching it');
        assert.strictEqual(
            requestStub.getCalls().filter((c) => c.args[0] === 'generate_explanation').length,
            1,
            'expected exactly one generate_explanation call so far (for a())'
        );

        manager.resume();
        await waitForPhase('idle');

        assert.ok(lookup(a!), 'expected a() to still be cached after resume');
        assert.ok(lookup(b!), 'expected b() to be cached after resume finished the pass');
        assert.strictEqual(
            requestStub.getCalls().filter((c) => c.args[0] === 'generate_explanation').length,
            2,
            'expected exactly 2 generate_explanation calls total -- resume must skip the already-cached a() and only generate b(), never regenerating a()'
        );
        const aCalls = requestStub
            .getCalls()
            .filter((c) => c.args[0] === 'generate_explanation' && (c.args[1] as { name: string }).name === 'a');
        assert.strictEqual(aCalls.length, 1, 'a() must never be regenerated after resume');
    });

    test('pause() is a no-op with a status message when nothing is running', () => {
        assert.strictEqual(manager.getPhase(), 'idle');
        // Should not throw, and phase stays idle.
        manager.pause();
        assert.strictEqual(manager.getPhase(), 'idle');
    });

    test('toggle() pauses a running pass and resumes a paused one', async function () {
        this.timeout(20_000);

        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({
            functions: [{ rel_fname: 'a.js', name: 'a', line: 0, importance: 1 }],
        });
        requestStub.withArgs('generate_explanation').callsFake(async () => {
            manager.toggle(); // pauses, since a pass is running
            return {
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: 'explained a' },
            };
        });

        manager.start();
        await waitForPhase('paused');

        manager.toggle(); // resumes
        await waitForPhase('idle');

        assert.strictEqual(
            requestStub.getCalls().filter((c) => c.args[0] === 'generate_explanation').length,
            1,
            'a() was already cached by the first (paused) pass, so resume should have generated nothing new'
        );
    });

    test('status-bar text shows an advancing N/total progress count while a pass runs (Session 64)', async function () {
        this.timeout(20_000);

        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({
            functions: [
                { rel_fname: 'a.js', name: 'a', line: 0, importance: 2 },
                { rel_fname: 'b.js', name: 'b', line: 0, importance: 1 },
            ],
        });

        const barTextsDuringGeneration: string[] = [];
        requestStub.withArgs('generate_explanation').callsFake(async (_method: string, rawParams: unknown) => {
            const params = rawParams as { name: string };
            const statusBarItem = (manager as unknown as { statusBarItem: vscode.StatusBarItem }).statusBarItem;
            // Captured mid-call, before this function's own generation
            // resolves -- proves the count reflects functions completed
            // *so far*, not the one currently in flight.
            barTextsDuringGeneration.push(statusBarItem.text);
            return {
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: `explained ${params.name}` },
            };
        });

        manager.start();
        await waitForPhase('idle');

        assert.deepStrictEqual(barTextsDuringGeneration, [
            '$(sync~spin) LucidHover: indexing 0/2',
            '$(sync~spin) LucidHover: indexing 1/2',
        ]);
    });

    test('the progress count survives into the paused state, frozen at the point of pause (Session 64)', async function () {
        this.timeout(20_000);

        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        let pausedOnce = false;
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({
            functions: [
                { rel_fname: 'a.js', name: 'a', line: 0, importance: 2 },
                { rel_fname: 'b.js', name: 'b', line: 0, importance: 1 },
            ],
        });
        requestStub.withArgs('generate_explanation').callsFake(async (_method: string, rawParams: unknown) => {
            const params = rawParams as { name: string };
            if (params.name === 'a' && !pausedOnce) {
                pausedOnce = true;
                manager.pause();
            }
            return {
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: `explained ${params.name}` },
            };
        });

        manager.start();
        await waitForPhase('paused');

        const statusBarItem = (manager as unknown as { statusBarItem: vscode.StatusBarItem }).statusBarItem;
        assert.strictEqual(statusBarItem.text, '$(debug-pause) LucidHover: indexing paused 1/2');
        assert.ok(
            (statusBarItem.tooltip as string).includes('1 generated, 0 already cached, 0 unresolved (50% of 2)'),
            `expected the paused tooltip to carry the frozen breakdown, got: ${statusBarItem.tooltip}`
        );
    });

    test('the tooltip shows an ETA only after at least one generation has completed (Session 64)', async function () {
        this.timeout(20_000);

        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({
            functions: [
                { rel_fname: 'a.js', name: 'a', line: 0, importance: 2 },
                { rel_fname: 'b.js', name: 'b', line: 0, importance: 1 },
            ],
        });

        const tooltipsDuringA: string[] = [];
        let pausedOnB = false;
        requestStub.withArgs('generate_explanation').callsFake(async (_method: string, rawParams: unknown) => {
            const params = rawParams as { name: string };
            const statusBarItem = (manager as unknown as { statusBarItem: vscode.StatusBarItem }).statusBarItem;
            if (params.name === 'a') {
                // No generation has completed yet at this point -- the ETA
                // line must not appear.
                tooltipsDuringA.push(statusBarItem.tooltip as string);
            } else if (params.name === 'b' && !pausedOnB) {
                pausedOnB = true;
                // a() has completed by now, feeding the rolling average one
                // sample. Pausing here doesn't stop b() itself from
                // generating (cancellation is only checked at the loop's
                // next checkpoint, and b() is the last ranked entry, so the
                // pass ends here regardless) -- it just gets the manager
                // into 'paused' so the assertion below can read a frozen
                // tooltip computed from that one completed sample.
                manager.pause();
            }
            return {
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: `explained ${params.name}` },
            };
        });

        manager.start();
        await waitForPhase('paused');

        assert.strictEqual(tooltipsDuringA.length, 1);
        assert.ok(
            !tooltipsDuringA[0].includes('remaining'),
            `expected no ETA before any generation had completed, got: ${tooltipsDuringA[0]}`
        );

        const statusBarItem = (manager as unknown as { statusBarItem: vscode.StatusBarItem }).statusBarItem;
        assert.ok(
            (statusBarItem.tooltip as string).includes('remaining'),
            `expected an ETA once a() had completed, got: ${statusBarItem.tooltip}`
        );
    });

    test('dispose() mid-pass does not crash the suspended run() when it later resumes and reaches finish() (code-review finding)', async function () {
        this.timeout(20_000);

        // `start()`'s `run()` is fire-and-forget (never awaited), so a
        // dispose() while a generate_explanation call is in flight -- the
        // real "extension deactivating / window closing mid-pass" scenario
        // -- leaves that suspended call to resume and still walk through to
        // `finish()` -> `updateStatusBar()` after the manager's own
        // `statusBarItem` has already been torn down. If `updateStatusBar()`
        // doesn't guard against that, this either throws synchronously here
        // or produces an unhandled rejection in `run()`'s un-awaited
        // promise (which, left unfixed, is disruptive enough to the whole
        // Extension Development Host process that it would likely take
        // other tests down with it, not just this one).
        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({
            functions: [{ rel_fname: 'a.js', name: 'a', line: 0, importance: 1 }],
        });
        let disposedDuringGeneration = false;
        requestStub.withArgs('generate_explanation').callsFake(async () => {
            manager.dispose();
            disposedDuringGeneration = true;
            return {
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: 'explained a' },
            };
        });

        manager.start();
        await waitForPhase('idle');

        assert.strictEqual(disposedDuringGeneration, true, 'expected dispose() to actually fire mid-generation');
        // Reaching here at all (no thrown/unhandled exception along the
        // way) is the assertion -- `teardown()`'s own `manager.dispose()`
        // call right after this must also not throw on an
        // already-disposed manager.
    });

    test('a failed generate_explanation call is counted as done, so the pass still reaches 100% instead of undercounting forever (Session 65)', async function () {
        this.timeout(20_000);

        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({
            functions: [
                { rel_fname: 'a.js', name: 'a', line: 0, importance: 2 },
                { rel_fname: 'b.js', name: 'b', line: 0, importance: 1 },
            ],
        });
        requestStub.withArgs('generate_explanation').callsFake(async (_method: string, rawParams: unknown) => {
            const params = rawParams as { name: string };
            if (params.name === 'a') {
                throw new Error('simulated generation failure');
            }
            return {
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: `explained ${params.name}` },
            };
        });

        manager.start();
        await waitForPhase('idle');

        // `updateStatusBar()`'s 'idle' case only hides the item -- it
        // doesn't rewrite text/tooltip -- so what's left here is the last
        // value written by the loop itself, after b() (the final entry)
        // completed.
        const statusBarItem = (manager as unknown as { statusBarItem: vscode.StatusBarItem }).statusBarItem;
        assert.strictEqual(
            statusBarItem.text,
            '$(sync~spin) LucidHover: indexing 2/2',
            'a failed attempt must still count toward the fraction reaching total, not leave it stuck below 100%'
        );
        assert.ok(
            (statusBarItem.tooltip as string).includes(
                '1 generated, 0 already cached, 0 unresolved, 1 failed (100% of 2)'
            ),
            `expected the breakdown to reach 100% and append the failed clause, got: ${statusBarItem.tooltip}`
        );
    });

    test('the completion toast includes the failure count when nonzero and omits it (unchanged wording) when zero (Session 65)', async function () {
        this.timeout(20_000);

        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        const setStatusBarMessageStub = sandbox.stub(vscode.window, 'setStatusBarMessage');
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({
            functions: [
                { rel_fname: 'a.js', name: 'a', line: 0, importance: 2 },
                { rel_fname: 'b.js', name: 'b', line: 0, importance: 1 },
            ],
        });
        requestStub.withArgs('generate_explanation').callsFake(async (_method: string, rawParams: unknown) => {
            const params = rawParams as { name: string };
            if (params.name === 'a') {
                throw new Error('simulated generation failure');
            }
            return {
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: `explained ${params.name}` },
            };
        });

        manager.start();
        await waitForPhase('idle');

        const finalToast = setStatusBarMessageStub.getCalls().map((c) => c.args[0] as string).pop();
        assert.ok(finalToast, 'expected a completion toast to have been shown');
        assert.strictEqual(
            finalToast,
            'LucidHover: background indexing done -- 1 generated, 0 already cached, 0 unresolved, 1 failed',
            `expected the toast to append the failed clause, got: ${finalToast}`
        );
    });

    test('a clean pass with no failures shows unchanged wording, with no failed clause (Session 65 regression)', async function () {
        this.timeout(20_000);

        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        const setStatusBarMessageStub = sandbox.stub(vscode.window, 'setStatusBarMessage');
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({
            functions: [{ rel_fname: 'a.js', name: 'a', line: 0, importance: 1 }],
        });
        requestStub.withArgs('generate_explanation').resolves({
            context_hash: 'ctx',
            context_tier: 'call_graph_only',
            explanation: { role_tag: 'utility', one_liner: 'explained a' },
        });

        manager.start();
        await waitForPhase('idle');

        const finalToast = setStatusBarMessageStub.getCalls().map((c) => c.args[0] as string).pop();
        assert.strictEqual(
            finalToast,
            'LucidHover: background indexing done -- 1 generated, 0 already cached, 0 unresolved',
            `expected a clean pass's wording to be unchanged from Session 64, got: ${finalToast}`
        );
    });

    test("a failed attempt counts as done for the ETA's remaining calculation, not left outstanding forever (Session 65)", async function () {
        this.timeout(20_000);

        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({
            functions: [
                { rel_fname: 'a.js', name: 'a', line: 0, importance: 3 },
                { rel_fname: 'b.js', name: 'b', line: 0, importance: 2 },
                { rel_fname: 'b.js', name: 'b', line: 0, importance: 1 },
            ],
        });

        requestStub.withArgs('generate_explanation').callsFake(async (_method: string, rawParams: unknown) => {
            const params = rawParams as { name: string };
            if (params.name === 'a') {
                throw new Error('simulated generation failure');
            }
            return {
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: `explained ${params.name}` },
            };
        });

        // Reads the manager's private progress/completion-timestamp state
        // via a short poll right after the pass's first successful
        // generation lands, rather than trying to intercept mid-call.
        let capturedEtaMs: number | undefined;
        let capturedTimestamps: number[] | undefined;
        manager.start();
        const internals = manager as unknown as {
            progress: { total: number; generated: number; failed: number; etaMs: number | undefined } | undefined;
            generationCompletionTimestamps: number[];
        };
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            // `generationCompletionTimestamps` is seeded with the pass's own
            // start time immediately (Session 67), so its length is always
            // >= 1 from the very start -- `>= 2` is the real "at least one
            // completion recorded" condition here (seed + 1 completion).
            if (internals.progress && internals.progress.generated >= 1 && internals.generationCompletionTimestamps.length >= 2) {
                capturedEtaMs = internals.progress.etaMs;
                capturedTimestamps = internals.generationCompletionTimestamps.slice();
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await waitForPhase('idle');

        assert.ok(
            capturedTimestamps && capturedTimestamps.length === 2,
            'expected exactly one recorded completion timestamp (plus the pass-start seed) at capture time -- the failed attempt for a() must not have recorded one'
        );
        assert.ok(capturedEtaMs !== undefined, 'expected an ETA to have been computed');
        // remaining = total(3) - doneCount(generated=1, failed=1) = 1, so
        // etaMs must equal exactly 1x the elapsed time between the
        // pass-start seed and the one recorded completion -- if a failed
        // attempt were still treated as "remaining" (the pre-fix bug),
        // doneCount would only be 1 and remaining would be 2, doubling this
        // value; if a failed attempt had also fed the completion-rate
        // window (this session's analogous risk), the window would include
        // an extra, wrong sample.
        const expectedEtaMs = capturedTimestamps![1] - capturedTimestamps![0];
        // Not `assert.strictEqual` -- `recordGenerationCompletion()` computes
        // this as `remaining / (completions / elapsedMs)`, and that
        // divide-then-divide-back can differ from `elapsedMs` itself by a
        // sub-millisecond floating-point rounding error even though they're
        // mathematically identical here (completions=1, remaining=1).
        assert.ok(
            Math.abs(capturedEtaMs! - expectedEtaMs) < 0.01,
            `expected etaMs (${capturedEtaMs}) to match the elapsed time between the seed and the one completion (${expectedEtaMs}) to within floating-point rounding`
        );
    });

    /**
     * Session 66: narrows the default pass to the highest-importance slice
     * of the ranked list instead of the whole repo. `lucidHover.
     * backgroundIndexScope`/`backgroundIndexTopN` are real settings read via
     * `vscode.workspace.getConfiguration`, so these tests set them for real
     * (`ConfigurationTarget.Global`, since the test workspace here is a bare
     * temp dir with no workspace folder to scope a `Workspace`-target update
     * to) and always reset them back to unset in a `finally`, so a failure
     * mid-test can't leak the override into a later test in this same
     * Extension Development Host process.
     */
    async function setConfig(key: string, value: unknown): Promise<void> {
        await vscode.workspace.getConfiguration('lucidHover').update(key, value, vscode.ConfigurationTarget.Global);
    }

    test('default scope (topN, unset) indexes every ranked function when there are fewer than the default 200 (Session 66)', async function () {
        this.timeout(20_000);

        sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
        const requestStub = sandbox.stub(sidecar, 'request');
        requestStub.withArgs('list_ranked_functions').resolves({
            functions: [
                { rel_fname: 'a.js', name: 'a', line: 0, importance: 2 },
                { rel_fname: 'b.js', name: 'b', line: 0, importance: 1 },
            ],
        });
        requestStub.withArgs('generate_explanation').resolves({
            context_hash: 'ctx',
            context_tier: 'call_graph_only',
            explanation: { role_tag: 'utility', one_liner: 'explained' },
        });

        manager.start();
        await waitForPhase('idle');

        assert.strictEqual(
            requestStub.getCalls().filter((c) => c.args[0] === 'generate_explanation').length,
            2,
            'expected both ranked functions to be generated -- the default topN (200) exceeds this test\'s ranked-list size, so nothing should be truncated'
        );
    });

    test('a small backgroundIndexTopN truncates the pass to only the top-N most important functions (Session 66)', async function () {
        this.timeout(20_000);
        await setConfig('backgroundIndexTopN', 1);
        try {
            sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
            const requestStub = sandbox.stub(sidecar, 'request');
            requestStub.withArgs('list_ranked_functions').resolves({
                functions: [
                    { rel_fname: 'a.js', name: 'a', line: 0, importance: 2 },
                    { rel_fname: 'b.js', name: 'b', line: 0, importance: 1 },
                ],
            });
            requestStub.withArgs('generate_explanation').resolves({
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: 'explained' },
            });

            manager.start();
            await waitForPhase('idle');

            const generateCalls = requestStub.getCalls().filter((c) => c.args[0] === 'generate_explanation');
            assert.strictEqual(generateCalls.length, 1, 'expected only the top-1 (by importance) function to be generated');
            assert.strictEqual(
                (generateCalls[0].args[1] as { name: string }).name,
                'a',
                'expected the single generated function to be the higher-importance one (a, importance 2), not b (importance 1)'
            );

            const statusBarItem = (manager as unknown as { statusBarItem: vscode.StatusBarItem }).statusBarItem;
            assert.ok(
                (statusBarItem.tooltip as string).includes('(100% of 1)'),
                `expected progress total to reflect the truncated scope (1), not the full ranked list (2), got: ${statusBarItem.tooltip}`
            );
        } finally {
            await setConfig('backgroundIndexTopN', undefined);
        }
    });

    test('backgroundIndexScope "fullRepo" opts out of the topN truncation even when backgroundIndexTopN is small (Session 66)', async function () {
        this.timeout(20_000);
        await setConfig('backgroundIndexScope', 'fullRepo');
        await setConfig('backgroundIndexTopN', 1);
        try {
            sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
            const requestStub = sandbox.stub(sidecar, 'request');
            requestStub.withArgs('list_ranked_functions').resolves({
                functions: [
                    { rel_fname: 'a.js', name: 'a', line: 0, importance: 2 },
                    { rel_fname: 'b.js', name: 'b', line: 0, importance: 1 },
                ],
            });
            requestStub.withArgs('generate_explanation').resolves({
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: 'explained' },
            });

            manager.start();
            await waitForPhase('idle');

            assert.strictEqual(
                requestStub.getCalls().filter((c) => c.args[0] === 'generate_explanation').length,
                2,
                'expected "fullRepo" scope to index every ranked function, ignoring backgroundIndexTopN entirely'
            );
        } finally {
            await setConfig('backgroundIndexScope', undefined);
            await setConfig('backgroundIndexTopN', undefined);
        }
    });

    /**
     * Session 67: raises `run()`'s generation loop from strictly-one-at-a-time
     * to a small concurrent worker pool (closing the strategy review's #2
     * backlog item). These tests construct their own `BackgroundIndexManager`
     * with an explicit `concurrency` (the injectable 5th constructor param,
     * same precedent as `sidecarManager.ts`'s `spawnFn`/`connectFn`) rather
     * than reusing the shared `manager`/`sidecar` from `setup()` above, which
     * is pinned to `concurrency: 1` for this suite's other, order-sensitive
     * tests. Two extra fixture files (c.js/d.js) are created and
     * symbol-resolved up front, alongside the shared a.js/b.js, so all four
     * functions' `resolveFileSymbols` calls hit already-open documents at
     * pool-run time -- minimizing real language-server timing variance
     * between workers so the concurrency assertions below aren't flaky.
     */
    suite('concurrent worker pool (Session 67)', () => {
        let poolManager: BackgroundIndexManager | undefined;

        setup(async function () {
            this.timeout(20_000);
            fs.writeFileSync(path.join(tempDir, 'c.js'), 'function c() {\n  return 3;\n}\n', 'utf8');
            fs.writeFileSync(path.join(tempDir, 'd.js'), 'function d() {\n  return 4;\n}\n', 'utf8');
            const cDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'c.js'));
            await waitForSymbols(cDocument);
            const dDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'd.js'));
            await waitForSymbols(dDocument);
        });

        teardown(() => {
            poolManager?.dispose();
            poolManager = undefined;
            fs.rmSync(path.join(tempDir, 'c.js'), { force: true });
            fs.rmSync(path.join(tempDir, 'd.js'), { force: true });
            // Only the same-file-dedup test creates this one; removing an
            // absent file with `force: true` is a no-op for every other test
            // in this nested suite.
            fs.rmSync(path.join(tempDir, 'shared.js'), { force: true });
        });

        const fourFunctionsRanked = [
            { rel_fname: 'a.js', name: 'a', line: 0, importance: 4 },
            { rel_fname: 'b.js', name: 'b', line: 0, importance: 3 },
            { rel_fname: 'c.js', name: 'c', line: 0, importance: 2 },
            { rel_fname: 'd.js', name: 'd', line: 0, importance: 1 },
        ];

        test('runs more than one generate_explanation call concurrently, not strictly one at a time', async function () {
            this.timeout(20_000);

            sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
            const requestStub = sandbox.stub(sidecar, 'request');
            requestStub.withArgs('list_ranked_functions').resolves({ functions: fourFunctionsRanked });

            let inFlight = 0;
            let maxInFlight = 0;
            requestStub.withArgs('generate_explanation').callsFake(async (_method: string, rawParams: unknown) => {
                const params = rawParams as { name: string };
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                // Held open long enough that, if the pool is genuinely
                // concurrent, the other workers' own calls land inside this
                // same window -- a strictly-serial loop (concurrency 1)
                // would never observe inFlight > 1 no matter how long this
                // holds.
                await new Promise((resolve) => setTimeout(resolve, 150));
                inFlight--;
                return {
                    context_hash: 'ctx',
                    context_tier: 'call_graph_only',
                    explanation: { role_tag: 'utility', one_liner: `explained ${params.name}` },
                };
            });

            poolManager = new BackgroundIndexManager(() => tempDir, () => cache, () => sidecar, output, 3);
            poolManager.start();

            const deadline = Date.now() + 15_000;
            while (poolManager.getPhase() !== 'idle' && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.strictEqual(poolManager.getPhase(), 'idle', 'expected the pass to finish within the test timeout');

            assert.strictEqual(
                requestStub.getCalls().filter((c) => c.args[0] === 'generate_explanation').length,
                4,
                'expected all 4 ranked functions to be generated'
            );
            assert.ok(
                maxInFlight >= 2,
                `expected at least 2 generate_explanation calls in flight at once with a concurrency-3 pool, observed max ${maxInFlight}`
            );
        });

        test('two workers claiming functions from the same file share one resolveAllFunctions call, not two (code-review finding)', async function () {
            this.timeout(20_000);

            // Two functions in one file, given the pool's top two importance
            // slots so a concurrency-2 pool's two workers claim them
            // together at pass start -- the scenario `getFileSymbols`'s
            // `Promise`-valued cache (rather than a resolved-value cache) is
            // for, but which no other pool test actually exercises (every
            // other test here uses 4 distinct single-function files).
            fs.writeFileSync(
                path.join(tempDir, 'shared.js'),
                'function shared1() {\n  return 1;\n}\n\nfunction shared2() {\n  return 2;\n}\n',
                'utf8'
            );
            const sharedDocument = await vscode.workspace.openTextDocument(path.join(tempDir, 'shared.js'));
            await waitForSymbols(sharedDocument);

            sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
            const requestStub = sandbox.stub(sidecar, 'request');
            requestStub.withArgs('list_ranked_functions').resolves({
                functions: [
                    { rel_fname: 'shared.js', name: 'shared1', line: 0, importance: 2 },
                    { rel_fname: 'shared.js', name: 'shared2', line: 4, importance: 1 },
                ],
            });
            requestStub.withArgs('generate_explanation').callsFake(async (_method: string, rawParams: unknown) => {
                const params = rawParams as { name: string };
                // Held open so both workers are genuinely resolving/
                // generating around the same time -- if `getFileSymbols`
                // were duplicating the resolution instead of sharing the
                // in-flight promise, a second `resolveAllFunctions` call for
                // shared.js would show up inside this window.
                await new Promise((resolve) => setTimeout(resolve, 100));
                return {
                    context_hash: 'ctx',
                    context_tier: 'call_graph_only',
                    explanation: { role_tag: 'utility', one_liner: `explained ${params.name}` },
                };
            });

            const resolveAllFunctionsSpy = sandbox.spy(functionResolution, 'resolveAllFunctions');

            poolManager = new BackgroundIndexManager(() => tempDir, () => cache, () => sidecar, output, 2);
            poolManager.start();

            const deadline = Date.now() + 15_000;
            while (poolManager.getPhase() !== 'idle' && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.strictEqual(poolManager.getPhase(), 'idle', 'expected the pass to finish within the test timeout');

            const sharedJsCalls = resolveAllFunctionsSpy
                .getCalls()
                .filter((call) => (call.args[0] as vscode.TextDocument).uri.fsPath === sharedDocument.uri.fsPath);
            assert.strictEqual(
                sharedJsCalls.length,
                1,
                `expected exactly one resolveAllFunctions call for shared.js even though two ranked functions share it, got ${sharedJsCalls.length}`
            );
            assert.strictEqual(
                requestStub.getCalls().filter((c) => c.args[0] === 'generate_explanation').length,
                2,
                'expected both functions in the shared file to still be generated despite sharing one resolution'
            );
        });

        test('pause() with a concurrent pool lets already-in-flight generations finish but claims no further work', async function () {
            this.timeout(20_000);

            sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
            const requestStub = sandbox.stub(sidecar, 'request');
            requestStub.withArgs('list_ranked_functions').resolves({ functions: fourFunctionsRanked });

            // Waits for *both* of the pool's 2 workers to have already
            // reached their own generate_explanation call (past the
            // post-`waitForInteractiveIdle` cancellation checkpoint) before
            // pausing -- pausing as soon as the *first* one arrives would
            // race the second worker's own still-in-flight symbol
            // resolution: if that worker hadn't reached its own
            // cancellation checkpoint yet, it would see the
            // already-cancelled token there and return without ever calling
            // generate_explanation, leaving only 1 call instead of the 2
            // this test asserts. Gating on `startedCount === 2` instead
            // removes that race entirely.
            let startedCount = 0;
            requestStub.withArgs('generate_explanation').callsFake(async (_method: string, rawParams: unknown) => {
                const params = rawParams as { name: string };
                startedCount++;
                if (startedCount === 2) {
                    poolManager!.pause();
                }
                // A short hold so pause() (fired above once both calls have
                // started) lands well before either resolves and a 3rd item
                // could be claimed.
                await new Promise((resolve) => setTimeout(resolve, 100));
                return {
                    context_hash: 'ctx',
                    context_tier: 'call_graph_only',
                    explanation: { role_tag: 'utility', one_liner: `explained ${params.name}` },
                };
            });

            poolManager = new BackgroundIndexManager(() => tempDir, () => cache, () => sidecar, output, 2);
            poolManager.start();

            const deadline = Date.now() + 15_000;
            while (poolManager.getPhase() !== 'paused' && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.strictEqual(poolManager.getPhase(), 'paused', 'expected the pass to reach paused within the test timeout');

            const generateCalls = requestStub.getCalls().filter((c) => c.args[0] === 'generate_explanation');
            assert.strictEqual(
                generateCalls.length,
                2,
                'expected exactly 2 generate_explanation calls (the concurrency-2 pool\'s two initial claims), never a 3rd claimed after pause() fired'
            );
            const generatedNames = generateCalls.map((c) => (c.args[1] as { name: string }).name).sort();
            assert.deepStrictEqual(
                generatedNames,
                ['a', 'b'],
                'expected the two highest-importance entries (a, b) to be the ones already in flight, not c/d'
            );
        });

        test('the ETA appears after the first completion even with a concurrent pool running (Session 64 behavior preserved)', async function () {
            this.timeout(20_000);

            sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
            const requestStub = sandbox.stub(sidecar, 'request');
            requestStub.withArgs('list_ranked_functions').resolves({ functions: fourFunctionsRanked });
            requestStub.withArgs('generate_explanation').resolves({
                context_hash: 'ctx',
                context_tier: 'call_graph_only',
                explanation: { role_tag: 'utility', one_liner: 'explained' },
            });

            poolManager = new BackgroundIndexManager(() => tempDir, () => cache, () => sidecar, output, 3);
            const internals = poolManager as unknown as { progress: { etaMs: number | undefined } | undefined };

            poolManager.start();
            const deadline = Date.now() + 15_000;
            while ((!internals.progress || internals.progress.etaMs === undefined) && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }

            assert.ok(internals.progress, 'expected progress to have been initialized');
            assert.ok(
                internals.progress!.etaMs !== undefined && internals.progress!.etaMs >= 0,
                'expected a defined, non-negative ETA once at least one generation had completed, even under concurrency'
            );
        });

        test('resume()/start() called mid-pause is a no-op, never starting a second concurrent pass (Session 69 fix)', async function () {
            this.timeout(20_000);

            sandbox.stub(sidecar, 'waitForInteractiveIdle').resolves();
            const requestStub = sandbox.stub(sidecar, 'request');
            requestStub.withArgs('list_ranked_functions').resolves({ functions: fourFunctionsRanked });

            let startedCount = 0;
            let releaseHeldCalls: (() => void) | undefined;
            const held = new Promise<void>((resolve) => {
                releaseHeldCalls = resolve;
            });
            requestStub.withArgs('generate_explanation').callsFake(async (_method: string, rawParams: unknown) => {
                const params = rawParams as { name: string };
                startedCount++;
                if (startedCount === 2) {
                    poolManager!.pause();
                    // Phase is now 'pausing', with both of the pool's workers
                    // still holding on `held` below -- exactly the window the
                    // code-reviewer flagged in Session 67: before this
                    // session's `start()` guard fix, a direct resume()/
                    // start() call landing right here would have kicked off a
                    // second, fully concurrent run() on top of these two
                    // still-in-flight generations, instead of being a no-op
                    // until the pause actually finishes draining.
                    poolManager!.resume();
                    assert.strictEqual(
                        poolManager!.getPhase(),
                        'pausing',
                        'expected resume() called mid-pause to leave the phase at "pausing", not flip it back to "running"'
                    );
                }
                await held;
                return {
                    context_hash: 'ctx',
                    context_tier: 'call_graph_only',
                    explanation: { role_tag: 'utility', one_liner: `explained ${params.name}` },
                };
            });

            poolManager = new BackgroundIndexManager(() => tempDir, () => cache, () => sidecar, output, 2);
            poolManager.start();

            const startedDeadline = Date.now() + 15_000;
            while (startedCount < 2 && Date.now() < startedDeadline) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.strictEqual(startedCount, 2, 'expected both initial workers to have started their generate_explanation call');

            releaseHeldCalls!();

            const pausedDeadline = Date.now() + 15_000;
            while (poolManager.getPhase() !== 'paused' && Date.now() < pausedDeadline) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.strictEqual(poolManager.getPhase(), 'paused', 'expected the single pass to finish draining into "paused"');

            assert.strictEqual(
                requestStub.getCalls().filter((c) => c.args[0] === 'generate_explanation').length,
                2,
                'expected exactly the 2 already-in-flight generate_explanation calls, never a 3rd/4th from a second concurrent pass'
            );
        });
    });
});
