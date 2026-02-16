/**
 * Unit tests for SyncStatusProvider
 * Feature: multi-instance-sync
 * Requirements: 6.1, 6.2, 6.3, 6.4
 *
 * TDD: Tests for sync status display
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { SyncStatusProvider, ISyncStatusProvider } from '../../sync/SyncStatusProvider';
import { SyncStatus } from '../../sync/SyncManager';

suite('SyncStatusProvider Unit Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let statusProvider: SyncStatusProvider;

    setup(() => {
        sandbox = sinon.createSandbox();
        statusProvider = new SyncStatusProvider();
    });

    teardown(() => {
        sandbox.restore();
        statusProvider.dispose();
    });

    /**
     * Requirement 6.1: Sync icon when multiple instances detected
     */
    suite('Multiple Instance Display (Requirement 6.1)', () => {
        test('should show sync icon when multiple instances connected', () => {
            const status: SyncStatus = {
                enabled: true,
                activeInstances: 2,
                lastSyncTime: Date.now(),
                lastError: null,
                isSyncing: false
            };

            statusProvider.update(status);
            const displayState = statusProvider.getDisplayState();

            assert.ok(displayState);
            assert.strictEqual(displayState!.visible, true);
            assert.ok(displayState!.icon.includes('sync'));
        });

        test('should hide sync icon when single instance', () => {
            const status: SyncStatus = {
                enabled: true,
                activeInstances: 1,
                lastSyncTime: Date.now(),
                lastError: null,
                isSyncing: false
            };

            statusProvider.update(status);
            const displayState = statusProvider.getDisplayState();

            assert.ok(displayState);
            assert.strictEqual(displayState!.visible, false);
        });
    });

    /**
     * Requirement 6.2: Visual indicator during sync
     */
    suite('Syncing Indicator (Requirement 6.2)', () => {
        test('should show spinning icon when syncing', () => {
            const status: SyncStatus = {
                enabled: true,
                activeInstances: 2,
                lastSyncTime: Date.now(),
                lastError: null,
                isSyncing: true
            };

            statusProvider.update(status);
            const displayState = statusProvider.getDisplayState();

            assert.ok(displayState);
            assert.ok(displayState!.icon.includes('spin'), 'Should show spinning icon');
            assert.strictEqual(displayState!.visible, true);
        });

        test('should stop spinning when sync completes', () => {
            // First, show syncing state
            statusProvider.update({
                enabled: true,
                activeInstances: 2,
                lastSyncTime: Date.now(),
                lastError: null,
                isSyncing: true
            });

            // Then update to synced state
            statusProvider.update({
                enabled: true,
                activeInstances: 2,
                lastSyncTime: Date.now(),
                lastError: null,
                isSyncing: false
            });

            const displayState = statusProvider.getDisplayState();
            assert.ok(!displayState!.icon.includes('spin'), 'Should not show spinning icon');
        });
    });

    /**
     * Requirement 6.3: Warning on sync errors
     */
    suite('Error Display (Requirement 6.3)', () => {
        test('should show error icon when sync error occurs', () => {
            const status: SyncStatus = {
                enabled: true,
                activeInstances: 1,
                lastSyncTime: Date.now(),
                lastError: 'Connection failed',
                isSyncing: false
            };

            statusProvider.update(status);
            const displayState = statusProvider.getDisplayState();

            assert.ok(displayState);
            assert.strictEqual(displayState!.visible, true);
            assert.ok(displayState!.icon.includes('ignored'), 'Should show error icon');
            assert.ok(displayState!.backgroundColor, 'Should have warning background');
        });

        test('should include error message in tooltip', () => {
            const status: SyncStatus = {
                enabled: true,
                activeInstances: 1,
                lastSyncTime: Date.now(),
                lastError: 'File access denied',
                isSyncing: false
            };

            statusProvider.update(status);
            const displayState = statusProvider.getDisplayState();

            // Tooltip should include the underlying error message regardless of localization.
            assert.ok(status.lastError !== null && displayState!.tooltip.includes(status.lastError));
        });
    });

    /**
     * Requirement 6.4: Detailed status on click
     */
    suite('Detailed Status (Requirement 6.4)', () => {
        test('should have tooltip with instance count', () => {
            const status: SyncStatus = {
                enabled: true,
                activeInstances: 3,
                lastSyncTime: Date.now(),
                lastError: null,
                isSyncing: false
            };

            statusProvider.update(status);
            const displayState = statusProvider.getDisplayState();

            assert.ok(displayState);
            // Tooltip should mention the count
            assert.ok(
                displayState!.tooltip.includes('3') ||
                displayState!.tooltip.includes('instance'),
                'Tooltip should mention instance count'
            );
        });
    });

    /**
     * Standalone mode
     */
    suite('Standalone Mode', () => {
        test('should hide when sync is disabled', () => {
            const status: SyncStatus = {
                enabled: false,
                activeInstances: 0,
                lastSyncTime: null,
                lastError: null,
                isSyncing: false
            };

            statusProvider.update(status);
            const displayState = statusProvider.getDisplayState();

            assert.ok(displayState);
            assert.strictEqual(displayState!.visible, false);
        });
    });

    /**
     * Show/Hide methods
     */
    suite('Show/Hide Methods', () => {
        test('should support explicit show/hide', () => {
            // Should not throw
            statusProvider.show();
            statusProvider.hide();
            assert.ok(true);
        });
    });

    /**
     * Dispose
     */
    suite('Dispose', () => {
        test('should dispose without error', () => {
            // Should not throw
            statusProvider.dispose();
            assert.ok(true);
        });
    });
});
