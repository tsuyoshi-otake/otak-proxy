import { defineConfig } from '@vscode/test-cli';

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

export default defineConfig({
	files: 'out/test/**/*.test.js',
	version: '1.106.3', // Use existing version to avoid network issues
	mocha: mochaConfig
});
