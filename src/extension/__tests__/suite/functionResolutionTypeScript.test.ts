import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveAllFunctions } from '../../functionResolution';

/**
 * Session 25 (TypeScript validation pass), check 2: session 18's
 * `relFile::enclosingScopeQualifiedName` fnId scheme (see cache/hash.ts and
 * functionResolution.ts) was designed and verified against JavaScript
 * document-symbol shapes only. TypeScript is the first thing that stresses
 * it with shapes JS can't produce: overloaded signatures, namespace-nested
 * functions, class methods, arrow functions assigned to class properties,
 * and generic functions. This is a checked-in automated test (not the
 * ad hoc scratchpad-node-script-against-mocked-vscode session 18 used, and
 * not a manual VS Code click-through) so a silent regression here is
 * actually caught, not just hoped not to recur.
 *
 * Uses a standalone temp file, not `fixtures/typescript/`, deliberately:
 * this only needs the real built-in TS language service's document-symbol
 * shapes for these five constructs, not repomap/call-graph/embeddings
 * correctness, so it doesn't need to satisfy (or perturb the counts
 * asserted by) `fixtures/REQUIREMENTS.md`'s structural requirements or
 * `sidecar/tests/test_repomap_typescript.py`.
 */
suite('functionResolution: fnId stability on TypeScript shapes (Session 25)', () => {
    let tempDir: string;
    let filePath: string;
    let document: vscode.TextDocument;

    // Deliberately not byte-identical to `after` for every function: the
    // point (same as session 18's original repro) is that editing/inserting
    // lines above a construct must shift its line number without changing
    // its fnId, while its fnHash changes only if its own source changed.
    const before = [
        'class Widget {',
        '  handler = (): void => {',
        '    doSomething();',
        '  };',
        '',
        '  render(): void {',
        '    doSomething();',
        '  }',
        '}',
        '',
        'namespace Shapes {',
        '  export function area(w: number, h: number): number {',
        '    return w * h;',
        '  }',
        '}',
        '',
        'function identify(x: number): string;',
        'function identify(x: string): number;',
        'function identify(x: number | string): string | number {',
        "  return typeof x === 'number' ? String(x) : Number(x);",
        '}',
        '',
        'function wrap<T>(value: T): T[] {',
        '  return [value];',
        '}',
        '',
        'function doSomething(): void {}',
        '',
    ].join('\n');

    // Inserts blank lines between `Widget` and `Shapes` -- an edit *above*
    // the namespace/overloads/generic function but *below* the class, so
    // `Widget.handler`/`Widget.render` keep their original line numbers
    // while everything after shifts down, same asymmetry session 18's
    // `validateAndPersistSignup` repro used.
    const after = before.replace('}\n\nnamespace Shapes', '}\n\n// unrelated edit\n// pushes everything below down\n\nnamespace Shapes');

    async function waitForSymbols(): Promise<vscode.DocumentSymbol[]> {
        for (let attempt = 0; attempt < 40; attempt++) {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );
            if (symbols && symbols.length > 0) {
                return symbols;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.fail('document symbol provider never returned symbols for the identity-shapes fixture');
    }

    async function replaceDocumentContent(newContent: string): Promise<void> {
        const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, newContent);
        const applied = await vscode.workspace.applyEdit(edit);
        assert.ok(applied, 'expected the in-place content edit to apply');
    }

    suiteSetup(async function () {
        this.timeout(20_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-fnid-ts-shapes-'));
        filePath = path.join(tempDir, 'identity_shapes.ts');
        fs.writeFileSync(filePath, before, 'utf8');
        document = await vscode.workspace.openTextDocument(filePath);
        await waitForSymbols();
    });

    suiteTeardown(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('resolves every TS shape as a function-like symbol at all (no silent exclusion)', async () => {
        const resolved = await resolveAllFunctions(document, tempDir);
        const names = resolved.map((r) => r.name).sort();

        // Every construct this test is about must actually show up --
        // if any one of these is silently excluded (e.g. because its
        // DocumentSymbol.kind isn't one `isFunctionLike` recognizes), it
        // never gets a cache row, never gets hovered, and this assertion
        // catches that instead of the gap being invisible.
        assert.ok(
            resolved.some((r) => r.name === 'handler'),
            'expected the arrow function assigned to a class property (Widget.handler) to resolve as a function'
        );
        assert.ok(
            resolved.some((r) => r.name === 'render'),
            'expected the class method (Widget.render) to resolve as a function'
        );
        assert.ok(
            resolved.some((r) => r.name === 'area'),
            'expected the namespace-nested function (Shapes.area) to resolve as a function'
        );
        assert.ok(
            resolved.some((r) => r.name === 'identify'),
            'expected the overloaded function (identify) to resolve as a function'
        );
        assert.ok(
            resolved.some((r) => r.name === 'wrap'),
            'expected the generic function (wrap<T>) to resolve as a function'
        );
        assert.ok(names.includes('doSomething'));
    });

    test('fnId is stable across a line-shifting edit for every TS shape', async () => {
        const beforeResolved = await resolveAllFunctions(document, tempDir);
        // Index by fnId's own identity component (relFile::qualifiedName is
        // opaque, but distinct symbols must map to distinct entries) --
        // keyed by name here since this fixture has no duplicate names.
        const beforeByName = new Map(beforeResolved.map((r) => [r.name, r]));

        await replaceDocumentContent(after);
        await waitForSymbols();
        const afterResolved = await resolveAllFunctions(document, tempDir);
        const afterByName = new Map(afterResolved.map((r) => [r.name, r]));

        assert.deepStrictEqual(
            [...afterByName.keys()].sort(),
            [...beforeByName.keys()].sort(),
            'expected the same set of resolved functions before and after the unrelated edit'
        );

        for (const name of beforeByName.keys()) {
            const b = beforeByName.get(name)!;
            const a = afterByName.get(name)!;
            assert.strictEqual(a.fnId, b.fnId, `expected fnId for '${name}' to be unchanged by an unrelated earlier edit`);
            // Content didn't change for any of these functions (only lines
            // *between* Widget and Shapes changed) -- fnHash must also be
            // unchanged, confirming this isn't stable only by coincidence.
            assert.strictEqual(
                a.fnHash,
                b.fnHash,
                `expected fnHash for '${name}' to be unchanged since its own source didn't change`
            );
        }

        // Sanity check the shift actually happened -- otherwise the fnId
        // stability assertions above would be trivially true for the wrong
        // reason (nothing moved).
        const shapesRange = afterResolved.find((r) => r.name === 'area')!.range;
        const shapesRangeBefore = beforeResolved.find((r) => r.name === 'area')!.range;
        assert.ok(
            shapesRange.start.line > shapesRangeBefore.start.line,
            'expected the unrelated edit to actually shift area() to a later line'
        );
        const widgetRenderRange = afterResolved.find((r) => r.name === 'render')!.range;
        const widgetRenderRangeBefore = beforeResolved.find((r) => r.name === 'render')!.range;
        assert.strictEqual(
            widgetRenderRange.start.line,
            widgetRenderRangeBefore.start.line,
            'expected Widget.render, which sits above the edit, to keep the same line'
        );
    });
});
