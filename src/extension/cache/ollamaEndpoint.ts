/**
 * Pure Ollama-endpoint validation logic, factored out of `config.ts` (Build
 * Order step 17) the same way `debounce.ts`'s `KeyedDebouncer` was in
 * Session 8: no `vscode` dependency, so it can be exercised with a plain
 * `node` unit test instead of needing the Extension Development Host just to
 * check URL-parsing/loopback-rejection edge cases. `config.ts`'s
 * `resolveOllamaEndpoint()` stays the thin `vscode.workspace.getConfiguration(...)`
 * wrapper around `resolveOllamaEndpointFromValue()` below.
 */

/**
 * Build Order step 14: the bundled default Ollama endpoint. Both the
 * bundled and any custom-model tier talk to Ollama's local HTTP API (see
 * sidecar/generation/ollama_client.py's module docstring) -- only the host
 * differs.
 */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

export interface ResolvedOllamaEndpoint {
    url: string;
    /**
     * Set when `lucidHover.ollamaEndpoint` was configured but rejected for
     * not being a local address -- Core Rule 1 ("no cloud LLM providers,
     * ever") applies to a user-supplied endpoint exactly as much as it does
     * to the bundled one, so a non-loopback host (including Ollama's own
     * cloud offering) is never dialed, not even on explicit request. The
     * caller is expected to surface this to the user; `resolveOllamaEndpoint`
     * itself only decides, it doesn't display anything.
     */
    rejectedValue?: string;
}

function isLoopbackHost(hostname: string): boolean {
    // `URL#hostname` renders an IPv6 literal host with its brackets intact
    // (`new URL('http://[::1]:11434').hostname === '[::1]'`, not `'::1'`) --
    // strip them before comparing, or `http://[::1]:11434` would be wrongly
    // rejected as non-local.
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * Resolves a raw `lucidHover.ollamaEndpoint` setting value, falling back to
 * `DEFAULT_OLLAMA_ENDPOINT` when unset, unparsable, or non-local.
 */
export function resolveOllamaEndpointFromValue(rawValue: string | undefined): ResolvedOllamaEndpoint {
    const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (trimmed.length === 0) {
        return { url: DEFAULT_OLLAMA_ENDPOINT };
    }

    let hostname: string;
    try {
        hostname = new URL(trimmed).hostname;
    } catch {
        return { url: DEFAULT_OLLAMA_ENDPOINT, rejectedValue: trimmed };
    }

    if (!isLoopbackHost(hostname)) {
        return { url: DEFAULT_OLLAMA_ENDPOINT, rejectedValue: trimmed };
    }
    return { url: trimmed };
}
