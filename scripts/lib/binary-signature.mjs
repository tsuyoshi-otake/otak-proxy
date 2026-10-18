/**
 * @file binary-signature
 * @description Decides whether check-invisible-unicode.mjs may skip a file as
 * binary. Extensions are never trusted: the scanner reads every file first,
 * and a file is skipped only when its bytes carry the signature of its
 * extension. A file whose extension is listed but whose bytes do not match is
 * decoded as UTF-8 and scanned like any text file, so its control bytes fail
 * the scan; a file with an unlisted extension is always scanned.
 *
 * The scanner runs on the packaged VSIX, and Node's require() parses any file
 * whose extension is not .json or .node as JavaScript - so "it is a .png" is
 * not a reason to stop looking for a payload.
 *
 * Plain ESM with no build step, like invisible-unicode.mjs: the scanner runs
 * before `tsc`.
 */

import * as path from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buffer) {
    return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function isMp3(buffer) {
    // An optional run of 0x00 bytes (some encoders pad the file start), then
    // either an ID3v2 header or an MPEG audio frame sync.
    let offset = 0;
    while (offset < buffer.length && buffer[offset] === 0x00) {
        offset += 1;
    }
    if (
        buffer[offset] === 0x49 && // 'I'
        buffer[offset + 1] === 0x44 && // 'D'
        buffer[offset + 2] === 0x33 && // '3'
        buffer[offset + 3] >= 0x02 && buffer[offset + 3] <= 0x04 &&
        buffer[offset + 4] === 0x00
    ) {
        return true;
    }
    return buffer[offset] === 0xff && (buffer[offset + 1] & 0xe0) === 0xe0;
}

/**
 * Every listed signature makes the file invalid JavaScript within its checked
 * bytes, so a file that matches can never be loaded as code by require(): the
 * parser meets a byte of 0x80 or above (decoded as U+FFFD, not a valid
 * identifier or operator character) or a C0 control byte that JavaScript
 * accepts only inside strings and comments, before anything that could open a
 * comment or a string.
 *
 *   .png  byte 0 is 0x89 (> 0x7f).
 *   .mp3  either a run of NUL bytes (C0), an ID3v2 header (the major-version
 *         and revision bytes after 'ID3' are 0x02-0x04 / 0x00, C0 controls),
 *         or a frame sync whose first byte is 0xff (> 0x7f).
 *
 * A format whose signature is printable ASCII - GIF (`GIF89a`), BMP (`BM`),
 * RIFF/WAV/WEBP (`RIFF`), fonts (`wOFF`, `OTTO`, `true`), PE (`MZ`) - can open
 * a JavaScript polyglot (`GIF89a=1;`), so such formats are deliberately not
 * listed: a file in one of them is scanned as text, and its control bytes fail
 * the scan until a reviewed signature that satisfies the rule above is added.
 */
const SIGNATURE_CHECKS = new Map([
    ['.png', isPng],
    ['.mp3', isMp3]
]);

/**
 * @param {string} fileName the file's name or label; only its extension is read
 * @param {Buffer} buffer the file's bytes - the caller must have already read it
 * @returns {boolean} true only when the extension is listed AND the bytes match
 */
export function isVerifiedBinary(fileName, buffer) {
    const check = SIGNATURE_CHECKS.get(path.extname(fileName).toLowerCase());
    return check !== undefined && check(buffer);
}
