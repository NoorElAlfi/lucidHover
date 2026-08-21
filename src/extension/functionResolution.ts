import * as path from 'path';
import * as vscode from 'vscode';
import { computeFnHash, computeFnId } from './cache/hash';

/**
 * Shared by the hover provider (level 0) and the docked panel's cursor-sync
 * (levels 1-2) -- both need to turn "document + cursor position" into the
 * same fn_id/fn_hash identity, but neither should duplicate the other's
 * resolution logic. This module never contacts the sidecar or cache; it only
 * resolves *what function* the cursor is on.
 */

export function isFunctionLike(symbol: vscode.DocumentSymbol): boolean {
    if (
        symbol.kind === vscode.SymbolKind.Function ||
        symbol.kind === vscode.SymbolKind.Method ||
        symbol.kind === vscode.SymbolKind.Constructor
    ) {
        return true;
    }
    // `const foo = () => {...}` surfaces as SymbolKind.Variable in the built-in
    // JS language service; its `detail` carries the inferred function type signature.
    if (symbol.kind === vscode.SymbolKind.Variable && /=>|\bfunction\b/.test(symbol.detail)) {
        return true;
    }
    return false;
}

export function findEnclosingFunctionSymbol(
    symbols: vscode.DocumentSymbol[],
    position: vscode.Position
): vscode.DocumentSymbol | undefined {
    for (const symbol of symbols) {
        if (!symbol.range.contains(position)) {
            continue;
        }
        const child = findEnclosingFunctionSymbol(symbol.children, position);
        if (child) {
            return child;
        }
        if (isFunctionLike(symbol)) {
            return symbol;
        }
    }
    return undefined;
}

interface FlattenedFunctionSymbol {
    symbol: vscode.DocumentSymbol;
    qualifiedName: string;
}

/**
 * Every function-like symbol in a document, flattened (Session 8:
 * debounced-save re-indexing needs to hash-diff *every* function in the
 * saved file, not just whichever one the cursor happens to be on), each
 * paired with a name built from its enclosing symbols (e.g.
 * "ClassName.methodName") instead of its position.
 *
 * This qualified name -- not an absolute line number -- is what makes fnId
 * stable across edits (see cache/hash.ts's computeFnId doc comment): nesting
 * is what actually distinguishes two same-named functions, not wherever they
 * happen to currently sit in the file.
 */
function flattenWithQualifiedNames(
    symbols: vscode.DocumentSymbol[],
    ancestorPath: string[] = []
): FlattenedFunctionSymbol[] {
    const result: FlattenedFunctionSymbol[] = [];
    for (const symbol of symbols) {
        const path = [...ancestorPath, symbol.name];
        if (isFunctionLike(symbol)) {
            result.push({ symbol, qualifiedName: path.join('.') });
        }
        result.push(...flattenWithQualifiedNames(symbol.children, path));
    }
    return result;
}

/**
 * Turns each flattened symbol's qualified name into a full fnId, appending a
 * `#n` (document-order) suffix only when two functions in the same file
 * genuinely land on the identical qualified name (e.g. two accidental
 * top-level redeclarations) -- so a collision-avoidance suffix is only ever
 * needed for real duplicates, never for the common case of a unique name
 * that merely shifted lines.
 */
function assignFnIds(relFile: string, flattened: FlattenedFunctionSymbol[]): Map<vscode.DocumentSymbol, string> {
    const counts = new Map<string, number>();
    for (const { qualifiedName } of flattened) {
        counts.set(qualifiedName, (counts.get(qualifiedName) ?? 0) + 1);
    }

    const seen = new Map<string, number>();
    const result = new Map<vscode.DocumentSymbol, string>();
    for (const { symbol, qualifiedName } of flattened) {
        let identity = qualifiedName;
        if ((counts.get(qualifiedName) ?? 0) > 1) {
            const index = seen.get(qualifiedName) ?? 0;
            seen.set(qualifiedName, index + 1);
            identity = `${qualifiedName}#${index}`;
        }
        result.set(symbol, computeFnId(relFile, identity));
    }
    return result;
}

export interface ResolvedFunction {
    relFile: string;
    name: string;
    range: vscode.Range;
    fnSource: string;
    fnId: string;
    fnHash: string;
}

export function relFileFor(document: vscode.TextDocument, workspaceRoot: string): string {
    return path.relative(workspaceRoot, document.uri.fsPath).split(path.sep).join('/');
}

function toResolvedFunction(
    symbol: vscode.DocumentSymbol,
    fnId: string,
    document: vscode.TextDocument,
    relFile: string
): ResolvedFunction {
    const fnSource = document.getText(symbol.range);
    return {
        relFile,
        name: symbol.name,
        range: symbol.range,
        fnSource,
        fnId,
        fnHash: computeFnHash(fnSource),
    };
}

/** Resolves the function enclosing `position`, or undefined if the cursor isn't inside one. */
export async function resolveEnclosingFunction(
    document: vscode.TextDocument,
    position: vscode.Position,
    workspaceRoot: string
): Promise<ResolvedFunction | undefined> {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
    );
    if (!symbols || symbols.length === 0) {
        return undefined;
    }

    const enclosing = findEnclosingFunctionSymbol(symbols, position);
    if (!enclosing) {
        return undefined;
    }

    // fnId needs every function's qualified name in the file, not just the
    // enclosing one, so that a name shared with another function in the
    // file gets the same #n disambiguation `resolveAllFunctions` would
    // assign it -- otherwise hover and save-reindex could compute different
    // fnIds for the same function.
    const relFile = relFileFor(document, workspaceRoot);
    const fnIds = assignFnIds(relFile, flattenWithQualifiedNames(symbols));
    const fnId = fnIds.get(enclosing) ?? computeFnId(relFile, enclosing.name);
    return toResolvedFunction(enclosing, fnId, document, relFile);
}

/**
 * Every function-like symbol in a document, resolved to the same identity
 * shape as `resolveEnclosingFunction` (Session 8: debounced-save
 * re-indexing hash-diffs every function in the saved file at once).
 */
export async function resolveAllFunctions(
    document: vscode.TextDocument,
    workspaceRoot: string
): Promise<ResolvedFunction[]> {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
    );
    if (!symbols || symbols.length === 0) {
        return [];
    }

    const relFile = relFileFor(document, workspaceRoot);
    const flattened = flattenWithQualifiedNames(symbols);
    const fnIds = assignFnIds(relFile, flattened);
    return flattened.map(({ symbol }) =>
        toResolvedFunction(symbol, fnIds.get(symbol) ?? computeFnId(relFile, symbol.name), document, relFile)
    );
}

/**
 * Same as `resolveAllFunctions`, but starting from a repo-relative path
 * instead of an already-open `TextDocument` (Session 12: both the periodic
 * flush pass and the git-hook re-index pass learn about a changed file by
 * relative path -- via the dirty-tracking set or the hook's marker file --
 * not from an editor the user necessarily still has open). Opening the
 * document off-screen like this doesn't show it in the UI. Mirrors
 * `BackgroundIndexManager`'s own private `resolveFileSymbols` (Session 9),
 * factored out here since a third call site made the duplication worth
 * removing; `BackgroundIndexManager` itself is left as-is.
 */
export async function resolveFunctionsInFile(
    workspaceRoot: string,
    relFile: string,
    output: vscode.OutputChannel
): Promise<ResolvedFunction[]> {
    try {
        const uri = vscode.Uri.file(path.join(workspaceRoot, relFile));
        const document = await vscode.workspace.openTextDocument(uri);
        return await resolveAllFunctions(document, workspaceRoot);
    } catch (err) {
        output.appendLine(`resolveFunctionsInFile: failed to open ${relFile}: ${String(err)}`);
        return [];
    }
}
