import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import noInvisibleUnicode from "./eslint-rules/no-invisible-unicode.mjs";

export default [{
    // Build output and the downloaded VS Code test harness are not sources.
    // Without this, a bare `eslint .` walks .vscode-test/ (~1000 bundled JS
    // files, including multi-MB bundles) and exhausts the default heap.
    ignores: [".vscode-test/**", "out/**", "dist/**", "node_modules/**"],
}, {
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint,
        // Local rules live in eslint-rules/. Editor feedback only; the repository-wide
        // scan (npm run lint:unicode) is what actually gates CI.
        otak: {
            rules: {
                "no-invisible-unicode": noInvisibleUnicode,
            },
        },
    },

    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",

        // Invisible code points can hide a payload from review (GlassWorm, Trojan Source).
        "otak/no-invisible-unicode": "error",
    },
}];