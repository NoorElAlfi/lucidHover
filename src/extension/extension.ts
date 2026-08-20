import * as path from 'path';
import * as vscode from 'vscode';
import { BackgroundFlushManager } from './backgroundFlush';
import { BackgroundIndexManager, registerCancelBackgroundIndexingCommand } from './backgroundIndex';
import { EMBEDDING_MODEL_ID } from './cache/config';
import { ExplanationCache } from './cache/explanationCache';
import { RoleCodeLensProvider } from './codelens/roleCodeLensProvider';
import { RoleGutterDecorationManager } from './codelens/roleGutterDecorations';
import { DirtyTracker } from './dirtyTracking';
import { GitHookReindexManager, registerInstallGitHooksCommand } from './gitHookReindex';
import { ExplanationHoverProvider } from './hover/functionHoverProvider';
import {
    EXPLANATION_PANEL_VIEW_ID,
    ExplanationPanelProvider,
    registerNavigateToFunctionCommand,
    registerShowMoreCommand,
} from './panel/explanationPanelProvider';
import { registerRefreshExplanationCommand } from './refreshExplanationCommand';
import { SaveReindexManager } from './saveReindex';
import { SidecarManager } from './sidecar/sidecarManager';
import { isWorkspaceTrusted, onDidGrantWorkspaceTrust } from './trust';

let sidecarManager: SidecarManager | null = null;
let explanationCache: ExplanationCache | null = null;
let indexedWorkspaceRoot: string | undefined;
let backgroundIndexManager: BackgroundIndexManager | null = null;
let roleCodeLensProvider: RoleCodeLensProvider | null = null;
let roleGutterDecorationManager: RoleGutterDecorationManager | null = null;
let gitHookReindexManager: GitHookReindexManager | null = null;

/**
 * Spawns the sidecar and opens the SQLite cache. Never call this without a
 * trust check -- the sidecar parses and (eventually) runs LLM inference over
 * workspace contents, and the cache only makes sense once generation can
 * run, which must not happen in an untrusted workspace.
 */
async function startIndexing(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        output.appendLine('no workspace folder open — sidecar not started');
        return;
    }

    // Storage dir must be known before the sidecar spawns (Session 11): it's
    // where the sidecar's LanceDB retrieval index lives, and the sidecar's
    // startup embedding pass needs a path to write to before any RPC
    // request could otherwise deliver one. Reordered ahead of
    // `manager.start()` for exactly this reason -- Sessions 1-10 only
    // needed it after the sidecar was already up, for the SQLite cache.
    const storageRoot = context.storageUri ?? context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(storageRoot);

    const manager = new SidecarManager(workspaceRoot, context.extensionPath, storageRoot.fsPath, EMBEDDING_MODEL_ID, output);
    sidecarManager = manager;
    context.subscriptions.push(manager);

    try {
        await manager.start();
        vscode.window.setStatusBarMessage('LucidHover: sidecar connected', 3000);
    } catch (err) {
        output.appendLine(`failed to start sidecar: ${String(err)}`);
        vscode.window.showErrorMessage('LucidHover: failed to start the sidecar process. See the LucidHover output channel.');
        return;
    }

    const dbPath = path.join(storageRoot.fsPath, 'explanation-cache.sqlite');
    explanationCache = new ExplanationCache(dbPath);
    context.subscriptions.push({ dispose: () => explanationCache?.dispose() });
    output.appendLine(`explanation cache opened at ${dbPath}`);

    // Set last: the hover provider's getters treat this as the "ready" gate
    // alongside the cache/sidecar being non-null.
    indexedWorkspaceRoot = workspaceRoot;

    // Session 10 design question 3: CodeLens/gutter are push surfaces, not
    // pull-on-demand like hover/panel, so nothing else redraws them when a
    // row appears. Wire the one notification path -- ExplanationCache.write()
    // -- to both surfaces here, then run an initial redraw for any editors
    // that were already open (as plain files, un-annotated) before trust was
    // granted and the cache existed.
    context.subscriptions.push(
        explanationCache.onDidWrite(() => {
            roleCodeLensProvider?.refresh();
            roleGutterDecorationManager?.refreshAll();
        })
    );
    roleCodeLensProvider?.refresh();
    roleGutterDecorationManager?.refreshAll();

    // Background pre-generation (Session 9): starts right after the sidecar
    // and cache are ready, same trust-gated moment as everything else above.
    // Deliberately not awaited -- it must not block extension activation,
    // and it throttles/paces itself against interactive requests internally.
    backgroundIndexManager?.start();

    // Git-aware hook (Session 12): needs a known, trusted workspaceRoot to
    // find `.git` and set up its marker-file watcher, same reason
    // `backgroundIndexManager` above is started explicitly here rather than
    // always-on from its constructor. May show a one-time install prompt
    // (see gitHookReindex.ts) -- not awaited, for the same "must not block
    // activation" reason as background indexing.
    void gitHookReindexManager?.start();
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('LucidHover');
    context.subscriptions.push(output);

    // Hover provider registers unconditionally -- only indexing/generation
    // are trust-gated (Core Rule 6). Its getters resolve to undefined until
    // startIndexing() finishes, so it renders nothing until then.
    const hoverProvider = vscode.languages.registerHoverProvider(
        { language: 'javascript' },
        new ExplanationHoverProvider(
            () => indexedWorkspaceRoot,
            () => explanationCache ?? undefined,
            () => sidecarManager ?? undefined,
            output
        )
    );
    context.subscriptions.push(hoverProvider);

    // Panel registration is likewise unconditional (Core Rule 6) -- it only
    // ever reads from the cache (never triggers generation), same as hover.
    const panelProvider = new ExplanationPanelProvider(
        () => indexedWorkspaceRoot,
        () => explanationCache ?? undefined,
        output
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(EXPLANATION_PANEL_VIEW_ID, panelProvider)
    );
    context.subscriptions.push(registerShowMoreCommand(panelProvider, () => explanationCache ?? undefined));
    context.subscriptions.push(
        registerNavigateToFunctionCommand(
            () => indexedWorkspaceRoot,
            () => sidecarManager ?? undefined,
            output
        )
    );
    context.subscriptions.push(
        registerRefreshExplanationCommand(
            () => indexedWorkspaceRoot,
            () => explanationCache ?? undefined,
            () => sidecarManager ?? undefined,
            panelProvider,
            output
        )
    );
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((e) => panelProvider.onSelectionChanged(e.textEditor))
    );

    // CodeLens role badge + gutter icon (Session 10 / Build Order step 10) --
    // registration is unconditional (Core Rule 6, same pattern as
    // hover/panel above); both only ever read the cache (Core Rule 4, same
    // as hover/panel), never trigger generation. Both reuse the identical
    // resolve+lookup+classify path (see codelens/roleCategory.ts) so they can
    // never disagree about which category a function belongs to.
    roleCodeLensProvider = new RoleCodeLensProvider(
        () => indexedWorkspaceRoot,
        () => explanationCache ?? undefined,
        output
    );
    context.subscriptions.push(roleCodeLensProvider);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ language: 'javascript' }, roleCodeLensProvider)
    );

    roleGutterDecorationManager = new RoleGutterDecorationManager(
        context.extensionUri,
        () => indexedWorkspaceRoot,
        () => explanationCache ?? undefined,
        output
    );
    context.subscriptions.push(roleGutterDecorationManager);

    // Debounced-save re-indexing (Session 8) -- registration is unconditional
    // (Core Rule 6, same pattern as hover/panel above); its getters resolve
    // to undefined until indexing has actually started under trust.
    const saveReindexManager = new SaveReindexManager(
        () => indexedWorkspaceRoot,
        () => explanationCache ?? undefined,
        () => sidecarManager ?? undefined,
        output
    );
    context.subscriptions.push(saveReindexManager);

    // On-type dirty-tracking (Session 12 / Build Order step 12) -- registers
    // unconditionally (Core Rule 6, same pattern as above); purely in-memory
    // bookkeeping, no UI reads it yet. The only consumer is the periodic
    // flush manager below.
    const dirtyTracker = new DirtyTracker(() => indexedWorkspaceRoot, output);
    context.subscriptions.push(dirtyTracker);

    // Periodic background flush (Session 12) -- registers unconditionally
    // and starts ticking immediately; each tick is a cheap no-op until
    // trust/sidecar/cache are ready and there's something dirty to check.
    const backgroundFlushManager = new BackgroundFlushManager(
        () => indexedWorkspaceRoot,
        () => explanationCache ?? undefined,
        () => sidecarManager ?? undefined,
        () => dirtyTracker,
        output
    );
    context.subscriptions.push(backgroundFlushManager);

    // Git-aware hook (Session 12) -- registration is unconditional; actually
    // finding `.git` and setting up the watcher happens inside
    // startIndexing(), same as backgroundIndexManager, since it needs a
    // known trusted workspaceRoot first.
    gitHookReindexManager = new GitHookReindexManager(
        () => indexedWorkspaceRoot,
        () => explanationCache ?? undefined,
        () => sidecarManager ?? undefined,
        context.workspaceState,
        output
    );
    context.subscriptions.push(gitHookReindexManager);
    context.subscriptions.push(registerInstallGitHooksCommand(gitHookReindexManager));

    // Background pre-generation indexing (Session 9) -- registration is
    // unconditional (Core Rule 6, same pattern as above); actually starting
    // the walk happens inside startIndexing(), once trust/sidecar/cache are
    // all ready. dispose() (extension deactivate / window close) cancels any
    // pass still in progress.
    backgroundIndexManager = new BackgroundIndexManager(
        () => indexedWorkspaceRoot,
        () => explanationCache ?? undefined,
        () => sidecarManager ?? undefined,
        output
    );
    context.subscriptions.push(backgroundIndexManager);
    context.subscriptions.push(registerCancelBackgroundIndexingCommand(backgroundIndexManager));

    if (isWorkspaceTrusted()) {
        void startIndexing(context, output);
    } else {
        vscode.window.showInformationMessage('Indexing paused — trust this workspace to enable LucidHover');

        const grantSubscription = onDidGrantWorkspaceTrust(() => {
            void startIndexing(context, output);
            grantSubscription.dispose();
        });
        context.subscriptions.push(grantSubscription);
    }
}

export function deactivate(): void {
    backgroundIndexManager?.dispose();
    backgroundIndexManager = null;
    gitHookReindexManager?.dispose();
    gitHookReindexManager = null;
    roleGutterDecorationManager?.dispose();
    roleGutterDecorationManager = null;
    roleCodeLensProvider = null;
    sidecarManager?.dispose();
    sidecarManager = null;
    explanationCache?.dispose();
    explanationCache = null;
    indexedWorkspaceRoot = undefined;
}
