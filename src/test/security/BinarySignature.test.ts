import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

/**
 * Tests for the binary-signature check behind the scanner's binary skip.
 *
 * The module is plain ESM under scripts/lib/ rather than TypeScript under
 * src/, because the scanner has to run before `tsc` does (see
 * InvisibleUnicode.test.ts for the same pattern).
 */

type IsVerifiedBinaryFn = (fileName: string, buffer: Buffer) => boolean;

let isVerifiedBinary: IsVerifiedBinaryFn;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mp3WithZeroRun(zeros: number): Buffer {
    return Buffer.concat([Buffer.alloc(zeros), Buffer.from([0xff, 0xfb, 0x80, 0x00])]);
}

function mp3WithId3(major: number): Buffer {
    return Buffer.from([0x49, 0x44, 0x33, major, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00]);
}

suite('binary signature check', () => {
    suiteSetup(async () => {
        const moduleSpecifier = pathToFileURL(
            path.resolve(__dirname, '../../..', 'scripts/lib/binary-signature.mjs')
        ).href;
        const module = await import(moduleSpecifier);
        isVerifiedBinary = module.isVerifiedBinary;
    });

    test('recognizes a real PNG signature', () => {
        assert.strictEqual(isVerifiedBinary('icon.png', Buffer.concat([PNG, Buffer.from([0x00, 0x1b])])), true);
        assert.strictEqual(isVerifiedBinary('ICON.PNG', PNG), true);
    });

    test('recognizes MP3 forms: zero run + frame sync, bare frame sync, ID3v2', () => {
        assert.strictEqual(isVerifiedBinary('a.mp3', mp3WithZeroRun(365)), true);
        assert.strictEqual(isVerifiedBinary('a.mp3', Buffer.from([0xff, 0xfb, 0x80, 0x00])), true);
        for (const major of [2, 3, 4]) {
            assert.strictEqual(isVerifiedBinary('a.mp3', mp3WithId3(major)), true, `ID3v2.${major}`);
        }
    });

    test('rejects mismatched bytes and unknown or absent extensions', () => {
        assert.strictEqual(isVerifiedBinary('fake.png', Buffer.from([0x00, 0x50, 0x4e, 0x47])), false);
        assert.strictEqual(isVerifiedBinary('x.gif', Buffer.from('GIF89a=1;\n', 'utf8')), false);
        assert.strictEqual(isVerifiedBinary('payload.mp3', Buffer.from('const a = 1;\n', 'utf8')), false);
        // ID3v1 and ID3v5 are not in the accepted major range.
        assert.strictEqual(isVerifiedBinary('a.mp3', mp3WithId3(1)), false);
        assert.strictEqual(isVerifiedBinary('a.mp3', mp3WithId3(5)), false);
        // Truncated signatures must not crash or match.
        assert.strictEqual(isVerifiedBinary('a.mp3', Buffer.from([0xff])), false);
        assert.strictEqual(isVerifiedBinary('a.mp3', Buffer.alloc(0)), false);
        // .png bytes under another extension do not skip either.
        assert.strictEqual(isVerifiedBinary('a.jpg', PNG), false);
    });

    test('every listed signature makes the file invalid JavaScript for require()', () => {
        // This pins the signature-table rule: a file that isVerifiedBinary
        // accepts must throw a SyntaxError under require(), so a payload cannot
        // ride inside a skipped "binary". A future signature that could open a
        // comment or string before its checked byte turns this test red.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-binsig-'));
        try {
            const variants: Array<[string, Buffer]> = [
                ['v.png', PNG],
                ['zero-run.mp3', mp3WithZeroRun(365)],
                ['sync.mp3', Buffer.from([0xff, 0xfb])],
                ['id3v2.mp3', mp3WithId3(2)],
                ['id3v3.mp3', mp3WithId3(3)],
                ['id3v4.mp3', mp3WithId3(4)]
            ];
            for (const [name, signature] of variants) {
                const file = path.join(dir, name);
                fs.writeFileSync(file, Buffer.concat([signature, Buffer.from('=1;module.exports=1;', 'utf8')]));
                assert.throws(
                    () => require(file),
                    (error: unknown) => error instanceof SyntaxError,
                    `require() must reject ${name}`
                );
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
