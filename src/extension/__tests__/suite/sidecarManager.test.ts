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

// Real connect-retry defaults (120 attempts x 250ms, see sidecarManager.ts's
// CONNECT_RETRY_ATTEMPTS doc comment) are calibrated for real repo-indexing
// startup time, not test speed -- every test here stubs `connectFn` (no real
// socket/pipe involved), so there is no production behavior to preserve by
// waiting through that budget in real time. A small, deterministic budget
// keeps every test's connect-retry loop (when it runs at all) effectively
// instantaneous regardless of how large the real default grows in the future.
const TEST_CONNECT_RETRY_ATTEMPTS = 3;
const TEST_CONNECT_RETRY_DELAY_MS = 1;

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
        connectFn as unknown as typeof net.connect,
        TEST_CONNECT_RETRY_ATTEMPTS,
        TEST_CONNECT_RETRY_DELAY_MS
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

    // Marketplace-readiness gate finding (code-reviewer): `python` alone is
    // missing on PATH on many non-Windows setups (python3-only distros/macOS
    // installs) -- this closes that gap.
    test('falls back to python3 when python ENOENTs, and succeeds without a full restart cycle', async () => {
        const fakeChildren: FakeChildProcess[] = [];
        spawnStub.callsFake(() => {
            const child = createFakeChildProcess();
            fakeChildren.push(child);
            if (fakeChildren.length === 1) {
                process.nextTick(() => {
                    const err = Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' });
                    child.emit('error', err);
                });
            }
            return child as unknown as cp.ChildProcess;
        });
        stubConnectAlwaysSucceeds(connectStub);

        manager = makeManager(output, spawnStub, connectStub);
        await manager.start();

        assert.strictEqual(spawnStub.callCount, 2, 'expected a second spawn attempt after the first ENOENTs');
        assert.strictEqual(spawnStub.firstCall.args[0], 'python');
        assert.strictEqual(spawnStub.secondCall.args[0], 'python3');
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

    /**
     * Session 53: `connectWithRetry`'s rejection is identical (repeated
     * `ENOENT`) whether the child never spawned, crashed before listening,
     * or is alive and simply still indexing a large repo -- these three
     * tests drive each real, distinguishable child-process state directly
     * and check `classifyStartFailure()`/`failureCauseDescription()`
     * (private, accessed the same cast-to-internals way the rest of this
     * suite already does) without paying the full multi-attempt backoff
     * cost `manager.restart()` would incur, since classification doesn't
     * depend on how many attempts have run.
     */
    suite('recovery failure classification', () => {
        function internals(m: SidecarManager) {
            return m as unknown as {
                classifyStartFailure: () => string;
                failureCauseDescription: () => string;
                lastSpawnError: NodeJS.ErrnoException | null;
                lastFailureCause: string | null;
            };
        }

        // `failureCauseDescription()` reads the cached `lastFailureCause`
        // field rather than re-classifying -- production always assigns it
        // right before reading it (`runRecoveryLoop`'s
        // `this.lastFailureCause = this.classifyStartFailure()`, immediately
        // followed by `updateStatusBar()`/`notifyGaveUp()`). These tests
        // call `start()` directly (bypassing `runRecoveryLoop` entirely, to
        // avoid its multi-attempt backoff cost), so they must reproduce that
        // same assignment themselves before checking the description.
        function classifyAndDescribe(m: SidecarManager): { cause: string; description: string } {
            const i = internals(m);
            const cause = i.classifyStartFailure();
            i.lastFailureCause = cause;
            return { cause, description: i.failureCauseDescription() };
        }

        test('a child "error" event (e.g. python missing from PATH) classifies as spawn-failed', async () => {
            const fakeChildren: FakeChildProcess[] = [];
            spawnStub.callsFake(() => {
                const child = createFakeChildProcess();
                fakeChildren.push(child);
                process.nextTick(() => {
                    const err = Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' });
                    child.emit('error', err);
                });
                return child as unknown as cp.ChildProcess;
            });
            stubConnectAlwaysFails(connectStub);

            manager = makeManager(output, spawnStub, connectStub);
            await assert.rejects(() => manager!.start());

            const { cause, description } = classifyAndDescribe(manager);
            assert.strictEqual(cause, 'spawn-failed');
            assert.ok(internals(manager).lastSpawnError, 'the spawn error should be captured, not left unhandled');
            assert.match(description, /Python is installed and on PATH/);
        });

        test('python AND python3 both ENOENT still classifies as spawn-failed, from the last candidate\'s error', async () => {
            const fakeChildren: FakeChildProcess[] = [];
            spawnStub.callsFake(() => {
                const child = createFakeChildProcess();
                fakeChildren.push(child);
                process.nextTick(() => {
                    const err = Object.assign(new Error(`spawn ${fakeChildren.length === 1 ? 'python' : 'python3'} ENOENT`), {
                        code: 'ENOENT',
                    });
                    child.emit('error', err);
                });
                return child as unknown as cp.ChildProcess;
            });
            stubConnectAlwaysFails(connectStub);

            manager = makeManager(output, spawnStub, connectStub);
            await assert.rejects(() => manager!.start());

            assert.strictEqual(spawnStub.callCount, 2, 'expected the python3 fallback to have been tried too');
            const { cause } = classifyAndDescribe(manager);
            assert.strictEqual(cause, 'spawn-failed');
            assert.match(internals(manager).lastSpawnError!.message, /spawn python3 ENOENT/);
        });

        test('a child that already exited before listening classifies as process-crashed', async () => {
            const fakeChildren: FakeChildProcess[] = [];
            spawnStub.callsFake(() => {
                const child = createFakeChildProcess();
                fakeChildren.push(child);
                return child as unknown as cp.ChildProcess;
            });
            stubConnectAlwaysFails(connectStub);

            manager = makeManager(output, spawnStub, connectStub);
            const startPromise = manager.start();
            // Set the exit state directly rather than emitting 'exit' --
            // emitting would also fire `start()`'s own exit handler, which
            // would trigger a second, unrelated recovery loop racing this
            // one (see that handler's own doc comment). Real
            // `child_process.ChildProcess` sets `exitCode` before emitting
            // 'exit' regardless, so this reproduces the same observed state
            // `classifyStartFailure()` reads without the cascade.
            fakeChildren[0].exitCode = 1;
            await assert.rejects(() => startPromise);

            const { cause, description } = classifyAndDescribe(manager);
            assert.strictEqual(cause, 'process-crashed');
            assert.match(description, /exited before it finished starting up/);
        });

        test('a still-alive child that never opened the socket classifies as slow-first-index, not a crash', async () => {
            spawnStub.callsFake(() => createFakeChildProcess() as unknown as cp.ChildProcess);
            stubConnectAlwaysFails(connectStub);

            manager = makeManager(output, spawnStub, connectStub);
            await assert.rejects(() => manager!.start());

            const { cause, description } = classifyAndDescribe(manager);
            assert.strictEqual(cause, 'slow-first-index');
            assert.match(description, /has not finished indexing this workspace yet/);
        });
    });

    test(
        'give-up toast and status bar reflect a genuine spawn failure with a specific message, not the generic one',
        async function () {
            this.timeout(90_000); // real backoff delays (up to ~54s) -- see the pre-existing give-up test above

            // Every candidate interpreter ENOENTs here (python AND its
            // python3 fallback), so each of the MAX_RESTART_ATTEMPTS restart
            // attempts now spawns twice before giving up on that attempt --
            // 5 attempts x 2 candidates = 10 total spawn calls.
            spawnStub.callsFake(() => {
                const child = createFakeChildProcess();
                process.nextTick(() => {
                    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
                    child.emit('error', err);
                });
                return child as unknown as cp.ChildProcess;
            });
            stubConnectAlwaysFails(connectStub);

            manager = makeManager(output, spawnStub, connectStub);
            const gaveUp = await manager.restart('test spawn failure loop');

            assert.strictEqual(gaveUp, false);
            assert.strictEqual(spawnStub.callCount, 10, 'MAX_RESTART_ATTEMPTS x SPAWN_INTERPRETER_CANDIDATES.length');
            assert.strictEqual(showErrorMessageStub.callCount, 1);

            const toastMessage = showErrorMessageStub.firstCall.args[0] as string;
            assert.match(toastMessage, /Python is installed and on PATH/);
            assert.match(
                (manager as unknown as { statusBarItem: vscode.StatusBarItem }).statusBarItem.tooltip as string,
                /Python is installed and on PATH/
            );
        }
    );
});
