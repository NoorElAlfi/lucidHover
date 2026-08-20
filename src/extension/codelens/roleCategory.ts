/**
 * `role_tag` is free-form 1-3 word model output (see the spec's Output
 * Schema section -- it is deliberately not a fixed enum in
 * sidecar/generation/schema.py). A gutter icon needs a small, finite set of
 * assets, so this module buckets arbitrary role-tag strings into one of a
 * fixed set of categories by keyword match, falling back to `generic` for
 * anything that matches no bucket. This is intentionally a small heuristic,
 * not a redesign of the prompt/schema toward a constrained enum -- that
 * would be a separate, larger change (see session-10 artifact "Decisions
 * made" for the reasoning).
 *
 * Single source of truth for both new v0-post-MVP display surfaces (Session
 * 10's CodeLens badge and gutter icon), so they can never drift into two
 * different pictures of "what category is this function."
 */

export type RoleCategory =
    | 'handler'
    | 'validator'
    | 'persister'
    | 'middleware'
    | 'test'
    | 'config'
    | 'utility'
    | 'generic';

interface CategoryDef {
    category: RoleCategory;
    keywords: string[];
    emoji: string;
    iconFile: string;
}

// Order matters: first matching bucket wins. Checked as case-insensitive
// substring match against the whole role_tag (e.g. "Retry handler" matches
// "handler"; "DB Persister" matches "persist").
const CATEGORIES: CategoryDef[] = [
    {
        category: 'validator',
        keywords: ['valid', 'guard', 'sanitiz', 'verify', 'check'],
        emoji: '✅',
        iconFile: 'validator.svg',
    },
    {
        category: 'persister',
        keywords: ['persist', 'store', 'database', 'db', 'repository', 'reader', 'writer', 'loader', 'fetch', 'save', 'cache'],
        emoji: '💾',
        iconFile: 'persister.svg',
    },
    {
        category: 'middleware',
        keywords: ['middleware', 'interceptor', 'wrapper', 'decorator'],
        emoji: '🔀',
        iconFile: 'middleware.svg',
    },
    {
        category: 'handler',
        keywords: ['handler', 'route', 'controller', 'endpoint', 'listener', 'callback', 'dispatch'],
        emoji: '🔧',
        iconFile: 'handler.svg',
    },
    {
        category: 'test',
        keywords: ['test', 'mock', 'stub', 'fixture', 'spec'],
        emoji: '🧪',
        iconFile: 'test.svg',
    },
    {
        category: 'config',
        keywords: ['config', 'setup', 'init', 'bootstrap', 'factory'],
        emoji: '⚙️',
        iconFile: 'config.svg',
    },
    {
        category: 'utility',
        keywords: ['util', 'helper', 'format', 'pars', 'convert', 'transform', 'serializ'],
        emoji: '🧰',
        iconFile: 'utility.svg',
    },
];

const GENERIC: CategoryDef = { category: 'generic', keywords: [], emoji: '❔', iconFile: 'generic.svg' };

const ALL_DEFS = [...CATEGORIES, GENERIC];

/** Every category a real cached row can be classified into (excludes the "pending" not-yet-cached state). */
export const ALL_ROLE_CATEGORIES: RoleCategory[] = ALL_DEFS.map((d) => d.category);

export function classifyRoleTag(roleTag: string): RoleCategory {
    const lower = roleTag.toLowerCase();
    for (const def of CATEGORIES) {
        if (def.keywords.some((kw) => lower.includes(kw))) {
            return def.category;
        }
    }
    return 'generic';
}

export function categoryEmoji(category: RoleCategory): string {
    return ALL_DEFS.find((d) => d.category === category)?.emoji ?? GENERIC.emoji;
}

export function categoryIconFile(category: RoleCategory): string {
    return ALL_DEFS.find((d) => d.category === category)?.iconFile ?? GENERIC.iconFile;
}

/**
 * A resolved function with no cached row yet is a display state of its own
 * (distinct from a "generic" cached role) -- neither surface generates on
 * this state (Core Rule 4), they just render a neutral placeholder until a
 * background/save/refresh pass writes a real row.
 */
export const PENDING_ICON_FILE = 'pending.svg';
export const PENDING_CODELENS_TITLE = '○ not indexed yet';
