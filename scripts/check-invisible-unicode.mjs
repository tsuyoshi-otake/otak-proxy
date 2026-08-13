#!/usr/bin/env node
/**
 * @file check-invisible-unicode
 * @description Fails the build when a tracked file - or a compiled artifact that is
 * about to ship - contains invisible or display-spoofing Unicode code points.
 *
 * ESLint only sees the files it parses. GlassWorm-style payloads can just as easily
 * sit in a locale JSON, a Markdown file, a workflow, or in `out/**` after the sources
 * were reviewed, so this scanner covers everything.
 *
 * Usage:
 *   node scripts/check-invisible-unicode.mjs            # every git-tracked file
 *   node scripts/check-invisible-unicode.mjs --dist     # the artifacts shipped in the VSIX
 *   node scripts/check-invisible-unicode.mjs <path>...  # explicit files or directories
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatFinding, scanTextForInvisibleUnicode } from './lib/invisible-unicode.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Extensions whose contents are not text; scanning them is meaningless. */
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp',
    '.wav', '.mp3', '.ogg', '.mp4',
    '.ttf', '.otf', '.woff', '.woff2',
    '.zip', '.vsix', '.gz', '.pdf', '.exe', '.dll'
]);

/**
 * What `package.json#files` actually ships, expressed as roots this scanner can walk.
 * Kept deliberately coarse: over-scanning `out/` is cheap, under-scanning is a gap.
 */
const DIST_ROOTS = ['out'];
const DIST_FILES = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE'];
const DIST_TEXT_EXTENSIONS = new Set(['.js', '.json', '.md', '.mjs', '.cjs']);

/**
 * Tracked files plus new files that are not gitignored. Untracked files matter: a
 * payload dropped into a brand-new file must fail the developer's own lint run, not
 * only CI after it has been committed. `--exclude-standard` keeps node_modules/,
 * out/ and .vscode-test/ out of the walk.
 */
function listCandidateFiles() {
    const stdout = execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
    return [...new Set(stdout.split('\0').filter(Boolean))];
}

function walkDirectory(absoluteDir, predicate, collected) {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
        const absolute = path.join(absoluteDir, entry.name);
        if (entry.isDirectory()) {
            walkDirectory(absolute, predicate, collected);
        } else if (entry.isFile() && predicate(absolute)) {
            collected.push(path.relative(repoRoot, absolute).split(path.sep).join('/'));
        }
    }
    return collected;
}

function listDistFiles() {
    const collected = [];

    for (const root of DIST_ROOTS) {
        const absolute = path.join(repoRoot, root);
        if (!fs.existsSync(absolute)) {
            throw new Error(`${root}/ does not exist - run "npm run compile" before scanning the dist artifacts.`);
        }
        walkDirectory(absolute, file => DIST_TEXT_EXTENSIONS.has(path.extname(file)), collected);
    }

    for (const file of DIST_FILES) {
        if (fs.existsSync(path.join(repoRoot, file))) {
            collected.push(file);
        }
    }

    // Localized manifest strings are generated, so they ship without ever being reviewed.
    for (const entry of fs.readdirSync(repoRoot)) {
        if (/^package\.nls.*\.json$/.test(entry)) {
            collected.push(entry);
        }
    }

    return collected;
}

function listExplicitTargets(targets) {
    const collected = [];
    for (const target of targets) {
        const absolute = path.resolve(repoRoot, target);
        const stat = fs.statSync(absolute);
        if (stat.isDirectory()) {
            walkDirectory(absolute, () => true, collected);
        } else {
            collected.push(path.relative(repoRoot, absolute).split(path.sep).join('/'));
        }
    }
    return collected;
}

/** Git's own heuristic: a NUL byte early in the file means "binary". */
function isBinary(buffer) {
    return buffer.subarray(0, 8000).includes(0x00);
}

function scanFiles(relativePaths) {
    const findings = [];
    let scanned = 0;
    let skipped = 0;

    for (const relativePath of relativePaths) {
        if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
            skipped += 1;
            continue;
        }

        let buffer;
        try {
            buffer = fs.readFileSync(path.join(repoRoot, relativePath));
        } catch {
            // Tracked but absent locally (sparse checkout, deleted-not-committed).
            skipped += 1;
            continue;
        }

        if (isBinary(buffer)) {
            skipped += 1;
            continue;
        }

        scanned += 1;
        for (const finding of scanTextForInvisibleUnicode(buffer.toString('utf8'))) {
            findings.push({ relativePath, finding });
        }
    }

    return { findings, scanned, skipped };
}

function main(argv) {
    const explicitTargets = argv.filter(arg => !arg.startsWith('--'));
    const distMode = argv.includes('--dist');

    let mode;
    let targets;
    if (explicitTargets.length > 0) {
        mode = 'explicit paths';
        targets = listExplicitTargets(explicitTargets);
    } else if (distMode) {
        mode = 'shipped artifacts';
        targets = listDistFiles();
    } else {
        mode = 'repository files';
        targets = listCandidateFiles();
    }

    const { findings, scanned, skipped } = scanFiles(targets);

    if (findings.length > 0) {
        console.error(`Invisible Unicode characters detected in ${mode}:\n`);
        for (const { relativePath, finding } of findings) {
            console.error(`  ${formatFinding(finding, relativePath)}`);
        }
        console.error(
            `\n${findings.length} occurrence(s) in ${new Set(findings.map(f => f.relativePath)).size} file(s).` +
            '\nInvisible characters can hide executable code from review (GlassWorm, Trojan Source).' +
            '\nRemove them, or - if a character is genuinely required - extend the exemptions in' +
            ' scripts/lib/invisible-unicode.mjs with a comment explaining why.'
        );
        return 1;
    }

    console.log(`No invisible Unicode characters found (${mode}: ${scanned} scanned, ${skipped} skipped as binary).`);
    return 0;
}

process.exitCode = main(process.argv.slice(2));
