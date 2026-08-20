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
const CONNECT_RETRY_ATTEMPTS = 20;
const CONNECT_RETRY_DELAY_MS = 250;

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
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

function connectWithRetry(address: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        let attempt = 0;

        const tryConnect = () => {
            attempt++;
            const socket = net.connect(address);

            const onError = (err: Error) => {
                socket.removeAllListeners();
                socket.destroy();
                if (attempt >= CONNECT_RETRY_ATTEMPTS) {
                    reject(err);
                } else {
                    setTimeout(tryConnect, CONNECT_RETRY_DELAY_MS);
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
    private readonly output: vscode.OutputChannel;

    private childProcess: cp.ChildProcess | null = null;
    private socket: net.Socket | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private readonly pendingRequests = new Map<number, PendingRequest>();
    private nextId = 1;
    private buffer = '';
    private consecutiveFailures = 0;
    private restarting = false;
    private disposed = false;

    constructor(
        workspaceRoot: string,
        extensionRoot: string,
        storageDir: string,
        embeddingModelId: string,
        output: vscode.OutputChannel
    ) {
        this.workspaceRoot = workspaceRoot;
        this.extensionRoot = extensionRoot;
        this.storageDir = storageDir;
        this.embeddingModelId = embeddingModelId;
        this.output = output;
    }

    async start(): Promise<void> {
        const address = computeAddress();
        this.log(`spawning sidecar (address=${address}, root=${this.workspaceRoot})`);

        // `storageDir`/`embeddingModelId` (Session 11): spawn-time, not
        // per-request, params -- see cache/config.ts's EMBEDDING_MODEL_ID
        // doc comment for why the retrieval tier needs these known before
        // the sidecar's startup embedding pass runs, ahead of any RPC call.
        const child = cp.spawn(
            'python',
            ['-m', 'sidecar.rpc_server', address, this.workspaceRoot, this.storageDir, this.embeddingModelId],
            { cwd: this.extensionRoot }
        );
        this.childProcess = child;

        child.stdout?.on('data', (data: Buffer) => this.log(data.toString('utf8').trimEnd()));
        child.stderr?.on('data', (data: Buffer) => this.log(`[stderr] ${data.toString('utf8').trimEnd()}`));
        child.on('exit', (code, signal) => {
            this.log(`sidecar process exited (code=${code}, signal=${signal})`);
        });

        const socket = await connectWithRetry(address);
        this.socket = socket;
        this.buffer = '';
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        socket.on('error', (err) => this.log(`socket error: ${err.message}`));

        this.heartbeatTimer = setInterval(() => {
            void this.heartbeatTick();
        }, HEARTBEAT_INTERVAL_MS);
    }

    /** Sends a JSON-RPC request and waits for its matching response. */
    request<T = unknown>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
        if (!this.socket || this.socket.destroyed) {
            return Promise.reject(new Error('sidecar is not connected'));
        }

        const id = this.nextId++;
        const payload = `${JSON.stringify({ id, method, params })}\n`;
        const socket = this.socket;

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
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
            });

            socket.write(payload, (err) => {
                if (err) {
                    this.pendingRequests.delete(id);
                    clearTimeout(timer);
                    reject(err);
                }
            });
        });
    }

    dispose(): void {
        this.disposed = true;
        this.teardown('dispose');
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
                await this.restart();
            }
        }
    }

    private async restart(): Promise<void> {
        if (this.disposed || this.restarting) {
            return;
        }
        this.restarting = true;
        this.log('sidecar unresponsive -- restarting');
        this.teardown('unresponsive, restarting');
        this.consecutiveFailures = 0;
        try {
            await this.start();
            this.log('sidecar restarted successfully');
        } catch (err) {
            this.log(`sidecar restart failed: ${String(err)}`);
        } finally {
            this.restarting = false;
        }
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
            this.childProcess.kill();
        }
        this.childProcess = null;

        for (const pending of this.pendingRequests.values()) {
            pending.reject(new Error(`sidecar torn down (${reason})`));
        }
        this.pendingRequests.clear();
    }

    private log(message: string): void {
        this.output.appendLine(message);
    }
}
