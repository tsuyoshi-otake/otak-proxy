# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

otak-proxy is a VSCode extension that provides dead-simple proxy toggling for VSCode and Git. It allows users to switch proxy settings on and off with a single click using a three-mode system (Auto/Manual/Off).

## Key Features

- Three-mode proxy system: Auto (system), Manual, or Off
- Auto mode syncs with system/browser proxy in real-time
- One-click status bar cycling through modes
- Live monitoring of system proxy changes
- Connection testing before enabling proxy
- Cross-platform support (Windows, macOS, Linux)

## Specifications

When working on this project, refer to the specification documents in `.kiro/specs/` as needed:

- `.kiro/specs/security-and-error-handling/requirements.md` - Security and error handling requirements
- `.kiro/specs/security-and-error-handling/design.md` - Technical design for security features
- `.kiro/specs/security-and-error-handling/tasks.md` - Implementation tasks

## Development

This is a TypeScript-based VSCode extension.

### Common Commands

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode for development
npm run watch

# Run linter
npm run lint

# Package extension
npm run package
```

### Project Structure

- `src/` - TypeScript source code
- `package.json` - Extension manifest and dependencies
- `.kiro/specs/` - Feature specifications and design documents
