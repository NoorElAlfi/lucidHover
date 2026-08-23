import * as vscode from 'vscode';
import { resolveFunctionsInFile, ResolvedFunction } from './functionResolution';
import { RequestPriority, SidecarManager } from './sidecar/sidecarManager';

/**
 * `stale` half of Session 13's freshness badge -- the counterpart to
 * `dirty-tracking.ts`'s `DirtyTracker`, but for the other half of the spec's
 * dirty-vs-stale distinction: "stale (confirmed dependency changed, cached
 * explanation may be wrong)". A function's own `fn_hash` can still match its
 * cached row while one of the *other* functions it calls or is called by has
 * genuinely changed -- exact-hash cache lookup has no way to notice that on
 * its own (Core Design Decision #4 keys on content hash, not context_hash).
 *
 * Purely in-memory, mirroring `DirtyTracker`'s shape exactly (relFile -> set
 * of stale fnIds) -- no schema change to the SQLite cache, no new cache-key
 * component. Populated by `flagStaleDependents` below (called by
 * save/flush/git-hook re-indexing, as a side effect of work they already do
 * -- see that function's doc comment), and cleared only when the flagged
 * function itself is actually regenerated (any trigger, including manual
 * refresh) -- never automatically, per Core Design Decision #5.
 */
export class StaleTracker implements vscode.Disposable {
    private readonly staleByFile = new Map<string, Set<string>>();

    markStale(relFile: string, fnId: string): void {
        let set = this.staleByFile.get(relFile);
        if (!set) {
            set = new Set();
            this.staleByFile.set(relFile, set);
        }
        set.add(fnId);
    }

    isStale(relFile: string, fnId: string): boolean {
        return this.staleByFile.get(relFile)?.has(fnId) ?? false;
    }

    clearFnId(relFile: string, fnId: string): void {
        const set = this.staleByFile.get(relFile);
        if (!set) {
            return;
        }
        set.delete(fnId);
        if (set.size === 0) {
            this.staleByFile.delete(relFile);
        }
    }

    dispose(): void {
        this.staleByFile.clear();
    }
}

interface RelatedFunctionDTO {
    rel_fname: string;
    name: string;
    line: number;
    importance: number;
}

interface IndexedFunctionDTO {
    name: string;
    line: number;
    callers: RelatedFunctionDTO[];
    callers_omitted: number;
    callees: RelatedFunctionDTO[];
    callees_omitted: number;
}

interface IndexFileResult {
    file_path: string;
    functions: IndexedFunctionDTO[];
}

/** Nearest-line match within one file's tag list -- same tolerance the sidecar's own `_find_def_tag` and `BackgroundIndexManager.matchRankedEntry` already use, since tree-sitter's def line and VS Code's document-symbol line don't always agree exactly (e.g. arrow-function assignments). */
function closestByName<T extends { name: string; line: number }>(
    entries: readonly T[],
    name: string,
    line: number
): T | undefined {
    const candidates = entries.filter((e) => e.name === name);
    if (candidates.length === 0) {
        return undefined;
    }
    return candidates.reduce((closest, candidate) =>
        Math.abs(candidate.line - line) < Math.abs(closest.line - line) ? candidate : closest
    );
}

function closestResolved(
    candidates: readonly ResolvedFunction[],
    name: string,
    line: number
): ResolvedFunction | undefined {
    const matches = candidates.filter((c) => c.name === name);
    if (matches.length === 0) {
        return undefined;
    }
    return matches.reduce((closest, candidate) =>
        Math.abs(candidate.range.start.line - line) < Math.abs(closest.range.start.line - line) ? candidate : closest
    );
}

/**
 * After a trigger (save/flush/git-hook re-indexing) regenerates one or more
 * functions in `relFile` with genuinely different content -- not a brand-new
 * function, a confirmed change to a previously-cached one, see
 * `ExplanationCache.getCurrentRowForFnId` -- flags every other cached
 * function that calls, or is called by, one of those changed functions as
 * `stale`.
 *
 * Uses the sidecar's `index_file` method: it already existed (Session 4/5's
 * RPC surface) but had no caller anywhere in the extension host until this
 * session. No LLM call -- it's pure call-graph lookup, same cost class as
 * `reindex_file`, which every caller of this function has just awaited
 * already. This is the "side effect of a trigger that already contacts the
 * sidecar" the session brief requires (Core Rule 4): staleness is never
 * computed from the hover/panel render path.
 *
 * `priority` (Session 36) defaults to `'interactive'`, matching every
 * caller before this session (save-reindex, a direct user action). The two
 * autonomous background callers (`BackgroundFlushManager`,
 * `GitHookReindexManager`) pass `'background'` and gate their own call to
 * this function on `sidecar.waitForInteractiveIdle()` first -- same
 * division of responsibility as `generateAndCache`'s own `priority` param
 * (session 32): the caller decides whether to wait, this just forwards the
 * label through to the RPC so it's visible to `hasInteractivePending()`.
 */
export async function flagStaleDependents(
    sidecar: SidecarManager,
    workspaceRoot: string,
    relFile: string,
    changedFunctions: readonly ResolvedFunction[],
    staleTracker: StaleTracker,
    output: vscode.OutputChannel,
    priority: RequestPriority = 'interactive'
): Promise<void> {
    if (changedFunctions.length === 0) {
        return;
    }

    let result: IndexFileResult;
    try {
        result = await sidecar.request<IndexFileResult>('index_file', { file_path: relFile }, undefined, priority);
    } catch (err) {
        output.appendLine(`staleness: index_file failed for ${relFile}, dependents not flagged: ${String(err)}`);
        return;
    }

    // Resolved lazily per dependent file and reused across every related
    // entry that points at it, same "resolve each file at most once" pattern
    // `BackgroundIndexManager` already uses for its own per-file cache.
    const resolvedByFile = new Map<string, ResolvedFunction[]>();
    async function fnIdFor(rel_fname: string, name: string, line: number): Promise<string | undefined> {
        let resolved = resolvedByFile.get(rel_fname);
        if (!resolved) {
            resolved = await resolveFunctionsInFile(workspaceRoot, rel_fname, output);
            resolvedByFile.set(rel_fname, resolved);
        }
        return closestResolved(resolved, name, line)?.fnId;
    }

    let flagged = 0;
    for (const changed of changedFunctions) {
        const entry = closestByName(result.functions, changed.name, changed.range.start.line);
        if (!entry) {
            continue;
        }
        for (const related of [...entry.callers, ...entry.callees]) {
            const fnId = await fnIdFor(related.rel_fname, related.name, related.line);
            if (!fnId) {
                continue;
            }
            staleTracker.markStale(related.rel_fname, fnId);
            flagged++;
        }
    }

    if (flagged > 0) {
        output.appendLine(`staleness: flagged ${flagged} dependent function(s) stale after changes in ${relFile}`);
    }
}
