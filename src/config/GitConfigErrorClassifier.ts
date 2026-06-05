import {
    getErrorCode,
    getErrorMessage,
    getErrorSignal,
    getErrorStderr,
    wasProcessKilled
} from '../utils/ErrorUtils';
import {
    getLockedConfigPath,
    isGitConfigLockError,
    isGitConfigMutexTimeout
} from './GitConfigLocking';
import { OperationResult } from './GitConfigTypes';

interface GitErrorDetails {
    errorMessage: string;
    stderr: string;
    code: unknown;
    signal: unknown;
    killed: boolean;
}

type GitErrorClassification = Pick<OperationResult, 'errorType'> & { error: string };
type GitErrorClassifier = (error: unknown, details: GitErrorDetails) => GitErrorClassification | null;

export function classifyGitConfigError(error: unknown, timeoutMs: number): GitErrorClassification {
    const details = getErrorDetails(error);
    const classifiers: GitErrorClassifier[] = [
        (_rawError, data) => classifyGitMissing(data),
        (rawError) => classifyGitMutexTimeout(rawError),
        (rawError, data) => classifyGitLock(rawError, data),
        (_rawError, data) => classifyGitPermission(data),
        (_rawError, data) => classifyGitTimeout(data, timeoutMs)
    ];

    for (const classifier of classifiers) {
        const classification = classifier(error, details);
        if (classification) {
            return classification;
        }
    }

    return { errorType: 'UNKNOWN', error: details.errorMessage };
}

function getErrorDetails(error: unknown): GitErrorDetails {
    return {
        errorMessage: getErrorMessage(error),
        stderr: getErrorStderr(error),
        code: getErrorCode(error),
        signal: getErrorSignal(error),
        killed: wasProcessKilled(error)
    };
}

function classifyGitMissing(details: GitErrorDetails): GitErrorClassification | null {
    return details.code === 'ENOENT' ||
        details.errorMessage.includes('ENOENT') ||
        details.errorMessage.includes('not found')
        ? { errorType: 'NOT_INSTALLED', error: 'Git is not installed or not in PATH' }
        : null;
}

function classifyGitMutexTimeout(error: unknown): GitErrorClassification | null {
    return isGitConfigMutexTimeout(error)
        ? {
            errorType: 'LOCKED',
            error: 'Git configuration is already being updated by another VS Code/Cursor window. Please wait a few seconds and try again.'
        }
        : null;
}

function classifyGitLock(error: unknown, details: GitErrorDetails): GitErrorClassification | null {
    if (!isGitConfigLockError(error)) {
        return null;
    }

    const lockedConfigPath = getLockedConfigPath(error);
    const lockHint = lockedConfigPath ? ` (lock: ${lockedConfigPath}.lock)` : '';
    return {
        errorType: 'LOCKED',
        error: `Git config file is locked by another process${lockHint}. ${details.errorMessage}`
    };
}

function classifyGitPermission(details: GitErrorDetails): GitErrorClassification | null {
    return details.code === 'EACCES' ||
        details.errorMessage.includes('EACCES') ||
        details.stderr.includes('Permission denied') ||
        details.stderr.includes('permission')
        ? { errorType: 'NO_PERMISSION', error: 'Permission denied when accessing Git configuration' }
        : null;
}

function classifyGitTimeout(details: GitErrorDetails, timeoutMs: number): GitErrorClassification | null {
    return details.killed ||
        details.errorMessage.includes('timeout') ||
        details.signal === 'SIGTERM'
        ? { errorType: 'TIMEOUT', error: `Git command timed out after ${timeoutMs}ms` }
        : null;
}
