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
 *   node scripts/check-invisible-unicode.mjs --dir <path>  # every file under a directory (e.g. an unzipped VSIX)
 *
 * A file whose extension is not in BINARY_EXTENSIONS is scanned as UTF-8 text even
 * when it contains NUL bytes - the c0-control category reports each NUL with its
 * location, so one NUL byte can no longer hide a payload behind a "binary" skip.
 * A run that ends up scanning zero files exits 1 in every mode: a scanner that
 * checked nothing must not pass the gate.
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

const USAGE =
    'Usage: node scripts/check-invisible-unicode.mjs [--dist | --dir <path> | <path>...]\n' +
    '  no flags        every git-tracked and new non-ignored file\n' +
    '  --dist          the compiled artifacts that ship in the VSIX\n' +
    '  --dir <path>    every file under a directory (e.g. an unzipped VSIX)\n' +
    '  <path>...       explicit files or directories, relative to the repository root\n' +
    '--dir cannot be combined with --dist or explicit paths.';

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
            collected.push(absolute);
        }
    }
    return collected;
}

function toRepoLabel(absolute) {
    return path.relative(repoRoot, absolute).split(path.sep).join('/');
}

function repoEntries(relativePaths) {
    return relativePaths.map(relative => ({
        absolute: path.join(repoRoot, relative),
        label: relative
    }));
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
        const absolute = path.join(repoRoot, file);
        if (fs.existsSync(absolute)) {
            collected.push(absolute);
        }
    }

    // Localized manifest strings are generated, so they ship without ever being reviewed.
    for (const entry of fs.readdirSync(repoRoot)) {
        if (/^package\.nls.*\.json$/.test(entry)) {
            collected.push(path.join(repoRoot, entry));
        }
    }

    return collected.map(absolute => ({ absolute, label: toRepoLabel(absolute) }));
}

function listExplicitTargets(targets) {
    const collected = [];
    for (const target of targets) {
        const absolute = path.resolve(repoRoot, target);
        const stat = fs.statSync(absolute);
        if (stat.isDirectory()) {
            for (const file of walkDirectory(absolute, () => true, [])) {
                collected.push({ absolute: file, label: toRepoLabel(file) });
            }
        } else {
            collected.push({ absolute, label: toRepoLabel(absolute) });
        }
    }
    return collected;
}

/**
 * Every file under an arbitrary directory - typically an unzipped VSIX, which sits
 * outside the repository. Labels are relative to the scanned directory so findings
 * read like paths inside the package.
 */
function listDirTargets(dir) {
    const absoluteDir = path.resolve(dir);
    let stat;
    try {
        stat = fs.statSync(absoluteDir);
    } catch {
        return { error: `--dir target does not exist: ${dir}` };
    }
    if (!stat.isDirectory()) {
        return { error: `--dir target is not a directory: ${dir}` };
    }
    return { entries: walkDirectory(absoluteDir, () => true, []).map(absolute => ({
        absolute,
        label: path.relative(absoluteDir, absolute).split(path.sep).join('/')
    })) };
}

function scanFiles(entries) {
    const findings = [];
    let scanned = 0;
    let skipped = 0;
    let unreadable = 0;

    for (const { absolute, label } of entries) {
        if (BINARY_EXTENSIONS.has(path.extname(label).toLowerCase())) {
            skipped += 1;
            continue;
        }

        let buffer;
        try {
            buffer = fs.readFileSync(absolute);
        } catch {
            // Tracked but absent locally (sparse checkout, deleted-not-committed).
            unreadable += 1;
            continue;
        }

        // No "binary" shortcut: the buffer is decoded as UTF-8 and scanned whole.
        // A NUL byte is reported by the c0-control category like any other control
        // character, and the rest of the file is still scanned.
        scanned += 1;
        for (const finding of scanTextForInvisibleUnicode(buffer.toString('utf8'))) {
            findings.push({ label, finding });
        }
    }

    return { findings, scanned, skipped, unreadable };
}

function usageError(message) {
    console.error(`${message}\n\n${USAGE}`);
    return 2;
}

function main(argv) {
    let distMode = false;
    /** @type {string | undefined} */
    let dirTarget;
    const explicitTargets = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dist') {
            distMode = true;
        } else if (arg === '--dir') {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                return usageError('--dir requires a directory path.');
            }
            dirTarget = next;
            i += 1;
        } else if (arg.startsWith('--')) {
            return usageError(`Unknown option: ${arg}`);
        } else {
            explicitTargets.push(arg);
        }
    }

    if (dirTarget !== undefined && (distMode || explicitTargets.length > 0)) {
        return usageError('--dir cannot be combined with --dist or explicit paths.');
    }
    if (distMode && explicitTargets.length > 0) {
        return usageError('--dist cannot be combined with explicit paths.');
    }

    let mode;
    /** @type {{ absolute: string, label: string }[]} */
    let entries;
    if (dirTarget !== undefined) {
        const result = listDirTargets(dirTarget);
        if (result.error) {
            return usageError(result.error);
        }
        mode = `directory ${path.resolve(dirTarget)}`;
        entries = result.entries;
    } else if (explicitTargets.length > 0) {
        mode = 'explicit paths';
        entries = listExplicitTargets(explicitTargets);
    } else if (distMode) {
        mode = 'shipped artifacts';
        entries = listDistFiles();
    } else {
        mode = 'repository files';
        entries = repoEntries(listCandidateFiles());
    }

    const { findings, scanned, skipped, unreadable } = scanFiles(entries);

    if (findings.length > 0) {
        console.error(`Invisible Unicode characters detected in ${mode}:\n`);
        for (const { label, finding } of findings) {
            console.error(`  ${formatFinding(finding, label)}`);
        }
        console.error(
            `\n${findings.length} occurrence(s) in ${new Set(findings.map(f => f.label)).size} file(s).` +
            '\nInvisible characters can hide executable code from review (GlassWorm, Trojan Source).' +
            '\nRemove them, or - if a character is genuinely required - extend the exemptions in' +
            ' scripts/lib/invisible-unicode.mjs with a comment explaining why.'
        );
        return 1;
    }

    if (scanned === 0) {
        console.error(
            `No files were scanned (${mode}: 0 scanned, ${skipped} skipped by extension, ${unreadable} unreadable).` +
            '\nA scan that checks nothing must not pass; fix the file selection.'
        );
        return 1;
    }

    console.log(`No invisible Unicode characters found (${mode}: ${scanned} scanned, ${skipped} skipped by extension, ${unreadable} unreadable).`);
    return 0;
}

process.exitCode = main(process.argv.slice(2));
