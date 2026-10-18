import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Policy test for the release and CI workflows (issue #108 item 14).
 *
 * A supply-chain regression in a workflow file - an unpinned action, a manual
 * dispatch trigger on the publish path, a silently-skipped duplicate publish -
 * cannot be caught by reading a diff, so it is enforced mechanically, the same
 * way the invisible-Unicode scan works. Text-level checks on purpose: pulling
 * in a YAML parser for this would cost a dependency and these rules are about
 * what is literally written in the file. Every check fails closed: anything it
 * cannot parse is a failure, never a pass.
 */
suite('Release workflow policy', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const workflowsDir = path.join(repoRoot, '.github', 'workflows');
    const publishWorkflow = path.join(workflowsDir, 'publish-vscode.yml');

    function workflowFiles(): string[] {
        return fs.readdirSync(workflowsDir)
            .filter(name => /\.ya?ml$/.test(name))
            .map(name => path.join(workflowsDir, name));
    }

    function read(file: string): string {
        return fs.readFileSync(file, 'utf8');
    }

    function stripFullLineComments(text: string): string {
        return text.split(/\r?\n/)
            .filter(line => !/^\s*#/.test(line))
            .join('\n');
    }

    /**
     * The `jobs:` mapping: job name -> the indented body below its `  name:` key.
     * Fails closed: any top-level (column 0) key after `jobs:` means something
     * follows the job list that this parser cannot see, and any line inside the
     * section that is neither blank nor indented is malformed for our purposes.
     */
    function jobBlocks(text: string): Array<{ name: string; body: string }> {
        const lines = stripFullLineComments(text).split('\n');
        const jobsIndex = lines.findIndex(line => /^jobs:\s*$/.test(line));
        assert.ok(jobsIndex >= 0, 'workflow must declare a jobs: section');

        const sectionLines: string[] = [];
        for (let i = jobsIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim() === '') {
                sectionLines.push(line);
                continue;
            }
            assert.ok(
                /^[ \t]/.test(line),
                `unexpected top-level key after jobs: "${line.trim()}" - nothing may follow the job list`
            );
            sectionLines.push(line);
        }

        const blocks: Array<{ name: string; body: string }> = [];
        const jobPattern = /^ {2}([A-Za-z0-9_-]+):\s*$/;
        let current: { name: string; body: string[] } | undefined;
        for (const line of sectionLines) {
            const match = jobPattern.exec(line);
            if (match) {
                if (current) {
                    blocks.push({ name: current.name, body: current.body.join('\n') });
                }
                current = { name: match[1], body: [] };
            } else if (current) {
                current.body.push(line);
            } else {
                assert.fail(`indented content before the first job name: "${line.trim()}"`);
            }
        }
        if (current) {
            blocks.push({ name: current.name, body: current.body.join('\n') });
        }
        return blocks;
    }

    /** The indented block under a top-level `key:` line (comments stripped). */
    function topLevelBlock(text: string, key: string): string[] {
        const lines = stripFullLineComments(text).split('\n');
        const index = lines.findIndex(line => new RegExp(`^${key}:\\s*$`).test(line));
        if (index < 0) {
            return [];
        }
        const block: string[] = [];
        for (let i = index + 1; i < lines.length && (/^[ \t]/.test(lines[i]) || lines[i].trim() === ''); i++) {
            block.push(lines[i]);
        }
        return block;
    }

    test('every job in every workflow has timeout-minutes', () => {
        for (const file of workflowFiles()) {
            const blocks = jobBlocks(read(file));
            assert.ok(blocks.length > 0, `${path.basename(file)} must declare at least one job`);
            for (const { name, body } of blocks) {
                assert.ok(
                    /^ {4}timeout-minutes:\s*\d+\s*$/m.test(body),
                    `${path.basename(file)} job "${name}" must set timeout-minutes`
                );
            }
        }
    });

    test('every uses: is owner/repo@<40 hex> with a # vX.Y.Z comment', () => {
        const usesPattern = /uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})\s+#\s+v\d+\.\d+\.\d+\s*$/gm;
        const anyUsesPattern = /uses:\s*(\S+)/g;
        for (const file of workflowFiles()) {
            const text = read(file);
            const allUses = [...text.matchAll(anyUsesPattern)];
            const pinnedUses = [...text.matchAll(usesPattern)];
            assert.strictEqual(
                allUses.length,
                pinnedUses.length,
                `${path.basename(file)}: every uses: must be owner/repo@<40-hex-sha> followed by a "# vX.Y.Z" comment`
            );
        }
    });

    test('every workflow has permissions: contents: read and nothing writes', () => {
        for (const file of workflowFiles()) {
            const text = read(file);
            const permissions = topLevelBlock(text, 'permissions')
                .map(line => line.trim())
                .filter(line => line !== '');
            assert.deepStrictEqual(
                permissions,
                ['contents: read'],
                `${path.basename(file)} must declare exactly "permissions: contents: read"`
            );
            assert.ok(
                !/:\s*write\b/.test(text),
                `${path.basename(file)} must not grant any write permission`
            );
        }
    });

    test('every actions/checkout step sets persist-credentials: false', () => {
        const checkoutPattern = /- name:.*\r?\n\s*uses:\s*actions\/checkout@|uses:\s*actions\/checkout@/g;
        for (const file of workflowFiles()) {
            const text = read(file);
            let match;
            let count = 0;
            while ((match = checkoutPattern.exec(text)) !== null) {
                count += 1;
                // The step's `with:` block runs until the next step or a
                // shallower indentation; persist-credentials must be inside it.
                const step = text.slice(match.index, match.index + 1500);
                const withMatch = /with:\r?\n((?:[ ]{10,}.*\r?\n?)+)/.exec(step);
                assert.ok(
                    withMatch && /persist-credentials:\s*false/.test(withMatch[1]),
                    `${path.basename(file)}: every actions/checkout step must set persist-credentials: false`
                );
            }
            assert.ok(count > 0, `${path.basename(file)} must use actions/checkout at least once`);
        }
    });

    test('the publish workflow triggers only on pushed v* tags', () => {
        const text = read(publishWorkflow);
        const onBlock = topLevelBlock(text, 'on')
            .map(line => line.trim())
            .filter(line => line !== '');
        assert.deepStrictEqual(
            onBlock,
            ['push:', 'tags:', "- 'v*'"],
            'publish-vscode.yml on: must be exactly push with tags [\'v*\']'
        );
        for (const forbidden of [
            'workflow_dispatch', 'pull_request', 'workflow_run',
            'schedule', 'repository_dispatch', 'branches'
        ]) {
            assert.ok(
                !onBlock.some(line => line.includes(forbidden)),
                `publish-vscode.yml on: must not contain ${forbidden}`
            );
        }
    });

    test('the publish path never passes --skip-duplicate', () => {
        const workflowText = read(publishWorkflow);
        assert.ok(!workflowText.includes('--skip-duplicate'), 'publish-vscode.yml must not pass --skip-duplicate');

        const packageJson = JSON.parse(read(path.join(repoRoot, 'package.json')));
        for (const scriptName of ['deploy', 'deploy:ovsx']) {
            const script = packageJson.scripts[scriptName] ?? '';
            assert.ok(
                !script.includes('--skip-duplicate'),
                `package.json script "${scriptName}" must not pass --skip-duplicate`
            );
        }
    });

    test('both publish jobs need the build and the up-front token check', () => {
        const blocks = jobBlocks(read(publishWorkflow));
        const byName = new Map(blocks.map(block => [block.name, block.body]));
        assert.ok(byName.has('check-tokens'), 'publish-vscode.yml must declare a check-tokens job');
        for (const jobName of ['publish-marketplace', 'publish-ovsx']) {
            const body = byName.get(jobName);
            assert.ok(body, `publish-vscode.yml must declare ${jobName}`);
            const needsMatch = /needs:\s*(?:\[\s*([^\]]+)\]|([^\r\n]+)|\r?\n((?:\s+-.*\r?\n?)+))/.exec(body!);
            assert.ok(needsMatch, `${jobName} must declare needs:`);
            const needsText = needsMatch[0];
            for (const required of ['build', 'check-tokens']) {
                assert.ok(
                    new RegExp(`\\b${required}\\b`).test(needsText),
                    `${jobName} must need ${required}`
                );
            }
        }
    });
});
