# Implementation Plan

- [ ] 1. Set up testing infrastructure
  - Create test directory structure for unit and property-based tests
  - Install and configure fast-check for property-based testing
  - Install and configure testing framework (Jest or Mocha)
  - Set up test utilities and helpers
  - _Requirements: All (testing foundation)_

- [ ] 2. Implement ProxyUrlValidator
  - Create ProxyUrlValidator class with validate() method
  - Implement protocol validation (http/https requirement)
  - Implement hostname validation (alphanumeric, dots, hyphens only)
  - Implement port validation (1-65535 range)
  - Implement credential format validation
  - Implement shell metacharacter detection
  - Create ValidationResult and ValidationError types
  - _Requirements: 1.1, 1.3, 1.4, 3.1, 3.2, 3.3, 3.4, 4.2_

- [ ]* 2.1 Write property test for shell metacharacter rejection
  - **Property 1: Shell metacharacter rejection**
  - **Validates: Requirements 1.1**

- [ ]* 2.2 Write property test for valid character acceptance
  - **Property 2: Valid character acceptance**
  - **Validates: Requirements 1.3**

- [ ]* 2.3 Write property test for protocol requirement
  - **Property 7: Protocol requirement**
  - **Validates: Requirements 3.2**

- [ ]* 2.4 Write property test for port range validation
  - **Property 8: Port range validation**
  - **Validates: Requirements 3.3**

- [ ]* 2.5 Write property test for hostname validation
  - **Property 9: Hostname validation**
  - **Validates: Requirements 3.4**

- [ ]* 2.6 Write property test for credential format validation
  - **Property 11: Credential format validation**
  - **Validates: Requirements 4.2**

- [ ]* 2.7 Write unit tests for validation edge cases
  - Test empty strings, whitespace-only URLs
  - Test boundary port numbers (0, 1, 65535, 65536)
  - Test various credential formats
  - _Requirements: 1.1, 1.3, 3.2, 3.3, 3.4, 4.1_

- [ ] 3. Implement InputSanitizer
  - Create InputSanitizer class with maskPassword() method
  - Implement removeCredentials() method
  - Handle edge cases (no credentials, malformed URLs)
  - _Requirements: 1.5, 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ]* 3.1 Write property test for credential masking in logs
  - **Property 4: Credential masking in logs**
  - **Validates: Requirements 1.5, 6.1, 6.3, 6.5**

- [ ]* 3.2 Write property test for credential masking in UI
  - **Property 5: Credential masking in UI**
  - **Validates: Requirements 6.2**

- [ ]* 3.3 Write property test for storage and display separation
  - **Property 6: Storage and display separation**
  - **Validates: Requirements 6.4**

- [ ]* 3.4 Write unit tests for sanitization edge cases
  - Test URLs with passwords in various positions
  - Test special characters in passwords
  - Test multiple @ symbols
  - _Requirements: 1.5, 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ] 4. Implement ProxyUrl data model
  - Create ProxyUrl interface with protocol, hostname, port, credentials
  - Implement toString() method
  - Implement toDisplayString() method with sanitization
  - _Requirements: 6.4_

- [ ] 5. Refactor GitConfigManager for secure command execution
  - Replace exec() calls with execFile() for parameterized execution
  - Implement setProxy() method with timeout handling
  - Implement unsetProxy() method
  - Implement getProxy() method
  - Add platform-specific command builders (Windows, macOS, Linux)
  - Parse stderr to determine specific error types (NOT_INSTALLED, NO_PERMISSION, TIMEOUT)
  - Create OperationResult type
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

- [ ] 6. Implement VscodeConfigManager
  - Create VscodeConfigManager class
  - Implement setProxy() method using VSCode configuration API
  - Implement unsetProxy() method
  - Implement getProxy() method
  - Add error handling for configuration failures
  - _Requirements: 2.2_

- [ ]* 6.1 Write unit test for VSCode configuration resilience
  - **Example 3: VSCode configuration resilience**
  - **Validates: Requirements 2.2**

- [ ] 7. Implement SystemProxyDetector
  - Create SystemProxyDetector class with detectSystemProxy() method
  - Implement Windows detection (registry query via reg command)
  - Implement macOS detection (scutil --proxy parsing)
  - Implement Linux detection (environment variables)
  - Add validation of detected proxy URLs
  - Implement graceful fallback when detection fails
  - _Requirements: 2.3, 3.5, 4.5, 5.5_

- [ ]* 7.1 Write property test for detection failure resilience
  - **Property 15: Detection failure resilience**
  - **Validates: Requirements 4.5, 5.5**

- [ ]* 7.2 Write unit tests for system proxy detection
  - Test system proxy detection failure (Example 4)
  - Test invalid system proxy format (Example 5)
  - Test platform-specific detection methods
  - _Requirements: 2.3, 3.5, 5.1, 5.2, 5.3, 5.5_

- [ ] 8. Implement ErrorAggregator
  - Create ErrorAggregator class
  - Implement addError() method
  - Implement hasErrors() method
  - Implement formatErrors() method with structured output
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

- [ ] 9. Implement UserNotifier
  - Create UserNotifier class
  - Implement showError() method with VSCode error notifications
  - Implement showSuccess() method
  - Implement showWarning() method
  - Format messages with troubleshooting suggestions
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ]* 9.1 Write property test for connection test failure reporting
  - **Property 13: Connection test failure reporting**
  - **Validates: Requirements 2.4**

- [ ]* 9.2 Write unit tests for user notifications
  - Test error message formatting
  - Test suggestion inclusion
  - Test different notification types
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ] 10. Implement ConfigurationState tracking
  - Create ConfigurationState interface
  - Track which operations succeeded/failed
  - Implement state persistence to VSCode global state
  - Add error handling for state write failures
  - _Requirements: 4.4_

- [ ]* 10.1 Write unit test for global state write failure
  - **Example 7: Global state write failure**
  - **Validates: Requirements 4.4**

- [ ] 11. Update setProxy command with validation and error handling
  - Integrate ProxyUrlValidator before any configuration
  - Use InputSanitizer for all display operations
  - Use ErrorAggregator to collect errors from Git and VSCode config
  - Update status bar with sanitized proxy URL
  - Handle empty URL as disable proxy (Edge Case 1)
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.2, 2.5, 3.1, 4.1, 6.2_

- [ ]* 11.1 Write unit test for empty URL handling
  - **Edge Case 1: Empty URL handling**
  - **Validates: Requirements 4.1**

- [ ] 12. Update detectProxy command with validation
  - Use SystemProxyDetector to find system proxy
  - Validate detected proxy with ProxyUrlValidator
  - Display sanitized proxy URL to user
  - Handle detection failures gracefully
  - _Requirements: 2.3, 3.5, 4.5_

- [ ] 13. Update disableProxy command with error handling
  - Use GitConfigManager.unsetProxy()
  - Use VscodeConfigManager.unsetProxy()
  - Use ErrorAggregator for any failures
  - Update status bar to show proxy disabled
  - _Requirements: 2.5_

- [ ] 14. Update testProxy command with error reporting
  - Test proxy connection to multiple URLs
  - Use ErrorAggregator to collect test failures
  - Display attempted URLs and troubleshooting suggestions
  - _Requirements: 2.4_

- [ ] 15. Add logging with credential sanitization
  - Create logging utility that uses InputSanitizer
  - Replace all direct logging of proxy URLs
  - Ensure no credentials appear in logs
  - _Requirements: 6.1, 6.5_

- [ ] 16. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ]* 17. Integration testing
  - Write integration test for complete setProxy flow
  - Write integration test for detectProxy flow
  - Write integration test for disableProxy flow
  - Write integration test for error recovery scenarios
  - Test on Windows, macOS, and Linux platforms
  - _Requirements: All_

- [ ]* 18. Security testing
  - Perform fuzzing with malformed URLs
  - Test command injection patterns
  - Verify credential leakage prevention
  - Test platform-specific escaping with dangerous inputs
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 6.1, 6.2, 6.3, 6.4, 6.5_
