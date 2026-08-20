import * as vscode from 'vscode';
import { ExplanationCache, CacheRow } from '../cache/explanationCache';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, resolveModelId } from '../cache/config';
import { DirtyTracker } from '../dirtyTracking';
import { generateAndCache } from '../generation';
import { resolveEnclosingFunction } from '../functionResolution';
import { SHOW_MORE_COMMAND_ID } from '../panel/explanationPanelProvider';
import { SidecarManager } from '../sidecar/sidecarManager';
import { StaleTracker } from '../staleTracking';

interface Level0Fields {
    role_tag?: unknown;
    one_liner?: unknown;
}

type FreshnessState = 'fresh' | 'dirty' | 'stale';

/**
 * Session 13 (Build Order step 13): replaces the v0 hardcoded "fresh"
 * placeholder (see session-05/07 artifacts) with the spec's real dirty/stale
 * distinction. `dirty` (an unsaved, in-memory edit to this exact function --
 * `DirtyTracker`, Session 12) takes precedence over `stale` (this function's
 * own content hasn't changed, but a cached dependency's has -- `StaleTracker`,
 * this session): a function mid-edit is already known to be showing
 * possibly-outdated content for a stronger reason than a dependency change,
 * so there's no need to show both at once. Both reads are synchronous
 * in-memory lookups -- no sidecar call, per Core Rule 4.
 */
function freshnessOf(dirty: boolean, stale: boolean): FreshnessState {
    if (dirty) {
        return 'dirty';
    }
    if (stale) {
        return 'stale';
    }
    return 'fresh';
}

/**
 * Level 0 only (Session 7): role_tag + one_liner + freshness. why_it_exists/
 * used_by/calls/side_effects/risk_note move to the docked panel, never
 * rendered here -- and per this session's design pass, the freshness badge
 * stays hover-only too: the docked panel is levels 1-2 *content*, not a
 * freshness surface (spec's "Hover UX & Content Model" table), so it doesn't
 * repeat this label.
 */
function renderMarkdown(row: CacheRow, freshness: FreshnessState): vscode.MarkdownString {
    const explanation = JSON.parse(row.explanation_json) as Level0Fields;
    const roleTag = typeof explanation.role_tag === 'string' ? explanation.role_tag : 'Unknown';
    const oneLiner = typeof explanation.one_liner === 'string' ? explanation.one_liner : '';

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = { enabledCommands: [SHOW_MORE_COMMAND_ID] };
    markdown.appendMarkdown(`#### ${roleTag} · *${freshness}*\n\n`);
    markdown.appendMarkdown(`**${oneLiner}**\n\n`);
    markdown.appendMarkdown('---\n\n');
    const args = encodeURIComponent(JSON.stringify([row.cache_key]));
    markdown.appendMarkdown(`[Show more →](command:${SHOW_MORE_COMMAND_ID}?${args})`);
    return markdown;
}

/**
 * Cache-backed hover provider (Session 5, generation wired in Session 6,
 * two-surface rendering split out in Session 7). Hover is a cache lookup
 * only (Core Rule 4): on a hit, renders directly from the cached row with no
 * sidecar call; on a miss, requests `generate_explanation` from the
 * sidecar, writes the result to cache, then renders. `getCache`/`getSidecar`
 * are getters (not constructor values) because both only exist once
 * Workspace Trust is granted and the sidecar has started, which happens
 * after this provider is registered (Core Rule 6: hover registration must
 * not itself depend on trust).
 */
export class ExplanationHoverProvider implements vscode.HoverProvider {
    constructor(
        private readonly getWorkspaceRoot: () => string | undefined,
        private readonly getCache: () => ExplanationCache | undefined,
        private readonly getSidecar: () => SidecarManager | undefined,
        private readonly getDirtyTracker: () => DirtyTracker | undefined,
        private readonly getStaleTracker: () => StaleTracker | undefined,
        private readonly output: vscode.OutputChannel
    ) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.Hover | undefined> {
        const workspaceRoot = this.getWorkspaceRoot();
        const cache = this.getCache();
        const sidecar = this.getSidecar();
        if (!workspaceRoot || !cache || !sidecar) {
            // Untrusted workspace, or sidecar/cache not yet started -- no
            // generation/cache access permitted (Core Rule 6).
            return undefined;
        }

        const resolved = await resolveEnclosingFunction(document, position, workspaceRoot);
        if (!resolved) {
            return undefined;
        }
        const { fnId, fnHash, relFile, range } = resolved;

        let row = cache.lookup({
            fnId,
            fnHash,
            modelId: resolveModelId(),
            embeddingModelId: EMBEDDING_MODEL_ID,
            promptVersion: PROMPT_VERSION,
        });

        if (row) {
            this.output.appendLine(`cache hit for ${fnId} -- sidecar not invoked`);
        } else {
            this.output.appendLine(`cache miss for ${fnId} -- requesting generate_explanation`);
            row = await generateAndCache(sidecar, cache, resolved);
        }

        const dirty = this.getDirtyTracker()?.dirtyFnIdsFor(relFile)?.has(fnId) ?? false;
        const stale = this.getStaleTracker()?.isStale(relFile, fnId) ?? false;

        return new vscode.Hover(renderMarkdown(row, freshnessOf(dirty, stale)), range);
    }
}
