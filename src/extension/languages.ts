import * as fs from 'fs';
import * as path from 'path';

/**
 * Extension-host reader for the repo-root `languages.json` manifest (Core
 * Rule 12). Session 21 added the manifest and its sidecar-side reader
 * (`sidecar/repomap/adapters/registry.py`); this is the extension-host
 * counterpart -- every `languageId`/`DocumentSelector` check that used to be
 * a literal `'javascript'` string reads through here instead, so adding a
 * language later is a manifest edit, not a grep-and-replace across this
 * directory.
 *
 * Deliberately no `vscode` import: this module only needs `fs`/`path`, so it
 * loads and unit-tests the same way `cache/ollamaEndpoint.ts` does --
 * plain-Node, no Extension Development Host required. Callers that need an
 * actual `vscode.DocumentSelector` type get one from
 * `documentSelectorForSupportedLanguages()` below; its return type is
 * structurally identical to one without this module needing to import
 * `vscode` itself.
 */

export interface LanguageManifestEntry {
    displayName: string;
    vscodeLanguageId: string;
    extensions: string[];
    resolutionStrategy: string;
}

interface RawLanguageManifestEntry {
    displayName: string;
    vscodeLanguageId: string;
    extensions: string[];
    resolutionStrategy: string;
}

// languages.js (compiled, in out/extension/) -> out/ -> repo root. Mirrors
// the sidecar's own `_MANIFEST_PATH` resolution in
// sidecar/repomap/adapters/registry.py (adapters/ -> repomap/ -> sidecar/ ->
// repo root) -- both sides locate the same repo-root file relative to their
// own compiled/installed location, not a shared absolute path.
const DEFAULT_MANIFEST_PATH = path.join(__dirname, '..', '..', 'languages.json');

function toEntry(raw: RawLanguageManifestEntry): LanguageManifestEntry {
    return {
        displayName: raw.displayName,
        vscodeLanguageId: raw.vscodeLanguageId,
        extensions: raw.extensions,
        resolutionStrategy: raw.resolutionStrategy,
    };
}

/**
 * Exported (not just the module-level singleton below) so the package.json
 * activation-events drift test can load the manifest directly by path,
 * without depending on this module's own `__dirname`-relative default --
 * the test knows the repo root already (it's reading package.json from it
 * too) and should verify the real on-disk manifest, not a resolution detail
 * of this loader.
 */
export function loadLanguageManifest(manifestPath: string = DEFAULT_MANIFEST_PATH): Map<string, LanguageManifestEntry> {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, RawLanguageManifestEntry>;
    const entries = new Map<string, LanguageManifestEntry>();
    for (const [languageId, data] of Object.entries(raw)) {
        entries.set(languageId, toEntry(data));
    }
    return entries;
}

// Loaded once per process, same eager-at-first-use timing as the sidecar's
// `get_registry()` singleton (Session 21) -- every function below reads
// through this instead of re-parsing the file.
const LANGUAGES = loadLanguageManifest();

export function supportedLanguages(): LanguageManifestEntry[] {
    return [...LANGUAGES.values()];
}

/** True only for a `vscodeLanguageId` some manifest entry declares -- everything else is the "no adapter" case (Session 22 item 4). */
export function isSupportedLanguageId(languageId: string): boolean {
    for (const entry of LANGUAGES.values()) {
        if (entry.vscodeLanguageId === languageId) {
            return true;
        }
    }
    return false;
}

/**
 * One selector entry per manifest language, for `registerHoverProvider`/
 * `registerCodeLensProvider` (both currently take a single `{ language:
 * 'javascript' }` literal). Untyped as `vscode.DocumentSelector` here only
 * to keep this module `vscode`-free; the shape (`{ language: string }[]`)
 * is exactly what that type accepts.
 */
export function documentSelectorForSupportedLanguages(): { language: string }[] {
    return supportedLanguages().map((entry) => ({ language: entry.vscodeLanguageId }));
}

/** Union of every manifest language's extensions, e.g. `['.js', '.jsx']` -- replaces the three independently-hardcoded copies session-20's audit found. */
export function allSupportedExtensions(): string[] {
    const extensions = new Set<string>();
    for (const entry of LANGUAGES.values()) {
        for (const ext of entry.extensions) {
            extensions.add(ext);
        }
    }
    return [...extensions];
}

/** Whether `fileName` (a path or bare name) ends in one of the manifest's extensions. */
export function hasSupportedExtension(fileName: string): boolean {
    return allSupportedExtensions().some((ext) => fileName.endsWith(ext));
}
