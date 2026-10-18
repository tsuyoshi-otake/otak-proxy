# AI-DLC and Spec-Driven Development

Kiro-style Spec Driven Development implementation on AI-DLC (AI Development Life Cycle)

## Project Context

### Paths
- Steering: `.kiro/steering/`
- Specs: `.kiro/specs/`

### Code Map (high-signal entry points)
- Extension entry: `src/extension.ts`
- Core orchestration: `src/core/*` (state, apply/disable flows, initialization)
- Proxy detection/monitoring: `src/monitoring/*` + `src/config/SystemProxyDetector.ts`
- Config writers: `src/config/*ConfigManager.ts` (Git, npm, VS Code, terminal env)
- Multi-instance sync: `src/sync/*`
- Security/sanitization: `src/validation/*` + `src/utils/Logger.ts`
- Tests:
  - Unit (plain Node): `scripts/run-unit-tests.mjs`
  - VS Code host: `.vscode-test.mjs`

### Steering vs Specification

**Steering** (`.kiro/steering/`) - Guide AI with project-wide rules and context
**Specs** (`.kiro/specs/`) - Formalize development process for individual features

### Active Specifications
- Check `.kiro/specs/` for active specifications
- Use `/kiro:spec-status [feature-name]` to check progress

## Development Guidelines
- Think in English, generate responses in Japanese. All Markdown content written to project files (e.g., requirements.md, design.md, tasks.md, research.md, validation reports) MUST be written in the target language configured for this specification (see spec.json.language).

## Minimal Workflow
- Phase 0 (optional): `/kiro:steering`, `/kiro:steering-custom`
- Phase 1 (Specification):
  - `/kiro:spec-init "description"`
  - `/kiro:spec-requirements {feature}`
  - `/kiro:validate-gap {feature}` (optional: for existing codebase)
  - `/kiro:spec-design {feature} [-y]`
  - `/kiro:validate-design {feature}` (optional: design review)
  - `/kiro:spec-tasks {feature} [-y]`
- Phase 2 (Implementation): `/kiro:spec-impl {feature} [tasks]`
  - `/kiro:validate-impl {feature}` (optional: after implementation)
- Progress check: `/kiro:spec-status {feature}` (use anytime)

## Development Rules
- 3-phase approval workflow: Requirements → Design → Tasks → Implementation
- Human review required each phase; use `-y` only for intentional fast-track
- Keep steering current and verify alignment with `/kiro:spec-status`
- Follow the user's instructions precisely, and within that scope act autonomously: gather the necessary context and complete the requested work end-to-end in this run, asking questions only when essential information is missing or the instructions are critically ambiguous.

## Testing (Fast + Isolated)
This repo has two test modes: VS Code extension-host tests and plain Node unit tests. Keep them isolated and fast.

### Risk-based Proxy Behavior Verification
- For changes that affect proxy detection, proxy application/removal, diagnostics, remediation, credentials, Git/npm/VS Code config writers, terminal environment handling, startup behavior, or toggle behavior, always run integration-level and unit-level tests for both happy paths and error paths. Include successful writes/removals, unavailable tools, permission/config failures, stale settings, credential-bearing proxy URLs, and concurrency or rapid-toggle cases when relevant.
- Validate operating-system and external-tool boundaries with deterministic protocol-compatible integration tests and isolated VS Code extension-host tests. Record any behavior that is outside those controlled test environments as a residual-risk assumption rather than treating it as tested.

## Supply-Chain Lint (Invisible Unicode / GlassWorm)
This extension publishes to the Visual Studio Marketplace **and** the Open VSX Registry, which is the channel the GlassWorm worm used to ship payloads hidden in invisible Unicode code points. Hidden code cannot be caught by reading a diff, so it is checked mechanically.

- Detector (single source of truth): `scripts/lib/invisible-unicode.mjs` — plain ESM, no build step, because both consumers run before `tsc`. The category table hard-codes the full Unicode 16.0 (unchanged in 17.0) `Default_Ignorable_Code_Point` set plus U+2800 (Braille blank); a unit test asserts the running Node's `\p{Default_Ignorable_Code_Point}` is fully covered, so a newer Unicode table reports what to add.
- Consumers:
  - ESLint rule `otak/no-invisible-unicode` (`eslint-rules/no-invisible-unicode.mjs`) — inline editor feedback for `src/**`.
  - `npm run lint:unicode` — every tracked *and* new non-ignored file (JSON, Markdown, workflows, scripts). Part of `npm run lint`, so it gates CI.
  - `npm run lint:unicode:dist` — the compiled artifacts that actually ship. Runs in the publish workflow before `vsce package`, so a payload injected into `out/**` is caught even when the sources are clean.
  - `node scripts/check-invisible-unicode.mjs --dir <path>` — every file under an arbitrary directory. CI and the publish workflow unzip the VSIX into `$RUNNER_TEMP` and scan it this way, so the packaged artifact itself is checked, not only the sources and `out/`.
- Scanning rules: every file is read first. A file is skipped as binary only when its bytes carry the signature of its extension (`scripts/lib/binary-signature.mjs`) — extensions are never trusted, because `require()` parses any extension other than `.json`/`.node` as JavaScript, so a UTF-8 payload named `images/payload.png` would otherwise ship unscanned. A file whose extension is listed but whose bytes do not match is decoded as UTF-8 and scanned like any text file — a NUL byte is a `c0-control` finding, never a reason to skip. Adding a format requires that every byte pattern the signature accepts is invalid JavaScript within the checked bytes: the parser must meet a byte of `0x80`+ (decoded as U+FFFD) or a C0 control that JavaScript accepts only inside strings/comments before anything that could open a comment or string. Signatures that are printable ASCII (GIF `GIF89a`, BMP `BM`, RIFF, `wOFF`/`OTTO`/`true`, PE `MZ`) can open a JS polyglot and are deliberately not listed — such a file is scanned as text and its control bytes fail the scan until a reviewed signature is added. A file that cannot be read, or a directory entry that is not a regular file (symlink, FIFO, socket, device), fails the run with its label and error code — all failures are listed, the run does not stop at the first. One exception: in repository mode (no flags), a candidate that no longer exists (`ENOENT`) is counted as missing instead of failing. A run that scans zero files fails in every mode; `--dir` cannot be combined with `--dist` or explicit paths.
- Exemptions are deliberate and narrow: a BOM at offset 0, and a single emoji presentation selector (U+FE0E/U+FE0F) directly after an emoji or keycap base. Runs of two or more selectors are always rejected — byte smuggling produces runs.
- Never write a literal invisible character into a test fixture; build it with `String.fromCodePoint` so the file itself stays clean and a reviewer can tell a fixture from a real payload.
- Adding an exemption requires a comment in `scripts/lib/invisible-unicode.mjs` explaining why the character is legitimate.

## Release Pipeline
- `.github/workflows/publish-vscode.yml` runs on pushed `v*` tags only (no `workflow_dispatch`): the build job verifies `GITHUB_REF` is `refs/tags/v` + `package.json` version and that the tagged commit sits on `origin/main` (`scripts/release/check-release-ref.mjs`), then packages and scans the VSIX; a `check-tokens` job verifies both registry secrets up front so a missing token fails before any partial publish; one job per registry (`needs: [build, check-tokens]`) downloads that artifact and publishes without `--skip-duplicate`, so an already-published version fails instead of passing silently.
- `.github/workflows/ci.yml` runs the same lint / unit / smoke / package / VSIX-scan steps on pull requests and pushes to `main`, plus `npm audit --audit-level=critical`; concurrency cancels superseded pull-request runs only, so every `main` push is tested to completion.
- Every workflow job has `timeout-minutes`, every `uses:` is pinned to a full commit SHA with a `# vX.Y.Z` comment, every `actions/checkout` sets `persist-credentials: false`, and `permissions:` is `contents: read`; `src/test/releaseWorkflowPolicy.test.ts` enforces this.
- `.github/dependabot.yml` proposes weekly npm and GitHub Actions updates with a 3-day `cooldown`; the cooldown applies to version updates only, not security-update PRs, so the minimum release age is checked by hand on those.

## Localization Source Of Truth
- UI/runtime messages: `src/i18n/locales/*.json`
- VS Code contributed strings (`package.json` placeholders like `%command.toggleProxy%`):
  - Generated from `src/i18n/locales/*.json` via `npm run gen:nls`
  - Do not edit `package.nls*.json` by hand

## Docs Policy (README / steering)
- Status bar illustrations in docs are ASCII diagrams, not UI screenshots. Screenshots go stale silently; ASCII diagrams are diffable and reviewed with the code.
- When changing status bar text/icons (`src/ui/StatusBarDisplay.ts` or `statusbar.*` strings in `src/i18n/locales/en.json`), update the ASCII state diagrams in `README.md` in the same change.
- The toggle is two-state (Off ↔ Auto). Manual is not a mode: a URL from `otak: Configure Manual Proxy` is the Auto fallback. Docs must not describe a 3-mode toggle.

### VS Code extension-host tests
- Default behavior: run only VS Code-dependent tests (auto-detected by scanning built `out/test/**/*.test.js` for `import/require('vscode')`).
- Override: set `OTAK_PROXY_VSCODE_TEST_ALL=1` to run all tests under the VS Code host.
- Isolation / no side effects on developer machine:
  - Each run uses a unique temp profile via `--user-data-dir` and `--extensions-dir`; a synchronous `process.on('exit')` hook in `.vscode-test.mjs` removes it after `vscode-test` exits (the config module runs only in the CLI process, never inside the extension host).
  - Git global config is redirected using `GIT_CONFIG_GLOBAL` (so `git config --global` doesn't touch `~/.gitconfig`).
  - npm user config is redirected using `NPM_CONFIG_USERCONFIG` (so `npm config` doesn't touch `~/.npmrc`).
- Commands:
  - `npm test` (runs `vscode-test`)
  - `npm run test:vscode` / `npm run test:vscode:fast`
  - `npm run test:smoke` (runs only tests tagged with `@smoke`)
  - `npm run test:mvp` (lint + unit(parallel) + smoke)

### Plain Node unit tests
- Command: `npm run test:unit` (runs Mocha directly against built `out/test/**/*.test.js`).
- Auto selection: excludes VS Code-dependent tests, integration tests, and extension-host suites.
- VS Code shim: `scripts/vscode-shim.cjs` provides a minimal `vscode` module for unit tests that import code paths referencing it.
- Parallel execution:
  - `npm run test:unit:parallel` enables Mocha `--parallel` with a bounded number of jobs.
- Isolation (#103): both lanes run through `scripts/lib/unit-mocha.mjs`. Every Mocha process (the main one and each `--parallel` worker) gets its own temp directory, `GIT_CONFIG_GLOBAL`, and `NPM_CONFIG_USERCONFIG` from `scripts/unit-worker-isolation.cjs`. Workers therefore never share the Git config mutex (`os.tmpdir()/otak-proxy.gitconfig.mutex` on Windows; `os.tmpdir()/otak-proxy-<uid>/otak-proxy.gitconfig.mutex` on POSIX, #108) or a config file. The runner removes the run directory after Mocha exits; workers do not clean up, because `--bail` force-kills them.
  - `npm run test:unit:isolation` checks this with two probe files (`scripts/fixtures/unit-isolation/`). It is part of `npm run test:mvp`. Do not run it next to another unit run: it compares the `otak-proxy-unit-*` directories in the system temp directory before and after.
  - Direct `mocha` runs do not get this isolation: set `GIT_CONFIG_GLOBAL` / `NPM_CONFIG_USERCONFIG` yourself. The VS Code host lane keeps the system temp directory, so its Git config mutex is still the shared one.

### Fast mode knobs (for iterative dev)
- `OTAK_PROXY_TEST_FAST=1`: reduces property test runs and keeps timeouts tight.
- `OTAK_PROXY_PROPERTY_RUNS=<n>`: explicit override for fast-check `numRuns`.
- `OTAK_PROXY_TEST_TIMEOUT_MULTIPLIER=<x>`: multiplies some property test timeouts.

### Log noise control
- `OTAK_PROXY_LOG_SILENT=1`: suppresses `Logger.*` output (default for both unit tests and VS Code tests).
- Set `OTAK_PROXY_LOG_SILENT=0` when you need verbose logs while debugging.

### CI convenience
- `npm run test:ci` runs lint + `npm test`.

## Steering Configuration
- Load entire `.kiro/steering/` as project memory
- Default files: `product.md`, `tech.md`, `structure.md`
- Custom files are supported (managed via `/kiro:steering-custom`)
