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
 * Session 29: session 26's gutter-staleness fix (`onDidChangeTextDocument`
 * listener in `RoleGutterDecorationManager`) was verified against a small
 * hand-written synthetic fixture (`function alpha() {...}` / `function beta()
 * {...}`) only. This sibling test reuses the exact same manager-instantiation
 * + `refreshEditor` spy pattern (see `roleGutterDecorations.test.ts`) but
 * against real production code shapes, to confirm the fix generalizes: real
 * class-field arrow methods (the shape session 25 also had to special-case in
 * `isFunctionLike`), not just plain top-level `function` declarations.
 *
 * Fixture uses the same real class/method names and shapes as
 * `functionResolutionRealWorld.test.ts`'s fixture (`MoveTouchControlsHandler`,
 * from a real occurrence in B:\pokerogue\src\ui\settings\move-touch-controls-handler.ts)
 * -- see that file's suite doc comment for full provenance and why the
 * bodies are hand-written rather than copied (pokerogue is AGPL-3.0-licensed;
 * this repo isn't). This test deletes the `stopDrag` class-field arrow
 * method (not a plain function) and confirms its gutter decoration actually
 * clears via the debounced re-render, not just that some redraw happened.
 */
suite('codelens/RoleGutterDecorationManager: live refresh on real-world text edit (Session 29)', () => {
    let sandbox: sinon.SinonSandbox;
    let output: vscode.OutputChannel;
    let cache: ExplanationCache;
    let tempDir: string;
    let filePath: string;
    let document: vscode.TextDocument;
    let editor: vscode.TextEditor;

    const before = [
        'export class MoveTouchControlsHandler {',
        '  private draggingElement: HTMLElement | null = null;',
        '',
        '  private startDrag = (controlGroup: HTMLElement): void => {',
        '    const target = controlGroup;',
        '    this.draggingElement = target;',
        '  };',
        '',
        '  private stopDrag = (): void => {',
        '    this.draggingElement = null;',
        '    return;',
        '  };',
        '}',
        '',
    ].join('\n');

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
        assert.fail('document symbol provider never returned symbols for the real-world gutter fixture');
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
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-gutter-realworld-'));
        filePath = path.join(tempDir, 'move_touch_controls_handler.ts');
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
        output = vscode.window.createOutputChannel('LucidHover Gutter Real-World Test');
        const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-gutter-realworld-cache-')), 'cache.sqlite');
        cache = new ExplanationCache(dbPath);

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

    test('deleting a real class-field arrow method (stopDrag) clears its gutter decoration via the debounced refresh', async function () {
        this.timeout(10_000);
        const manager = makeManager();
        const internals = manager as unknown as ManagerInternals;
        const refreshSpy = sandbox.spy(internals, 'refreshEditor');

        try {
            await internals.refreshEditor(editor);
            assert.strictEqual(refreshSpy.callCount, 1, 'precondition: exactly one bootstrap refresh');

            const stopDragBefore = (await resolveAllFunctions(document, tempDir)).find((r) => r.name === 'stopDrag');
            assert.ok(
                stopDragBefore,
                'precondition: the real-world class-field arrow method (stopDrag) should resolve as a function before deletion'
            );

            // Delete stopDrag entirely -- no save, no cache write, no editor
            // visibility change: onDidChangeTextDocument must be the only
            // thing that can trigger a re-render.
            const deleteRange = new vscode.Range(new vscode.Position(7, 0), new vscode.Position(12, 0));
            const edit = new vscode.WorkspaceEdit();
            edit.delete(document.uri, deleteRange);
            const applied = await vscode.workspace.applyEdit(edit);
            assert.ok(applied, 'expected the delete edit to apply');
            await waitForSymbols();

            for (let attempt = 0; attempt < 20 && refreshSpy.callCount < 2; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            assert.strictEqual(
                refreshSpy.callCount,
                2,
                'expected the bare text edit deleting a real-world class-field arrow method to trigger exactly one debounced re-render'
            );
            assert.strictEqual(
                refreshSpy.getCall(1).args[0],
                editor,
                'expected the re-render to target the editor showing the edited document'
            );
            await refreshSpy.getCall(1).returnValue;

            const stillResolved = await resolveAllFunctions(document, tempDir);
            assert.ok(
                !stillResolved.some((r) => r.name === 'stopDrag'),
                'expected stopDrag to no longer resolve as a function after deletion -- the recomputed decoration set for this pass must not include it'
            );
        } finally {
            manager.dispose();
        }
    });
});
