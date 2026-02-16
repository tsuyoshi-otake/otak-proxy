# AI-DLC and Spec-Driven Development

Kiro-style Spec Driven Development implementation on AI-DLC (AI Development Life Cycle)

## Project Context

### Paths
- Steering: `.kiro/steering/`
- Specs: `.kiro/specs/`

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

### VS Code extension-host tests
- Default behavior: run only VS Code-dependent tests (auto-detected by scanning built `out/test/**/*.test.js` for `import/require('vscode')`).
- Override: set `OTAK_PROXY_VSCODE_TEST_ALL=1` to run all tests under the VS Code host.
- Isolation / no side effects on developer machine:
  - Each run uses a unique temp profile via `--user-data-dir` and `--extensions-dir`.
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

### Fast mode knobs (for iterative dev)
- `OTAK_PROXY_TEST_FAST=1`: reduces property test runs and keeps timeouts tight.
- `OTAK_PROXY_PROPERTY_RUNS=<n>`: explicit override for fast-check `numRuns`.
- `OTAK_PROXY_TEST_TIMEOUT_MULTIPLIER=<x>`: multiplies some property test timeouts.

### CI convenience
- `npm run test:ci` runs lint + `npm test`.

## Steering Configuration
- Load entire `.kiro/steering/` as project memory
- Default files: `product.md`, `tech.md`, `structure.md`
- Custom files are supported (managed via `/kiro:steering-custom`)
