# Implementation Plan

- [x] 1. Refactor activate function to ensure proper initialization order
  - Extract command registration logic into a separate `registerCommands` function
  - Extract initial setup logic into a separate `performInitialSetup` function
  - Reorder activation steps: initialize core components → register commands → display status bar → perform initial setup
  - _Requirements: 1.1, 5.1_

- [x] 1.1 Write property test for command registration order
  - **Property 1: Command registration precedes status bar display**
  - **Validates: Requirements 1.1, 5.1**

- [x] 2. Create registerCommands helper function
  - Move all command registration code from activate function
  - Register toggleProxy, configureUrl, testProxy, and importProxy commands
  - Register configuration change listener
  - Register window focus listener
  - Add all disposables to context.subscriptions
  - _Requirements: 1.1, 5.1_

- [x] 2.1 Write unit test for registerCommands function
  - Verify all commands are registered
  - Verify command IDs are correct
  - _Requirements: 1.1, 5.1_

- [x] 3. Create performInitialSetup helper function
  - Move initial setup logic from activate function
  - Check hasInitialSetup flag
  - Call askForInitialSetup if needed
  - Apply current proxy settings
  - Handle errors gracefully with try-catch
  - _Requirements: 1.4, 5.3_

- [x] 3.1 Write unit test for performInitialSetup function
  - Test with hasInitialSetup=true (skip setup)
  - Test with hasInitialSetup=false (run setup)
  - Test error handling
  - _Requirements: 1.4, 5.3_

- [x] 4. Enhance testProxy command with action buttons
  - Modify error message when no proxy is configured to include action buttons
  - Add "Configure Manual" button that executes otak-proxy.configureUrl
  - Add "Import System" button that executes otak-proxy.importProxy
  - Add "Cancel" button to dismiss the message
  - _Requirements: 3.1, 3.2_

- [x] 4.1 Write property test for testProxy command behavior
  - **Property 5: Test result display**
  - **Validates: Requirements 3.4**

- [x] 4.2 Write unit test for testProxy error message
  - Test error message when no proxy is configured
  - Verify action buttons are present
  - _Requirements: 3.1, 3.2_

- [x] 5. Add error handling to all command handlers
  - Wrap each command handler logic in try-catch block
  - Log errors using Logger.error
  - Display user-friendly error messages using userNotifier.showError
  - Include troubleshooting suggestions in error messages
  - _Requirements: 1.4, 4.4_

- [x] 5.1 Write property test for error handling
  - **Property 6: Error handling for detection failures**
  - **Validates: Requirements 4.4**

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement command link validation in updateStatusBar
  - Add verification that all command links reference registered commands
  - Log warning if unregistered command is referenced
  - _Requirements: 5.4_

- [x] 7.1 Write property test for command link validity
  - **Property 8: Command link validity**
  - **Validates: Requirements 5.4**

- [x] 8. Write property test for command execution
  - **Property 2: Command links are executable**
  - **Validates: Requirements 1.3**

- [x] 9. Write property test for valid proxy URL persistence
  - **Property 3: Valid proxy URL persistence**
  - **Validates: Requirements 2.2**

- [x] 10. Write property test for invalid proxy URL rejection
  - **Property 4: Invalid proxy URL rejection**
  - **Validates: Requirements 2.4**

- [x] 11. Write property test for command dependency verification
  - **Property 7: Command dependency verification**
  - **Validates: Requirements 5.2**

- [x] 12. Write integration test for full activation flow
  - Test complete activation from start to finish
  - Verify all commands are executable after activation
  - Verify status bar is displayed correctly
  - _Requirements: 1.1, 1.2, 1.3, 5.1_

- [x] 13. Write unit tests for edge cases
  - Test command execution with uninitialized state
  - Test configureUrl with empty input
  - Test configureUrl with cancelled input
  - Test importProxy with no system proxy detected
  - Test importProxy with detection failure
  - _Requirements: 1.4, 2.1, 2.3, 4.3, 4.4, 5.3_

- [x] 14. Final Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
