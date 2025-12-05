# Design Document: Security and Error Handling

## Overview

This design addresses critical security vulnerabilities and error handling deficiencies in the otak-proxy VSCode extension. The extension currently executes shell commands with insufficient input validation, creating command injection risks. Additionally, error handling is minimal, leading to poor user experience when operations fail.

The design focuses on three core improvements:
1. **Input validation and sanitization** - Prevent command injection through strict URL validation
2. **Secure command execution** - Use parameterized commands and platform-specific escaping
3. **Comprehensive error handling** - Provide clear, actionable feedback for all failure scenarios

**Design Rationale**: Security vulnerabilities in developer tools are particularly dangerous because they operate with the user's full system privileges. Command injection through proxy URLs could allow malicious actors to execute arbitrary code. This design prioritizes security without sacrificing usability.

## Architecture

### Current Architecture Issues

The extension currently uses string concatenation to build shell commands:
- Git proxy configuration via `git config --global http.proxy ${url}`
- System proxy detection via platform-specific shell commands
- No input validation before command execution

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Extension Commands                       │
│  (setProxy, detectProxy, disableProxy, testProxy)           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Validation Layer (NEW)                      │
│  - ProxyUrlValidator: Format & security validation          │
│  - InputSanitizer: Credential masking for display           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Configuration Management Layer                  │
│  - GitConfigManager: Safe Git command execution             │
│  - VscodeConfigManager: VSCode settings management          │
│  - SystemProxyDetector: Platform-specific detection         │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                 Error Handling Layer (NEW)                   │
│  - ErrorAggregator: Collect and format multiple errors      │
│  - UserNotifier: Display contextual error messages          │
└─────────────────────────────────────────────────────────────┘
```

**Design Rationale**: Separating validation, execution, and error handling into distinct layers follows the principle of separation of concerns. This makes the code more testable and allows each layer to be independently verified for correctness.

## Components and Interfaces

### 1. ProxyUrlValidator

Validates proxy URLs for format correctness and security.

```typescript
interface ProxyUrlValidator {
  /**
   * Validates a proxy URL for format and security
   * @param url - The proxy URL to validate
   * @returns ValidationResult with success status and error details
   */
  validate(url: string): ValidationResult;
  
  /**
   * Checks if URL contains shell metacharacters
   * @param url - The URL to check
   * @returns true if URL contains dangerous characters
   */
  containsShellMetacharacters(url: string): boolean;
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
}
```

**Validation Rules**:
- Protocol: Must be `http://` or `https://`
- Hostname: Alphanumeric, dots, hyphens only
- Port: 1-65535 (optional)
- Credentials: Alphanumeric, hyphens, underscores, @ symbol in username/password only
- Forbidden: Shell metacharacters (`;`, `|`, `&`, `$`, `` ` ``, `\n`, `\r`, `<`, `>`, `(`, `)`)

**Design Rationale**: Whitelist approach (allowing only known-safe characters) is more secure than blacklist approach. Even if new shell metacharacters are discovered, the whitelist prevents them.

### 2. InputSanitizer

Sanitizes proxy URLs for safe display in logs, UI, and error messages.

```typescript
interface InputSanitizer {
  /**
   * Masks password in proxy URL for display
   * @param url - The proxy URL with potential credentials
   * @returns URL with password replaced by asterisks
   */
  maskPassword(url: string): string;
  
  /**
   * Removes credentials entirely from URL
   * @param url - The proxy URL
   * @returns URL without username:password portion
   */
  removeCredentials(url: string): string;
}
```

**Design Rationale**: Credentials should never appear in logs or UI. Masking prevents accidental exposure while still showing the user which proxy is configured.

### 3. GitConfigManager

Manages Git proxy configuration with secure command execution.

```typescript
interface GitConfigManager {
  /**
   * Sets Git global proxy configuration
   * @param url - Validated proxy URL
   * @returns Result with success status and any errors
   */
  setProxy(url: string): Promise<OperationResult>;
  
  /**
   * Removes Git global proxy configuration
   * @returns Result with success status and any errors
   */
  unsetProxy(): Promise<OperationResult>;
  
  /**
   * Gets current Git proxy configuration
   * @returns Current proxy URL or null
   */
  getProxy(): Promise<string | null>;
}

interface OperationResult {
  success: boolean;
  error?: string;
  errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'UNKNOWN';
}
```

**Implementation Strategy**:
- Use Node.js `child_process.execFile()` instead of `exec()` to prevent shell interpretation
- Pass URL as separate argument, not concatenated into command string
- Set command timeout (5 seconds) to prevent hanging
- Parse stderr to determine specific error types

**Design Rationale**: `execFile()` does not invoke a shell, eliminating command injection risk. Even if validation fails, the URL cannot be interpreted as commands.

### 4. SystemProxyDetector

Detects system proxy settings across platforms.

```typescript
interface SystemProxyDetector {
  /**
   * Detects system proxy for current platform
   * @returns Detected proxy URL or null
   */
  detectSystemProxy(): Promise<string | null>;
}
```

**Platform-Specific Detection**:
- **Windows**: Read registry keys via `reg query` command
  - `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
  - Keys: `ProxyEnable`, `ProxyServer`
- **macOS**: Parse `scutil --proxy` output
- **Linux**: Check environment variables `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`

**Error Handling**: If detection fails on any platform, log the error and return null rather than throwing. This allows the extension to continue functioning.

**Design Rationale**: Platform-specific detection is necessary because proxy configuration varies widely. Graceful degradation ensures the extension works even if detection fails.

### 5. ErrorAggregator

Collects and formats multiple errors from configuration operations.

```typescript
interface ErrorAggregator {
  /**
   * Adds an error to the collection
   * @param operation - Which operation failed (e.g., "Git configuration")
   * @param error - Error details
   */
  addError(operation: string, error: string): void;
  
  /**
   * Checks if any errors were collected
   * @returns true if errors exist
   */
  hasErrors(): boolean;
  
  /**
   * Formats all errors into user-friendly message
   * @returns Formatted error message with troubleshooting steps
   */
  formatErrors(): string;
  
  /**
   * Clears all collected errors
   */
  clear(): void;
}
```

**Design Rationale**: When setting a proxy, multiple operations occur (Git config, VSCode config, testing). If some fail, the user needs to know which succeeded and which failed, not just the first error encountered.

### 6. UserNotifier

Displays error messages and notifications to users.

```typescript
interface UserNotifier {
  /**
   * Shows error message with troubleshooting suggestions
   * @param message - Error message
   * @param suggestions - Array of troubleshooting steps
   */
  showError(message: string, suggestions?: string[]): void;
  
  /**
   * Shows success message
   * @param message - Success message
   */
  showSuccess(message: string): void;
  
  /**
   * Shows warning message
   * @param message - Warning message
   */
  showWarning(message: string): void;
}
```

**Design Rationale**: Centralizing user notifications makes it easier to ensure consistent messaging and allows for future enhancements like notification preferences.

## Data Models

### ProxyUrl

Represents a validated proxy URL with parsed components.

```typescript
interface ProxyUrl {
  protocol: 'http' | 'https';
  hostname: string;
  port?: number;
  username?: string;
  password?: string;
  
  /**
   * Returns full URL string
   */
  toString(): string;
  
  /**
   * Returns URL with masked password
   */
  toDisplayString(): string;
}
```

### ValidationError

Represents a validation error with context.

```typescript
interface ValidationError {
  field: 'protocol' | 'hostname' | 'port' | 'credentials' | 'security';
  message: string;
  suggestion?: string;
}
```

### ConfigurationState

Tracks which configuration operations succeeded.

```typescript
interface ConfigurationState {
  gitConfigured: boolean;
  vscodeConfigured: boolean;
  systemProxyDetected: boolean;
  lastError?: string;
}
```


## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Security Properties

**Property 1: Shell metacharacter rejection**
*For any* proxy URL containing shell metacharacters (`;`, `|`, `&`, `$`, `` ` ``, `\n`, `\r`, `<`, `>`, `(`, `)`), the validation function should reject the URL and return an error message.
**Validates: Requirements 1.1**

**Property 2: Valid character acceptance**
*For any* proxy URL containing only allowed characters (alphanumeric, dots, colons, hyphens, underscores, slashes, @ in credentials), the validation function should accept the URL if it is otherwise well-formed.
**Validates: Requirements 1.3**

**Property 3: Invalid URL prevention**
*For any* proxy URL that fails validation, the URL should not be saved to configuration or applied to Git/VSCode settings.
**Validates: Requirements 1.4**

**Property 4: Credential masking in logs**
*For any* proxy URL containing a password, when logged or displayed in error messages, the password portion should be replaced with asterisks or removed entirely.
**Validates: Requirements 1.5, 6.1, 6.3, 6.5**

**Property 5: Credential masking in UI**
*For any* proxy URL containing a password, when displayed in the status bar or UI elements, the password should be masked with asterisks.
**Validates: Requirements 6.2**

**Property 6: Storage and display separation**
*For any* proxy URL with credentials, the stored configuration should preserve the complete URL while all display operations should show the sanitized version.
**Validates: Requirements 6.4**

### Validation Properties

**Property 7: Protocol requirement**
*For any* proxy URL missing the `http://` or `https://` protocol prefix, the validation function should reject the URL with a message requesting the protocol.
**Validates: Requirements 3.2**

**Property 8: Port range validation**
*For any* proxy URL with a port number outside the range 1-65535, the validation function should reject the URL with a message showing the valid range.
**Validates: Requirements 3.3**

**Property 9: Hostname validation**
*For any* proxy URL with a hostname containing invalid characters (anything other than alphanumeric, dots, hyphens), the validation function should reject the URL with an explanation of hostname requirements.
**Validates: Requirements 3.4**

**Property 10: Pre-save validation**
*For any* proxy URL input, validation should complete before any save operation begins, ensuring invalid URLs never reach the configuration layer.
**Validates: Requirements 3.1**

**Property 11: Credential format validation**
*For any* proxy URL containing authentication credentials, the validator should verify that the username and password contain only allowed characters and are properly formatted.
**Validates: Requirements 4.2**

### Error Handling Properties

**Property 12: Error aggregation completeness**
*For any* set of configuration operations that fail, the final error message should contain information about all failures, not just the first one encountered.
**Validates: Requirements 2.5**

**Property 13: Connection test failure reporting**
*For any* proxy connection test that fails, the error message should include all test URLs that were attempted and at least one troubleshooting suggestion.
**Validates: Requirements 2.4**

**Property 14: Platform-specific command execution**
*For any* platform (Windows, macOS, Linux), shell commands should use syntax and escaping rules appropriate for that platform, preventing command execution failures.
**Validates: Requirements 5.1, 5.2, 5.3, 5.4**

**Property 15: Detection failure resilience**
*For any* platform where system proxy detection fails, the extension should continue operation and attempt alternative detection methods or allow manual configuration.
**Validates: Requirements 4.5, 5.5**

### Edge Cases and Examples

**Edge Case 1: Empty URL handling**
When the extension receives an empty string as a proxy URL, it should treat this as a request to disable the proxy rather than as an error.
**Validates: Requirements 4.1**

**Example 1: Git not installed error**
When Git is not installed on the system, the error message should specifically state "Git is not installed" rather than a generic error.
**Validates: Requirements 2.1**

**Example 2: Git permission error**
When Git commands fail due to permission issues, the error message should specifically mention permissions.
**Validates: Requirements 2.1**

**Example 3: VSCode configuration resilience**
When VSCode configuration fails, the extension should display an error but continue to attempt Git configuration.
**Validates: Requirements 2.2**

**Example 4: System proxy detection failure**
When system proxy detection fails, the extension should log the reason and inform the user that no system proxy was detected.
**Validates: Requirements 2.3**

**Example 5: Invalid system proxy format**
When the detected system proxy has an invalid format, the extension should skip it and continue checking other proxy sources.
**Validates: Requirements 3.5**

**Example 6: Git command timeout**
When a Git command exceeds the timeout threshold (5 seconds), the extension should cancel the operation and inform the user.
**Validates: Requirements 4.3**

**Example 7: Global state write failure**
When the extension cannot write to VSCode global state, it should log the error and continue operating with in-memory state.
**Validates: Requirements 4.4**

## Error Handling

### Error Categories

1. **Validation Errors**: User input does not meet format or security requirements
   - Response: Reject immediately, show specific validation error
   - User Action: Correct the input based on error message

2. **Configuration Errors**: Git or VSCode configuration operations fail
   - Response: Attempt to continue with other operations, aggregate errors
   - User Action: Check Git installation, permissions, or VSCode settings

3. **Detection Errors**: System proxy detection fails
   - Response: Log error, continue with manual configuration
   - User Action: Manually enter proxy URL

4. **Connection Errors**: Proxy connection test fails
   - Response: Show test URLs and troubleshooting steps
   - User Action: Verify proxy URL, check network connectivity

5. **System Errors**: Unexpected failures (state write, timeout)
   - Response: Log error, attempt graceful degradation
   - User Action: Restart VSCode or check system resources

### Error Message Format

All error messages should follow this structure:
```
[Operation] failed: [Specific reason]

What happened:
- [Detail 1]
- [Detail 2]

Suggestions:
- [Action 1]
- [Action 2]
```

Example:
```
Git proxy configuration failed: Git is not installed

What happened:
- The extension attempted to run 'git config --global http.proxy'
- Git command was not found in system PATH

Suggestions:
- Install Git from https://git-scm.com
- Ensure Git is added to your system PATH
- Restart VSCode after installing Git
```

### Error Recovery Strategies

1. **Partial Success**: If Git config succeeds but VSCode config fails, inform user of partial success
2. **Retry Logic**: For transient errors (timeouts), offer retry option
3. **Fallback Options**: If system detection fails, prompt for manual entry
4. **State Consistency**: If any operation fails mid-process, rollback to previous state

## Testing Strategy

### Unit Testing

Unit tests will verify specific scenarios and edge cases:

1. **Validation Edge Cases**:
   - Empty strings
   - URLs with only whitespace
   - URLs with mixed valid/invalid characters
   - Boundary port numbers (0, 1, 65535, 65536)
   - Various credential formats

2. **Platform-Specific Behavior**:
   - Command syntax on each platform
   - Escaping rules per platform
   - Detection methods per platform

3. **Error Scenarios**:
   - Git not installed
   - Git permission denied
   - Command timeout
   - State write failure

4. **Sanitization Examples**:
   - URLs with passwords in various positions
   - Special characters in passwords
   - Multiple @ symbols

### Property-Based Testing

Property-based tests will verify universal properties across many inputs using a PBT library appropriate for TypeScript (such as `fast-check`).

**Configuration**:
- Each property test should run a minimum of 100 iterations
- Each test must include a comment tag: `**Feature: security-and-error-handling, Property {number}: {property_text}**`
- Each correctness property must be implemented by a single property-based test

**Test Generators**:

1. **URL Generator**: Generates random valid proxy URLs
   - Random protocol (http/https)
   - Random valid hostname (alphanumeric + dots + hyphens)
   - Random valid port (1-65535) or none
   - Random credentials or none

2. **Invalid URL Generator**: Generates URLs with specific invalid characteristics
   - URLs with shell metacharacters
   - URLs without protocols
   - URLs with invalid ports
   - URLs with invalid hostnames

3. **Credential Generator**: Generates URLs with various credential formats
   - Different username/password lengths
   - Special characters in credentials
   - Edge cases (empty username, empty password)

**Property Test Examples**:

```typescript
// Property 1: Shell metacharacter rejection
test('Property 1: Shell metacharacter rejection', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant(';'), fc.constant('|'), fc.constant('&'),
        fc.constant('$'), fc.constant('`'), fc.constant('\n')
      ),
      fc.string(),
      (metachar, baseUrl) => {
        const url = `http://proxy.com${metachar}${baseUrl}`;
        const result = validator.validate(url);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('shell metacharacters');
      }
    ),
    { numRuns: 100 }
  );
});

// Property 4: Credential masking in logs
test('Property 4: Credential masking in logs', () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }),
      fc.string({ minLength: 1 }),
      (username, password) => {
        const url = `http://${username}:${password}@proxy.com:8080`;
        const masked = sanitizer.maskPassword(url);
        expect(masked).not.toContain(password);
        expect(masked).toContain('***');
      }
    ),
    { numRuns: 100 }
  );
});
```

### Integration Testing

Integration tests will verify end-to-end workflows:

1. **Set Proxy Flow**: Validate → Configure Git → Configure VSCode → Test Connection
2. **Detect Proxy Flow**: Detect System → Validate → Offer to Apply
3. **Disable Proxy Flow**: Remove Git Config → Remove VSCode Config → Verify Removal
4. **Error Recovery Flow**: Partial failure → Error aggregation → User notification

### Test Coverage Goals

- **Line Coverage**: Minimum 85%
- **Branch Coverage**: Minimum 80%
- **Property Coverage**: 100% of correctness properties must have corresponding tests
- **Platform Coverage**: All platform-specific code must be tested on respective platforms

## Implementation Phases

### Phase 1: Validation Layer (High Priority)
- Implement ProxyUrlValidator with all validation rules
- Implement InputSanitizer for credential masking
- Write property-based tests for validation and sanitization
- **Risk**: This is the security-critical component and must be correct

### Phase 2: Secure Command Execution (High Priority)
- Refactor GitConfigManager to use `execFile()` instead of `exec()`
- Implement platform-specific command builders
- Add timeout handling
- Write tests for command execution safety
- **Risk**: Incorrect implementation could still allow command injection

### Phase 3: Error Handling (Medium Priority)
- Implement ErrorAggregator
- Implement UserNotifier with formatted messages
- Add error recovery logic
- Write tests for error scenarios
- **Risk**: Poor error messages lead to user frustration

### Phase 4: System Proxy Detection (Low Priority)
- Implement platform-specific detection
- Add fallback logic
- Write tests for detection on each platform
- **Risk**: Detection may fail on some systems, but manual entry is available

### Phase 5: Integration and Testing (Medium Priority)
- Integration tests for complete flows
- Manual testing on all platforms
- Security review of validation and command execution
- **Risk**: Platform-specific issues may only appear in real environments

## Security Considerations

### Threat Model

**Threat**: Malicious proxy URL leads to command injection
- **Attack Vector**: User enters URL like `http://proxy.com; rm -rf /`
- **Mitigation**: Whitelist validation + parameterized commands
- **Residual Risk**: Low (defense in depth)

**Threat**: Credentials exposed in logs or UI
- **Attack Vector**: Logs or screenshots reveal proxy passwords
- **Mitigation**: Mask passwords in all display contexts
- **Residual Risk**: Low (credentials still in config files, but that's expected)

**Threat**: Malicious system proxy detected and applied
- **Attack Vector**: Attacker modifies system proxy settings
- **Mitigation**: Validate detected proxies before applying
- **Residual Risk**: Medium (if system is compromised, many attacks possible)

### Security Testing

1. **Fuzzing**: Generate thousands of malformed URLs to test validator
2. **Injection Testing**: Attempt various command injection patterns
3. **Credential Leakage**: Verify passwords never appear in logs or UI
4. **Platform Testing**: Test escaping on all platforms with dangerous inputs

## Performance Considerations

- **Validation**: O(n) where n is URL length, negligible for typical URLs
- **Command Execution**: Timeout set to 5 seconds to prevent hanging
- **Error Aggregation**: O(m) where m is number of operations, typically 2-3
- **System Detection**: May take 1-2 seconds on some platforms, run asynchronously

## Dependencies

- **Node.js**: `child_process.execFile` for secure command execution
- **VSCode API**: Configuration API for settings management
- **Testing**: `fast-check` for property-based testing, `jest` or `mocha` for unit tests
- **Platform Detection**: Node.js `os` module for platform identification

## Future Enhancements

1. **Proxy Auto-Configuration (PAC)**: Support PAC file URLs
2. **Proxy Authentication**: Prompt for credentials if not in URL
3. **Connection Testing**: More sophisticated proxy connectivity tests
4. **Proxy Profiles**: Save multiple proxy configurations for quick switching
5. **Audit Logging**: Log all proxy configuration changes for security auditing
