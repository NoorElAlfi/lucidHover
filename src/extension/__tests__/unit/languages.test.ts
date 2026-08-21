import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    allSupportedExtensions,
    documentSelectorForSupportedLanguages,
    hasSupportedExtension,
    isSupportedLanguageId,
    loadLanguageManifest,
    supportedLanguages,
} from '../../languages';

const REPO_ROOT = path.resolve(__dirname, '../../../../');

describe('languages.ts (repo-root languages.json reader)', () => {
    it('loads the real languages.json -- javascript, typescript, and typescriptreact today', () => {
        const languages = supportedLanguages();
        assert.strictEqual(languages.length, 3);
        const byId = new Map(languages.map((entry) => [entry.vscodeLanguageId, entry]));
        assert.deepStrictEqual(byId.get('javascript')?.extensions, ['.js', '.jsx']);
        assert.deepStrictEqual(byId.get('typescript')?.extensions, ['.ts']);
        assert.deepStrictEqual(byId.get('typescriptreact')?.extensions, ['.tsx']);
    });

    it('isSupportedLanguageId is true only for a manifest vscodeLanguageId -- everything else is the "no adapter" case', () => {
        assert.strictEqual(isSupportedLanguageId('javascript'), true);
        assert.strictEqual(isSupportedLanguageId('typescript'), true);
        assert.strictEqual(isSupportedLanguageId('typescriptreact'), true);
        assert.strictEqual(isSupportedLanguageId('python'), false);
        assert.strictEqual(isSupportedLanguageId(''), false);
    });

    it('documentSelectorForSupportedLanguages derives one selector entry per manifest language', () => {
        assert.deepStrictEqual(
            documentSelectorForSupportedLanguages().map((s) => s.language).sort(),
            ['javascript', 'typescript', 'typescriptreact']
        );
    });

    it('allSupportedExtensions unions every manifest language\'s extensions', () => {
        assert.deepStrictEqual(allSupportedExtensions().slice().sort(), ['.js', '.jsx', '.ts', '.tsx']);
    });

    it('hasSupportedExtension matches any manifest extension, not just the first', () => {
        assert.strictEqual(hasSupportedExtension('src/foo.js'), true);
        assert.strictEqual(hasSupportedExtension('src/Foo.jsx'), true);
        assert.strictEqual(hasSupportedExtension('src/foo.ts'), true);
        assert.strictEqual(hasSupportedExtension('src/foo.tsx'), true);
        assert.strictEqual(hasSupportedExtension('src/foo.py'), false);
    });

    describe('package.json activationEvents agreement (Session 22 item 2 -- required, not optional)', () => {
        // VS Code parses activationEvents before extension code runs, so
        // package.json can't read languages.json at runtime -- CLAUDE.md
        // Core Rule 12 / session-21's Decided Q2 accept that duplication and
        // rely on this test to catch it drifting instead.
        it('has exactly one onLanguage:<id> activation event per languages.json entry, and no extra ones', () => {
            const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
                activationEvents: string[];
            };
            const manifestLanguages = loadLanguageManifest(path.join(REPO_ROOT, 'languages.json'));
            const expected = [...manifestLanguages.values()]
                .map((entry) => `onLanguage:${entry.vscodeLanguageId}`)
                .sort();
            const actualOnLanguageEvents = packageJson.activationEvents.filter((e) => e.startsWith('onLanguage:')).sort();

            assert.deepStrictEqual(
                actualOnLanguageEvents,
                expected,
                'package.json activationEvents has drifted from languages.json -- add/remove the matching ' +
                    '"onLanguage:<vscodeLanguageId>" entry.'
            );
        });
    });
});
