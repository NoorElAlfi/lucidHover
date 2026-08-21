import * as path from 'path';
import { glob } from 'glob';
import Mocha from 'mocha';

/** Discovered and invoked by `@vscode/test-electron`'s `runTests()` (see `../runTest.ts`). */
export async function run(): Promise<void> {
    // TDD interface (`suite`/`test`/`setup`/`teardown`), matching VS Code's
    // own extension-testing convention (the official generator/samples use
    // this, not BDD) -- distinct from the plain-Node unit suite's `describe`/
    // `it`, which is a wholly separate Mocha instance (see `.mocharc.json`).
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 20_000,
    });

    const testsRoot = __dirname;
    const files = await glob('**/*.test.js', { cwd: testsRoot });
    for (const file of files) {
        mocha.addFile(path.resolve(testsRoot, file));
    }

    return new Promise((resolve, reject) => {
        try {
            mocha.run((failures) => {
                if (failures > 0) {
                    reject(new Error(`${failures} integration test(s) failed`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}
