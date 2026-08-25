import * as path from 'path';
import * as vscode from 'vscode';
import { BackgroundFlushManager } from './backgroundFlush';
import { BackgroundIndexManager, registerToggleBackgroundIndexingCommand } from './backgroundIndex';
import { DEFAULT_OLLAMA_ENDPOINT, EMBEDDING_MODEL_ID, resolveOllamaEndpoint } from './cache/config';
import { ExplanationCache } from './cache/explanationCache';
import { RoleCodeLensProvider } from './codelens/roleCodeLensProvider';
import { RoleGutterDecorationManager } from './codelens/roleGutterDecorations';
import { DirtyTracker } from './dirtyTracking';
import { GitHookReindexManager, registerInstallGitHooksCommand } from './gitHookReindex';
import { ExplanationHoverProvider } from './hover/functionHoverProvider';
import { documentSelectorForSupportedLanguages } from './languages';
import { registerShowBlastRadiusCommand } from './panel/blastRadiusCommand';
import { registerShowCallTraceCommand } from './panel/callTraceCommand';
import {
    EXPLANATION_PANEL_VIEW_ID,
    ExplanationPanelProvider,
    registerNavigateToFunctionCommand,
    registerShowMoreCommand,
} from './panel/explanationPanelProvider';
import { registerPrioritizeFileIndexingCommand } from './prioritizeFileIndexingCommand';
import { registerPurgeSupersededCacheCommand } from './purgeSupersededCacheCommand';
import { registerRefreshExplanationCommand } from './refreshExplanationCommand';
import { SaveReindexManager } from './saveReindex';
import { SidecarManager } from './sidecar/sidecarManager';
import { StaleTracker } from './staleTracking';
import { registerGenerateSummaryDocsCommand } from './summaryDocGenerator';
import { isWorkspaceTrusted, onDidGrantWorkspaceTrust } from './trust';

let sidecarManager: SidecarManager | null = null;
let explanationCache: ExplanationCache | null = null;
let indexedWorkspaceRoot: string | undefined;
let backgroundIndexManager: BackgroundIndexManager | null = null;
let roleCodeLensProvider: RoleCodeLensProvider | null = null;
let roleGutterDecorationManager: RoleGutterDecorationManager | null = null;
let gitHookReindexManager: GitHookReindexManager | null = null;

/**
 * Resolves `lucidHover.ollamaEndpoint`, surfacing (output channel + a
 * warning toast) the Core Rule 1 rejection case where the configured value
 * isn't a local address -- a non-loopback host (including Ollama's own
 * cloud offering) is never dialed, not even on explicit user request, so
 * this is the one place that has to tell the user their setting was
 * overridden rather than silently applied. Shared by `startIndexing()` and
 * the "Restart Sidecar" command below so both paths report rejection the
 * same way.
 */
function resolveOllamaEndpointAndWarn(output: vscode.OutputChannel): string {
    const { url, rejectedValue } = resolveOllamaEndpoint();
    if (rejectedValue) {
        output.appendLine(
            `lucidHover.ollamaEndpoint "${rejectedValue}" is not a local address -- LucidHover is fully local ` +
                `(Core Rule 1) and will not contact it. Falling back to ${DEFAULT_OLLAMA_ENDPOINT}.`
        );
        vscode.window.showWarningMessage(
            `LucidHover: "${rejectedValue}" is not a local Ollama endpoint and was rejected. Using ${DEFAULT_OLLAMA_ENDPOINT} instead.`
        );
    }
    return url;
}

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

    const ollamaBaseUrl = resolveOllamaEndpointAndWarn(output);
    const manager = new SidecarManager(
        workspaceRoot,
        context.extensionPath,
        storageRoot.fsPath,
        EMBEDDING_MODEL_ID,
        ollamaBaseUrl,
        output
    );
    sidecarManager = manager;
    context.subscriptions.push(manager);

    // Build Order step 16: routes the very first startup attempt through the
    // same backoff-retry-then-give-up recovery loop as a mid-session crash,
    // rather than a single unretried attempt -- a Python-not-on-PATH-yet or
    // Ollama-still-starting-up hiccup gets the same real retry window. On
    // exhaustion, `restart()`'s own give-up toast already tells the user
    // what happened and offers a retry action, so there's nothing further to
    // surface here.
    const started = await manager.restart('initial startup');
    if (!started) {
        return;
    }
    vscode.window.setStatusBarMessage('LucidHover: sidecar connected', 3000);

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

    // On-type dirty-tracking (Session 12) and stale-dependency tracking
    // (Session 13) -- constructed up front, ahead of the hover provider
    // below, since the hover provider's freshness badge reads both. Purely
    // in-memory bookkeeping; registering/constructing them doesn't itself
    // depend on Workspace Trust (Core Rule 6), same as the hover provider.
    const dirtyTracker = new DirtyTracker(() => indexedWorkspaceRoot, output);
    context.subscriptions.push(dirtyTracker);

    const staleTracker = new StaleTracker();
    context.subscriptions.push(staleTracker);

    // Hover provider registers unconditionally -- only indexing/generation
    // are trust-gated (Core Rule 6). Its getters resolve to undefined until
    // startIndexing() finishes, so it renders nothing until then.
    const hoverProvider = vscode.languages.registerHoverProvider(
        documentSelectorForSupportedLanguages(),
        new ExplanationHoverProvider(
            () => indexedWorkspaceRoot,
            () => explanationCache ?? undefined,
            () => sidecarManager ?? undefined,
            () => dirtyTracker,
            () => staleTracker,
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
    context.subscriptions.push(registerPurgeSupersededCacheCommand(() => explanationCache ?? undefined));
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
            () => dirtyTracker,
            () => staleTracker,
            panelProvider,
            output
        )
    );
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((e) => panelProvider.onSelectionChanged(e.textEditor))
    );
    context.subscriptions.push(
        registerShowBlastRadiusCommand(
            () => indexedWorkspaceRoot,
            () => explanationCache ?? undefined,
            () => sidecarManager ?? undefined,
            panelProvider,
            output
        )
    );
    context.subscriptions.push(
        registerShowCallTraceCommand(
            () => indexedWorkspaceRoot,
            () => explanationCache ?? undefined,
            () => sidecarManager ?? undefined,
            panelProvider,
            output
        )
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
        vscode.languages.registerCodeLensProvider(documentSelectorForSupportedLanguages(), roleCodeLensProvider)
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
        () => staleTracker,
        output
    );
    context.subscriptions.push(saveReindexManager);

    // Periodic background flush (Session 12) -- registers unconditionally
    // and starts ticking immediately; each tick is a cheap no-op until
    // trust/sidecar/cache are ready and there's something dirty to check.
    const backgroundFlushManager = new BackgroundFlushManager(
        () => indexedWorkspaceRoot,
        () => explanationCache ?? undefined,
        () => sidecarManager ?? undefined,
        () => dirtyTracker,
        () => staleTracker,
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
        () => staleTracker,
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
    context.subscriptions.push(registerToggleBackgroundIndexingCommand(backgroundIndexManager));

    // Prioritized file indexing (Session 54) -- registered unconditionally
    // (Core Rule 6, same pattern as the other commands above); a no-op with a
    // status message until indexing has actually started under trust, same
    // readiness check as "Refresh Explanation".
    context.subscriptions.push(
        registerPrioritizeFileIndexingCommand(
            () => indexedWorkspaceRoot,
            () => explanationCache ?? undefined,
            () => sidecarManager ?? undefined,
            output
        )
    );

    // Build Order step 14: `lucidHover.ollamaEndpoint` is spawn-time config
    // (see cache/config.ts's `resolveOllamaEndpoint` doc), so a user editing
    // it has no way to make it take effect short of this explicit restart or
    // a full window reload. Registered unconditionally (Core Rule 6, same
    // pattern as the other commands above) -- it's a no-op with a status
    // message if the sidecar was never started (e.g. untrusted workspace).
    context.subscriptions.push(
        vscode.commands.registerCommand('lucidhover.restartSidecar', async () => {
            if (!sidecarManager) {
                vscode.window.showInformationMessage('LucidHover: sidecar is not running -- nothing to restart.');
                return;
            }
            const ollamaBaseUrl = resolveOllamaEndpointAndWarn(output);
            output.appendLine(`restarting sidecar to apply lucidHover.ollamaEndpoint = ${ollamaBaseUrl}`);
            const ok = await sidecarManager.applyOllamaEndpoint(ollamaBaseUrl);
            if (ok) {
                vscode.window.setStatusBarMessage('LucidHover: sidecar restarted', 3000);
            }
            // On failure, `applyOllamaEndpoint`'s underlying recovery loop
            // already showed its own give-up toast -- nothing further needed.
        })
    );

    // Secondary summary-doc generator (Session 15 / Build Order step 15,
    // post-MVP) -- registered unconditionally (Core Rule 6, same pattern as
    // the other commands above); its own readiness check (workspaceRoot/
    // cache/sidecar all non-null) lives inside the command handler, same as
    // "Refresh Explanation". Explicit-command-only: writing real files to
    // the workspace (docs/wiki/*.md) is a new category of side effect this
    // extension has never had before, so it needs a real user action, not a
    // side effect of background indexing finishing.
    context.subscriptions.push(
        registerGenerateSummaryDocsCommand(
            () => indexedWorkspaceRoot,
            () => explanationCache ?? undefined,
            () => sidecarManager ?? undefined,
            output
        )
    );

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
