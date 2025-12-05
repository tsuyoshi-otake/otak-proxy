# Implementation Plan

## Current State Analysis
The extension currently has:
- Basic `validateProxyUrl()` function using URL class (protocol, hostname, port validation)
- Basic `sanitizeProxyUrl()` function that masks passwords
- Basic `escapeShellArg()` function for shell escaping (INCOMPLETE - needs proper implementation)
- Git proxy configuration using `exec()` with string concatenation (CRITICAL SECURITY RISK)
- System proxy detection for Windows, macOS, and Linux
- VSCode configuration management
- Basic test infrastructure with Mocha and Sinon
- NO property-based testing infrastructure
- NO comprehensive input validation (shell metacharacter detection missing)
- NO structured error handling or aggregation
- NO separation of concerns (all code in single extension.ts file)

## Remaining Implementation Tasks

- [x] 1. Set up property-based testing infrastructure
  - Install fast-check package (`npm install --save-dev fast-check`)
  - Create `src/test/generators.ts` with URL generators for property tests
  - Configure test runner to support property-based tests
  - Set up test configuration for minimum 100 iterations per property test
  - _Requirements: All (testing foundation)_


- [x] 2. Create ProxyUrlValidator class with comprehensive validation
  - Create `src/validation/ProxyUrlValidator.ts` file
  - Extract existing `validateProxyUrl()` logic into ProxyUrlValidator class
  - Add `containsShellMetacharacters()` method to detect (`;`, `|`, `&`, `` ` ``, `\n`, `\r`, `<`, `>`, `(`, `)`)
  - Add strict character whitelist validation for hostname (alphanumeric, dots, hyphens only)
  - Add credential format validation (alphanumeric, hyphens, underscores, @ only)
  - Create ValidationResult interface with `isValid: boolean` and `errors: string[]`
  - Create ValidationError interface with `field` and `message` properties
  - _Requirements: 1.1, 1.3, 1.4, 3.1, 3.2, 3.3, 3.4, 4.2_

- [x] 2.1 Write property test for shell metacharacter rejection






  - **Property 1: Shell metacharacter rejection**
  - **Validates: Requirements 1.1**

- [x] 2.2 Write property test for valid character acceptance






  - **Property 2: Valid character acceptance**
  - **Validates: Requirements 1.3**

- [x] 2.3 Write property test for protocol requirement






  - **Property 7: Protocol requirement**
  - **Validates: Requirements 3.2**


- [x] 2.4 Write property test for port range validation





  - **Property 8: Port range validation**
  - **Validates: Requirements 3.3**


- [x] 2.5 Write property test for hostname validation





  - **Property 9: Hostname validation**
  - **Validates: Requirements 3.4**

- [x] 2.6 Write property test for credential format validation






  - **Property 11: Credential format validation**
  - **Validates: Requirements 4.2**



- [x] 2.7 Write unit tests for validation edge cases





  - Test empty strings, whitespace-only URLs
  - Test boundary port numbers (0, 1, 65535, 65536)
  - Test various credential formats
  - _Requirements: 1.1, 1.3, 3.2, 3.3, 3.4, 4.1_

- [x] 3. Create InputSanitizer class for credential protection







  - Create `src/validation/InputSanitizer.ts` file
  - Extract existing `sanitizeProxyUrl()` logic into InputSanitizer class
  - Implement `maskPassword()` method (replace password with asterisks)
  - Implement `removeCredentials()` method (remove username:password entirely)
  - Handle edge cases (no credentials, malformed URLs, multiple @ symbols)
  - Ensure consistent masking across all display contexts
  - _Requirements: 1.5, 6.1, 6.2, 6.3, 6.4, 6.5_


- [x] 3.1 Write property test for credential masking in logs




  - **Property 4: Credential masking in logs**
  - **Validates: Requirements 1.5, 6.1, 6.3, 6.5**

- [x] 3.2 Write property test for credential masking in UI




  - **Property 5: Credential masking in UI**
  - **Validates: Requirements 6.2**

- [x] 3.3 Write property test for storage and display separation






  - **Property 6: Storage and display separation**
  - **Validates: Requirements 6.4**



- [x]* 3.4 Write unit tests for sanitization edge cases




  - Test URLs with passwords in various positions
  - Test special characters in passwords
  - Test multiple @ symbols
  - _Requirements: 1.5, 6.1, 6.2, 6.3, 6.4, 6.5_


- [x] 4. Create ProxyUrl data model




  - Create ProxyUrl interface with protocol, hostname, port, credentials
  - Implement toString() method
  - Implement toDisplayString() method using InputSanitizer
  - _Requirements: 6.4_

- [x] 5. Refactor GitConfigManager for secure command execution (CRITICAL SECURITY FIX)








  - Create GitConfigManager class to encapsulate Git operations
  - Replace `exec()` with `execFile()` to prevent shell interpretation
  - Implement setProxy() with parameterized command execution and timeout (5 seconds)
  - Implement unsetProxy() method
  - Implement getProxy() method
  - Parse stderr to determine specific error types (NOT_INSTALLED, NO_PERMISSION, TIMEOUT)
  - Create OperationResult type with success status and error details
  - Remove `escapeShellArg()` function (no longer needed with execFile)
  - _Requirements: 1.2, 2.1, 4.3, 5.1, 5.2, 5.3, 5.4_

- [ ]* 5.1 Write property test for invalid URL prevention
  - **Property 3: Invalid URL prevention**
  - **Validates: Requirements 1.4**

- [ ]* 5.2 Write property test for pre-save validation
  - **Property 10: Pre-save validation**
  - **Validates: Requirements 3.1**

- [ ]* 5.3 Write property test for platform-specific command execution
  - **Property 14: Platform-specific command execution**
  - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

- [ ]* 5.4 Write unit tests for Git configuration scenarios
  - Test Git not installed error (Example 1)
  - Test Git permission error (Example 2)
  - Test Git command timeout (Example 6)
  - _Requirements: 2.1, 4.3_

- [x] 6. Create VscodeConfigManager class





  - Extract VSCode configuration logic into VscodeConfigManager class
  - Implement setProxy() method using VSCode configuration API
  - Implement unsetProxy() method
  - Implement getProxy() method
  - Add comprehensive error handling for configuration failures
  - _Requirements: 2.2_

- [ ]* 6.1 Write unit test for VSCode configuration resilience
  - **Example 3: VSCode configuration resilience**
  - **Validates: Requirements 2.2**


- [x] 7. Refactor SystemProxyDetector into a class




  - Extract existing `detectSystemProxySettings()` into SystemProxyDetector class
  - Ensure validation of detected proxy URLs using ProxyUrlValidator
  - Improve error handling and logging for detection failures
  - Add graceful fallback when detection fails on any platform
  - _Requirements: 2.3, 3.5, 4.5, 5.5_

- [ ]* 7.1 Write property test for detection failure resilience
  - **Property 15: Detection failure resilience**
  - **Validates: Requirements 4.5, 5.5**

- [ ]* 7.2 Write unit tests for system proxy detection
  - Test system proxy detection failure (Example 4)
  - Test invalid system proxy format (Example 5)
  - Test platform-specific detection methods
  - _Requirements: 2.3, 3.5, 5.1, 5.2, 5.3, 5.5_

- [x] 8. Implement ErrorAggregator for multi-operation error handling





  - Create ErrorAggregator class
  - Implement addError() method to collect errors from multiple operations
  - Implement hasErrors() method
  - Implement formatErrors() method with structured, user-friendly output
  - Implement clear() method
  - _Requirements: 2.5_

- [ ]* 8.1 Write property test for error aggregation completeness
  - **Property 12: Error aggregation completeness**
  - **Validates: Requirements 2.5**

- [ ]* 8.2 Write unit tests for error aggregation
  - Test single error formatting
  - Test multiple error aggregation
  - Test error message structure
  - _Requirements: 2.5_


- [x] 9. Implement UserNotifier for consistent user feedback




  - Create UserNotifier class
  - Implement showError() method with VSCode error notifications
  - Implement showSuccess() method
  - Implement showWarning() method
  - Format messages with troubleshooting suggestions following design document format
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ]* 9.1 Write property test for connection test failure reporting
  - **Property 13: Connection test failure reporting**
  - **Validates: Requirements 2.4**

- [ ]* 9.2 Write unit tests for user notifications
  - Test error message formatting
  - Test suggestion inclusion
  - Test different notification types
  - _Requirements: 2.1, 2.2, 2.3, 2.4_


- [x] 10. Enhance ConfigurationState tracking



  - Extend existing ProxyState interface to track operation success/failure
  - Track which operations (Git, VSCode) succeeded/failed
  - Add error handling for state write failures with graceful degradation
  - _Requirements: 4.4_

- [ ]* 10.1 Write unit test for global state write failure
  - **Example 7: Global state write failure**
  - **Validates: Requirements 4.4**

- [x] 11. Refactor applyProxySettings with validation and error handling




  - Integrate ProxyUrlValidator before any configuration
  - Use InputSanitizer for all display operations
  - Use ErrorAggregator to collect errors from Git and VSCode config
  - Use UserNotifier for consistent error messages
  - Update status bar with sanitized proxy URL
  - Handle empty URL as disable proxy (Edge Case 1)
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.2, 2.5, 3.1, 4.1, 6.2_

- [ ]* 11.1 Write unit test for empty URL handling
  - **Edge Case 1: Empty URL handling**
  - **Validates: Requirements 4.1**


- [x] 12. Refactor detectSystemProxySettings command with validation




  - Use SystemProxyDetector class
  - Validate detected proxy with ProxyUrlValidator before applying
  - Display sanitized proxy URL to user using InputSanitizer
  - Handle detection failures gracefully with UserNotifier
  - _Requirements: 2.3, 3.5, 4.5_


- [x] 13. Refactor proxy disable operations with error handling




  - Use GitConfigManager.unsetProxy()
  - Use VscodeConfigManager.unsetProxy()
  - Use ErrorAggregator for any failures
  - Use UserNotifier for feedback
  - Update status bar to show proxy disabled
  - _Requirements: 2.5_


- [x] 14. Enhance testProxy command with comprehensive error reporting




  - Use ErrorAggregator to collect test failures from multiple URLs
  - Display attempted URLs in error messages
  - Provide troubleshooting suggestions via UserNotifier
  - _Requirements: 2.4_

- [x] 15. Add comprehensive logging with credential sanitization





  - Create logging utility that uses InputSanitizer
  - Replace all console.log and console.error calls with sanitized logging
  - Ensure no credentials appear in any log output
  - _Requirements: 6.1, 6.5_


- [x] 16. Checkpoint - Ensure all tests pass




  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Integration testing






  - Write integration test for complete setProxy flow
  - Write integration test for detectProxy flow
  - Write integration test for disableProxy flow
  - Write integration test for error recovery scenarios
  - Test on Windows, macOS, and Linux platforms
  - _Requirements: All_

- [x] 18. Security testing






  - Perform fuzzing with malformed URLs
  - Test command injection patterns
  - Verify credential leakage prevention
  - Test platform-specific escaping with dangerous inputs
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 6.1, 6.2, 6.3, 6.4, 6.5_
