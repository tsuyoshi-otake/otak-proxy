import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	version: '1.106.3', // Use existing version to avoid network issues
	mocha: {
		// Enable parallel test execution for faster test runs
		// Note: Some tests may need to be marked as serial if they have shared state
		parallel: false, // Disabled for now due to VSCode extension context requirements
		timeout: 60000, // Increase timeout for property-based tests
		// Use environment variable to control test execution
		// CI: 100 runs per property test
		// Development: 10 runs per property test
	}
});
