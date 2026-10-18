/**
 * @file invisible-unicode
 * @description Shared detector for invisible / deceptive Unicode code points.
 *
 * Threat model: the GlassWorm campaign (October 2025) shipped malicious VS Code and
 * Open VSX extensions whose payload was encoded in invisible Unicode code points -
 * variation selectors and tag characters, which render as nothing in editors and in
 * review diffs. Trojan Source (CVE-2021-42574) bidi overrides are the same class of
 * problem: text a human reads is not the text the parser sees. Neither can be caught
 * by reading code, so it has to be caught mechanically.
 *
 * This module is the single source of truth for that check. It is plain ESM with no
 * dependencies and no build step, because both consumers must run before `tsc` does:
 *   - eslint-rules/no-invisible-unicode.mjs  (inline editor feedback for src/**)
 *   - scripts/check-invisible-unicode.mjs    (repository- and artifact-wide scan)
 */

/**
 * Code point ranges that carry no legitimate meaning in this repository's sources.
 * Ordered roughly by how strongly they indicate smuggling rather than sloppy editing.
 */
export const INVISIBLE_CATEGORIES = Object.freeze([
    {
        id: 'tag',
        label: 'Unicode tag character',
        start: 0xe0000,
        end: 0xe007f,
        reason: 'Invisible tag characters can carry a hidden payload (GlassWorm).'
    },
    {
        id: 'variation-selector-supplement',
        label: 'variation selector supplement',
        start: 0xe0100,
        end: 0xe01ef,
        reason: 'Variation selectors encode arbitrary bytes invisibly (GlassWorm).'
    },
    {
        id: 'variation-selector',
        label: 'variation selector',
        start: 0xfe00,
        end: 0xfe0f,
        reason: 'Variation selectors encode arbitrary bytes invisibly (GlassWorm).'
    },
    {
        id: 'bidi-control',
        label: 'bidirectional override',
        start: 0x202a,
        end: 0x202e,
        reason: 'Bidi overrides make displayed code differ from parsed code (Trojan Source).'
    },
    {
        id: 'bidi-isolate',
        label: 'bidirectional isolate',
        start: 0x2066,
        end: 0x2069,
        reason: 'Bidi isolates make displayed code differ from parsed code (Trojan Source).'
    },
    {
        id: 'directional-mark',
        label: 'directional mark',
        start: 0x200e,
        end: 0x200f,
        reason: 'Invisible directional marks can reorder displayed text.'
    },
    {
        id: 'arabic-letter-mark',
        label: 'Arabic letter mark',
        start: 0x061c,
        end: 0x061c,
        reason: 'Invisible directional mark; same reordering risk as U+200E/U+200F.'
    },
    {
        id: 'zero-width',
        label: 'zero-width character',
        start: 0x200b,
        end: 0x200d,
        reason: 'Zero-width characters are invisible and can hide or split identifiers.'
    },
    {
        id: 'invisible-operator',
        label: 'invisible operator / word joiner',
        start: 0x2060,
        end: 0x2065,
        reason: 'Invisible formatting characters with no legitimate use in sources.'
    },
    {
        id: 'deprecated-format',
        label: 'deprecated format control',
        start: 0x206a,
        end: 0x206f,
        reason: 'Deprecated and reserved invisible format controls (Default_Ignorable, Unicode 16.0; unchanged in 17.0).'
    },
    {
        id: 'line-separator',
        label: 'line/paragraph separator',
        start: 0x2028,
        end: 0x2029,
        reason: 'Separators terminate lines for the parser but not for most viewers.'
    },
    {
        id: 'soft-hyphen',
        label: 'soft hyphen',
        start: 0x00ad,
        end: 0x00ad,
        reason: 'Invisible in most renderings; can hide a break inside a token.'
    },
    {
        id: 'mongolian-format',
        label: 'Mongolian format control',
        start: 0x180b,
        end: 0x180f,
        reason: 'Invisible format controls with no legitimate use in sources.'
    },
    {
        id: 'interlinear-annotation',
        label: 'interlinear annotation',
        start: 0xfff9,
        end: 0xfffb,
        reason: 'Annotation controls can hide text from the reader.'
    },
    {
        id: 'byte-order-mark',
        label: 'zero-width no-break space / BOM',
        start: 0xfeff,
        end: 0xfeff,
        reason: 'A BOM anywhere but the first offset is an invisible embedded character.'
    },
    {
        id: 'c1-control',
        label: 'C1 control',
        start: 0x0080,
        end: 0x009f,
        reason: 'Non-printable control characters do not belong in sources.'
    },
    {
        id: 'c0-control',
        label: 'C0 control',
        start: 0x0000,
        end: 0x001f,
        reason: 'Non-printable control characters do not belong in sources.'
    },
    {
        id: 'delete-control',
        label: 'DEL control',
        start: 0x007f,
        end: 0x007f,
        reason: 'Non-printable control character.'
    },
    // The remaining categories complete the Unicode 16.0 (unchanged in 17.0)
    // Default_Ignorable_Code_Point table. They are hard-coded because the
    // property tables differ between Node versions; a unit test asserts that
    // every code point the running Node marks \p{Default_Ignorable_Code_Point}
    // is covered here, so a newer Node reports what to add.
    {
        id: 'combining-grapheme-joiner',
        label: 'combining grapheme joiner',
        start: 0x034f,
        end: 0x034f,
        reason: 'Invisible combining mark (Default_Ignorable, Unicode 16.0; unchanged in 17.0) with no legitimate use in sources.'
    },
    {
        id: 'hangul-jamo-filler',
        label: 'Hangul jamo filler',
        start: 0x115f,
        end: 0x1160,
        reason: 'Renders as blank space (Default_Ignorable, Unicode 16.0; unchanged in 17.0); can hide or pad tokens.'
    },
    {
        id: 'khmer-inherent-vowel',
        label: 'Khmer inherent vowel mark',
        start: 0x17b4,
        end: 0x17b5,
        reason: 'Invisible format marks (Default_Ignorable, Unicode 16.0; unchanged in 17.0) with no legitimate use in sources.'
    },
    {
        id: 'hangul-filler',
        label: 'Hangul filler',
        start: 0x3164,
        end: 0x3164,
        reason: 'Renders as blank space (Default_Ignorable, Unicode 16.0; unchanged in 17.0); can hide or pad tokens.'
    },
    {
        id: 'halfwidth-hangul-filler',
        label: 'halfwidth Hangul filler',
        start: 0xffa0,
        end: 0xffa0,
        reason: 'Renders as blank space (Default_Ignorable, Unicode 16.0; unchanged in 17.0); can hide or pad tokens.'
    },
    {
        id: 'unassigned-default-ignorable',
        label: 'unassigned default-ignorable code point',
        start: 0xfff0,
        end: 0xfff8,
        reason: 'Reserved default-ignorable code points (Unicode 16.0; unchanged in 17.0); reserved for future smuggling-friendly characters.'
    },
    {
        id: 'shorthand-format',
        label: 'shorthand format control',
        start: 0x1bca0,
        end: 0x1bca3,
        reason: 'Invisible format controls (Default_Ignorable, Unicode 16.0; unchanged in 17.0) with no legitimate use in sources.'
    },
    {
        id: 'musical-format',
        label: 'musical format control',
        start: 0x1d173,
        end: 0x1d17a,
        reason: 'Invisible beam/slur controls (Default_Ignorable, Unicode 16.0; unchanged in 17.0) with no legitimate use in sources.'
    },
    {
        // Covers the rest of the E0000-E0FFF default-ignorable block: the
        // unassigned code points either side of the tag characters and the
        // variation-selector supplement, which are matched by earlier
        // categories. Reserved today, default-ignorable by design (Unicode 16.0; unchanged in 17.0).
        id: 'default-ignorable-reserved',
        label: 'reserved default-ignorable code point',
        start: 0xe0080,
        end: 0xe0fff,
        reason: 'Reserved default-ignorable code points (Unicode 16.0; unchanged in 17.0) in the block GlassWorm used.'
    },
    {
        // U+2800 BRAILLE PATTERN BLANK is not Default_Ignorable, but it renders
        // as an empty cell in every font, so it can pad or split tokens the same
        // way the fillers above can.
        id: 'braille-blank',
        label: 'Braille pattern blank',
        start: 0x2800,
        end: 0x2800,
        reason: 'Renders as a blank glyph; can hide or pad tokens.'
    }
]);

/** Tab, LF and CR are the only C0 characters a text file may legitimately contain. */
const ALLOWED_C0 = new Set([0x09, 0x0a, 0x0d]);

const EMOJI_BASE_PATTERN = /\p{Extended_Pictographic}/u;
/** Bases of keycap sequences such as `1` + U+FE0F + U+20E3. */
const KEYCAP_BASE_PATTERN = /[0-9#*]/;

function categoryOf(codePoint) {
    for (const category of INVISIBLE_CATEGORIES) {
        if (codePoint >= category.start && codePoint <= category.end) {
            return category;
        }
    }
    return undefined;
}

function isEmojiPresentationBase(codePoint) {
    if (codePoint < 0) {
        return false;
    }
    const char = String.fromCodePoint(codePoint);
    return EMOJI_BASE_PATTERN.test(char) || KEYCAP_BASE_PATTERN.test(char);
}

/**
 * @param {{ codePoint: number, index: number, previousCodePoint: number,
 *           previousWasSelector: boolean, allowEmojiPresentation: boolean }} occurrence
 */
function isExemptOccurrence(occurrence) {
    const { codePoint, index, previousCodePoint, previousWasSelector, allowEmojiPresentation } = occurrence;

    if (ALLOWED_C0.has(codePoint)) {
        return true;
    }
    if (codePoint === 0xfeff) {
        // An encoding marker only at the very start; anywhere else it is embedded content.
        return index === 0;
    }
    if ((codePoint === 0xfe0e || codePoint === 0xfe0f) && allowEmojiPresentation) {
        return !previousWasSelector && isEmojiPresentationBase(previousCodePoint);
    }
    return false;
}

/**
 * @typedef {object} InvisibleUnicodeFinding
 * @property {number} index      UTF-16 offset of the character in the scanned text.
 * @property {number} line       1-based line number.
 * @property {number} column     1-based column, counted in UTF-16 units.
 * @property {number} codePoint  The offending code point.
 * @property {string} escape     Printable `U+XXXX` form.
 * @property {string} categoryId Identifier from {@link INVISIBLE_CATEGORIES}.
 * @property {string} label      Human-readable category name.
 * @property {string} reason     Why the character is rejected.
 */

/**
 * Scan text for invisible or display-spoofing code points.
 *
 * Two exemptions keep the check usable on real files:
 *  - a BOM at offset 0 (an encoding marker, not embedded content);
 *  - a single emoji presentation selector (U+FE0E/U+FE0F) directly after an emoji or
 *    keycap base, which is how documentation writes emoji. Runs of two or more
 *    selectors are never exempt - byte smuggling always produces runs.
 *
 * @param {string} text
 * @param {{ allowEmojiPresentation?: boolean }} [options]
 * @returns {InvisibleUnicodeFinding[]}
 */
export function scanTextForInvisibleUnicode(text, options = {}) {
    const { allowEmojiPresentation = true } = options;
    /** @type {InvisibleUnicodeFinding[]} */
    const findings = [];

    let index = 0;
    let line = 1;
    let column = 1;
    let previousCodePoint = -1;
    let previousWasSelector = false;

    for (const char of text) {
        const codePoint = char.codePointAt(0) ?? 0;
        const category = categoryOf(codePoint);
        const isPresentationSelector = codePoint === 0xfe0e || codePoint === 0xfe0f;
        const exempt = isExemptOccurrence({
            codePoint,
            index,
            previousCodePoint,
            previousWasSelector,
            allowEmojiPresentation
        });

        if (category && !exempt) {
            findings.push({
                index,
                line,
                column,
                codePoint,
                escape: formatCodePoint(codePoint),
                categoryId: category.id,
                label: category.label,
                reason: category.reason
            });
        }

        if (char === '\n') {
            line += 1;
            column = 1;
        } else {
            column += char.length;
        }
        index += char.length;
        previousCodePoint = codePoint;
        previousWasSelector = isPresentationSelector;
    }

    return findings;
}

/** `U+00AD` style rendering, wide enough for astral code points. */
export function formatCodePoint(codePoint) {
    return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * One-line report entry, `file:line:column` first so terminals and editors can
 * jump straight to it.
 */
export function formatFinding(finding, filePath) {
    return `${filePath}:${finding.line}:${finding.column}  ${finding.escape} (${finding.label}) - ${finding.reason}`;
}
