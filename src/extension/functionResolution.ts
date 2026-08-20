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

/**
 * Every function-like symbol in a document, flattened (Session 8:
 * debounced-save re-indexing needs to hash-diff *every* function in the
 * saved file, not just whichever one the cursor happens to be on).
 */
export function flattenFunctionSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];
    for (const symbol of symbols) {
        if (isFunctionLike(symbol)) {
            result.push(symbol);
        }
        result.push(...flattenFunctionSymbols(symbol.children));
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
    document: vscode.TextDocument,
    relFile: string
): ResolvedFunction {
    const fnSource = document.getText(symbol.range);
    const line = symbol.range.start.line;
    return {
        relFile,
        name: symbol.name,
        range: symbol.range,
        fnSource,
        fnId: computeFnId(relFile, symbol.name, line),
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

    return toResolvedFunction(enclosing, document, relFileFor(document, workspaceRoot));
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
    return flattenFunctionSymbols(symbols).map((symbol) => toResolvedFunction(symbol, document, relFile));
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
