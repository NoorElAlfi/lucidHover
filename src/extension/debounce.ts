/**
 * Pure per-key debounce, no `vscode` dependency (Session 8). Deliberately
 * factored out of `saveReindex.ts` so the actual "several rapid triggers
 * within the window collapse to one fire" behavior can be unit-tested with
 * plain `node` against the compiled output, without needing a live VS Code
 * Extension Development Host -- see session-08 artifact's "Test status".
 */
export class KeyedDebouncer<K> {
    private readonly timers = new Map<K, ReturnType<typeof setTimeout>>();

    constructor(private readonly delayMs: number) {}

    /** Resets the timer for `key` if one is already pending, then schedules `fn`. */
    schedule(key: K, fn: () => void): void {
        const existing = this.timers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this.timers.delete(key);
            fn();
        }, this.delayMs);
        this.timers.set(key, timer);
    }

    dispose(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }
}
