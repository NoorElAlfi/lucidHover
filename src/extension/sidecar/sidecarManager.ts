import * as cp from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Heartbeat cadence. Chosen as a reasonable middle ground: fast enough that a dead
 * sidecar doesn't sit unresponsive for long, slow enough not to spam the process. */
const HEARTBEAT_INTERVAL_MS = 7_000;
/** Consecutive heartbeat failures before we conclude the sidecar is gone and restart it. */
const HEARTBEAT_FAILURE_THRESHOLD = 3;
const REQUEST_TIMEOUT_MS = 4_000;
/** Session 32: once no interactive-priority request is pending, a background
 * loop still waits this long before committing to sending its next request --
 * a short settle window so an interactive request that's about to be issued
 * (e.g. VS Code just dispatched a hover a few ms before this check ran) gets
 * a chance to register as pending before a background call starts. Once a
 * background request is actually sent, nothing can preempt it (Core Rule 11:
 * the sidecar dispatches strictly one request at a time), so this window is
 * the only remaining lever on the client side. See session-32 artifact for
 * the measurement this value is tuned against. */
const INTERACTIVE_GRACE_MS = 300;
/** Total connect-retry budget (attempts x delay) is deliberately generous --
 * `repo_map.index()` (rpc_server.py's `main()`) runs synchronously before the
 * socket/pipe opens, and its cost scales with repo size. The previous budget
 * (20 x 250ms = 5s) was calibrated for the small fixture repos (sub-second
 * indexing) and was never re-checked against a real repo -- confirmed
 * directly against a 615-file real-world TypeScript repo that indexing alone
 * takes ~5.5s, i.e. it silently exceeded the old budget, causing every
 * restart attempt to fail identically (the sidecar was never actually
 * crashing -- it just hadn't finished indexing before the extension gave up
 * waiting for the socket) until `runRecoveryLoop` gave up after
 * `MAX_RESTART_ATTEMPTS`. 120 x 250ms = 30s gives real headroom for
 * repos meaningfully larger than that one without changing the retry
 * cadence itself. This is the same class of startup-budget bug
 * `_embed_repo_in_background`'s own doc comment (rpc_server.py) already
 * describes hitting once before, for the embedding pass -- backgrounding
 * `repo_map.index()` the same way would remove the ceiling entirely, but
 * needs a "not indexed yet" degraded-RPC-response protocol that doesn't
 * exist today; raising this budget is the minimal fix for the problem as
 * actually measured. */
const CONNECT_RETRY_ATTEMPTS = 120;
const CONNECT_RETRY_DELAY_MS = 250;
/** Consecutive failed (re)start attempts before the recovery loop gives up and
 * waits for a manual "Restart Sidecar" instead of retrying forever (Build
 * Order step 16). */
const MAX_RESTART_ATTEMPTS = 5;
/** Exponential backoff between (re)start attempts: 2s, 4s, 8s, 16s, 30s (capped). */
const RESTART_BACKOFF_BASE_MS = 2_000;
const RESTART_BACKOFF_MAX_MS = 30_000;

/**
 * Session 32: distinguishes a real-time-sensitive caller (hover cache-miss,
 * debounced-save reindex, manual refresh, panel navigation -- default,
 * matches every call site that existed before this session) from an
 * opportunistic background caller (`BackgroundIndexManager`'s pre-generation
 * walk) that can and should defer to interactive work. Purely a client-side
 * scheduling hint -- the sidecar's own dispatch loop knows nothing about it
 * and stays strictly one-request-at-a-time either way (Core Rule 11).
 */
export type RequestPriority = 'interactive' | 'background';

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    priority: RequestPriority;
}

interface RpcResponse {
    id: number | null;
    result?: unknown;
    error?: { message: string };
}

function computeAddress(): string {
    const id = `lucidhover-${process.pid}-${Date.now()}`;
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\${id}`;
    }
    return path.join(os.tmpdir(), `${id}.sock`);
}

function connectWithRetry(
    address: string,
    connectFn: typeof net.connect,
    attempts: number,
    delayMs: number
): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        let attempt = 0;

        const tryConnect = () => {
            attempt++;
            const socket = connectFn(address);

            const onError = (err: Error) => {
                socket.removeAllListeners();
                socket.destroy();
                if (attempt >= attempts) {
                    reject(err);
                } else {
                    setTimeout(tryConnect, delayMs);
                }
            };

            socket.once('error', onError);
            socket.once('connect', () => {
                socket.removeListener('error', onError);
                resolve(socket);
            });
        };

        tryConnect();
    });
}

/**
 * Spawns and supervises the Python sidecar process (Core Design Decision #7):
 * a local socket/named-pipe JSON-RPC connection, with heartbeat-driven
 * auto-restart. Only indexing/generation calls go through here -- hover
 * itself must never depend on this being alive synchronously (Core Rule 4).
 */
export class SidecarManager implements vscode.Disposable {
    private readonly workspaceRoot: string;
    private readonly extensionRoot: string;
    private readonly storageDir: string;
    private readonly embeddingModelId: string;
    // Not readonly, unlike the spawn-time values above: `applyOllamaEndpoint`
    // (Build Order step 14) updates this and respawns, since there's no
    // per-request path for it the way `model_id` has (see cache/config.ts's
    // `resolveOllamaEndpoint` doc for why it can't be per-request).
    private ollamaBaseUrl: string;
    private readonly output: vscode.OutputChannel;

    private childProcess: cp.ChildProcess | null = null;
    private socket: net.Socket | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private readonly pendingRequests = new Map<number, PendingRequest>();
    private nextId = 1;
    /** Session 32: resolve callbacks for `waitForInteractiveIdle()` callers
     * currently parked, woken whenever the interactive-pending count could
     * have dropped to zero (see `notifyIfIdle`). */
    private interactiveIdleWaiters: Array<() => void> = [];
    private buffer = '';
    private consecutiveFailures = 0;
    private restarting = false;
    private disposed = false;
    /** True only while `teardown()` is deliberately killing a still-running
     * child (an in-progress restart/dispose) -- distinguishes an expected
     * exit from an unexpected crash for the `child.on('exit', ...)` handler. */
    private expectedExit = false;
    /** Consecutive failed (re)start attempts since the last success or the
     * last manual restart's explicit reset (Build Order step 16). */
    private restartAttempts = 0;
    /** True once the recovery loop has hit MAX_RESTART_ATTEMPTS and stopped
     * auto-retrying; cleared by a manual restart. */
    private givenUp = false;
    /** The single in-flight recovery loop, if any -- every restart trigger
     * (heartbeat, unexpected exit, manual command, initial startup) funnels
     * through `restart()`, which de-dupes against this rather than letting
     * concurrent triggers spawn competing loops. */
    private currentRecovery: Promise<boolean> | null = null;
    private restartRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private restartRetrySignal: (() => void) | null = null;
    private readonly statusBarItem: vscode.StatusBarItem;
    // Injectable seams for `child_process.spawn`/`net.connect`, defaulting to
    // the real functions -- every production call site (`extension.ts`)
    // relies on the defaults and is unaffected. Added for Build Order step 17:
    // the Extension Development Host's `child_process`/`net` module exports
    // turned out to have non-configurable property descriptors, so sinon
    // cannot monkey-patch them there (`sinon.stub(cp, 'spawn')` throws
    // "non-configurable and non-writable"); constructor injection sidesteps
    // that entirely rather than fighting the platform, letting
    // `sidecarManager.test.ts` pass plain stub functions straight in.
    private readonly spawnFn: typeof cp.spawn;
    private readonly connectFn: typeof net.connect;
    // Same injection precedent as spawnFn/connectFn above, for the same
    // reason: sidecarManager.test.ts drives the "gives up after
    // MAX_RESTART_ATTEMPTS" path with a stub that fails every connect
    // attempt, so this budget's *real* wall-clock cost (attempts x delayMs,
    // per restart attempt) is entirely test runtime with no production
    // value -- at the real default (120 x 250ms = 30s, see CONNECT_RETRY_ATTEMPTS's
    // doc comment) that test would take minutes. Defaults preserve production
    // behavior; only the test passes small values.
    private readonly connectRetryAttempts: number;
    private readonly connectRetryDelayMs: number;

    constructor(
        workspaceRoot: string,
        extensionRoot: string,
        storageDir: string,
        embeddingModelId: string,
        ollamaBaseUrl: string,
        output: vscode.OutputChannel,
        spawnFn: typeof cp.spawn = cp.spawn,
        connectFn: typeof net.connect = net.connect,
        connectRetryAttempts: number = CONNECT_RETRY_ATTEMPTS,
        connectRetryDelayMs: number = CONNECT_RETRY_DELAY_MS
    ) {
        this.workspaceRoot = workspaceRoot;
        this.extensionRoot = extensionRoot;
        this.storageDir = storageDir;
        this.embeddingModelId = embeddingModelId;
        this.ollamaBaseUrl = ollamaBaseUrl;
        this.output = output;
        this.spawnFn = spawnFn;
        this.connectFn = connectFn;
        this.connectRetryAttempts = connectRetryAttempts;
        this.connectRetryDelayMs = connectRetryDelayMs;

        // Hidden until the recovery loop actually needs to say something
        // (Build Order step 16, design question 2) -- a healthy sidecar never
        // shows this.
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'lucidhover.restartSidecar';
    }

    async start(): Promise<void> {
        const address = computeAddress();
        this.log(`spawning sidecar (address=${address}, root=${this.workspaceRoot})`);

        // `storageDir`/`embeddingModelId` (Session 11) and `ollamaBaseUrl`
        // (Build Order step 14): spawn-time, not per-request, params -- see
        // cache/config.ts's EMBEDDING_MODEL_ID / resolveOllamaEndpoint doc
        // comments for why the retrieval tier and the custom-endpoint tier
        // both need these known before the sidecar's startup embedding pass
        // runs, ahead of any RPC call.
        const child = this.spawnFn(
            'python',
            [
                '-m',
                'sidecar.rpc_server',
                address,
                this.workspaceRoot,
                this.storageDir,
                this.embeddingModelId,
                this.ollamaBaseUrl,
            ],
            { cwd: this.extensionRoot }
        );
        this.childProcess = child;
        this.expectedExit = false;

        child.stdout?.on('data', (data: Buffer) => this.log(data.toString('utf8').trimEnd()));
        child.stderr?.on('data', (data: Buffer) => this.log(`[stderr] ${data.toString('utf8').trimEnd()}`));
        child.on('exit', (code, signal) => {
            this.log(`sidecar process exited (code=${code}, signal=${signal})`);
            // `teardown()` sets `expectedExit` right before it kills a child
            // itself (a deliberate restart/dispose) -- anything else is an
            // unexpected crash the recovery loop should react to immediately
            // rather than waiting for the next heartbeat tick to notice
            // (Build Order step 16, design question 3). The `childProcess
            // !== child` check guards against a stale listener on an old
            // process instance firing after a newer one has already taken
            // over.
            if (this.disposed || this.expectedExit || this.childProcess !== child) {
                return;
            }
            this.log('sidecar exited unexpectedly -- triggering recovery');
            void this.restart('sidecar process exited unexpectedly');
        });

        const socket = await connectWithRetry(address, this.connectFn, this.connectRetryAttempts, this.connectRetryDelayMs);
        this.socket = socket;
        this.buffer = '';
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        socket.on('error', (err) => this.log(`socket error: ${err.message}`));

        this.heartbeatTimer = setInterval(() => {
            void this.heartbeatTick();
        }, HEARTBEAT_INTERVAL_MS);
    }

    /**
     * Sends a JSON-RPC request and waits for its matching response.
     *
     * `priority` (Session 32) defaults to `'interactive'`, matching every
     * call site that existed before this session -- only
     * `BackgroundIndexManager`'s pre-generation loop passes `'background'`.
     * It doesn't change how this request is sent or dispatched (the sidecar
     * is still strictly one-at-a-time, Core Rule 11); it only makes this
     * request visible to `waitForInteractiveIdle()` while it's pending, so a
     * background caller can defer its *next* request until interactive work
     * has drained.
     */
    request<T = unknown>(
        method: string,
        params: unknown,
        timeoutMs = REQUEST_TIMEOUT_MS,
        priority: RequestPriority = 'interactive'
    ): Promise<T> {
        if (!this.socket || this.socket.destroyed) {
            return Promise.reject(new Error('sidecar is not connected'));
        }

        const id = this.nextId++;
        const payload = `${JSON.stringify({ id, method, params })}\n`;
        const socket = this.socket;

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                this.notifyIfIdle();
                reject(new Error(`sidecar request timed out: ${method}`));
            }, timeoutMs);

            this.pendingRequests.set(id, {
                resolve: (value: unknown) => {
                    clearTimeout(timer);
                    resolve(value as T);
                },
                reject: (err: Error) => {
                    clearTimeout(timer);
                    reject(err);
                },
                priority,
            });

            socket.write(payload, (err) => {
                if (err) {
                    this.pendingRequests.delete(id);
                    this.notifyIfIdle();
                    clearTimeout(timer);
                    reject(err);
                }
            });
        });
    }

    /**
     * Resolves once no interactive-priority request is pending, after a
     * short settle window (see `INTERACTIVE_GRACE_MS`) confirms nothing new
     * arrived in the meantime. Intended for a background caller to await
     * immediately before sending each of its own requests -- see
     * `BackgroundIndexManager`'s pre-generation loop. Local, in-memory
     * bookkeeping only; never issues an RPC of its own (Core Rule 11's
     * "don't add a polling loop" is about sidecar traffic, not this).
     */
    async waitForInteractiveIdle(): Promise<void> {
        while (!this.disposed) {
            while (this.hasInteractivePending() && !this.disposed) {
                await this.nextIdleSignal();
            }
            if (this.disposed) {
                return;
            }
            // A fresh, independent timer -- deliberately not the `sleep()`
            // helper below, which stores its timer/resolve callback in the
            // single-slot `restartRetryTimer`/`restartRetrySignal` fields for
            // `runRecoveryLoop`'s backoff wait. This grace wait and a restart
            // backoff can legitimately be in flight at the same time (a
            // crash-triggered restart backing off while background indexing
            // is separately parked here); sharing that single slot would let
            // whichever one calls `sleep()` second silently steal the
            // other's timer out from under `cancelPendingRetry()` (found by
            // code-reviewer during this session).
            await new Promise<void>((resolve) => setTimeout(resolve, INTERACTIVE_GRACE_MS));
            if (!this.hasInteractivePending()) {
                return;
            }
            // Something interactive arrived during the settle window -- loop
            // around and wait it out too.
        }
    }

    private hasInteractivePending(): boolean {
        for (const pending of this.pendingRequests.values()) {
            if (pending.priority === 'interactive') {
                return true;
            }
        }
        return false;
    }

    private nextIdleSignal(): Promise<void> {
        return new Promise((resolve) => this.interactiveIdleWaiters.push(resolve));
    }

    /** Call after any removal from `pendingRequests` -- wakes every parked
     * `waitForInteractiveIdle()` caller if the interactive count has (or
     * could have) reached zero. Waking on every removal rather than only
     * interactive ones keeps this simple; a spurious wake just re-checks and
     * goes back to waiting if something interactive is still pending. */
    private notifyIfIdle(): void {
        if (this.hasInteractivePending()) {
            return;
        }
        const waiters = this.interactiveIdleWaiters;
        this.interactiveIdleWaiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }

    dispose(): void {
        this.disposed = true;
        this.cancelPendingRetry();
        this.teardown('dispose');
        this.statusBarItem.dispose();
    }

    /**
     * Applies a freshly-resolved `lucidHover.ollamaEndpoint` value and
     * respawns the sidecar with it (Build Order step 14). Backs the
     * explicit "LucidHover: Restart Sidecar" command -- `ollamaBaseUrl` is
     * spawn-time config (see the field's own comment above), so there is no
     * way to change which Ollama daemon the sidecar talks to without a
     * respawn; this reuses the same recovery loop the heartbeat/exit-driven
     * auto-restart already relies on, just with a new value in place first,
     * triggered explicitly, and with the backoff/give-up state reset (Build
     * Order step 16, design question 4 -- a manual restart is a fresh start,
     * even if an auto-retry happens to be mid-backoff at that moment).
     */
    async applyOllamaEndpoint(url: string): Promise<boolean> {
        this.ollamaBaseUrl = url;
        return this.restart('applying lucidHover.ollamaEndpoint', true);
    }

    private onData(chunk: Buffer): void {
        this.buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            if (line.trim().length > 0) {
                this.handleMessage(line);
            }
        }
    }

    private handleMessage(line: string): void {
        let message: RpcResponse;
        try {
            message = JSON.parse(line) as RpcResponse;
        } catch (err) {
            this.log(`failed to parse sidecar message: ${String(err)}`);
            return;
        }

        const pending = message.id !== null ? this.pendingRequests.get(message.id) : undefined;
        if (!pending) {
            return;
        }
        this.pendingRequests.delete(message.id as number);
        this.notifyIfIdle();

        if (message.error) {
            pending.reject(new Error(message.error.message));
        } else {
            pending.resolve(message.result);
        }
    }

    private async heartbeatTick(): Promise<void> {
        if (this.disposed || this.restarting) {
            return;
        }
        if (this.pendingRequests.size > 0) {
            // The sidecar's request loop is strictly one-at-a-time per
            // connection (sidecar/rpc_server.py's _process_lines) -- a
            // `status` ping sent while a real `generate_explanation` call
            // is in flight (routinely 10s-60s+ for real generation, see
            // session-06 artifact) would just queue behind it and almost
            // certainly time out, producing a false "unresponsive" signal
            // that kills a perfectly healthy sidecar mid-request. The
            // outstanding request's own eventual resolution/rejection is
            // already a liveness signal; skip the heartbeat until idle.
            return;
        }
        try {
            await this.request('status', {});
            this.consecutiveFailures = 0;
        } catch (err) {
            this.consecutiveFailures++;
            this.log(
                `heartbeat failed (${this.consecutiveFailures}/${HEARTBEAT_FAILURE_THRESHOLD}): ${String(err)}`
            );
            if (this.consecutiveFailures >= HEARTBEAT_FAILURE_THRESHOLD) {
                // Fire-and-forget: `restart()` never throws (see below), and
                // `heartbeatTick` is itself invoked fire-and-forget from the
                // interval timer, so there's no caller here to hand a result
                // to.
                void this.restart('unresponsive');
            }
        }
    }

    /**
     * The single entry point for every restart trigger (heartbeat threshold,
     * an unexpected `child.on('exit', ...)`, the manual "Restart Sidecar"
     * command, and -- via `startIndexing()` -- the very first startup
     * attempt). Never throws; resolves `true` once reconnected, `false` if
     * the recovery loop gave up after `MAX_RESTART_ATTEMPTS` (Build Order
     * step 16, design questions 1 and 5).
     *
     * De-dupes against `currentRecovery` rather than just no-op'ing on
     * reentrancy: if a loop is already in flight (mid-attempt, or asleep
     * between backoff attempts), a concurrent caller wakes it early and
     * awaits its real eventual outcome instead of either being silently
     * ignored or spawning a second, competing loop (design question 4).
     */
    async restart(reason = 'unresponsive', resetAttempts = false): Promise<boolean> {
        if (this.disposed) {
            return false;
        }
        if (resetAttempts) {
            this.restartAttempts = 0;
            this.givenUp = false;
        }
        if (this.currentRecovery) {
            this.log(`sidecar restart (${reason}) requested while recovery already in progress -- joining it`);
            this.cancelPendingRetry();
            return this.currentRecovery;
        }
        const promise = this.runRecoveryLoop(reason);
        this.currentRecovery = promise;
        try {
            return await promise;
        } finally {
            this.currentRecovery = null;
        }
    }

    private async runRecoveryLoop(reason: string): Promise<boolean> {
        this.restarting = true;
        this.log(`sidecar recovery starting (${reason})`);
        try {
            while (!this.disposed) {
                this.teardown(reason);
                try {
                    await this.start();
                    this.log('sidecar (re)started successfully');
                    this.restartAttempts = 0;
                    this.consecutiveFailures = 0;
                    this.givenUp = false;
                    this.updateStatusBar();
                    return true;
                } catch (err) {
                    this.restartAttempts++;
                    this.log(
                        `sidecar start attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS} failed (${reason}): ${String(err)}`
                    );
                    if (this.disposed) {
                        // `dispose()` raced with this attempt (it can call
                        // `teardown()` while `start()` is still in flight,
                        // same as before this session) -- stop instead of
                        // scheduling a backoff sleep nothing will ever cancel.
                        return false;
                    }
                    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
                        this.givenUp = true;
                        this.updateStatusBar();
                        this.notifyGaveUp(reason);
                        return false;
                    }
                    this.updateStatusBar();
                    const delay = Math.min(
                        RESTART_BACKOFF_BASE_MS * 2 ** (this.restartAttempts - 1),
                        RESTART_BACKOFF_MAX_MS
                    );
                    await this.sleep(delay);
                }
            }
            return false;
        } finally {
            this.restarting = false;
        }
    }

    /** Resolves after `ms`, or immediately if `cancelPendingRetry()` wakes it
     * early (a manual restart interrupting a backoff wait, or `dispose()`). */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            this.restartRetrySignal = resolve;
            this.restartRetryTimer = setTimeout(() => {
                this.restartRetryTimer = null;
                this.restartRetrySignal = null;
                resolve();
            }, ms);
        });
    }

    private cancelPendingRetry(): void {
        if (this.restartRetryTimer) {
            clearTimeout(this.restartRetryTimer);
            this.restartRetryTimer = null;
        }
        if (this.restartRetrySignal) {
            const resolve = this.restartRetrySignal;
            this.restartRetrySignal = null;
            resolve();
        }
    }

    /** Reflects current recovery state in the status bar (Build Order step
     * 16, design question 2). Hidden while healthy; a low-friction spinner
     * once a backoff-retry is actually scheduled (already past the
     * heartbeat's own 3-strike quiet buffer and, for a crash, the first
     * immediate retry attempt); an explicit error state once the loop has
     * given up. */
    private updateStatusBar(): void {
        if (this.disposed) {
            return;
        }
        if (this.givenUp) {
            this.statusBarItem.text = '$(error) LucidHover: sidecar down';
            this.statusBarItem.tooltip = 'The LucidHover sidecar could not be restarted. Click to retry.';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            this.statusBarItem.show();
        } else if (this.restartAttempts > 0) {
            this.statusBarItem.text = `$(sync~spin) LucidHover: sidecar restarting (${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})`;
            this.statusBarItem.tooltip = 'The LucidHover sidecar is recovering from an unexpected exit or unresponsive state.';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }

    /** Fires once per give-up episode -- the one point auto-recovery has
     * actually stopped and a toast (rather than the ambient status bar) is
     * warranted (design question 2). Offers a direct action back into the
     * existing "LucidHover: Restart Sidecar" command. */
    private notifyGaveUp(reason: string): void {
        if (this.disposed) {
            return;
        }
        this.log(`sidecar recovery gave up after ${MAX_RESTART_ATTEMPTS} attempts (${reason})`);
        void vscode.window
            .showErrorMessage(
                `LucidHover: the sidecar process could not be restarted after ${MAX_RESTART_ATTEMPTS} attempts. ` +
                    'Indexing and explanation updates are paused. See the LucidHover output channel for details.',
                'Restart Sidecar'
            )
            .then((choice) => {
                if (choice === 'Restart Sidecar') {
                    void vscode.commands.executeCommand('lucidhover.restartSidecar');
                }
            });
    }

    private teardown(reason: string): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        if (this.childProcess && this.childProcess.exitCode === null && !this.childProcess.killed) {
            // Tell the exit handler this kill is deliberate (a restart or
            // dispose tearing down the old process), not a crash to react to.
            this.expectedExit = true;
            this.childProcess.kill();
        }
        this.childProcess = null;

        for (const pending of this.pendingRequests.values()) {
            pending.reject(new Error(`sidecar torn down (${reason})`));
        }
        this.pendingRequests.clear();
        this.notifyIfIdle();
    }

    private log(message: string): void {
        // Guard against a late child-process stdout/stderr 'data' event
        // firing after dispose() has already torn everything down --
        // teardown() kills the child but doesn't await its exit, and
        // doesn't remove the process's own stdout/stderr listeners (only
        // the socket's), so a straggler can still call in here with the
        // output channel already disposed (found session 27).
        if (this.disposed) {
            return;
        }
        this.output.appendLine(message);
    }
}
