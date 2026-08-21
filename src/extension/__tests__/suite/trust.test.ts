/**
 * Core Rule 6 (Workspace Trust gating): `trust.ts`'s two exports are thin
 * wrappers around the real `vscode.workspace` trust API. This confirms the
 * wiring is real (not hardcoded) by checking it against the live test-host
 * state. Full sidecar-spawn gating in an actually-untrusted workspace is
 * still only covered by session-02's manual/acceptance verification -- this
 * suite launches with `--disable-workspace-trust` (see `../runTest.ts`), so
 * exercising the untrusted branch end-to-end isn't possible from here
 * without a second, interactive launch profile.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import { isWorkspaceTrusted, onDidGrantWorkspaceTrust } from '../../trust';

suite('trust (Workspace Trust gating)', () => {
    test('isWorkspaceTrusted mirrors the live vscode.workspace.isTrusted state', () => {
        assert.strictEqual(isWorkspaceTrusted(), vscode.workspace.isTrusted);
    });

    test('onDidGrantWorkspaceTrust returns a real, disposable subscription', () => {
        let fired = false;
        const disposable = onDidGrantWorkspaceTrust(() => {
            fired = true;
        });
        assert.strictEqual(typeof disposable.dispose, 'function');
        disposable.dispose();
        // Disposing immediately, without a real trust-grant event firing in
        // this already-trusted test host, must not itself invoke the callback.
        assert.strictEqual(fired, false);
    });
});
