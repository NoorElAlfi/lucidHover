/**
 * Session 56: pure cache read plus VS Code's own document-symbol provider --
 * no sidecar involved at all, unlike `showMostImportantFunctionsCommand.ts`'s
 * `list_ranked_functions` call.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../../cache/config';
import { CacheRow, ExplanationCache } from '../../cache/explanationCache';
import { resolveAllFunctions, ResolvedFunction } from '../../functionResolution';
import { searchExplanations } from '../../searchExplanationsCommand';

suite('searchExplanationsCommand (Session 56)', () => {
    let tempDir: string;
    let output: vscode.OutputChannel;
    let sandbox: sinon.SinonSandbox;
    let cache: ExplanationCache;

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

    const fileContent = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';

    suiteSetup(async function () {
        this.timeout(30_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-search-explanations-'));
        fs.writeFileSync(path.join(tempDir, 'file.js'), fileContent, 'utf8');
        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'file.js'));
        await waitForSymbols(document);
        output = vscode.window.createOutputChannel('LucidHover Search Explanations Test');
    });

    suiteTeardown(function () {
        // maxRetries/retryDelay (not needed by this repo's other suites'
        // identical-looking teardowns, which don't leave a real editor tab
        // open on a file inside tempDir at suiteTeardown time): the
        // "navigates to the exact resolved function on pick" test above
        // opens `file.js` in a real (non-preview) editor via this command's
        // own showTextDocument call, and Windows can hold the file handle
        // open briefly after that -- confirmed by reproducing a deterministic
        // EPERM here without this option.
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-search-explanations-cache-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);
    });

    teardown(() => {
        cache.dispose();
        sandbox.restore();
    });

    function rowFor(fn: ResolvedFunction, overrides: Partial<CacheRow> = {}): CacheRow {
        return {
            cache_key: `key-${fn.fnHash}`,
            fn_id: fn.fnId,
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: `explains ${fn.name}` }),
            fn_hash: fn.fnHash,
            context_hash: 'ctx',
            model_id: resolveModelId(),
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: PROMPT_VERSION,
            context_tier: 'call_graph_only',
            generated_at: new Date().toISOString(),
            ...overrides,
        };
    }

    test('excludes superseded rows for a function with more than one cached generation', async function () {
        this.timeout(20_000);

        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'file.js'));
        const functions = await resolveAllFunctions(document, tempDir);
        const a = functions.find((f) => f.name === 'a');
        assert.ok(a, 'expected to resolve a()');

        // evictSuperseded=false stacks both rows -- the same "auto-evict off"
        // scenario listCurrentRows (and this command) must still collapse
        // down to one row per fn_id, same as session 39's purge sweep does.
        const older = rowFor(a!, {
            cache_key: 'a-old',
            fn_hash: 'a-hash-old',
            explanation_json: JSON.stringify({ role_tag: 'stale-role', one_liner: 'old explanation' }),
            generated_at: '2026-08-19T00:00:00.000Z',
        });
        const newer = rowFor(a!, {
            cache_key: 'a-new',
            fn_hash: 'a-hash-new',
            explanation_json: JSON.stringify({ role_tag: 'utility', one_liner: 'new explanation' }),
            generated_at: '2026-08-20T00:00:00.000Z',
        });
        cache.write(older, false);
        cache.write(newer, false);

        const quickPickStub = sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);

        await searchExplanations(() => tempDir, () => cache, output);

        assert.strictEqual(quickPickStub.calledOnce, true);
        const items = (await quickPickStub.firstCall.args[0]) as vscode.QuickPickItem[];
        const aItems = items.filter((i) => i.label === 'a' && i.description === 'file.js');
        assert.strictEqual(aItems.length, 1, 'expected exactly one (the current, non-superseded) row for a()');
        assert.strictEqual(aItems[0].detail, 'utility — new explanation');
    });

    test('navigates to the exact resolved function on pick', async function () {
        this.timeout(20_000);

        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'file.js'));
        const functions = await resolveAllFunctions(document, tempDir);
        const b = functions.find((f) => f.name === 'b');
        assert.ok(b, 'expected to resolve b()');
        cache.write(rowFor(b!));

        sandbox.stub(vscode.window, 'showQuickPick').callsFake(async (items) => {
            const resolved = (await items) as vscode.QuickPickItem[];
            return resolved.find((i) => i.label === 'b');
        });

        await searchExplanations(() => tempDir, () => cache, output);

        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'expected an editor to be opened for the picked function');
        assert.strictEqual(path.basename(editor!.document.uri.fsPath), 'file.js');
        assert.strictEqual(editor!.selection.active.line, b!.range.start.line);
    });

    test('does nothing when the quick pick is cancelled (returns undefined)', async function () {
        this.timeout(20_000);

        const document = await vscode.workspace.openTextDocument(path.join(tempDir, 'file.js'));
        const functions = await resolveAllFunctions(document, tempDir);
        const a = functions.find((f) => f.name === 'a');
        assert.ok(a, 'expected to resolve a()');
        cache.write(rowFor(a!));

        sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);
        const showTextDocumentSpy = sandbox.spy(vscode.window, 'showTextDocument');

        await searchExplanations(() => tempDir, () => cache, output);

        assert.strictEqual(
            showTextDocumentSpy.called,
            false,
            'expected no navigation to happen when the quick pick is cancelled'
        );
    });

    test('is a no-op (status message, no throw) when indexing is not ready', async function () {
        this.timeout(20_000);
        await searchExplanations(() => undefined, () => undefined, output);
    });

    test('shows a status message and never opens the quick pick when nothing is cached yet', async function () {
        this.timeout(20_000);
        const quickPickStub = sandbox.stub(vscode.window, 'showQuickPick');

        await searchExplanations(() => tempDir, () => cache, output);

        assert.strictEqual(quickPickStub.called, false, 'expected no quick pick against an empty cache');
    });
});
