import * as vscode from 'vscode';
import { ExplanationCache, CacheRow } from '../cache/explanationCache';
import { EMBEDDING_MODEL_ID, MODEL_ID, PROMPT_VERSION } from '../cache/config';
import { generateAndCache } from '../generation';
import { resolveEnclosingFunction } from '../functionResolution';
import { SHOW_MORE_COMMAND_ID } from '../panel/explanationPanelProvider';
import { SidecarManager } from '../sidecar/sidecarManager';

interface Level0Fields {
    role_tag?: unknown;
    one_liner?: unknown;
}

/**
 * Level 0 only (Session 7): role_tag + one_liner, hardcoded "fresh" freshness
 * (the dirty/stale distinction doesn't exist until Session 8's invalidation
 * work -- see spec's Hover UX visual rules, v0 note). why_it_exists/used_by/
 * calls/side_effects/risk_note move to the docked panel, never rendered here.
 */
function renderMarkdown(row: CacheRow): vscode.MarkdownString {
    const explanation = JSON.parse(row.explanation_json) as Level0Fields;
    const roleTag = typeof explanation.role_tag === 'string' ? explanation.role_tag : 'Unknown';
    const oneLiner = typeof explanation.one_liner === 'string' ? explanation.one_liner : '';

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = { enabledCommands: [SHOW_MORE_COMMAND_ID] };
    markdown.appendMarkdown(`#### ${roleTag} · *fresh*\n\n`);
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
        const { fnId, fnHash, range } = resolved;

        let row = cache.lookup({
            fnId,
            fnHash,
            modelId: MODEL_ID,
            embeddingModelId: EMBEDDING_MODEL_ID,
            promptVersion: PROMPT_VERSION,
        });

        if (row) {
            this.output.appendLine(`cache hit for ${fnId} -- sidecar not invoked`);
        } else {
            this.output.appendLine(`cache miss for ${fnId} -- requesting generate_explanation`);
            row = await generateAndCache(sidecar, cache, resolved);
        }

        return new vscode.Hover(renderMarkdown(row), range);
    }
}
