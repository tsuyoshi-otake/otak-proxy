import * as assert from 'assert';
import * as path from 'path';
import { pathToFileURL } from 'url';

/**
 * Tests for the GlassWorm invisible-Unicode detector.
 *
 * The detector is plain ESM under scripts/lib/ rather than TypeScript under src/,
 * because both consumers (the ESLint rule and the CI scanner) have to run before
 * `tsc` does. It is imported dynamically here so the compiled CommonJS test can
 * still load an ESM module.
 *
 * Fixtures are built with String.fromCodePoint on purpose: this file must stay free
 * of literal invisible characters, or the scanner it tests would flag its own suite -
 * and a reviewer could not tell the fixtures apart from an actual smuggled payload.
 */
interface InvisibleUnicodeFinding {
    index: number;
    line: number;
    column: number;
    codePoint: number;
    escape: string;
    categoryId: string;
    label: string;
    reason: string;
}

type ScanFn = (text: string, options?: { allowEmojiPresentation?: boolean }) => InvisibleUnicodeFinding[];

let scanTextForInvisibleUnicode: ScanFn;
let formatFinding: (finding: InvisibleUnicodeFinding, filePath: string) => string;

const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

const ZERO_WIDTH_SPACE = 0x200b;
const VARIATION_SELECTOR_16 = 0xfe0f;
const BYTE_ORDER_MARK = 0xfeff;
const CHECK_MARK = 0x2705;
const GRINNING_FACE = 0x1f600;
const COMBINING_KEYCAP = 0x20e3;

suite('Invisible Unicode detector (GlassWorm)', () => {
    suiteSetup(async () => {
        const moduleSpecifier = pathToFileURL(
            path.resolve(__dirname, '../../..', 'scripts/lib/invisible-unicode.mjs')
        ).href;
        const module = await import(moduleSpecifier);
        scanTextForInvisibleUnicode = module.scanTextForInvisibleUnicode;
        formatFinding = module.formatFinding;
    });

    test('accepts ordinary source text', () => {
        const source = 'const proxyUrl = "http://proxy.example.com:8080";\n\t// tab, CR\r\n';
        assert.deepStrictEqual(scanTextForInvisibleUnicode(source), []);
    });

    test('accepts non-ASCII text that is actually visible', () => {
        const source = '{ "statusbar.enabled": "プロキシ", "ar": "الوكيل" }';
        assert.deepStrictEqual(scanTextForInvisibleUnicode(source), []);
    });

    test('detects Unicode tag characters', () => {
        // U+E0041 renders as nothing but survives copy/paste into a source file.
        const findings = scanTextForInvisibleUnicode(`const a = 1;${cp(0xe0041)}`);
        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].categoryId, 'tag');
        assert.strictEqual(findings[0].escape, 'U+E0041');
    });

    test('detects variation selector supplement payloads', () => {
        const smuggled = cp(0xe0100, 0xe0101, 0xe0102);
        const findings = scanTextForInvisibleUnicode(`const a = 1;${smuggled}`);
        assert.strictEqual(findings.length, 3);
        assert.ok(findings.every(f => f.categoryId === 'variation-selector-supplement'));
    });

    test('detects zero-width, bidi and other invisible controls', () => {
        const cases: Array<[number, string]> = [
            [0x200b, 'zero-width'],            // ZERO WIDTH SPACE
            [0x200d, 'zero-width'],            // ZERO WIDTH JOINER
            [0x202e, 'bidi-control'],          // RIGHT-TO-LEFT OVERRIDE (Trojan Source)
            [0x2066, 'bidi-isolate'],          // LEFT-TO-RIGHT ISOLATE
            [0x200e, 'directional-mark'],      // LEFT-TO-RIGHT MARK
            [0x061c, 'arabic-letter-mark'],
            [0x2060, 'invisible-operator'],    // WORD JOINER
            [0x2028, 'line-separator'],
            [0x00ad, 'soft-hyphen'],
            [0x180e, 'mongolian-format'],
            [0xfff9, 'interlinear-annotation'],
            [0x0085, 'c1-control'],            // NEXT LINE
            [0x0001, 'c0-control'],
            [0x007f, 'delete-control']
        ];

        for (const [codePoint, expectedCategory] of cases) {
            const findings = scanTextForInvisibleUnicode(`x${cp(codePoint)}y`);
            assert.strictEqual(findings.length, 1, `expected a finding for ${expectedCategory}`);
            assert.strictEqual(findings[0].categoryId, expectedCategory);
            assert.strictEqual(findings[0].codePoint, codePoint);
        }
    });

    test('allows tab, LF and CR', () => {
        assert.deepStrictEqual(scanTextForInvisibleUnicode('a\tb\r\nc'), []);
    });

    test('allows an emoji presentation selector after an emoji or keycap base', () => {
        assert.deepStrictEqual(scanTextForInvisibleUnicode(`- ${cp(CHECK_MARK, VARIATION_SELECTOR_16)} done`), []);
        assert.deepStrictEqual(scanTextForInvisibleUnicode(`1${cp(VARIATION_SELECTOR_16, COMBINING_KEYCAP)}`), []);
    });

    test('flags a presentation selector with no emoji base', () => {
        const findings = scanTextForInvisibleUnicode(`token${cp(VARIATION_SELECTOR_16)}`);
        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].categoryId, 'variation-selector');
    });

    test('flags runs of presentation selectors, which is how bytes get smuggled', () => {
        const findings = scanTextForInvisibleUnicode(
            cp(CHECK_MARK, VARIATION_SELECTOR_16, VARIATION_SELECTOR_16, VARIATION_SELECTOR_16)
        );
        // The first selector is legitimate emoji presentation; the rest are not.
        assert.strictEqual(findings.length, 2);
    });

    test('honours allowEmojiPresentation: false for strict scans', () => {
        const findings = scanTextForInvisibleUnicode(
            cp(CHECK_MARK, VARIATION_SELECTOR_16),
            { allowEmojiPresentation: false }
        );
        assert.strictEqual(findings.length, 1);
    });

    test('allows a BOM only at offset 0', () => {
        assert.deepStrictEqual(scanTextForInvisibleUnicode(`${cp(BYTE_ORDER_MARK)}const a = 1;`), []);

        const findings = scanTextForInvisibleUnicode(`const a${cp(BYTE_ORDER_MARK)} = 1;`);
        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].categoryId, 'byte-order-mark');
    });

    test('reports 1-based line and column of the offending character', () => {
        const findings = scanTextForInvisibleUnicode(`line one\nab${cp(ZERO_WIDTH_SPACE)}cd\n`);
        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].line, 2);
        assert.strictEqual(findings[0].column, 3);
        assert.strictEqual(findings[0].index, 11);
    });

    test('counts columns in UTF-16 units so editors agree with the report', () => {
        // U+1F600 occupies two UTF-16 units, so the next character starts at column 3.
        const findings = scanTextForInvisibleUnicode(cp(GRINNING_FACE, ZERO_WIDTH_SPACE));
        assert.strictEqual(findings[0].column, 3);
    });

    test('formats a finding as a clickable file:line:column entry', () => {
        const [finding] = scanTextForInvisibleUnicode(`a${cp(ZERO_WIDTH_SPACE)}`);
        const formatted = formatFinding(finding, 'src/extension.ts');
        assert.ok(formatted.startsWith('src/extension.ts:1:2'), formatted);
        assert.ok(formatted.includes('U+200B'), formatted);
    });
});
