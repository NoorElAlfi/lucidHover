import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveAllFunctions } from '../../functionResolution';

/**
 * Session 25 found (via `fixtures/javascript/sample.js`'s own `double`/
 * `makeCounter`) that `isFunctionLike`'s pre-existing `SymbolKind.Variable`
 * branch was silently failing for ordinary top-level `const x = (...) => {}`
 * arrow functions in the bundled VS Code 1.134.0 test instance, because
 * `symbol.detail` comes back empty for this shape -- the pre-existing
 * `detail`-regex check had nothing to match against and returned `false`,
 * excluding the function entirely rather than mis-resolving it. Fixed by
 * falling back to `document.getText(symbol.range)` when `detail` is empty
 * (`functionResolution.ts`). Session 25's own new test only covered
 * TypeScript shapes; sessions 25 and 29 both flagged in their handoffs that
 * the original JS-side motivating case (`double`/`makeCounter` themselves)
 * never got its own regression test -- this closes that gap.
 *
 * Uses a standalone temp file with the same top-level-arrow-const shape,
 * rather than asserting against `fixtures/javascript/sample.js` directly
 * (session 29's own precedent for real-world-motivated regression tests --
 * see `functionResolutionRealWorld.test.ts`): pins the exact construct that
 * triggered the bug without coupling this test to that fixture file's
 * unrelated future edits/line numbers.
 */
suite('functionResolution: top-level arrow-const functions (Session 25 regression, Session 34)', () => {
    let tempDir: string;
    let filePath: string;
    let document: vscode.TextDocument;

    // Same shape as fixtures/javascript/sample.js's double()/makeCounter() --
    // a plain top-level `const x = (...) => {...}` (empty symbol.detail in
    // the bundled TS language service) and a version returning a nested
    // named function expression, both first-party LucidHover fixture code.
    const source = [
        'const double = (n) => {',
        '    return n * 2;',
        '};',
        '',
        'const makeCounter = () => {',
        '    let count = 0;',
        '    return function increment() {',
        '        count += 1;',
        '        return count;',
        '    };',
        '};',
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
        assert.fail('document symbol provider never returned symbols for the arrow-const fixture');
    }

    suiteSetup(async function () {
        this.timeout(20_000);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-fnres-arrowconst-'));
        filePath = path.join(tempDir, 'arrow_const_fixture.js');
        fs.writeFileSync(filePath, source, 'utf8');
        document = await vscode.workspace.openTextDocument(filePath);
        await waitForSymbols();
    });

    suiteTeardown(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('resolves top-level arrow-const functions as function-like symbols despite empty symbol.detail', async () => {
        const resolved = await resolveAllFunctions(document, tempDir);
        const names = resolved.map((r) => r.name).sort();

        assert.ok(
            resolved.some((r) => r.name === 'double'),
            "expected the plain arrow-const function (double) to resolve as a function -- this is the exact " +
                'shape session 25 found silently excluded (empty symbol.detail on the pre-existing Variable-kind branch)'
        );
        assert.ok(
            resolved.some((r) => r.name === 'makeCounter'),
            'expected the arrow-const function returning a nested named function expression (makeCounter) to resolve as a function'
        );
        // resolveAllFunctions also resolves the nested named function
        // expression (increment) as its own function-like symbol -- correct,
        // intended behavior (every function in the file needs its own
        // fnId/fnHash for save-reindex hash-diffing), not part of the
        // regression this test targets, so it's asserted for rather than
        // against.
        assert.deepStrictEqual(names, ['double', 'increment', 'makeCounter']);
    });

    test('fnId is stable across an edit that shifts arrow-const function lines', async () => {
        const before = await resolveAllFunctions(document, tempDir);
        const doubleBefore = before.find((r) => r.name === 'double');
        const makeCounterBefore = before.find((r) => r.name === 'makeCounter');
        assert.ok(doubleBefore && makeCounterBefore);

        // Insert two blank lines above double() -- shifts both functions
        // down, but must not change either fnId (Session 18's original
        // line-shift stability guarantee still applies to this shape).
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), '\n\n');
        const applied = await vscode.workspace.applyEdit(edit);
        assert.ok(applied, 'expected the line-shifting edit to apply');
        await waitForSymbols();

        const after = await resolveAllFunctions(document, tempDir);
        const doubleAfter = after.find((r) => r.name === 'double');
        const makeCounterAfter = after.find((r) => r.name === 'makeCounter');
        assert.ok(doubleAfter && makeCounterAfter);

        assert.strictEqual(doubleAfter!.fnId, doubleBefore!.fnId, "expected double's fnId to survive the line shift");
        assert.strictEqual(
            makeCounterAfter!.fnId,
            makeCounterBefore!.fnId,
            "expected makeCounter's fnId to survive the line shift"
        );
        assert.notStrictEqual(
            doubleAfter!.range.start.line,
            doubleBefore!.range.start.line,
            'precondition: the edit should actually have shifted double() to a new line'
        );
    });
});
