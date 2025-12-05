# Requirements Document

## Introduction

This document specifies requirements for improving the security and error handling of the otak-proxy VSCode extension. The extension currently has critical security vulnerabilities in shell command execution and insufficient error handling that can lead to poor user experience and potential security risks.

## Glossary

- **Extension**: The otak-proxy VSCode extension
- **Proxy URL**: A URL string in the format `http://proxy.example.com:8080` or `https://proxy.example.com:8080`
- **Shell Command**: Operating system commands executed via Node.js child_process
- **Git Configuration**: Global Git proxy settings stored in `.gitconfig`
- **VSCode Configuration**: VSCode workspace/user settings for HTTP proxy
- **System Proxy**: Operating system or browser proxy settings
- **Malicious Input**: User input containing shell metacharacters or command injection attempts
- **Shell Metacharacter**: Special characters interpreted by shells (e.g., `;`, `|`, `&`, `$`, backticks, newlines)

## Requirements

### Requirement 1

**User Story:** As a user, I want the extension to safely handle proxy URLs, so that malicious input cannot execute arbitrary commands on my system.

#### Acceptance Criteria

1. WHEN a user provides a proxy URL containing shell metacharacters THEN the Extension SHALL reject the URL and display an error message
2. WHEN the Extension executes Git configuration commands THEN the Extension SHALL use parameterized command execution or proper escaping to prevent command injection
3. WHEN the Extension validates a proxy URL THEN the Extension SHALL verify the URL contains only alphanumeric characters, dots, colons, hyphens, underscores, slashes, and the @ symbol in allowed positions
4. WHEN the Extension detects invalid characters in a proxy URL THEN the Extension SHALL prevent the URL from being saved or applied
5. WHEN the Extension formats proxy URLs for display THEN the Extension SHALL sanitize passwords and special characters

### Requirement 2

**User Story:** As a user, I want clear feedback when proxy operations fail, so that I can understand what went wrong and how to fix it.

#### Acceptance Criteria

1. WHEN Git configuration fails THEN the Extension SHALL display a specific error message indicating whether Git is not installed, not in PATH, or lacks permissions
2. WHEN VSCode configuration fails THEN the Extension SHALL display an error message and continue with Git configuration
3. WHEN system proxy detection fails THEN the Extension SHALL log the failure reason and inform the user that no system proxy was detected
4. WHEN proxy connection testing fails THEN the Extension SHALL display which test URLs were attempted and suggest troubleshooting steps
5. WHEN multiple configuration operations fail THEN the Extension SHALL aggregate error messages and display them together with context

### Requirement 3

**User Story:** As a user, I want the extension to validate proxy URLs before applying them, so that I don't configure invalid settings.

#### Acceptance Criteria

1. WHEN a user enters a proxy URL THEN the Extension SHALL validate the URL format before saving
2. WHEN a proxy URL is missing the protocol THEN the Extension SHALL reject the URL and request the user include `http://` or `https://`
3. WHEN a proxy URL contains an invalid port number THEN the Extension SHALL reject the URL and display the valid port range (1-65535)
4. WHEN a proxy URL contains an invalid hostname THEN the Extension SHALL reject the URL and explain hostname requirements
5. WHEN the Extension detects a system proxy with invalid format THEN the Extension SHALL skip that proxy and continue checking other sources

### Requirement 4

**User Story:** As a developer, I want the extension to handle edge cases gracefully, so that unexpected inputs don't crash the extension or leave it in an inconsistent state.

#### Acceptance Criteria

1. WHEN the Extension receives an empty proxy URL THEN the Extension SHALL treat it as disabling the proxy
2. WHEN the Extension receives a proxy URL with authentication credentials THEN the Extension SHALL validate and properly escape the credentials
3. WHEN Git commands timeout THEN the Extension SHALL cancel the operation and inform the user
4. WHEN the Extension cannot write to global state THEN the Extension SHALL log the error and attempt to continue with in-memory state
5. WHEN system proxy detection commands fail on any platform THEN the Extension SHALL gracefully fall back to the next detection method

### Requirement 5

**User Story:** As a user, I want consistent behavior across different operating systems, so that the extension works reliably regardless of my platform.

#### Acceptance Criteria

1. WHEN the Extension executes shell commands on Windows THEN the Extension SHALL use Windows-compatible command syntax
2. WHEN the Extension executes shell commands on macOS THEN the Extension SHALL use macOS-compatible command syntax
3. WHEN the Extension executes shell commands on Linux THEN the Extension SHALL use Linux-compatible command syntax
4. WHEN the Extension escapes shell arguments THEN the Extension SHALL use platform-specific escaping rules
5. WHEN the Extension detects system proxy settings THEN the Extension SHALL use platform-appropriate detection methods

### Requirement 6

**User Story:** As a security-conscious user, I want the extension to protect sensitive information, so that my proxy credentials are not exposed in logs or error messages.

#### Acceptance Criteria

1. WHEN the Extension logs proxy URLs containing passwords THEN the Extension SHALL mask the password portion
2. WHEN the Extension displays proxy URLs in the status bar THEN the Extension SHALL mask passwords with asterisks
3. WHEN the Extension displays error messages containing proxy URLs THEN the Extension SHALL sanitize any authentication credentials
4. WHEN the Extension stores proxy URLs in configuration THEN the Extension SHALL preserve the original URL but sanitize it for display
5. WHEN the Extension tests proxy connections THEN the Extension SHALL not log the full URL with credentials in plain text
