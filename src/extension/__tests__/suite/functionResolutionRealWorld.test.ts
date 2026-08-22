import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveAllFunctions } from '../../functionResolution';

/**
 * Session 29: session 25's `isFunctionLike` fix (Field/Property SymbolKind +
 * source-text fallback for empty `symbol.detail`) was found and verified
 * against a hand-written synthetic repro (`Widget.handler = (): void =>
 * {...}`) only -- never against a genuine occurrence of the same shape in
 * real-world code. This test closes that gap.
 *
 * The fixture below reproduces the real class/method names and real
 * document-symbol *shapes* of a class found in the pokerogue repo
 * (B:\pokerogue\src\ui\settings\move-touch-controls-handler.ts,
 * `MoveTouchControlsHandler`, confirmed at the time of writing) -- but the
 * method bodies are hand-written, not copied from that file, since pokerogue
 * is AGPL-3.0-licensed and this repo isn't; only the identifiers/signatures
 * (which determine the SymbolKind/shape this test is actually about) come
 * from the real occurrence:
 *   - `stopDrag` (real occurrence: lines 194-196 there) is the exact shape
 *     session 25's fix targets: a `private` class-field arrow property with
 *     a `(): void =>` signature and a braced body.
 *   - `startDrag` (lines 170-172) is the same shape with a parameter.
 *   - `isLeft` (line 163) is the same SymbolKind.Field/Property shape but
 *     with an expression body (no braces, no `function`/`=>`-adjacent
 *     keyword inside the body) -- still must resolve via the `=>` in its own
 *     signature.
 *   - `drag` (lines 178-189) is a multi-statement braced arrow field,
 *     included as a fourth real-world data point.
 *
 * Uses a standalone temp file, not `fixtures/`, per session 25/26's own
 * precedent -- this only needs the real TS language service's document-symbol
 * shapes for these constructs, not repomap/call-graph correctness.
 */
suite('functionResolution: real-world class-field arrow functions (Session 29)', () => {
    let tempDir: string;
    let filePath: string;
    let document: vscode.TextDocument;

    // Same class/method names and signatures as the real pokerogue
    // occurrence -- see the suite doc comment above for provenance -- but
    // with hand-written bodies (not copied from that AGPL-3.0-licensed file).
    const source = [
        'export class MoveTouchControlsHandler {',
        '  private draggingElement: HTMLElement | null = null;',
        '',
        "  private isLeft = (element: HTMLElement) => element.classList.contains('touch-left');",
        '',
        '  private startDrag = (controlGroup: HTMLElement): void => {',
        '    this.draggingElement = controlGroup;',
        '  };',
        '',
        '  private drag = (event: PointerEvent): void => {',
        '    if (!this.draggingElement) {',
        '      return;',
        '    }',
        '    const direction = this.isLeft(this.draggingElement) ? 1 : -1;',
        '    const nextX = direction * event.clientX;',
        "    this.draggingElement.style.left = `${nextX}px`;",
        '  };',
        '',
        '  private stopDrag = (): void => {',
        '    this.draggingElement = null;',
        '  };',
        '}',
        '',
    ].join('\n');

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
        assert.fail('document symbol provider never returned symbols for the real-world fixture');
    }

    suiteSetup(async function () {
        this.timeout(20_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-fnres-realworld-'));
        filePath = path.join(tempDir, 'move_touch_controls_handler.ts');
        fs.writeFileSync(filePath, source, 'utf8');
        document = await vscode.workspace.openTextDocument(filePath);
        await waitForSymbols();
    });

    suiteTeardown(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('resolves real pokerogue class-field arrow functions as function-like symbols', async () => {
        const resolved = await resolveAllFunctions(document, tempDir);
        const names = resolved.map((r) => r.name).sort();

        assert.ok(
            resolved.some((r) => r.name === 'stopDrag'),
            'expected the real-world braced class-field arrow property (stopDrag) to resolve as a function -- ' +
                'this is the exact shape session 25 fixed isFunctionLike for, now confirmed against genuine ' +
                'production code rather than only the synthetic Widget.handler repro'
        );
        assert.ok(
            resolved.some((r) => r.name === 'startDrag'),
            'expected the real-world parameterized class-field arrow property (startDrag) to resolve as a function'
        );
        assert.ok(
            resolved.some((r) => r.name === 'drag'),
            'expected the real-world multi-statement class-field arrow property (drag) to resolve as a function'
        );
        assert.ok(
            resolved.some((r) => r.name === 'isLeft'),
            'expected the real-world expression-bodied class-field arrow property (isLeft) to resolve as a function'
        );
        assert.deepStrictEqual(names, ['drag', 'isLeft', 'startDrag', 'stopDrag']);
    });
});
