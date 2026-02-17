function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (isRecord(error) && typeof error.message === 'string') {
        return error.message;
    }
    return String(error);
}

export function getErrorCode(error: unknown): string | number | undefined {
    if (!isRecord(error)) {
        return undefined;
    }
    const code = error.code;
    if (typeof code === 'string' || typeof code === 'number') {
        return code;
    }
    return undefined;
}

export function getErrorStderr(error: unknown): string {
    if (isRecord(error) && typeof error.stderr === 'string') {
        return error.stderr;
    }
    return '';
}

export function getErrorSignal(error: unknown): string | undefined {
    if (isRecord(error) && typeof error.signal === 'string') {
        return error.signal;
    }
    return undefined;
}

export function wasProcessKilled(error: unknown): boolean {
    if (isRecord(error) && typeof error.killed === 'boolean') {
        return error.killed;
    }
    return false;
}

