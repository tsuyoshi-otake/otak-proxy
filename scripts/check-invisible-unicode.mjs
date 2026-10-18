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
 * Every file is read. A file is skipped as binary only when its bytes carry the
 * signature of its extension (scripts/lib/binary-signature.mjs): require()
 * loads a file with any extension other than .json/.node as JavaScript, so an
 * extension alone must not end the check. A file that cannot be read, or a
 * directory entry that is not a regular file, fails the run. A file with an
 * unlisted extension, or a listed extension whose bytes do not match, is
 * decoded as UTF-8 and scanned whole - the c0-control category reports each
 * NUL with its location, so one NUL byte can no longer hide a payload behind a
 * "binary" skip. A run that ends up scanning zero files exits 1 in every mode:
 * a scanner that checked nothing must not pass the gate.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isVerifiedBinary } from './lib/binary-signature.mjs';
import { formatFinding, scanTextForInvisibleUnicode } from './lib/invisible-unicode.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/**
 * Collects regular files matching `predicate` into `collected`. An entry that
 * is neither a directory nor a regular file (symlink, FIFO, socket, device) is
 * collected into `nonRegular` instead of being dropped silently: the scanner
 * turns each one into a failure, because skipping it would let a crafted tree
 * hide a file from the scan.
 */
function walkDirectory(absoluteDir, predicate, collected, nonRegular) {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
        const absolute = path.join(absoluteDir, entry.name);
        if (entry.isDirectory()) {
            walkDirectory(absolute, predicate, collected, nonRegular);
        } else if (entry.isFile()) {
            if (predicate(absolute)) {
                collected.push(absolute);
            }
        } else {
            nonRegular.push(absolute);
        }
    }
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
    const nonRegular = [];

    for (const root of DIST_ROOTS) {
        const absolute = path.join(repoRoot, root);
        if (!fs.existsSync(absolute)) {
            throw new Error(`${root}/ does not exist - run "npm run compile" before scanning the dist artifacts.`);
        }
        walkDirectory(absolute, file => DIST_TEXT_EXTENSIONS.has(path.extname(file)), collected, nonRegular);
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

    return [
        ...collected.map(absolute => ({ absolute, label: toRepoLabel(absolute) })),
        ...nonRegular.map(absolute => ({ absolute, label: toRepoLabel(absolute), nonRegular: true }))
    ];
}

function listExplicitTargets(targets) {
    const collected = [];
    for (const target of targets) {
        const absolute = path.resolve(repoRoot, target);
        const label = toRepoLabel(absolute);
        let stat;
        try {
            stat = fs.statSync(absolute);
        } catch (error) {
            collected.push({ absolute, label, readError: error });
            continue;
        }
        if (stat.isDirectory()) {
            const files = [];
            const nonRegular = [];
            walkDirectory(absolute, () => true, files, nonRegular);
            for (const file of files) {
                collected.push({ absolute: file, label: toRepoLabel(file) });
            }
            for (const file of nonRegular) {
                collected.push({ absolute: file, label: toRepoLabel(file), nonRegular: true });
            }
        } else if (stat.isFile()) {
            collected.push({ absolute, label });
        } else {
            collected.push({ absolute, label, nonRegular: true });
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
    const files = [];
    const nonRegular = [];
    walkDirectory(absoluteDir, () => true, files, nonRegular);
    const labelOf = absolute => path.relative(absoluteDir, absolute).split(path.sep).join('/');
    return { entries: [
        ...files.map(absolute => ({ absolute, label: labelOf(absolute) })),
        ...nonRegular.map(absolute => ({ absolute, label: labelOf(absolute), nonRegular: true }))
    ] };
}

function scanFiles(entries, { repoMode }) {
    const findings = [];
    const failures = [];
    let scanned = 0;
    let binary = 0;
    let missing = 0;

    for (const { absolute, label, nonRegular, readError } of entries) {
        if (nonRegular) {
            failures.push({ label, detail: 'not a regular file' });
            continue;
        }
        if (readError) {
            failures.push({ label, detail: readError.code || readError.message });
            continue;
        }

        let buffer;
        try {
            buffer = fs.readFileSync(absolute);
        } catch (error) {
            // In repository mode a tracked file that is absent from the working
            // tree (deleted but not committed, outside a sparse checkout) is
            // missing, not a failure. Everywhere else a file that cannot be
            // read fails the run: the gate must not approve what it did not read.
            if (repoMode && error.code === 'ENOENT') {
                missing += 1;
                continue;
            }
            failures.push({ label, detail: error.code || error.message });
            continue;
        }

        // The extension is never trusted on its own: the buffer decides. When
        // the bytes carry the signature of the extension the file is a verified
        // binary; otherwise it is decoded as UTF-8 and scanned whole, and a NUL
        // byte is reported by the c0-control category like any other control
        // character.
        if (isVerifiedBinary(label, buffer)) {
            binary += 1;
            continue;
        }

        scanned += 1;
        for (const finding of scanTextForInvisibleUnicode(buffer.toString('utf8'))) {
            findings.push({ label, finding });
        }
    }

    return { findings, failures, scanned, binary, missing };
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

    // Repository mode (no flags) is the only mode where a candidate may be
    // absent by design: git ls-files lists tracked files that a sparse checkout
    // or an uncommitted delete can leave missing.
    const repoMode = dirTarget === undefined && explicitTargets.length === 0 && !distMode;
    const { findings, failures, scanned, binary, missing } = scanFiles(entries, { repoMode });
    let failed = false;

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
        failed = true;
    }

    if (failures.length > 0) {
        console.error(`Files that could not be scanned in ${mode}:\n`);
        for (const { label, detail } of failures) {
            console.error(`  ${label}: ${detail}`);
        }
        failed = true;
    }

    const counts =
        `${scanned} scanned, ${binary} binary (signature verified)` +
        (repoMode ? `, ${missing} missing` : '') +
        (failures.length > 0 ? `, ${failures.length} failed` : '');

    if (scanned === 0) {
        console.error(
            `No files were scanned (${mode}: ${counts}).` +
            '\nA scan that checks nothing must not pass; fix the file selection.'
        );
        failed = true;
    }

    if (failed) {
        return 1;
    }

    console.log(`No invisible Unicode characters found (${mode}: ${counts}).`);
    return 0;
}

process.exitCode = main(process.argv.slice(2));
