import * as assert from 'assert';
import { DEFAULT_OLLAMA_ENDPOINT, resolveOllamaEndpointFromValue } from '../../cache/ollamaEndpoint';

describe('cache/config resolveOllamaEndpointFromValue', () => {
    it('falls back to the default when unset/empty/whitespace', () => {
        for (const value of [undefined, '', '   ']) {
            assert.deepStrictEqual(resolveOllamaEndpointFromValue(value), { url: DEFAULT_OLLAMA_ENDPOINT });
        }
    });

    it('accepts localhost, 127.0.0.1, and ::1 (with port)', () => {
        for (const url of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://[::1]:11434']) {
            assert.deepStrictEqual(resolveOllamaEndpointFromValue(url), { url });
        }
    });

    it('accepts a mixed-case localhost host', () => {
        assert.deepStrictEqual(resolveOllamaEndpointFromValue('http://LOCALHOST:11434'), {
            url: 'http://LOCALHOST:11434',
        });
    });

    // Core Rule 1: no cloud LLM providers, ever -- applies to a user-supplied
    // endpoint exactly as much as the bundled one.
    it('rejects a non-loopback host and falls back to the default, surfacing rejectedValue', () => {
        const rejected = 'http://example.com:11434';
        assert.deepStrictEqual(resolveOllamaEndpointFromValue(rejected), {
            url: DEFAULT_OLLAMA_ENDPOINT,
            rejectedValue: rejected,
        });
    });

    it('rejects a scheme-less host (unparsable as a URL) and falls back to the default', () => {
        assert.deepStrictEqual(resolveOllamaEndpointFromValue('localhost:11434'), {
            url: DEFAULT_OLLAMA_ENDPOINT,
            rejectedValue: 'localhost:11434',
        });
    });

    it('rejects garbage input and falls back to the default', () => {
        assert.deepStrictEqual(resolveOllamaEndpointFromValue('not a url at all'), {
            url: DEFAULT_OLLAMA_ENDPOINT,
            rejectedValue: 'not a url at all',
        });
    });

    it('trims surrounding whitespace before validating', () => {
        assert.deepStrictEqual(resolveOllamaEndpointFromValue('  http://localhost:11434  '), {
            url: 'http://localhost:11434',
        });
    });
});
