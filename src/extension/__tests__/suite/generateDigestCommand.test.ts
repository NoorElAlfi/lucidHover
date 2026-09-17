/**
 * Codebase digest export (chat-discussed follow-up, not a Build Order
 * step): live verification against a real spawned sidecar (no Ollama
 * needed -- `generate_digest` is a pure filesystem walk, no LLM call) that
 * generateDigestCommand.ts's `generateCodebaseDigest` opens the real digest
 * text as an untitled document, copies it to the clipboard, and that the
 * digest reflects real gitignore/excluded-dir filtering end to end through
 * the RPC round trip. `sidecar/tests/test_digest.py` already covers the
 * walk/filter/budget logic in isolation -- this confirms the TS command
 * wires it up correctly.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { generateCodebaseDigest } from '../../digest/generateDigestCommand';
import { SidecarManager } from '../../sidecar/sidecarManager';

suite('digest/generateDigestCommand (real sidecar, no Ollama needed -- filesystem-only)', () => {
    let tempDir: string;
    let storageDir: string;
    let output: vscode.OutputChannel;
    let sidecar: SidecarManager;

    function findExtensionRoot(): string {
        const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'lucidhover');
        assert.ok(ext, 'expected the lucidhover extension to be loaded under test');
        return ext!.extensionPath;
    }

    suiteSetup(async function () {
        // Real process spawn + real socket connect -- same generous-but-
        // bounded budget blastRadiusCommand.test.ts uses for the identical
        // class of setup cost.
        this.timeout(120_000);

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-digest-'));
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidhover-digest-storage-'));

        fs.writeFileSync(path.join(tempDir, 'a.js'), 'function a() {\n  return 1;\n}\n', 'utf8');
        fs.writeFileSync(path.join(tempDir, 'README.md'), '# hello\n', 'utf8');
        fs.mkdirSync(path.join(tempDir, 'node_modules'));
        fs.writeFileSync(path.join(tempDir, 'node_modules', 'dep.js'), 'function shouldNotAppear() {}\n', 'utf8');
        fs.mkdirSync(path.join(tempDir, 'generated'));
        fs.writeFileSync(
            path.join(tempDir, 'generated', 'ignored.js'),
            'function shouldAlsoNotAppear() {}\n',
            'utf8'
        );
        fs.writeFileSync(path.join(tempDir, '.gitignore'), 'generated/\n', 'utf8');

        output = vscode.window.createOutputChannel('LucidHover Digest Test (sidecar log)');
        sidecar = new SidecarManager(
            tempDir,
            findExtensionRoot(),
            storageDir,
            'all-minilm',
            'http://localhost:11434',
            output
        );
        await sidecar.start();
    });

    suiteTeardown(function () {
        sidecar?.dispose();
        // Deliberately does NOT dispose `output` -- see
        // blastRadiusCommand.test.ts's own suiteTeardown comment: a real
        // child process's stdout/stderr listeners can still fire after
        // teardown() kills it but before it actually exits.
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
        fs.rmSync(storageDir, { recursive: true, force: true });
    });

    test('opens the real digest as an untitled document, copies it to the clipboard, and excludes gitignored/excluded-dir files', async function () {
        this.timeout(20_000);

        await vscode.env.clipboard.writeText('sentinel-before-digest');

        await generateCodebaseDigest(() => sidecar, output);

        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'expected the digest to open in a new editor');
        assert.strictEqual(editor!.document.isUntitled, true, 'expected an untitled document, not a saved file');

        const text = editor!.document.getText();
        assert.ok(text.includes('File: a.js'), 'expected a.js content section header');
        assert.ok(text.includes('function a()'), 'expected a.js real content');
        assert.ok(text.includes('README.md'), 'expected README.md to be included (non-source files are walked too)');
        assert.ok(!text.includes('shouldNotAppear'), 'node_modules must be excluded');
        assert.ok(!text.includes('shouldAlsoNotAppear'), 'gitignored generated/ must be excluded');

        const clipboardText = await vscode.env.clipboard.readText();
        assert.strictEqual(clipboardText, text, 'expected the full digest text to also be copied to the clipboard');
    });
});
