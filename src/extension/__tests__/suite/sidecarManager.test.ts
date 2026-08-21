/**
 * Integration coverage for `SidecarManager`'s crash-recovery supervision
 * (Build Order step 16, hardened in Session 16 -- manually verified there
 * via a human plus a live PowerShell kill-loop, precisely because no
 * automated way to drive it existed yet). This suite closes that gap:
 * `SidecarManager`'s `spawnFn`/`connectFn` constructor params (Build Order
 * step 17) are given plain sinon stub functions, so crashes, connect
 * failures, and the give-up/manual-restart paths can be triggered
 * programmatically and deterministically, without a real Python process.
 *
 * Injection, not `sinon.stub(child_process, 'spawn')`: the Extension
 * Development Host's `child_process`/`net` module exports have
 * non-configurable property descriptors, so sinon cannot monkey-patch them
 * directly here (confirmed by a first attempt at this suite -- see
 * `sidecarManager.ts`'s constructor doc comment).
 *
 * Runs inside the Extension Development Host (`vscode` import required for
 * `StatusBarItem`/`window.showErrorMessage`/`OutputChannel`) -- see
 * `../runTest.ts`.
 */
import * as assert from 'assert';
import * as cp from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { SidecarManager } from '../../sidecar/sidecarManager';
import { createFakeChildProcess, FakeChildProcess, stubConnectAlwaysFails, stubConnectAlwaysSucceeds } from './fakes';

function makeManager(
    output: vscode.OutputChannel,
    spawnFn: sinon.SinonStub,
    connectFn: sinon.SinonStub
): SidecarManager {
    return new SidecarManager(
        path.join(os.tmpdir(), 'lucidhover-test-workspace'),
        path.join(os.tmpdir(), 'lucidhover-test-extension'),
        path.join(os.tmpdir(), 'lucidhover-test-storage'),
        'all-minilm',
        'http://localhost:11434',
        output,
        spawnFn as unknown as typeof cp.spawn,
        connectFn as unknown as typeof net.connect
    );
}

suite('sidecar/SidecarManager (crash recovery)', () => {
    let sandbox: sinon.SinonSandbox;
    let spawnStub: sinon.SinonStub;
    let connectStub: sinon.SinonStub;
    let showErrorMessageStub: sinon.SinonStub;
    let output: vscode.OutputChannel;
    let manager: SidecarManager | undefined;

    setup(() => {
        sandbox = sinon.createSandbox();
        spawnStub = sinon.stub();
        connectStub = sinon.stub();
        showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        output = vscode.window.createOutputChannel('LucidHover Test');
        manager = undefined;
    });

    teardown(() => {
        manager?.dispose();
        output.dispose();
        sandbox.restore();
    });

    test('start() spawns python with the expected argv and connects', async () => {
        const fakeChildren: FakeChildProcess[] = [];
        spawnStub.callsFake(() => {
            const child = createFakeChildProcess();
            fakeChildren.push(child);
            return child as unknown as cp.ChildProcess;
        });
        stubConnectAlwaysSucceeds(connectStub);

        manager = makeManager(output, spawnStub, connectStub);
        await manager.start();

        assert.strictEqual(spawnStub.callCount, 1);
        const [command, args] = spawnStub.firstCall.args as [string, string[]];
        assert.strictEqual(command, 'python');
        assert.strictEqual(args[0], '-m');
        assert.strictEqual(args[1], 'sidecar.rpc_server');
        if (process.platform === 'win32') {
            assert.match(args[2], /^\\\\\.\\pipe\\lucidhover-/);
        } else {
            assert.match(args[2], /lucidhover-.*\.sock$/);
        }
        assert.strictEqual(args[3], path.join(os.tmpdir(), 'lucidhover-test-workspace'));
        assert.strictEqual(args[4], path.join(os.tmpdir(), 'lucidhover-test-storage'));
        assert.strictEqual(args[5], 'all-minilm');
        assert.strictEqual(args[6], 'http://localhost:11434');
    });

    test('an unexpected child exit triggers automatic recovery and reconnects', async () => {
        const fakeChildren: FakeChildProcess[] = [];
        spawnStub.callsFake(() => {
            const child = createFakeChildProcess();
            fakeChildren.push(child);
            return child as unknown as cp.ChildProcess;
        });
        stubConnectAlwaysSucceeds(connectStub);

        manager = makeManager(output, spawnStub, connectStub);
        await manager.start();
        assert.strictEqual(spawnStub.callCount, 1);

        // Simulate the OS reporting the process gone, unprompted -- not a
        // `teardown()`-initiated kill, so `expectedExit` is false and this
        // must be treated as a crash (Build Order step 16, design question 3).
        fakeChildren[0].emit('exit', 1, null);

        // The exit handler's `void this.restart(...)` sets `currentRecovery`
        // synchronously before its first await, so joining it here (rather
        // than polling) gets the real eventual outcome, per `restart()`'s own
        // de-dupe contract.
        const recovered = await manager.restart('test-join');

        assert.strictEqual(recovered, true);
        assert.strictEqual(spawnStub.callCount, 2, 'a second sidecar process should have been spawned');
    });

    test('teardown()-initiated exit (dispose) does not trigger a spurious restart', async () => {
        const fakeChildren: FakeChildProcess[] = [];
        spawnStub.callsFake(() => {
            const child = createFakeChildProcess();
            fakeChildren.push(child);
            return child as unknown as cp.ChildProcess;
        });
        stubConnectAlwaysSucceeds(connectStub);

        manager = makeManager(output, spawnStub, connectStub);
        await manager.start();
        assert.strictEqual(spawnStub.callCount, 1);

        manager.dispose();
        assert.strictEqual(fakeChildren[0].kill.called, true);

        // A real child process's 'exit' event arrives asynchronously after
        // kill() -- simulate that late arrival and confirm the `disposed`
        // guard swallows it rather than spawning a replacement.
        fakeChildren[0].emit('exit', null, 'SIGTERM');
        await new Promise((resolve) => process.nextTick(resolve));
        assert.strictEqual(spawnStub.callCount, 1, 'dispose must not trigger a restart');
    });

    test('a late exit event from a superseded (already-replaced) child is ignored', async () => {
        const fakeChildren: FakeChildProcess[] = [];
        spawnStub.callsFake(() => {
            const child = createFakeChildProcess();
            fakeChildren.push(child);
            return child as unknown as cp.ChildProcess;
        });
        stubConnectAlwaysSucceeds(connectStub);

        manager = makeManager(output, spawnStub, connectStub);
        await manager.start();
        const oldChild = fakeChildren[0];

        // A manual restart (resetAttempts=true, same entry point
        // `applyOllamaEndpoint`/the restart command use) tears down and
        // respawns -- teardown() marks the old child's exit as expected.
        const restarted = await manager.restart('manual', true);
        assert.strictEqual(restarted, true);
        assert.strictEqual(spawnStub.callCount, 2);

        // The old (already-torn-down) child's real exit event arrives late.
        // `this.childProcess !== child` must guard this -- it is no longer
        // the live child, regardless of `expectedExit`'s current value.
        oldChild.emit('exit', null, 'SIGTERM');
        await new Promise((resolve) => process.nextTick(resolve));
        assert.strictEqual(spawnStub.callCount, 2, 'a stale exit event must not trigger another restart');
    });

    test(
        'gives up after MAX_RESTART_ATTEMPTS consecutive failures (status + one-time toast), ' +
            'then a manual restart un-sticks it',
        async function () {
            this.timeout(90_000); // real backoff delays (up to ~54s) -- see design note below

            spawnStub.callsFake(() => createFakeChildProcess() as unknown as cp.ChildProcess);
            stubConnectAlwaysFails(connectStub);

            manager = makeManager(output, spawnStub, connectStub);
            const gaveUp = await manager.restart('test crash loop');

            assert.strictEqual(gaveUp, false, 'restart() must resolve false once the recovery loop gives up');
            assert.strictEqual((manager as unknown as { givenUp: boolean }).givenUp, true);
            assert.strictEqual(spawnStub.callCount, 5, 'exactly MAX_RESTART_ATTEMPTS spawn attempts');
            assert.strictEqual(showErrorMessageStub.callCount, 1, 'the give-up toast fires exactly once');
            assert.match(
                (manager as unknown as { statusBarItem: vscode.StatusBarItem }).statusBarItem.text,
                /sidecar down/
            );

            // Now let connects succeed, and drive the un-stick path a manual
            // restart is supposed to provide (Build Order step 16, design
            // question 4): reset attempts/given-up state and reconnect.
            stubConnectAlwaysSucceeds(connectStub);
            const recovered = await manager.applyOllamaEndpoint('http://localhost:11434');

            assert.strictEqual(recovered, true);
            assert.strictEqual((manager as unknown as { givenUp: boolean }).givenUp, false);
            assert.strictEqual((manager as unknown as { restartAttempts: number }).restartAttempts, 0);
            assert.strictEqual(spawnStub.callCount, 6, 'the manual restart spawns one more attempt');
        }
    );
});
