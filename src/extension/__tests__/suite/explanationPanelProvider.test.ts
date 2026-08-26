/**
 * Session 52: regression coverage for the real bug fixed this session --
 * `ExplanationPanelProvider`'s webview message handler used to forward
 * `showBlastRadius`/`traceExecutionPath` with no function identity at all,
 * so `blastRadiusCommand.ts`/`callTraceCommand.ts` always re-resolved from
 * `vscode.window.activeTextEditor`'s *live* cursor position -- ignoring
 * whatever function the panel was actually displaying. If the cursor had
 * since moved away (or off any function entirely) before the user clicked
 * "See full blast radius →" / "Trace execution from here →", the
 * command silently targeted the wrong function, or nothing at all.
 *
 * This suite exercises `ExplanationPanelProvider`'s own tracking/forwarding
 * logic in isolation, using a minimal fake `vscode.WebviewView` (see
 * `fakes.ts`'s `createFakeWebviewView`) rather than a real rendered webview
 * iframe (not available to this test harness) -- `blastRadiusCommand.test.ts`
 * / `callTraceCommand.test.ts` already cover the command-level half of the
 * fix (an explicit `target` param overriding live-cursor resolution) against
 * a real spawned sidecar; this suite covers that the panel actually supplies
 * that `target` correctly, and only when it genuinely has one.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../../cache/config';
import { CacheRow, ExplanationCache } from '../../cache/explanationCache';
import { resolveEnclosingFunction, ResolvedFunction } from '../../functionResolution';
import {
    ExplanationPanelProvider,
    NAVIGATE_COMMAND_ID,
    REFRESH_COMMAND_ID,
    SHOW_BLAST_RADIUS_COMMAND_ID,
    SHOW_CALL_TRACE_COMMAND_ID,
} from '../../panel/explanationPanelProvider';
import { createFakeWebviewView } from './fakes';

suite('panel/explanationPanelProvider currentFunction tracking (Session 52)', () => {
    let tempDir: string;
    let output: vscode.OutputChannel;
    let sandbox: sinon.SinonSandbox;
    let cache: ExplanationCache;
    let panel: ExplanationPanelProvider;

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

    // target() has real content at the top of the file; the trailing blank
    // lines have no enclosing function at all, so moving the cursor there
    // reproduces the "off any function" half of the reported bug alongside
    // the "onto a different function" half already covered by moving to a
    // named function's own line.
    const targetContent = 'function target() {\n  return 1;\n}\n\n\n\n';

    suiteSetup(async function () {
        this.timeout(30_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-panel-currentfn-'));
        fs.writeFileSync(path.join(tempDir, 'target.js'), targetContent, 'utf8');
        output = vscode.window.createOutputChannel('LucidHover Panel currentFunction Test');
    });

    suiteTeardown(function () {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-panel-currentfn-cache-')), 'cache.sqlite');
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

    test('showBlastRadius: forwards the panel-tracked function, not a live cursor moved off any function', async () => {
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        await waitForSymbols(document);
        const editor = await vscode.window.showTextDocument(document);
        const resolved = await resolveEnclosingFunction(document, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve target()');

        const row: CacheRow = {
            cache_key: 'test-key-target',
            fn_id: resolved!.fnId,
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: 'Returns 1.' }),
            fn_hash: resolved!.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
        cache.write(row);

        const fakeView = createFakeWebviewView();
        panel.resolveWebviewView(fakeView as unknown as vscode.WebviewView);

        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);
        panel.onSelectionChanged(editor);
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Move the cursor to a blank line past the function's closing brace
        // (no enclosing function there) WITHOUT calling onSelectionChanged
        // again -- simulates the panel not yet having re-synced when the
        // webview's button click arrives, the exact race the real bug hit.
        const blankLine = new vscode.Position(document.lineCount - 1, 0);
        editor.selection = new vscode.Selection(blankLine, blankLine);
        const liveResolved = await resolveEnclosingFunction(document, blankLine, tempDir);
        assert.strictEqual(liveResolved, undefined, 'expected the blank trailing line to resolve to no function');

        const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();

        fakeView.simulateMessageFromWebview({ type: 'showBlastRadius' });

        assert.strictEqual(executeCommandStub.calledOnce, true);
        const [commandId, target] = executeCommandStub.firstCall.args;
        assert.strictEqual(commandId, SHOW_BLAST_RADIUS_COMMAND_ID);
        assert.strictEqual(target?.fnId, resolved!.fnId, 'expected the command to target the panel-displayed function, not the live (function-less) cursor');
    });

    test('traceExecutionPath: same fix, mirrored for the execution-trace button', async () => {
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        await waitForSymbols(document);
        const editor = await vscode.window.showTextDocument(document);
        const resolved = await resolveEnclosingFunction(document, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve target()');

        const row: CacheRow = {
            cache_key: 'test-key-target-2',
            fn_id: resolved!.fnId,
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: 'Returns 1.' }),
            fn_hash: resolved!.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
        cache.write(row);

        const fakeView = createFakeWebviewView();
        panel.resolveWebviewView(fakeView as unknown as vscode.WebviewView);

        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);
        panel.onSelectionChanged(editor);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const blankLine = new vscode.Position(document.lineCount - 1, 0);
        editor.selection = new vscode.Selection(blankLine, blankLine);

        const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();

        fakeView.simulateMessageFromWebview({ type: 'traceExecutionPath' });

        assert.strictEqual(executeCommandStub.calledOnce, true);
        const [commandId, target] = executeCommandStub.firstCall.args;
        assert.strictEqual(commandId, SHOW_CALL_TRACE_COMMAND_ID);
        assert.strictEqual(target?.fnId, resolved!.fnId);
    });

    test('showRow (hover "Show more" push): no ResolvedFunction available, so the button falls back to live-cursor resolution rather than a stale one', async () => {
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        await waitForSymbols(document);
        await vscode.window.showTextDocument(document);
        const resolved = await resolveEnclosingFunction(document, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve target()');

        const row: CacheRow = {
            cache_key: 'test-key-target-3',
            fn_id: resolved!.fnId,
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: 'Returns 1.' }),
            fn_hash: resolved!.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };

        const fakeView = createFakeWebviewView();
        panel.resolveWebviewView(fakeView as unknown as vscode.WebviewView);
        panel.showRow(row);

        const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
        fakeView.simulateMessageFromWebview({ type: 'showBlastRadius' });

        assert.strictEqual(executeCommandStub.calledOnce, true);
        const [commandId, target] = executeCommandStub.firstCall.args;
        assert.strictEqual(commandId, SHOW_BLAST_RADIUS_COMMAND_ID);
        assert.strictEqual(target, undefined, 'expected no target -- showRow has no ResolvedFunction to offer, so the command must fall back to live-cursor resolution');
    });
});

/**
 * Session 55: discoverability additions -- a "Regenerate" button (same
 * currentFunction-targeting fix as Session 52's blast-radius/trace buttons,
 * applied to the pre-existing but previously always-live-cursor
 * `lucidhover.refreshExplanation` command), a "Copy" button (a `copy`
 * webview message carrying a plain-text rendering, handled by writing it to
 * `vscode.env.clipboard`), and a relative-timestamp display (`generated_at`
 * forwarded on the existing `render` message as `generatedAt`).
 */
suite('panel/explanationPanelProvider discoverability additions (Session 55)', () => {
    let tempDir: string;
    let output: vscode.OutputChannel;
    let sandbox: sinon.SinonSandbox;
    let cache: ExplanationCache;
    let panel: ExplanationPanelProvider;

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

    const targetContent = 'function target() {\n  return 1;\n}\n';

    suiteSetup(async function () {
        this.timeout(30_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-panel-discoverability-'));
        fs.writeFileSync(path.join(tempDir, 'target.js'), targetContent, 'utf8');
        output = vscode.window.createOutputChannel('LucidHover Panel Discoverability Test');
    });

    suiteTeardown(function () {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-panel-discoverability-cache-')), 'cache.sqlite');
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

    test('regenerate message forwards the panel-tracked function to REFRESH_COMMAND_ID, mirroring the blast-radius/trace fix', async () => {
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        await waitForSymbols(document);
        const editor = await vscode.window.showTextDocument(document);
        const resolved = await resolveEnclosingFunction(document, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve target()');

        const row: CacheRow = {
            cache_key: 'test-key-regen',
            fn_id: resolved!.fnId,
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: 'Returns 1.' }),
            fn_hash: resolved!.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
        cache.write(row);

        const fakeView = createFakeWebviewView();
        panel.resolveWebviewView(fakeView as unknown as vscode.WebviewView);

        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);
        panel.onSelectionChanged(editor);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();

        fakeView.simulateMessageFromWebview({ type: 'regenerate' });

        assert.strictEqual(executeCommandStub.calledOnce, true);
        const [commandId, target] = executeCommandStub.firstCall.args;
        assert.strictEqual(commandId, REFRESH_COMMAND_ID);
        assert.strictEqual(target?.fnId, resolved!.fnId, 'expected the command to target the panel-displayed function, not the live cursor');
    });

    // vscode.env.clipboard.writeText's property descriptor is non-configurable
    // in the real Extension Development Host, so sinon can't stub it (see
    // https://sinonjs.org/faq#property-descriptor-errors) -- these tests
    // exercise the real clipboard instead, same as other suites in this repo
    // exercise other real VS Code APIs they can't mock.
    test('copy message writes the supplied text to the clipboard', async () => {
        const fakeView = createFakeWebviewView();
        panel.resolveWebviewView(fakeView as unknown as vscode.WebviewView);

        await vscode.env.clipboard.writeText('sentinel-before-copy');
        fakeView.simulateMessageFromWebview({ type: 'copy', text: 'some explanation text' });
        await new Promise((resolve) => setTimeout(resolve, 50));

        const clipboardText = await vscode.env.clipboard.readText();
        assert.strictEqual(clipboardText, 'some explanation text');
    });

    test('a non-string copy payload is ignored rather than writing garbage to the clipboard', async () => {
        const fakeView = createFakeWebviewView();
        panel.resolveWebviewView(fakeView as unknown as vscode.WebviewView);

        await vscode.env.clipboard.writeText('sentinel-unchanged');
        fakeView.simulateMessageFromWebview({ type: 'copy', text: 42 });
        await new Promise((resolve) => setTimeout(resolve, 50));

        const clipboardText = await vscode.env.clipboard.readText();
        assert.strictEqual(clipboardText, 'sentinel-unchanged');
    });

    test('postRow forwards generated_at as generatedAt on the render message', async () => {
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        await waitForSymbols(document);
        const editor = await vscode.window.showTextDocument(document);
        const resolved = await resolveEnclosingFunction(document, new vscode.Position(0, 10), tempDir);
        assert.ok(resolved, 'expected to resolve target()');

        const generatedAt = '2026-08-20T00:00:00.000Z';
        const row: CacheRow = {
            cache_key: 'test-key-timestamp',
            fn_id: resolved!.fnId,
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: 'Returns 1.' }),
            fn_hash: resolved!.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: generatedAt,
        };
        cache.write(row);

        const fakeView = createFakeWebviewView();
        panel.resolveWebviewView(fakeView as unknown as vscode.WebviewView);

        editor.selection = new vscode.Selection(resolved!.range.start, resolved!.range.start);
        panel.onSelectionChanged(editor);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const renderCall = fakeView.webview.postMessage.getCalls().find((c) => c.args[0]?.type === 'render');
        assert.ok(renderCall, 'expected a render message to have been posted');
        assert.strictEqual(renderCall!.args[0].generatedAt, generatedAt);
    });
});

/**
 * Session 58 ("Back to caller"): the panel's new single-slot navigation-back
 * affordance, added after real manual testing found that clicking a
 * used-by/calls row leaves no way back for a same-file jump (VS Code's own
 * "Go Back" doesn't fire without a document change). Covers the three
 * behaviors backTarget's own doc comment describes: it's set from the
 * currently-displayed function right before a navigate click is forwarded,
 * it only surfaces as `backTo` on the render message for the specific
 * function that navigate click targeted, and clicking it navigates to the
 * exact remembered location rather than re-resolving by name.
 */
suite('panel/explanationPanelProvider "Back to caller" (Session 58)', () => {
    let tempDir: string;
    let output: vscode.OutputChannel;
    let sandbox: sinon.SinonSandbox;
    let cache: ExplanationCache;
    let panel: ExplanationPanelProvider;

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

    const targetContent =
        'function caller() {\n  return target();\n}\n\nfunction target() {\n  return 1;\n}\n\nfunction other() {\n  return 2;\n}\n';

    suiteSetup(async function () {
        this.timeout(30_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-panel-backtocaller-'));
        fs.writeFileSync(path.join(tempDir, 'target.js'), targetContent, 'utf8');
        output = vscode.window.createOutputChannel('LucidHover Panel Back-to-Caller Test');
    });

    suiteTeardown(function () {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-panel-backtocaller-cache-')), 'cache.sqlite');
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

    function cacheRowFor(resolved: ResolvedFunction, cacheKey: string): CacheRow {
        return {
            cache_key: cacheKey,
            fn_id: resolved.fnId,
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: 'test' }),
            fn_hash: resolved.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
        };
    }

    test('a navigate click from the caller\'s card surfaces "Back to caller" only on the target it named', async () => {
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        await waitForSymbols(document);
        const editor = await vscode.window.showTextDocument(document);

        const callerPos = new vscode.Position(0, 10);
        const targetPos = new vscode.Position(4, 10);
        const caller = await resolveEnclosingFunction(document, callerPos, tempDir);
        const target = await resolveEnclosingFunction(document, targetPos, tempDir);
        assert.ok(caller, 'expected to resolve caller()');
        assert.ok(target, 'expected to resolve target()');

        cache.write(cacheRowFor(caller!, 'test-key-caller'));
        cache.write(cacheRowFor(target!, 'test-key-target'));

        const fakeView = createFakeWebviewView();
        panel.resolveWebviewView(fakeView as unknown as vscode.WebviewView);

        // Land on caller() first so the panel's currentFunction is caller.
        editor.selection = new vscode.Selection(caller!.range.start, caller!.range.start);
        panel.onSelectionChanged(editor);
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Simulate the webview's "target" used-by/calls row being clicked --
        // stub executeCommand only for this one call so the real
        // lucidhover.navigateToFunction command (which targets whatever
        // workspace the real activated extension is indexing, not this
        // test's tempDir) never actually runs.
        const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
        fakeView.simulateMessageFromWebview({ type: 'navigate', name: 'target' });
        assert.strictEqual(executeCommandStub.calledOnce, true);
        assert.deepStrictEqual(executeCommandStub.firstCall.args, [NAVIGATE_COMMAND_ID, 'target']);
        executeCommandStub.restore();

        // Now simulate actually landing on target() (what the real navigate
        // command would have done) and confirm its render carries backTo.
        editor.selection = new vscode.Selection(target!.range.start, target!.range.start);
        panel.onSelectionChanged(editor);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const targetRenderCall = fakeView.webview.postMessage
            .getCalls()
            .reverse()
            .find((c) => c.args[0]?.type === 'render' && c.args[0]?.fnName === 'target');
        assert.ok(targetRenderCall, 'expected a render message for target()');
        assert.strictEqual(targetRenderCall!.args[0].backTo, 'caller');

        // Landing on a third, unrelated function must NOT carry backTo --
        // the target-name match is the only invalidation this needs.
        const otherPos = new vscode.Position(8, 10);
        const other = await resolveEnclosingFunction(document, otherPos, tempDir);
        assert.ok(other, 'expected to resolve other()');
        cache.write(cacheRowFor(other!, 'test-key-other'));
        editor.selection = new vscode.Selection(other!.range.start, other!.range.start);
        panel.onSelectionChanged(editor);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const otherRenderCall = fakeView.webview.postMessage
            .getCalls()
            .reverse()
            .find((c) => c.args[0]?.type === 'render' && c.args[0]?.fnName === 'other');
        assert.ok(otherRenderCall, 'expected a render message for other()');
        assert.strictEqual(otherRenderCall!.args[0].backTo, undefined, 'backTo must not leak onto an unrelated function');
    });

    test('backToCaller navigates to the exact remembered location, not a re-resolved name lookup', async () => {
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        await waitForSymbols(document);
        const editor = await vscode.window.showTextDocument(document);

        const callerPos = new vscode.Position(0, 10);
        const targetPos = new vscode.Position(4, 10);
        const caller = await resolveEnclosingFunction(document, callerPos, tempDir);
        const target = await resolveEnclosingFunction(document, targetPos, tempDir);
        assert.ok(caller, 'expected to resolve caller()');
        assert.ok(target, 'expected to resolve target()');

        cache.write(cacheRowFor(caller!, 'test-key-caller-2'));
        cache.write(cacheRowFor(target!, 'test-key-target-2'));

        const fakeView = createFakeWebviewView();
        panel.resolveWebviewView(fakeView as unknown as vscode.WebviewView);

        editor.selection = new vscode.Selection(caller!.range.start, caller!.range.start);
        panel.onSelectionChanged(editor);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
        fakeView.simulateMessageFromWebview({ type: 'navigate', name: 'target' });
        executeCommandStub.restore();

        // Move the live cursor/selection away from caller() first, so a
        // pass would only happen if backToCaller actually navigates rather
        // than being a no-op that happens to leave the cursor in place.
        const blankLine = new vscode.Position(document.lineCount - 1, 0);
        editor.selection = new vscode.Selection(blankLine, blankLine);

        fakeView.simulateMessageFromWebview({ type: 'backToCaller' });
        await new Promise((resolve) => setTimeout(resolve, 100));

        const activeEditor = vscode.window.activeTextEditor;
        assert.ok(activeEditor, 'expected an active editor after backToCaller');
        assert.strictEqual(activeEditor!.selection.active.line, caller!.range.start.line);

        const callerRenderCall = fakeView.webview.postMessage
            .getCalls()
            .reverse()
            .find((c) => c.args[0]?.type === 'render' && c.args[0]?.fnName === 'caller');
        assert.ok(callerRenderCall, 'expected the panel to re-render caller() after backToCaller');
    });

    // Real user report: clicking "Back to caller" sometimes left the panel
    // showing the old function even though the editor genuinely navigated
    // back. Root cause: `onDidChangeTextEditorSelection` doesn't fire when
    // the resulting selection happens to already match what the editor had
    // (e.g. the cursor coincidentally sitting at the exact target position
    // already) -- `onSelectionChanged`'s event-driven refresh silently never
    // ran. This reproduces that exact no-change case directly by setting
    // the live selection to caller()'s position *before* triggering
    // backToCaller, so any refresh that happens can only be the explicit
    // `navigateToLocation` -> `refreshFor` call, never the selection-changed
    // event (there's no change for it to fire on).
    test('backToCaller refreshes the panel even when the resulting selection is a no-op (no selection-changed event to rely on)', async () => {
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'target.js'));
        await waitForSymbols(document);
        const editor = await vscode.window.showTextDocument(document);

        const callerPos = new vscode.Position(0, 10);
        const targetPos = new vscode.Position(4, 10);
        const caller = await resolveEnclosingFunction(document, callerPos, tempDir);
        const target = await resolveEnclosingFunction(document, targetPos, tempDir);
        assert.ok(caller, 'expected to resolve caller()');
        assert.ok(target, 'expected to resolve target()');

        cache.write(cacheRowFor(caller!, 'test-key-caller-3'));
        cache.write(cacheRowFor(target!, 'test-key-target-3'));

        const fakeView = createFakeWebviewView();
        panel.resolveWebviewView(fakeView as unknown as vscode.WebviewView);

        editor.selection = new vscode.Selection(caller!.range.start, caller!.range.start);
        panel.onSelectionChanged(editor);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
        fakeView.simulateMessageFromWebview({ type: 'navigate', name: 'target' });
        executeCommandStub.restore();

        // The live selection is already sitting exactly where backToCaller
        // is about to navigate to -- setting it again below is a genuine
        // no-op from VS Code's point of view, so onDidChangeTextEditorSelection
        // has nothing to fire on.
        editor.selection = new vscode.Selection(caller!.range.start, caller!.range.start);
        fakeView.webview.postMessage.resetHistory();

        fakeView.simulateMessageFromWebview({ type: 'backToCaller' });
        await new Promise((resolve) => setTimeout(resolve, 100));

        const callerRenderCall = fakeView.webview.postMessage
            .getCalls()
            .find((c) => c.args[0]?.type === 'render' && c.args[0]?.fnName === 'caller');
        assert.ok(
            callerRenderCall,
            'expected backToCaller to refresh the panel unconditionally, not only via the selection-changed event'
        );
    });
});
