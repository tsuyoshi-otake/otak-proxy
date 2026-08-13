/**
 * @file no-invisible-unicode
 * @description ESLint rule rejecting invisible / display-spoofing Unicode code points.
 *
 * Gives the GlassWorm check (see scripts/lib/invisible-unicode.mjs) an inline editor
 * presence for the files ESLint parses. The repository-wide scanner
 * (scripts/check-invisible-unicode.mjs) is the authority in CI, since it also covers
 * JSON, Markdown, workflows and the compiled artifacts that actually ship.
 */

import { scanTextForInvisibleUnicode } from '../scripts/lib/invisible-unicode.mjs';

/** @type {import('eslint').Rule.RuleModule} */
export default {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow invisible or display-spoofing Unicode code points, which can hide executable payloads from code review.'
        },
        schema: [
            {
                type: 'object',
                properties: {
                    allowEmojiPresentation: { type: 'boolean' }
                },
                additionalProperties: false
            }
        ],
        messages: {
            invisibleUnicode: 'Invisible Unicode character {{escape}} ({{label}}). {{reason}}'
        }
    },

    create(context) {
        const options = context.options[0] ?? {};
        const sourceCode = context.sourceCode;

        return {
            Program(node) {
                const text = sourceCode.getText();
                for (const finding of scanTextForInvisibleUnicode(text, options)) {
                    context.report({
                        node,
                        loc: sourceCode.getLocFromIndex(finding.index),
                        messageId: 'invisibleUnicode',
                        data: {
                            escape: finding.escape,
                            label: finding.label,
                            reason: finding.reason
                        }
                    });
                }
            }
        };
    }
};
