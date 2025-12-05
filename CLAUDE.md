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
  - `src/config/` - Configuration managers (Git, VSCode, System Proxy)
  - `src/validation/` - Input validation and sanitization
  - `src/errors/` - Error handling and user notifications
  - `src/models/` - Data models
  - `src/utils/` - Utility functions
  - `src/test/` - Test suites
- `package.json` - Extension manifest and dependencies
- `.kiro/specs/` - Feature specifications and design documents

### Testing

The project uses a comprehensive testing strategy with both unit tests and property-based tests:

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- --grep "Security Test Suite"
npm test -- --grep "ProxyUrlValidator"
```

#### Test Structure

- **Unit Tests**: Test specific scenarios and edge cases
- **Property-Based Tests**: Use fast-check to verify properties across many random inputs (minimum 100 iterations per property)
- **Integration Tests**: Test complete workflows end-to-end

#### Test Suites

The project includes the following test suites (163 tests total):

1. **ProxyUrlValidator Test Suite** (`src/test/ProxyUrlValidator.test.ts`)
   - Basic validation (protocol, port, hostname, credentials)
   - Shell metacharacter detection
   - Property-based tests for validation rules
   - Validates Requirements 1.1, 1.3, 1.4, 3.2, 3.3, 3.4, 4.2

2. **InputSanitizer Test Suite** (`src/test/InputSanitizer.test.ts`)
   - Password masking and credential removal
   - Edge cases (special characters, multiple @ symbols)
   - Property-based tests for credential protection
   - Validates Requirements 1.5, 6.1, 6.2, 6.3, 6.4, 6.5

3. **GitConfigManager Test Suite** (`src/test/GitConfigManager.test.ts`)
   - Git proxy configuration operations
   - Error handling (Git not installed, permissions, timeout)
   - Round-trip testing (set/get/unset)
   - Validates Requirements 1.2, 2.1, 4.3, 5.1-5.4

4. **VscodeConfigManager Test Suite** (`src/test/VscodeConfigManager.test.ts`)
   - VSCode configuration operations
   - Configuration resilience
   - Round-trip testing
   - Validates Requirements 2.2

5. **ErrorAggregator Test Suite** (`src/test/ErrorAggregator.test.ts`)
   - Multi-operation error collection
   - Error message formatting with suggestions
   - Edge cases (empty messages, special characters)
   - Validates Requirements 2.5

6. **ProxyUrl Test Suite** (`src/test/ProxyUrl.test.ts`)
   - Data model construction and parsing
   - Display string generation with credential masking
   - Round-trip parsing
   - Validates Requirements 6.4

7. **Integration Test Suite** (`src/test/integration.test.ts`)
   - Complete setProxy/detectProxy/disableProxy flows
   - Error recovery scenarios
   - End-to-end workflows
   - Validates all requirements in real-world scenarios

8. **Extension Test Suite** (`src/test/extension.test.ts`)
   - Extension activation and initialization
   - Status bar functionality
   - Command registration

#### Security Testing

The `src/test/security.test.ts` file contains comprehensive security tests covering:

1. **Fuzzing with Malformed URLs**
   - Random garbage input handling
   - Mixed valid/invalid components
   - Control characters and Unicode
   - Extremely long URLs and excessive nesting

2. **Command Injection Pattern Testing**
   - Shell metacharacters (`;`, `|`, `&`, `` ` ``, `\n`, `\r`, `<`, `>`, `(`, `)`)
   - Command substitution attempts
   - Injection in credentials, ports, and paths
   - Path traversal attacks

3. **Credential Leakage Prevention**
   - Password masking in all contexts (logs, UI, errors)
   - Complete credential removal when needed
   - Property-based fuzzing for credential protection

4. **Platform-Specific Escaping**
   - Windows-specific dangerous patterns
   - Unix/Linux-specific dangerous patterns
   - macOS-specific dangerous patterns
   - Environment variable expansion prevention
   - Null bytes and binary data handling
   - Defense-in-depth against SQL/LDAP injection patterns

5. **Integration Security Tests**
   - End-to-end security validation
   - Multi-operation security maintenance
   - Rapid-fire injection attempt handling

#### Property-Based Testing

Property tests are tagged with comments following this format:
```typescript
/**
 * Feature: security-and-error-handling, Property 1: Shell metacharacter rejection
 * Validates: Requirements 1.1
 */
```

Each property test runs a minimum of 100 iterations to ensure comprehensive coverage across the input space.
