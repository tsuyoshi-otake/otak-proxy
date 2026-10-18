#!/usr/bin/env node
/**
 * @file check-release-ref
 * @description Guards the publish workflow against releasing the wrong ref.
 *
 * A tag push is the only publish trigger. Before anything is built or published
 * this script verifies that:
 *   1. the triggering ref is a tag (`refs/tags/v<semver>` in GITHUB_REF; when
 *      GitHub sets it, GITHUB_REF_TYPE must also be `tag` - a branch named
 *      `v3.2.17` passes neither, unlike a bare GITHUB_REF_NAME),
 *   2. the tag name equals `v` + the `version` field of package.json, and
 *   3. the tagged commit is an ancestor of the main branch.
 *
 * Checks 1 and 2 are pure functions; the package version is injected so tests
 * need no repository files. Check 3 shells out through an injected `exec` so
 * the test suite can run it against a real temporary `git init` repository.
 *
 * Usage (CI):  node scripts/release/check-release-ref.mjs [mainRef]
 *   env: GITHUB_REF (refs/tags/vX.Y.Z), GITHUB_SHA (tagged commit),
 *        GITHUB_REF_TYPE (`tag` when set)
 *   optional argv[2]: ref to test ancestry against (default: origin/main;
 *   the workflow fetches `origin main` first so the ref exists)
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export class ReleaseRefError extends Error {
}

const TAG_PATTERN = /^refs\/tags\/v(\d+\.\d+\.\d+(?:-[-0-9A-Za-z.]+)?)$/;

/**
 * @param {string} ref full git ref from GITHUB_REF, e.g. `refs/tags/v3.2.16`
 * @param {string} [refType] GITHUB_REF_TYPE when set (`tag` on tag pushes)
 * @returns {string} the tag's version portion without the leading `v`
 */
export function versionFromTagRef(ref, refType) {
    if (!ref || typeof ref !== 'string') {
        throw new ReleaseRefError('Missing GITHUB_REF: the publish workflow only runs on tag pushes.');
    }
    if (refType !== undefined && refType !== 'tag') {
        throw new ReleaseRefError(`GITHUB_REF_TYPE is ${refType}, not tag; refusing to publish.`);
    }
    const match = TAG_PATTERN.exec(ref);
    if (!match) {
        throw new ReleaseRefError(
            `Ref ${ref} is not a refs/tags/v<semver> tag; the publish workflow only runs on release tag pushes.`
        );
    }
    return match[1];
}

/**
 * @param {string} ref full git ref
 * @param {string} packageVersion `version` field of package.json
 * @param {string} [refType]
 */
export function checkTagMatchesVersion(ref, packageVersion, refType) {
    const tagVersion = versionFromTagRef(ref, refType);
    if (tagVersion !== packageVersion) {
        throw new ReleaseRefError(
            `Tag v${tagVersion} does not match package.json version ${packageVersion}. ` +
            'Bump the version on main, then tag the merge commit.'
        );
    }
    return tagVersion;
}

/**
 * @param {(args: string[]) => void} exec runs `git <args>` in repoRoot, throws on non-zero exit
 * @param {string} commit tagged commit SHA
 * @param {string} branchRef ref the tagged commit must be an ancestor of
 */
export function checkTagOnMain(exec, commit, branchRef = 'origin/main') {
    if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) {
        throw new ReleaseRefError(`Missing or malformed commit SHA: ${JSON.stringify(commit)}`);
    }
    try {
        exec(['merge-base', '--is-ancestor', commit, branchRef]);
    } catch {
        throw new ReleaseRefError(
            `Tagged commit ${commit} is not reachable from ${branchRef}. ` +
            'Only commits merged to main may be released; delete the tag or merge first.'
        );
    }
}

function defaultExec(cwd) {
    return (args) => {
        execFileSync('git', args, { cwd, stdio: 'pipe' });
    };
}

function readPackageVersion() {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return packageJson.version;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, mainRef?: string, exec?: (args: string[]) => void,
 *           packageVersion?: string }} [options]
 */
export function run(options = {}) {
    const env = options.env ?? process.env;
    const exec = options.exec ?? defaultExec(repoRoot);
    const mainRef = options.mainRef ?? 'origin/main';
    const packageVersion = options.packageVersion ?? readPackageVersion();

    const tagVersion = checkTagMatchesVersion(env.GITHUB_REF ?? '', packageVersion, env.GITHUB_REF_TYPE);
    checkTagOnMain(exec, env.GITHUB_SHA ?? '', mainRef);

    console.log(`Release ref OK: tag v${tagVersion} on ${env.GITHUB_SHA} is reachable from ${mainRef}.`);
    return 0;
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
    try {
        const mainRef = process.argv[2] ?? 'origin/main';
        process.exitCode = run({ mainRef });
    } catch (error) {
        console.error(error instanceof ReleaseRefError ? error.message : error);
        process.exitCode = 1;
    }
}
