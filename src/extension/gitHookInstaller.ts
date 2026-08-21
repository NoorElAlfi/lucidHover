import * as fsp from 'fs/promises';
import * as path from 'path';
import { allSupportedExtensions } from './languages';

/**
 * Pure git-hook-file manipulation, no `vscode` dependency (Session 12,
 * mirroring `debounce.ts`'s Session 8 precedent) -- factored out of
 * `gitHookReindex.ts` so the idempotent-append logic (the trickiest, most
 * bug-prone part: it edits files that may belong to another tool) can be
 * unit-tested with plain `node` against a real temp git repo, without
 * needing a live VS Code Extension Development Host.
 */

export interface SimpleLogger {
    appendLine(message: string): void;
}

export const HOOK_BEGIN_MARKER = '# >>> LucidHover git-hook >>>';
export const HOOK_END_MARKER = '# <<< LucidHover git-hook <<<';
export const SHARED_SCRIPT_NAME = 'lucidhover-git-reindex.sh';

/**
 * Written and fully owned by LucidHover (unlike the three hook entry points
 * below, nothing else would ever want to write to this file), so it's safe
 * to just overwrite on every install/re-activation rather than append-guard
 * it. Resolves `git rev-parse --git-dir` itself rather than assuming
 * `.git/hooks`, so it still works if a hook ever runs from a worktree.
 *
 * The `git diff` pathspec is generated from `languages.json`'s extensions
 * (Session 22 -- previously a hardcoded `'*.js'` literal, one of three
 * independently-drifted copies of the same filter per session-20's audit)
 * so a language added to the manifest is picked up here too, with no edit
 * to this file.
 */
export function buildSharedScriptContent(extensions: string[] = allSupportedExtensions()): string {
    const pathspecs = extensions.map((ext) => `'*${ext}'`).join(' ');
    return `#!/bin/sh
# Written by LucidHover. Safe to regenerate -- diffs the two given refs and
# writes the changed source files (repo-relative, one per line) to the
# marker file the extension watches.
old="$1"
new="$2"
git_dir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
git diff --name-only "$old" "$new" -- ${pathspecs} > "$git_dir/LUCIDHOVER_REINDEX" 2>/dev/null
`;
}

export interface HookSpec {
    file: string;
    block: string;
}

// One block per hook type (Build Order step 12's "post-checkout/post-merge/
// post-commit"). All three ultimately resolve an old/new ref pair and hand
// it to the one shared diff script above -- see session-12 artifact
// "Decisions made" for why post-checkout only handles the branch-switch case.
export const HOOKS: HookSpec[] = [
    {
        file: 'post-commit',
        block: `prev_head=$(git rev-parse HEAD@{1} 2>/dev/null) || prev_head=$(git hash-object -t tree /dev/null)
sh "$(git rev-parse --git-dir)/hooks/${SHARED_SCRIPT_NAME}" "$prev_head" HEAD`,
    },
    {
        file: 'post-merge',
        block: `prev_head=$(git rev-parse HEAD@{1} 2>/dev/null) || prev_head=$(git hash-object -t tree /dev/null)
sh "$(git rev-parse --git-dir)/hooks/${SHARED_SCRIPT_NAME}" "$prev_head" HEAD`,
    },
    {
        file: 'post-checkout',
        block: `# $3=1 is a branch-level checkout (git checkout <branch>); $3=0 is a
# file-level checkout (git checkout -- <path>), which doesn't tell the hook
# which files changed -- left uncovered, the next save/flush cycle or a
# manual refresh catches it instead.
if [ "$3" = "1" ]; then
  sh "$(git rev-parse --git-dir)/hooks/${SHARED_SCRIPT_NAME}" "$1" "$2"
fi`,
    },
];

export async function readOptional(filePath: string): Promise<string | undefined> {
    try {
        return await fsp.readFile(filePath, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw err;
    }
}

/**
 * Real git repo, not a worktree/submodule (`.git` as a file pointing
 * elsewhere) or a plain folder -- scope cut for this session, noted in the
 * artifact. `<root>/.git` must exist and be a directory.
 */
export async function isRealGitRepo(workspaceRoot: string): Promise<boolean> {
    try {
        const stat = await fsp.stat(path.join(workspaceRoot, '.git'));
        return stat.isDirectory();
    } catch {
        return false;
    }
}

export function hooksDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.git', 'hooks');
}

export async function hooksInstalled(workspaceRoot: string): Promise<boolean> {
    for (const spec of HOOKS) {
        const content = await readOptional(path.join(hooksDir(workspaceRoot), spec.file));
        if (!content || !content.includes(HOOK_BEGIN_MARKER)) {
            return false;
        }
    }
    return true;
}

export async function chmodExecutable(filePath: string, output: SimpleLogger): Promise<void> {
    try {
        await fsp.chmod(filePath, 0o755);
    } catch (err) {
        // Non-fatal: NTFS ignores the POSIX exec bit and Git for Windows
        // runs hooks via its bundled shell regardless; only real Unix
        // filesystems need this to actually matter.
        output.appendLine(`git-hook install: chmod failed for ${filePath} (likely harmless on this platform): ${String(err)}`);
    }
}

/**
 * Appends the LucidHover block to one hook file, creating it (with a
 * shebang) if it doesn't exist yet. Idempotent -- if `HOOK_BEGIN_MARKER` is
 * already present, does nothing, so re-activating the extension or re-running
 * the install command never duplicates the block. Existing content from
 * another tool (husky, pre-commit, a hand-written hook) is preserved and
 * never overwritten, only appended to.
 */
export async function installOneHook(workspaceRoot: string, spec: HookSpec, output: SimpleLogger): Promise<void> {
    const hookPath = path.join(hooksDir(workspaceRoot), spec.file);
    const existing = await readOptional(hookPath);

    if (existing?.includes(HOOK_BEGIN_MARKER)) {
        return;
    }

    const appended = `${HOOK_BEGIN_MARKER}\n${spec.block}\n${HOOK_END_MARKER}\n`;
    let next: string;
    if (existing === undefined) {
        next = `#!/bin/sh\n\n${appended}`;
    } else {
        const withTrailingNewline = existing.endsWith('\n') ? existing : `${existing}\n`;
        next = `${withTrailingNewline}\n${appended}`;
    }

    await fsp.writeFile(hookPath, next, 'utf8');
    await chmodExecutable(hookPath, output);
    output.appendLine(`git-hook install: ${existing === undefined ? 'created' : 'appended to'} ${spec.file}`);
}

export async function installSharedScript(workspaceRoot: string, output: SimpleLogger): Promise<void> {
    const scriptPath = path.join(hooksDir(workspaceRoot), SHARED_SCRIPT_NAME);
    await fsp.writeFile(scriptPath, buildSharedScriptContent(), 'utf8');
    await chmodExecutable(scriptPath, output);
}

export async function installAllHooks(workspaceRoot: string, output: SimpleLogger): Promise<void> {
    await installSharedScript(workspaceRoot, output);
    for (const spec of HOOKS) {
        await installOneHook(workspaceRoot, spec, output);
    }
    output.appendLine('git-hook install: done (post-checkout, post-merge, post-commit)');
}
