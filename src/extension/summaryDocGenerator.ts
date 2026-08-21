import * as path from 'path';
import * as vscode from 'vscode';
import { EMBEDDING_MODEL_ID, PROMPT_VERSION, SUMMARY_DOC_PROMPT_VERSION, resolveModelId } from './cache/config';
import { CacheRow, ExplanationCache } from './cache/explanationCache';
import { computeCacheKey, computeFileSummaryFnHash, computeFnId } from './cache/hash';
import { ResolvedFunction, resolveFunctionsInFile } from './functionResolution';
import { SidecarManager } from './sidecar/sidecarManager';

export const GENERATE_SUMMARY_DOCS_COMMAND_ID = 'lucidhover.generateSummaryDocs';

// Same call class as generateAndCache's generate_explanation (an Ollama round
// trip, not a near-instant RPC method) -- see generation.ts's GENERATE_TIMEOUT_MS.
const FILE_SUMMARY_TIMEOUT_MS = 120_000;

// Reserved function name for a file's synthetic summary row -- never produced
// by VS Code's document-symbol provider, so it can never collide with a real
// resolved function's fn_id.
const SYNTHETIC_FILE_SUMMARY_NAME = '__file_summary__';

const TOP_KEY_FUNCTIONS = 25;

interface ExplanationFields {
    role_tag?: string;
    one_liner?: string;
}

interface RankedFunction {
    rel_fname: string;
    name: string;
    line: number;
    importance: number;
}

interface DocFunctionEntry {
    resolved: ResolvedFunction;
    importance: number;
    explanation: ExplanationFields;
}

/**
 * Secondary summary-doc generator (Session 15 / Build Order step 15,
 * post-MVP): "explicitly secondary -- a rendering target for data already
 * computed, not a second pipeline" (spec). Everything here is a template
 * pass over `ExplanationCache` rows that background indexing/save/refresh
 * already produced, plus one small new LLM call per file for a purpose
 * paragraph (see sidecar's new "generate_file_summary" method). No new
 * ranking, no new staleness model -- reuses `list_ranked_functions` (Session
 * 9's PageRank walk) and whatever's currently cached, as of whenever this
 * command is run.
 *
 * Explicit-command-only (not automatic after background indexing finishes):
 * writing real files to the user's workspace is a new category of side
 * effect for this codebase (nothing before this session has ever written to
 * the workspace filesystem), so it needs its own real user action, not a
 * side effect of something else completing.
 */
export function registerGenerateSummaryDocsCommand(
    getWorkspaceRoot: () => string | undefined,
    getCache: () => ExplanationCache | undefined,
    getSidecar: () => SidecarManager | undefined,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(GENERATE_SUMMARY_DOCS_COMMAND_ID, async () => {
        const workspaceRoot = getWorkspaceRoot();
        const cache = getCache();
        const sidecar = getSidecar();
        if (!workspaceRoot || !cache || !sidecar) {
            vscode.window.setStatusBarMessage('LucidHover: indexing not ready yet', 3000);
            return;
        }

        vscode.window.setStatusBarMessage('LucidHover: generating summary docs...', 5000);
        output.appendLine('summary-docs: starting');
        try {
            await generateSummaryDocs(workspaceRoot, cache, sidecar, output);
        } catch (err) {
            output.appendLine(`summary-docs: failed: ${String(err)}`);
            vscode.window.showErrorMessage(
                'LucidHover: summary doc generation failed. See the LucidHover output channel.'
            );
        }
    });
}

async function generateSummaryDocs(
    workspaceRoot: string,
    cache: ExplanationCache,
    sidecar: SidecarManager,
    output: vscode.OutputChannel
): Promise<void> {
    const modelId = resolveModelId();

    let ranked: RankedFunction[];
    try {
        const result = await sidecar.request<{ functions: RankedFunction[] }>('list_ranked_functions', {});
        ranked = result.functions;
    } catch (err) {
        output.appendLine(`summary-docs: list_ranked_functions failed: ${String(err)}`);
        vscode.window.showErrorMessage(
            'LucidHover: could not list functions for summary docs. See the LucidHover output channel.'
        );
        return;
    }

    // Group by file, preserving `ranked`'s existing importance-descending
    // order within each group -- no second sort needed later for the
    // per-file page, only for the cross-file key-functions index below.
    const byFile = new Map<string, RankedFunction[]>();
    for (const entry of ranked) {
        let list = byFile.get(entry.rel_fname);
        if (!list) {
            list = [];
            byFile.set(entry.rel_fname, list);
        }
        list.push(entry);
    }

    const fileEntries: { relFile: string; functions: DocFunctionEntry[] }[] = [];

    // Same lazy per-file resolve + nearest-line match `BackgroundIndexManager`
    // already uses (tree-sitter's def line and VS Code's document-symbol line
    // don't always agree exactly) -- kept as a local duplicate rather than
    // extracted into a shared helper, same precedent staleTracking.ts's own
    // closestByName/closestResolved already set.
    // Counted, not just skipped, so a gap between `ranked.length` and what
    // actually lands in the docs is visible in the output channel instead of
    // requiring a cross-reference against BackgroundIndexManager's own
    // separate "unresolved"/"already cached" log line.
    let unresolvedCount = 0;
    let notYetCachedCount = 0;

    for (const [relFile, entries] of byFile) {
        const symbols = await resolveFunctionsInFile(workspaceRoot, relFile, output);
        const functions: DocFunctionEntry[] = [];
        for (const entry of entries) {
            const resolved = matchRankedEntry(entry, symbols);
            if (!resolved) {
                unresolvedCount++;
                continue;
            }
            const row = cache.lookup({
                fnId: resolved.fnId,
                fnHash: resolved.fnHash,
                modelId,
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: PROMPT_VERSION,
            });
            if (!row) {
                // Not generated yet (background indexing hasn't reached it,
                // or generation failed) -- omit from the docs rather than
                // error the whole run; it'll appear next time this command
                // runs after it's cached.
                notYetCachedCount++;
                continue;
            }
            let explanation: ExplanationFields;
            try {
                explanation = JSON.parse(row.explanation_json) as ExplanationFields;
            } catch {
                notYetCachedCount++;
                continue;
            }
            functions.push({ resolved, importance: entry.importance, explanation });
        }
        if (functions.length > 0) {
            fileEntries.push({ relFile, functions });
        }
    }

    if (unresolvedCount > 0 || notYetCachedCount > 0) {
        output.appendLine(
            `summary-docs: skipped ${unresolvedCount + notYetCachedCount} of ${ranked.length} ranked function(s) ` +
                `(${notYetCachedCount} not yet cached, ${unresolvedCount} unresolved -- see BackgroundIndexManager's ` +
                `own log line for why a function may be unresolved)`
        );
    }

    if (fileEntries.length === 0) {
        vscode.window.showInformationMessage(
            'LucidHover: no cached explanations yet -- hover, save, or wait for background indexing to finish before generating summary docs.'
        );
        return;
    }

    const docsRoot = vscode.Uri.file(path.join(workspaceRoot, 'docs', 'wiki'));
    await vscode.workspace.fs.createDirectory(docsRoot);

    let purposeFailures = 0;
    const filePurposes = new Map<string, string>();
    for (const { relFile, functions } of fileEntries) {
        const { text, failed } = await resolveFileSummaryParagraph(sidecar, cache, modelId, relFile, functions, output);
        if (failed) {
            purposeFailures++;
        }
        filePurposes.set(relFile, text);
        await writeDocFile(docsRoot, `${relFile}.md`, renderFilePage(relFile, functions, text));
    }

    await writeDocFile(docsRoot, 'index.md', renderIndexPage(workspaceRoot, fileEntries, filePurposes));

    const allFunctions = fileEntries
        .flatMap((fe) => fe.functions.map((f) => ({ ...f, relFile: fe.relFile })))
        .sort((a, b) => b.importance - a.importance)
        .slice(0, TOP_KEY_FUNCTIONS);
    await writeDocFile(docsRoot, 'functions.md', renderFunctionsIndexPage(allFunctions));

    const pagesWritten = fileEntries.length + 2; // + index.md + functions.md
    const message =
        purposeFailures > 0
            ? `LucidHover: wrote ${pagesWritten} summary doc page(s) to docs/wiki/ (${purposeFailures} purpose paragraph(s) failed -- see the LucidHover output channel).`
            : `LucidHover: wrote ${pagesWritten} summary doc page(s) to docs/wiki/.`;
    output.appendLine(`summary-docs: done -- ${pagesWritten} page(s), ${purposeFailures} purpose-paragraph failure(s)`);
    vscode.window.showInformationMessage(message);
}

/** Mirrors BackgroundIndexManager.matchRankedEntry -- see that method's doc comment. */
function matchRankedEntry(entry: RankedFunction, symbols: ResolvedFunction[]): ResolvedFunction | undefined {
    const candidates = symbols.filter((s) => s.name === entry.name);
    if (candidates.length === 0) {
        return undefined;
    }
    return candidates.reduce((closest, candidate) =>
        Math.abs(candidate.range.start.line - entry.line) < Math.abs(closest.range.start.line - entry.line)
            ? candidate
            : closest
    );
}

/**
 * The purpose paragraph for one file: a cache lookup against a synthetic
 * `__file_summary__` row first (see hash.ts's `computeFileSummaryFnHash` doc
 * comment for why its fn_hash is a hash of the file's *current* function
 * hashes), falling back to the sidecar's new `generate_file_summary` RPC on
 * a miss. A failure here is scoped to this one file -- the caller still
 * writes the page, with a placeholder paragraph and a note in the output
 * channel, rather than aborting the whole run (per this session's design:
 * one file/module failing shouldn't lose every other already-computed page).
 */
async function resolveFileSummaryParagraph(
    sidecar: SidecarManager,
    cache: ExplanationCache,
    modelId: string,
    relFile: string,
    functions: DocFunctionEntry[],
    output: vscode.OutputChannel
): Promise<{ text: string; failed: boolean }> {
    const fnId = computeFnId(relFile, SYNTHETIC_FILE_SUMMARY_NAME);
    const fnHash = computeFileSummaryFnHash(functions.map((f) => f.resolved.fnHash));

    const cached = cache.lookup({
        fnId,
        fnHash,
        modelId,
        embeddingModelId: EMBEDDING_MODEL_ID,
        promptVersion: SUMMARY_DOC_PROMPT_VERSION,
    });
    if (cached) {
        try {
            const parsed = JSON.parse(cached.explanation_json) as { purpose?: string };
            if (parsed.purpose) {
                return { text: parsed.purpose, failed: false };
            }
        } catch {
            // Fall through and regenerate.
        }
    }

    try {
        const result = await sidecar.request<{ summary: string }>(
            'generate_file_summary',
            {
                file_path: relFile,
                functions: functions.map((f) => ({
                    name: f.resolved.name,
                    role_tag: f.explanation.role_tag ?? null,
                    one_liner: f.explanation.one_liner ?? null,
                })),
                model_id: modelId,
            },
            FILE_SUMMARY_TIMEOUT_MS
        );

        const row: CacheRow = {
            cache_key: computeCacheKey({
                fnSource: fnHash,
                contextHash: '',
                modelId,
                embeddingModelId: EMBEDDING_MODEL_ID,
                promptVersion: SUMMARY_DOC_PROMPT_VERSION,
            }),
            fn_id: fnId,
            explanation_json: JSON.stringify({ purpose: result.summary }),
            fn_hash: fnHash,
            context_hash: '',
            model_id: modelId,
            embedding_model_id: EMBEDDING_MODEL_ID,
            prompt_version: SUMMARY_DOC_PROMPT_VERSION,
            context_tier: 'summary-doc',
            generated_at: new Date().toISOString(),
        };
        cache.write(row);
        return { text: result.summary, failed: false };
    } catch (err) {
        output.appendLine(`summary-docs: generate_file_summary failed for ${relFile}: ${String(err)}`);
        return { text: '_(purpose paragraph unavailable -- see the LucidHover output channel)_', failed: true };
    }
}

function renderFilePage(relFile: string, functions: DocFunctionEntry[], purpose: string): string {
    const lines: string[] = [`# ${relFile}`, '', purpose, '', '## Functions', ''];
    for (const { resolved, explanation } of functions) {
        const role = explanation.role_tag ?? 'Unclassified';
        lines.push(`### ${resolved.name} (${role})`, '');
        lines.push(explanation.one_liner ?? '_(no summary cached)_', '');
        lines.push(`Line ${resolved.range.start.line + 1}.`, '');
    }
    return lines.join('\n');
}

function renderIndexPage(
    workspaceRoot: string,
    fileEntries: { relFile: string; functions: DocFunctionEntry[] }[],
    filePurposes: Map<string, string>
): string {
    const repoName = path.basename(workspaceRoot);
    const totalFunctions = fileEntries.reduce((sum, fe) => sum + fe.functions.length, 0);
    const lines: string[] = [
        `# ${repoName} — Codebase Summary`,
        '',
        `Generated by LucidHover from ${totalFunctions} cached function explanation(s) across ${fileEntries.length} file(s).`,
        '',
        '## Files',
        '',
    ];
    for (const { relFile } of fileEntries) {
        const purpose = filePurposes.get(relFile) ?? '';
        const firstSentence = purpose.split(/(?<=[.!?])\s/)[0] || purpose;
        lines.push(`- [${relFile}](${relFile}.md) — ${firstSentence}`);
    }
    lines.push('', '## See also', '', '- [Key Functions Index](functions.md)');
    return lines.join('\n');
}

function renderFunctionsIndexPage(
    allFunctions: (DocFunctionEntry & { relFile: string })[]
): string {
    const lines: string[] = [
        '# Key Functions',
        '',
        `Top ${allFunctions.length} function(s) repo-wide, ranked by call-graph importance.`,
        '',
        '| Function | File | Role | Summary |',
        '|---|---|---|---|',
    ];
    for (const { resolved, explanation, relFile } of allFunctions) {
        const role = explanation.role_tag ?? 'Unclassified';
        const oneLiner = (explanation.one_liner ?? '').replace(/\|/g, '\\|');
        lines.push(`| ${resolved.name} | [${relFile}:${resolved.range.start.line + 1}](${relFile}.md) | ${role} | ${oneLiner} |`);
    }
    return lines.join('\n');
}

async function writeDocFile(docsRoot: vscode.Uri, relPath: string, content: string): Promise<void> {
    const segments = relPath.split('/');
    const uri = vscode.Uri.joinPath(docsRoot, ...segments);
    if (segments.length > 1) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(docsRoot, ...segments.slice(0, -1)));
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}
