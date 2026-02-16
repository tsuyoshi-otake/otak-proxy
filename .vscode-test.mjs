import { defineConfig } from '@vscode/test-cli';
import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Support filtering tests via MOCHA_GREP environment variable
const mochaConfig = {
	// Enable parallel test execution for faster test runs
	// Note: Some tests may need to be marked as serial if they have shared state
	parallel: false, // Disabled for now due to VSCode extension context requirements
	timeout: 60000, // Increase timeout for property-based tests
	// Use environment variable to control test execution
	// CI: 100 runs per property test
	// Development: 10 runs per property test
};

// Add grep filter if MOCHA_GREP is set
if (process.env.MOCHA_GREP) {
	mochaConfig.grep = process.env.MOCHA_GREP;
}

// Avoid Windows "Error mutex already exists" by isolating user data / extensions per run.
// @vscode/test-electron defaults to a shared `.vscode-test/user-data` and `.vscode-test/extensions`
// which can collide if VS Code is still shutting down from a previous run.
const profileDir = join(tmpdir(), `otak-proxy-vscode-test-${process.pid}-${randomUUID()}`);
mkdirSync(profileDir, { recursive: true });

// Keep VS Code tests hermetic so they don't mutate the developer machine's global settings.
// Git: `git config --global` respects GIT_CONFIG_GLOBAL
// npm: `npm config` respects NPM_CONFIG_USERCONFIG
const sandboxConfigDir = join(profileDir, 'sandbox-config');
mkdirSync(sandboxConfigDir, { recursive: true });
const gitConfigGlobal = join(sandboxConfigDir, 'gitconfig');
const npmUserConfig = join(sandboxConfigDir, 'npmrc');
writeFileSync(gitConfigGlobal, '', { flag: 'a' });
writeFileSync(npmUserConfig, '', { flag: 'a' });

function envToRecord(env) {
	const out = {};
	for (const [k, v] of Object.entries(env)) {
		if (typeof v === 'string') out[k] = v;
	}
	return out;
}

const launchArgs = [
	`--user-data-dir=${join(profileDir, 'user-data')}`,
	`--extensions-dir=${join(profileDir, 'extensions')}`,
	'--new-window',
];

function walk(dir) {
	/** @type {string[]} */
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...walk(p));
		else out.push(p);
	}
	return out;
}

function isVscodeDependentTestFile(filePath) {
	const src = readFileSync(filePath, 'utf8');
	return (
		src.includes("require('vscode')") ||
		src.includes('require(\"vscode\")') ||
		src.includes("from 'vscode'") ||
		src.includes('from \"vscode\"')
	);
}

// Default: run only VS Code-dependent tests under the extension host.
// This keeps `npm test` fast and avoids running slow unit/property suites twice.
// Override with OTAK_PROXY_VSCODE_TEST_ALL=1 to run everything in VS Code.
let testFiles = 'out/test/**/*.test.js';
try {
	const outTestDir = join(process.cwd(), 'out', 'test');
	if (!process.env.OTAK_PROXY_VSCODE_TEST_ALL && statSync(outTestDir).isDirectory()) {
		const all = walk(outTestDir).filter(p => p.endsWith('.test.js'));
		const vscodeTests = all.filter(isVscodeDependentTestFile);
		testFiles = vscodeTests.length ? vscodeTests : testFiles;
	}
} catch {
	// Fall back to the default glob if build output isn't present yet.
}

export default defineConfig({
	files: testFiles,
	version: '1.106.3', // Use existing version to avoid network issues
	mocha: mochaConfig,
	launchArgs,
	env: {
		...envToRecord(process.env),
		GIT_CONFIG_GLOBAL: gitConfigGlobal,
		NPM_CONFIG_USERCONFIG: npmUserConfig,
	},
});
