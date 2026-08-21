/**
 * Entry point for the integration suite (Build Order step 17): launches a
 * real, scriptable VS Code instance via `@vscode/test-electron` -- the
 * officially-documented pattern for testing code that imports `vscode`
 * (Core Rule 3, no custom Extension Development Host harness or `vscode`
 * shim). Everything under `suite/` runs inside that instance and can
 * therefore exercise `SidecarManager`, `trust.ts`, and the hover provider
 * for real, closing the automation gap sessions 14-16 hit.
 *
 * The launched instance opens `fixtures/<language>` as its workspace folder
 * (already trusted -- see `.vscode-test/user-data` seeding below), where
 * `<language>` is `LUCIDHOVER_FIXTURE_LANGUAGE` (default `javascript`) --
 * see `fixtures/REQUIREMENTS.md` for what a language's fixture directory
 * must contain. Session 23: single env-var switch instead of a hardcoded
 * `'sample-repo'` literal, so adding a second language's fixture doesn't
 * require editing this file.
 */
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
    const fixtureLanguage = process.env.LUCIDHOVER_FIXTURE_LANGUAGE ?? 'javascript';
    const workspacePath = path.resolve(extensionDevelopmentPath, 'fixtures', fixtureLanguage);

    try {
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                workspacePath,
                // Deliberately NOT --disable-extensions: functionResolution.ts
                // relies on VS Code's built-in JS language service (via
                // `vscode.executeDocumentSymbolProvider`) to resolve
                // functions in the fixture repo, and that flag also disables
                // built-in extensions. This profile has no other (user)
                // extensions installed anyway, so isolation isn't lost.
                //
                // The test workspace is a first-party fixture, not untrusted
                // user content -- skip the trust prompt so the suite can run
                // headlessly. Trust-gating itself (Core Rule 6) is exercised
                // in suite/trust.test.ts via the API, not by driving the UI.
                '--disable-workspace-trust',
            ],
        });
    } catch (err) {
        console.error('integration suite failed to run:', err);
        process.exit(1);
    }
}

void main();
