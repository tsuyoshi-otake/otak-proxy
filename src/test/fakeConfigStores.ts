/**
 * In-memory stand-ins for the external CLIs this extension writes through.
 *
 * A stub that answers `{ stdout: '', stderr: '' }` to every invocation cannot
 * distinguish a write that landed from one the tool silently discarded, so it
 * cannot exercise the write-verification post-conditions added in #73. These
 * fakes keep the state the real tool would keep: a `set` persists, a read
 * reports what was persisted, and an unset key reads back the way the real tool
 * reports a missing key.
 *
 * Each factory returns the runner plus direct access to the stored values so a
 * test can assert on the resulting configuration as well as on the argv.
 */

type CommandRunner = (
    command: string,
    args: string[],
    options?: unknown
) => Promise<{ stdout: string; stderr: string }>;

export type FakeGitProxyKey = 'http.proxy' | 'https.proxy';

export interface FakeGitConfig {
    runner: CommandRunner;
    get(key: FakeGitProxyKey): string | null;
    set(key: FakeGitProxyKey, value: string): void;
}

/**
 * A `git config --global` store limited to the two proxy keys.
 *
 * Supports the argv shapes GitConfigManager actually issues:
 * `--replace-all`, `--get-all`, `--get-regexp`, `--unset` and `--unset-all`.
 */
export function createFakeGitConfig(initial: Partial<Record<FakeGitProxyKey, string>> = {}): FakeGitConfig {
    const store = new Map<FakeGitProxyKey, string>(
        Object.entries(initial).filter(([, value]) => typeof value === 'string') as Array<[FakeGitProxyKey, string]>
    );

    const proxyKeyOf = (args: string[]): FakeGitProxyKey | undefined =>
        (['http.proxy', 'https.proxy'] as const).find(key => args.includes(key));

    const runner: CommandRunner = async (_command, args) => {
        const key = proxyKeyOf(args);

        if (args.includes('--replace-all') && key) {
            // The value is the argv element right after the key.
            store.set(key, args[args.indexOf(key) + 1]);
            return { stdout: '', stderr: '' };
        }

        if (args.includes('--get-all') && key) {
            const value = store.get(key);
            if (value === undefined) {
                throw gitExitCode(1);
            }
            return { stdout: `${value}\n`, stderr: '' };
        }

        if (args.includes('--get-regexp')) {
            const lines = [...store.entries()].map(([name, value]) => `${name} ${value}`);
            if (lines.length === 0) {
                throw gitExitCode(1);
            }
            return { stdout: `${lines.join('\n')}\n`, stderr: '' };
        }

        if ((args.includes('--unset') || args.includes('--unset-all')) && key) {
            if (!store.delete(key)) {
                // git reports "you try to unset an option which does not exist".
                throw gitExitCode(5);
            }
            return { stdout: '', stderr: '' };
        }

        return { stdout: '', stderr: '' };
    };

    return {
        runner,
        get: key => store.get(key) ?? null,
        set: (key, value) => {
            store.set(key, value);
        }
    };
}

export type FakeNpmProxyKey = 'proxy' | 'https-proxy';

export interface FakeNpmConfig {
    runner: CommandRunner;
    get(key: FakeNpmProxyKey): string | null;
    set(key: FakeNpmProxyKey, value: string): void;
}

/**
 * An `npm config` store limited to the two proxy keys.
 *
 * An unset key reads back as `null`, which is what npm itself prints.
 */
export function createFakeNpmConfig(initial: Partial<Record<FakeNpmProxyKey, string>> = {}): FakeNpmConfig {
    const store = new Map<FakeNpmProxyKey, string>(
        Object.entries(initial).filter(([, value]) => typeof value === 'string') as Array<[FakeNpmProxyKey, string]>
    );

    const proxyKeyOf = (args: string[]): FakeNpmProxyKey | undefined =>
        (['proxy', 'https-proxy'] as const).find(key => args.includes(key));

    const runner: CommandRunner = async (_command, args) => {
        const key = proxyKeyOf(args);
        if (!key) {
            return { stdout: '', stderr: '' };
        }

        if (args.includes('set')) {
            store.set(key, args[args.indexOf(key) + 1]);
            return { stdout: '', stderr: '' };
        }

        if (args.includes('delete')) {
            store.delete(key);
            return { stdout: '', stderr: '' };
        }

        if (args.includes('get')) {
            return { stdout: `${store.get(key) ?? 'null'}\n`, stderr: '' };
        }

        return { stdout: '', stderr: '' };
    };

    return {
        runner,
        get: key => store.get(key) ?? null,
        set: (key, value) => {
            store.set(key, value);
        }
    };
}

export interface FakePipConfig {
    runner: CommandRunner;
    get(): string | null;
    set(value: string): void;
}

/**
 * A `pip config --user` store for the single `global.proxy` key.
 *
 * Reading an unset key fails the way pip fails: exit 1 with `No such key`.
 */
export function createFakePipConfig(initial: string | null = null): FakePipConfig {
    let stored = initial;

    const runner: CommandRunner = async (_command, args) => {
        if (args.includes('get')) {
            if (stored === null) {
                throw pipNoSuchKey();
            }
            return { stdout: `${stored}\n`, stderr: '' };
        }

        if (args.includes('unset')) {
            if (stored === null) {
                throw pipNoSuchKey();
            }
            stored = null;
            return { stdout: '', stderr: '' };
        }

        stored = args[args.length - 1];
        return { stdout: 'Writing to user config\n', stderr: '' };
    };

    return {
        runner,
        get: () => stored,
        set: value => {
            stored = value;
        }
    };
}

function gitExitCode(code: number): Error & { code: number; stdout: string; stderr: string } {
    return Object.assign(new Error(`git exited with code ${code}`), { code, stdout: '', stderr: '' });
}

function pipNoSuchKey(): Error & { code: number; stdout: string; stderr: string } {
    return Object.assign(new Error('Command failed: pip config --user get global.proxy'), {
        code: 1,
        stdout: '',
        stderr: 'ERROR: No such key - global.proxy'
    });
}
