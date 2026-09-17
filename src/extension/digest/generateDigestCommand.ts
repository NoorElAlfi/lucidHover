import * as vscode from 'vscode';
import { SidecarManager } from '../sidecar/sidecarManager';

export const GENERATE_CODEBASE_DIGEST_COMMAND_ID = 'lucidhover.generateCodebaseDigest';

// No LLM call (Core Rule 1) -- this is a full filesystem walk + read of
// every non-excluded, non-gitignored, under-budget file
// (sidecar/digest/ingestion.py), real I/O work but bounded by that
// module's own size/count budgets. A generous fixed timeout, same class of
// reasoning as blastRadiusCommand.ts's BLAST_RADIUS_TIMEOUT_MS, just scaled
// up since this walks the whole repo rather than a bounded graph traversal.
const GENERATE_DIGEST_TIMEOUT_MS = 60_000;

interface RawDigestResult {
    text: string;
    total_files: number;
    included_files: number;
    truncated: boolean;
}

/**
 * Codebase digest export (chat-discussed follow-up, not a Build Order
 * step): a gitingest-style single-document export of the whole workspace --
 * summary, ASCII tree, and the content of every included file -- for the
 * user to copy and paste into any LLM themselves. Everything here stays
 * local: the sidecar builds the text (sidecar/digest/ingestion.py), this
 * command only opens it as a document and copies it to the clipboard (both
 * this session's own explicit `AskUserQuestion` choice) -- nothing is ever
 * sent anywhere (Core Rule 1).
 *
 * Not part of the explanation cache: no fn_id/fn_hash/cache_key involved
 * (Core Rule 5/9 don't apply), since this is a point-in-time export, not a
 * cached, invalidatable per-function artifact. Workspace-only for v1 (this
 * session's own explicit choice) -- no Explorer folder-subtree entry point.
 */
export async function generateCodebaseDigest(
    getSidecar: () => SidecarManager | undefined,
    output: vscode.OutputChannel
): Promise<void> {
    const sidecar = getSidecar();
    if (!sidecar) {
        vscode.window.setStatusBarMessage('LucidHover: indexing not ready yet', 3000);
        return;
    }

    output.appendLine('digest: generating codebase digest');
    try {
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'LucidHover: generating codebase digest...',
                cancellable: false,
            },
            () => sidecar.request<RawDigestResult>('generate_digest', {}, GENERATE_DIGEST_TIMEOUT_MS)
        );

        const doc = await vscode.workspace.openTextDocument({ content: result.text, language: 'plaintext' });
        await vscode.window.showTextDocument(doc, { preview: false });

        let clipboardFailed = false;
        try {
            await vscode.env.clipboard.writeText(result.text);
        } catch (err) {
            clipboardFailed = true;
            output.appendLine(`digest: clipboard copy failed: ${String(err)}`);
        }

        const truncationNote = result.truncated ? ', truncated by budget -- see the note in the digest' : '';
        const clipboardNote = clipboardFailed ? '' : ', copied to clipboard';
        vscode.window.setStatusBarMessage(
            `LucidHover: digest ready -- ${result.included_files}/${result.total_files} file(s) included${truncationNote}${clipboardNote}`,
            5000
        );
        output.appendLine(
            `digest: done -- ${result.included_files}/${result.total_files} file(s) included, truncated=${result.truncated}`
        );
    } catch (err) {
        output.appendLine(`digest: generate_digest failed: ${String(err)}`);
        vscode.window.showErrorMessage(
            'LucidHover: could not generate codebase digest. See the LucidHover output channel.'
        );
    }
}

export function registerGenerateCodebaseDigestCommand(
    getSidecar: () => SidecarManager | undefined,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(GENERATE_CODEBASE_DIGEST_COMMAND_ID, () =>
        generateCodebaseDigest(getSidecar, output)
    );
}
