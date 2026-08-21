import { EventEmitter } from 'events';
import * as sinon from 'sinon';

/**
 * Minimal stand-in for `cp.ChildProcess`, covering only what
 * `SidecarManager.start()`/`teardown()` touch: `.stdout`/`.stderr` data
 * events, `.on('exit', ...)`, `.kill()`, `.exitCode`, `.killed`. Built with
 * plain `EventEmitter` rather than a mocking library beyond sinon (Core
 * Rule 3 -- no new IPC/process library).
 *
 * Passed into `SidecarManager` via its injectable `spawnFn`/`connectFn`
 * constructor params, not via `sinon.stub(child_process, 'spawn')` -- the
 * Extension Development Host's `child_process`/`net` module exports turned
 * out to have non-configurable property descriptors, so sinon cannot
 * monkey-patch them directly there.
 */
export interface FakeChildProcess extends EventEmitter {
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
    kill: sinon.SinonStub;
}

export function createFakeChildProcess(): FakeChildProcess {
    const child = new EventEmitter() as FakeChildProcess;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.kill = sinon.stub().callsFake(() => {
        child.killed = true;
        return true;
    });
    return child;
}

/** Minimal stand-in for `net.Socket`, covering only what `connectWithRetry`/
 * `SidecarManager` touch. */
export interface FakeSocket extends EventEmitter {
    destroyed: boolean;
    destroy: sinon.SinonStub;
    write: sinon.SinonStub;
}

export function createFakeSocket(): FakeSocket {
    const socket = new EventEmitter() as FakeSocket;
    socket.destroyed = false;
    socket.destroy = sinon.stub().callsFake(() => {
        socket.destroyed = true;
    });
    socket.write = sinon.stub().callsFake((_data: string, cb?: (err?: Error) => void) => {
        cb?.();
        return true;
    });
    return socket;
}

/**
 * Configures a `net.connect` stub so every call resolves (asynchronously,
 * via `process.nextTick` -- deliberately not a fake-timer-controlled
 * `setImmediate`, so this behaves the same whether or not the test has fake
 * timers installed) to a fresh fake socket that immediately "connects".
 */
export function stubConnectAlwaysSucceeds(netConnectStub: sinon.SinonStub): FakeSocket[] {
    const sockets: FakeSocket[] = [];
    netConnectStub.callsFake(() => {
        const socket = createFakeSocket();
        sockets.push(socket);
        process.nextTick(() => socket.emit('connect'));
        return socket;
    });
    return sockets;
}

/** Configures a `net.connect` stub so every call fails immediately. */
export function stubConnectAlwaysFails(netConnectStub: sinon.SinonStub): FakeSocket[] {
    const sockets: FakeSocket[] = [];
    netConnectStub.callsFake(() => {
        const socket = createFakeSocket();
        sockets.push(socket);
        process.nextTick(() => socket.emit('error', new Error('ECONNREFUSED (fake)')));
        return socket;
    });
    return sockets;
}
