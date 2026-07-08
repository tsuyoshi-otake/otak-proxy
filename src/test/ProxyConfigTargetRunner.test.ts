import * as assert from 'assert';
import { updateProxyConfigTarget } from '../core/ProxyConfigTargetRunner';
import { ProxyConfigTarget } from '../core/ProxyApplierTypes';
import { ErrorAggregator } from '../errors/ErrorAggregator';

suite('ProxyConfigTargetRunner Test Suite', () => {
    const proxyUrl = 'http://proxy.example.com:8080';

    function createTarget(
        name: string,
        result: { success: boolean; error?: string; errorType?: string }
    ): ProxyConfigTarget {
        return {
            name,
            manager: {
                setProxy: async () => result,
                unsetProxy: async () => result
            }
        };
    }

    test('should skip missing Git instead of aggregating an error', async () => {
        const aggregator = new ErrorAggregator();
        const target = createTarget('Git configuration', {
            success: false,
            error: 'Git is not installed or not in PATH',
            errorType: 'NOT_INSTALLED'
        });

        const success = await updateProxyConfigTarget(target, true, proxyUrl, aggregator);

        assert.strictEqual(success, true);
        assert.strictEqual(aggregator.hasErrors(), false);
    });

    test('should skip missing npm instead of aggregating an error', async () => {
        const aggregator = new ErrorAggregator();
        const target = createTarget('npm configuration', {
            success: false,
            error: 'npm is not installed or not in PATH',
            errorType: 'NOT_INSTALLED'
        });

        const success = await updateProxyConfigTarget(target, true, proxyUrl, aggregator);

        assert.strictEqual(success, true);
        assert.strictEqual(aggregator.hasErrors(), false);
    });

    test('should skip missing pip instead of aggregating an error', async () => {
        const aggregator = new ErrorAggregator();
        const target = createTarget('pip configuration', {
            success: false,
            error: 'pip is not installed or Python is not in PATH',
            errorType: 'NOT_INSTALLED'
        });

        const success = await updateProxyConfigTarget(target, true, proxyUrl, aggregator);

        assert.strictEqual(success, true);
        assert.strictEqual(aggregator.hasErrors(), false);
    });

    test('should keep real npm configuration failures as errors', async () => {
        const aggregator = new ErrorAggregator();
        const target = createTarget('npm configuration', {
            success: false,
            error: 'Failed to read/write npm configuration',
            errorType: 'CONFIG_ERROR'
        });

        const success = await updateProxyConfigTarget(target, true, proxyUrl, aggregator);

        assert.strictEqual(success, false);
        assert.strictEqual(aggregator.hasErrors(), true);
        assert.deepStrictEqual(aggregator.getErrors(), [{
            operation: 'npm configuration',
            error: 'Failed to read/write npm configuration'
        }]);
    });

    test('should keep real pip configuration failures as errors', async () => {
        const aggregator = new ErrorAggregator();
        const target = createTarget('pip configuration', {
            success: false,
            error: 'Failed to read/write pip configuration',
            errorType: 'CONFIG_ERROR'
        });

        const success = await updateProxyConfigTarget(target, true, proxyUrl, aggregator);

        assert.strictEqual(success, false);
        assert.strictEqual(aggregator.hasErrors(), true);
        assert.deepStrictEqual(aggregator.getErrors(), [{
            operation: 'pip configuration',
            error: 'Failed to read/write pip configuration'
        }]);
    });

    test('should not skip NOT_INSTALLED for non-optional targets', async () => {
        const aggregator = new ErrorAggregator();
        const target = createTarget('VSCode configuration', {
            success: false,
            error: 'VS Code settings backend is not installed',
            errorType: 'NOT_INSTALLED'
        });

        const success = await updateProxyConfigTarget(target, true, proxyUrl, aggregator);

        assert.strictEqual(success, false);
        assert.strictEqual(aggregator.hasErrors(), true);
    });
});
