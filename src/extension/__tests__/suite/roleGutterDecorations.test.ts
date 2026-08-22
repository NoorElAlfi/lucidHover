import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../../cache/config';
import { CacheRow, ExplanationCache } from '../../cache/explanationCache';
import { RoleGutterDecorationManager } from '../../codelens/roleGutterDecorations';
import { resolveAllFunctions } from '../../functionResolution';

/** Exposes the private async method under test without changing its real (production) visibility. */
type ManagerInternals = {
    refreshEditor(editor: vscode.TextEditor): Promise<void>;
};

/**
 * Session 26 fix: reproduces the dogfooding bug report (stale/multiplying
 * gutter dots) as an automated regression, not a manual VS Code
 * click-through -- `RoleGutterDecorationManager` had no
 * `onDidChangeTextDocument` listener at all, so a decoration set once by
 * `refreshEditor` only ever auto-adjusted its *position* as VS Code's own
 * range-tracking followed edits; it never got recomputed against the
 * current source on a bare text edit (unlike `RoleCodeLensProvider`, which
 * VS Code re-invokes itself on document changes -- see
 * roleGutterDecorations.ts's class doc comment).
 *
 * Spies on the manager's own private `refreshEditor` method rather than
 * `editor.setDecorations` -- VS Code's real `TextEditor` is a proxy-backed
 * object whose methods have non-configurable property descriptors, which
 * sinon cannot wrap (`TypeError: Cannot redefine property`), the same class
 * of platform limitation `fakes.ts`'s doc comment already records for
 * `child_process`/`net`. `refreshEditor` is a plain class method with no
 * such restriction, and spying on it (rather than stubbing) still calls
 * through to the real implementation, so the actual decoration recompute
 * still runs for real -- this only adds an observation point on top.
 *
 * Uses a standalone temp file (same pattern as
 * functionResolutionTypeScript.test.ts), not `fixtures/`, since this only
 * needs a real editor + real document-symbol shapes, not repomap/call-graph
 * correctness.
 */
suite('codelens/RoleGutterDecorationManager: live refresh on text edit (Session 26)', () => {
    let sandbox: sinon.SinonSandbox;
    let output: vscode.OutputChannel;
    let cache: ExplanationCache;
    let tempDir: string;
    let filePath: string;
    let document: vscode.TextDocument;
    let editor: vscode.TextEditor;

    const before = ['function alpha() {', "  return 'a';", '}', '', 'function beta() {', "  return 'b';", '}', ''].join(
        '\n'
    );

    async function waitForSymbols(): Promise<void> {
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
        assert.fail('document symbol provider never returned symbols for the gutter-decoration fixture');
    }

    function makeManager(): RoleGutterDecorationManager {
        return new RoleGutterDecorationManager(
            vscode.Uri.file(tempDir),
            () => tempDir,
            () => cache,
            output
        );
    }

    suiteSetup(async function () {
        this.timeout(20_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-gutter-refresh-'));
        filePath = path.join(tempDir, 'gutter_fixture.js');
        fs.writeFileSync(filePath, before, 'utf8');
        document = await vscode.workspace.openTextDocument(filePath);
        editor = await vscode.window.showTextDocument(document);
        await waitForSymbols();
    });

    suiteTeardown(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    setup(async () => {
        sandbox = sinon.createSandbox();
        output = vscode.window.createOutputChannel('LucidHover Gutter Test');
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-gutter-cache-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);

        // Reset the document back to its original two-function content before
        // each test, and let symbols settle again -- the test mutates it.
        const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, before);
        await vscode.workspace.applyEdit(edit);
        await waitForSymbols();

        const resolved = await resolveAllFunctions(document, tempDir);
        for (const fn of resolved) {
            const row: CacheRow = {
                cache_key: `test-${fn.name}`,
                fn_id: fn.fnId,
                explanation_json: JSON.stringify({ role_tag: 'handler', one_liner: `${fn.name} explained.` }),
                fn_hash: fn.fnHash,
                context_hash: 'ctx',
                model_id: resolveModelId(),
                embedding_model_id: EMBEDDING_MODEL_ID,
                prompt_version: PROMPT_VERSION,
                context_tier: 'call_graph_only',
                generated_at: new Date().toISOString(),
            };
            cache.write(row);
        }
    });

    teardown(() => {
        cache.dispose();
        output.dispose();
        sandbox.restore();
    });

    test("a bare text edit (no save, no cache write, no visibility change) triggers a gutter re-render, and a deleted function's decoration actually clears", async function () {
        this.timeout(10_000);
        const manager = makeManager();
        const internals = manager as unknown as ManagerInternals;
        const refreshSpy = sandbox.spy(internals, 'refreshEditor');

        try {
            // Deterministic bootstrap pass (real implementation, via the spy
            // wrapper) so the "did an edit trigger a *second* pass" check
            // below isn't racing refreshAll()'s own fire-and-forget calls.
            await internals.refreshEditor(editor);
            assert.strictEqual(refreshSpy.callCount, 1, 'precondition: exactly one bootstrap refresh');

            const betaResolvedBefore = (await resolveAllFunctions(document, tempDir)).find((r) => r.name === 'beta');
            assert.ok(betaResolvedBefore, 'precondition: beta should resolve as a function before deletion');

            // Delete beta() entirely -- no save, no cache write, no editor
            // visibility change: onDidChangeTextDocument must be the only
            // thing that can trigger a re-render.
            const deleteRange = new vscode.Range(new vscode.Position(4, 0), new vscode.Position(8, 0));
            const edit = new vscode.WorkspaceEdit();
            edit.delete(document.uri, deleteRange);
            const applied = await vscode.workspace.applyEdit(edit);
            assert.ok(applied, 'expected the delete edit to apply');
            await waitForSymbols();

            // Poll past the debounce window for the fix's own re-render,
            // rather than a fixed sleep -- fails fast if it never comes.
            for (let attempt = 0; attempt < 20 && refreshSpy.callCount < 2; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            assert.strictEqual(
                refreshSpy.callCount,
                2,
                'expected the bare text edit to trigger exactly one debounced re-render, with no other trigger involved'
            );
            assert.strictEqual(
                refreshSpy.getCall(1).args[0],
                editor,
                'expected the re-render to target the editor showing the edited document'
            );
            // Let the second (real, called-through) refreshEditor pass finish
            // recomputing and calling editor.setDecorations for real.
            await refreshSpy.getCall(1).returnValue;

            const stillResolved = await resolveAllFunctions(document, tempDir);
            assert.ok(
                !stillResolved.some((r) => r.name === 'beta'),
                'expected beta to no longer resolve as a function after deletion -- the recomputed decoration set for this pass must not include it'
            );
        } finally {
            manager.dispose();
        }
    });
});
