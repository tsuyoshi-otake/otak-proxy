import * as assert from 'node:assert';
import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ServerHits {
    get: number;
    connect: number;
    tcp: number;
}

interface ListeningHttp {
    url: string;
    hostPort: string;
    hits: ServerHits;
    close(): Promise<void>;
}

function emptyHits(): ServerHits {
    return { get: 0, connect: 0, tcp: 0 };
}

function gitEnv(gitconfig: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of [
        'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY',
        'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'
    ]) {
        delete env[name];
    }
    env.GIT_CONFIG_GLOBAL = gitconfig;
    env.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null';
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_SSL_NO_VERIFY = '1';
    return env;
}

async function writeGitConfig(gitconfig: string, values: Record<string, string>): Promise<void> {
    fs.writeFileSync(gitconfig, '', 'utf8');
    for (const [key, value] of Object.entries(values)) {
        await execFileAsync('git', ['config', '--global', key, value], {
            timeout: 8000,
            encoding: 'utf8',
            windowsHide: true,
            env: gitEnv(gitconfig)
        });
    }
}

async function gitLsRemote(remote: string, gitconfig: string): Promise<void> {
    try {
        await execFileAsync('git', ['-c', 'http.sslVerify=false', 'ls-remote', remote], {
            timeout: 8000,
            encoding: 'utf8',
            windowsHide: true,
            env: gitEnv(gitconfig)
        });
    } catch {
        // Routing is observed from sockets. Protocol/TLS failure after the
        // first hop is expected for dummy origins that return 404/407.
    }
}

function listenHttp(role: 'origin' | 'proxy'): Promise<ListeningHttp> {
    const hits = emptyHits();
    const sockets = new Set<Duplex>();
    const server = http.createServer((request, response) => {
        hits.get += 1;
        if (role === 'proxy') {
            response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="otak-proxy-test"' });
        } else {
            response.writeHead(404);
        }
        response.end();
    });
    server.on('connection', socket => {
        hits.tcp += 1;
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.on('connect', (_request, socket) => {
        hits.connect += 1;
        socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="otak-proxy-test"\r\n\r\n');
        socket.destroy();
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('expected TCP address'));
                return;
            }
            resolve({
                url: `http://127.0.0.1:${address.port}`,
                hostPort: `127.0.0.1:${address.port}`,
                hits,
                close: async () => {
                    for (const socket of sockets) {
                        socket.destroy();
                    }
                    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
                }
            });
        });
    });
}

function listenTlsOrigin(key: string, cert: string): Promise<ListeningHttp> {
    const hits = emptyHits();
    const sockets = new Set<Duplex>();
    const server = https.createServer({ key, cert }, (_request, response) => {
        hits.get += 1;
        response.writeHead(404);
        response.end();
    });
    server.on('connection', socket => {
        hits.tcp += 1;
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('expected TCP address'));
                return;
            }
            resolve({
                url: `https://127.0.0.1:${address.port}`,
                hostPort: `127.0.0.1:${address.port}`,
                hits,
                close: async () => {
                    for (const socket of sockets) {
                        socket.destroy();
                    }
                    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
                }
            });
        });
    });
}

function findOpenSsl(): string | undefined {
    const fromPath = process.platform === 'win32' ? 'openssl.exe' : 'openssl';
    const gitExe = process.env.GIT_EXEC_PATH;
    const candidates = [
        fromPath,
        path.join('C:', 'Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
        gitExe ? path.join(gitExe, '..', '..', 'usr', 'bin', 'openssl.exe') : undefined
    ].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
        try {
            const result = spawnSync(candidate, ['version'], { windowsHide: true, encoding: 'utf8' });
            if (result.status === 0) {
                return candidate;
            }
        } catch {
            // try the next candidate
        }
    }
    return undefined;
}

async function generateSelfSigned(directory: string): Promise<{ key: string; cert: string } | undefined> {
    const openssl = findOpenSsl();
    if (!openssl) {
        return undefined;
    }
    const keyPath = path.join(directory, 'key.pem');
    const certPath = path.join(directory, 'cert.pem');
    try {
        await execFileAsync(openssl, [
            'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
            '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1'
        ], { timeout: 15000, encoding: 'utf8', windowsHide: true });
        return {
            key: fs.readFileSync(keyPath, 'utf8'),
            cert: fs.readFileSync(certPath, 'utf8')
        };
    } catch {
        return undefined;
    }
}

async function gitAvailable(): Promise<boolean> {
    try {
        await execFileAsync('git', ['--version'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
        return true;
    } catch {
        return false;
    }
}

suite('Git HTTP stack routing (#55)', () => {
    test('http.proxy routes HTTP remotes; leftover https.proxy does not', async function() {
        if (!await gitAvailable()) {
            this.skip();
            return;
        }

        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-git-routing-'));
        const gitconfig = path.join(directory, 'gitconfig');
        const origin = await listenHttp('origin');
        const proxyA = await listenHttp('proxy');
        const proxyB = await listenHttp('proxy');
        const remote = `${origin.url}/repo.git`;

        try {
            await writeGitConfig(gitconfig, { 'http.proxy': proxyA.url });
            await gitLsRemote(remote, gitconfig);
            assert.ok(proxyA.hits.get > 0, 'HTTP remote + http.proxy must send GET to A');
            assert.strictEqual(origin.hits.get, 0, 'HTTP remote + http.proxy must not reach origin');
            assert.strictEqual(proxyB.hits.get, 0);
            assert.strictEqual(proxyB.hits.connect, 0);

            proxyA.hits.get = 0;
            proxyA.hits.connect = 0;
            origin.hits.get = 0;
            await writeGitConfig(gitconfig, { 'https.proxy': proxyA.url });
            await gitLsRemote(remote, gitconfig);
            assert.strictEqual(proxyA.hits.get, 0, 'HTTP remote + https.proxy only must not use the proxy');
            assert.strictEqual(proxyA.hits.connect, 0);
            assert.ok(origin.hits.get > 0, 'HTTP remote + https.proxy only goes DIRECT to origin');

            proxyA.hits.get = 0;
            origin.hits.get = 0;
            await writeGitConfig(gitconfig, { 'http.proxy': proxyA.url, 'https.proxy': proxyB.url });
            await gitLsRemote(remote, gitconfig);
            assert.ok(proxyA.hits.get > 0, 'split keys still route HTTP remotes through http.proxy');
            assert.strictEqual(proxyB.hits.get, 0, 'https.proxy B is unused for HTTP remotes');
            assert.strictEqual(proxyB.hits.connect, 0);
            assert.strictEqual(origin.hits.get, 0);
        } finally {
            await Promise.all([origin.close(), proxyA.close(), proxyB.close()]);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('http.proxy sends CONNECT for HTTPS remotes; https.proxy does not', async function() {
        if (!await gitAvailable()) {
            this.skip();
            return;
        }

        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-git-https-routing-'));
        const tls = await generateSelfSigned(directory);
        if (!tls) {
            this.skip();
            return;
        }

        const gitconfig = path.join(directory, 'gitconfig');
        const origin = await listenTlsOrigin(tls.key, tls.cert);
        const proxyA = await listenHttp('proxy');
        const proxyB = await listenHttp('proxy');
        const remote = `${origin.url}/repo.git`;

        try {
            await writeGitConfig(gitconfig, { 'http.proxy': proxyA.url, 'http.sslVerify': 'false' });
            await gitLsRemote(remote, gitconfig);
            assert.ok(proxyA.hits.connect > 0, 'HTTPS remote + http.proxy must CONNECT to A');
            assert.strictEqual(origin.hits.tcp, 0, 'CONNECT 407 must keep origin empty');
            assert.strictEqual(proxyB.hits.connect, 0);

            proxyA.hits.connect = 0;
            origin.hits.tcp = 0;
            origin.hits.get = 0;
            await writeGitConfig(gitconfig, { 'https.proxy': proxyA.url, 'http.sslVerify': 'false' });
            await gitLsRemote(remote, gitconfig);
            assert.strictEqual(proxyA.hits.connect, 0, 'HTTPS remote + https.proxy only must not CONNECT');
            assert.ok(origin.hits.tcp + origin.hits.get > 0, 'HTTPS remote + https.proxy only goes DIRECT to origin');

            proxyA.hits.connect = 0;
            origin.hits.tcp = 0;
            origin.hits.get = 0;
            await writeGitConfig(gitconfig, {
                'http.proxy': proxyA.url,
                'https.proxy': proxyB.url,
                'http.sslVerify': 'false'
            });
            await gitLsRemote(remote, gitconfig);
            assert.ok(proxyA.hits.connect > 0, 'split keys still CONNECT through http.proxy');
            assert.strictEqual(proxyB.hits.connect, 0, 'https.proxy B is unused for HTTPS remotes');
            assert.strictEqual(origin.hits.tcp, 0);
        } finally {
            await Promise.all([origin.close(), proxyA.close(), proxyB.close()]);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
