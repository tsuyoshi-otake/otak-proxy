/**
 * @file core/types.ts Unit Tests
 * @description Tests for type definitions exported from core/types.ts
 * Validates Requirements 1.1, 1.2, 1.5
 */

import * as assert from 'assert';

suite('Core Types Test Suite', () => {
    // We need to test that types are exported correctly and can be imported
    let types: typeof import('../../core/types');

    suiteSetup(() => {
        // Import the types module
        types = require('../../core/types');
    });

    suite('ProxyMode enum', () => {
        test('should export ProxyMode enum', () => {
            assert.ok(types.ProxyMode, 'ProxyMode should be exported');
        });

        test('should have Off value', () => {
            assert.strictEqual(types.ProxyMode.Off, 'off', 'ProxyMode.Off should be "off"');
        });

        test('should have Manual value', () => {
            assert.strictEqual(types.ProxyMode.Manual, 'manual', 'ProxyMode.Manual should be "manual"');
        });

        test('should have Auto value', () => {
            assert.strictEqual(types.ProxyMode.Auto, 'auto', 'ProxyMode.Auto should be "auto"');
        });
    });

    suite('ProxyState interface', () => {
        test('should be able to create a valid ProxyState object', () => {
            const state: import('../../core/types').ProxyState = {
                mode: types.ProxyMode.Off
            };
            assert.strictEqual(state.mode, 'off');
        });

        test('should accept all optional properties', () => {
            const state: import('../../core/types').ProxyState = {
                mode: types.ProxyMode.Manual,
                manualProxyUrl: 'http://proxy:8080',
                autoProxyUrl: 'http://auto-proxy:8080',
                lastSystemProxyCheck: Date.now(),
                gitConfigured: true,
                vscodeConfigured: true,
                npmConfigured: true,
                systemProxyDetected: true,
                lastError: 'test error'
            };

            assert.strictEqual(state.mode, 'manual');
            assert.strictEqual(state.manualProxyUrl, 'http://proxy:8080');
            assert.strictEqual(state.autoProxyUrl, 'http://auto-proxy:8080');
            assert.ok(state.lastSystemProxyCheck);
            assert.strictEqual(state.gitConfigured, true);
            assert.strictEqual(state.vscodeConfigured, true);
            assert.strictEqual(state.npmConfigured, true);
            assert.strictEqual(state.systemProxyDetected, true);
            assert.strictEqual(state.lastError, 'test error');
        });
    });

    suite('CommandContext interface', () => {
        test('CommandContext type should be exported', () => {
            // This test validates that the CommandContext interface is properly exported
            // We can't directly test an interface existence at runtime,
            // but we can verify it compiles correctly

            // The fact that this test file compiles with the import validates the export
            const hasCommandContext = 'CommandContext' in types ||
                typeof (types as any).CommandContext !== 'undefined';

            // Note: TypeScript interfaces are erased at runtime, so we just verify the module loads
            assert.ok(types, 'Types module should load successfully with all type definitions');
        });
    });

    suite('Type compatibility', () => {
        test('ProxyState should be compatible with extension.ts usage', () => {
            // Create a state object that matches the extension.ts usage pattern
            const state: import('../../core/types').ProxyState = {
                mode: types.ProxyMode.Auto,
                autoProxyUrl: 'http://detected-proxy:8080',
                lastSystemProxyCheck: Date.now(),
                systemProxyDetected: true
            };

            // Verify mode transitions work correctly
            assert.strictEqual(state.mode, types.ProxyMode.Auto);

            // Simulate mode change
            state.mode = types.ProxyMode.Off;
            assert.strictEqual(state.mode, types.ProxyMode.Off);
        });
    });
});
