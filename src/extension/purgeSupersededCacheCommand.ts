import * as vscode from 'vscode';
import { ExplanationCache } from './cache/explanationCache';

export const PURGE_SUPERSEDED_CACHE_COMMAND_ID = 'lucidhover.purgeSupersededCache';

/**
 * Session 39 (cache eviction policy): the manual half of the chosen
 * "automatic narrow, with a manual-only toggle" policy. Runs
 * `ExplanationCache.purgeSupersededRows()` -- the same narrow per-tuple
 * sweep `write()`'s auto-evict applies at write time, applied once across
 * the whole table. Meant to be run either on demand, or as the catch-up
 * sweep after `lucidHover.autoEvictSupersededCache` has been off for a
 * while (rows accumulate with it off; this command is how they get cleaned
 * up without turning auto-evict back on).
 */
export function registerPurgeSupersededCacheCommand(getCache: () => ExplanationCache | undefined): vscode.Disposable {
    return vscode.commands.registerCommand(PURGE_SUPERSEDED_CACHE_COMMAND_ID, () => {
        const cache = getCache();
        if (!cache) {
            vscode.window.setStatusBarMessage('LucidHover: cache not ready yet', 3000);
            return;
        }

        const purged = cache.purgeSupersededRows();
        vscode.window.setStatusBarMessage(
            purged > 0
                ? `LucidHover: purged ${purged} superseded cache row${purged === 1 ? '' : 's'}`
                : 'LucidHover: no superseded cache rows found',
            5000
        );
    });
}
