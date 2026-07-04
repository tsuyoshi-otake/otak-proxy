<div align="center">

# otak-proxy

**One-click proxy switching after initial setup for VS Code, Git, npm, and integrated terminals.**
otak-proxy lets you flip between Auto and Off from the status bar, follows your system proxy automatically, and keeps every open VS Code/Cursor window in sync.

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/odangoo.otak-proxy?label=Marketplace&color=1d4ed8)](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-proxy)
[![VS Code engine](https://img.shields.io/badge/VS%20Code-%5E1.97.0-007acc)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-otak--proxy-24292f)](https://github.com/tsuyoshi-otake/otak-proxy)

![One-click switching](https://img.shields.io/badge/switching-one%20click-1d4ed8)
![Auto system proxy](https://img.shields.io/badge/system%20proxy-auto%20follow-0f766e)
![Multi-instance sync](https://img.shields.io/badge/multi--instance-synced-2563eb)
![No telemetry](https://img.shields.io/badge/telemetry-none-64748b)
![16 UI languages](https://img.shields.io/badge/languages-16-7c3aed)

[**Install**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-proxy) ·
[**GitHub**](https://github.com/tsuyoshi-otake/otak-proxy) ·
[**Report an issue**](https://github.com/tsuyoshi-otake/otak-proxy/issues)

</div>

---

Working behind a corporate proxy usually means editing several configuration files by hand: VS Code settings, the Git config, the npm config, and the environment variables your terminals inherit. Keeping them aligned, and remembering to turn them all off again, is tedious and error-prone. **otak-proxy reduces the workflow to a single status-bar click after initial setup** and keeps VS Code, Git, npm, and new integrated terminals in step, with an Auto mode that follows your system proxy in the background.

![otak-proxy](images/otak-proxy.png)

## Quick Start

### Auto Mode

1. **Install** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-proxy).
2. Click the status bar to switch to **Auto**.
3. otak-proxy applies the system proxy to VS Code, Git, npm, and new integrated terminals.
4. Click the status bar again to switch **Off** and clear managed proxy settings.

### Optional Fallback Proxy

1. **Install** the extension.
2. Run `otak: Configure Manual Proxy`.
3. Enter a fallback proxy URL (for example: `http://proxy.example.com:8080`).

The configured URL is used as an Auto fallback when the system proxy is unavailable. If your proxy URL includes credentials, read [Security & Privacy](#security--privacy) before allowing writes to VS Code, Git, or npm configuration files.

## Capabilities

- **Two-state toggle**: Off and Auto, cycled from the status bar.
- **Auto mode**: reads the system proxy and applies changes in the background.
- **Optional fallback proxy**: uses a configured proxy URL when the system proxy is unavailable.
- **Status-bar control**: switch modes without leaving your editor.
- **Connection test**: checks whether a proxy can be reached before enabling it.
- **Automatic connection testing**: in Auto mode, periodically verifies that the active proxy is still reachable.
- **Diagnostics and safe remediation**: records sanitized diagnostics, retries eligible apply failures once, and suppresses repair loops when another tool keeps rewriting settings.
- **Credential-aware storage**: stores proxy credentials in VS Code SecretStorage where available and keeps sync/global state sanitized.
- **Windows diagnostics**: reads WinINET/WinHTTP/PAC/WPAD state without mutating Windows settings; WinHTTP reset is available only as a user-approved command.
- **Multi-instance sync**: shares proxy settings across all open VS Code/Cursor windows so they stay in step.
- **Integrated terminals**: sets `HTTP_PROXY` and `HTTPS_PROXY` for new VS Code terminals.
- **URL display setting**: hide the proxy URL in the status bar when needed.
- **Localized interface**: UI follows your VS Code display language across 16 languages.

## How It Works

### Status Bar

Click the proxy indicator to cycle through states:

```
Off -> Auto -> Off
```

Older saved Manual states are migrated to Auto when loaded. A configured proxy URL can still be used as the Auto fallback.

### Status Indicators

- `Proxy: Off` — Proxy is disabled
- `Auto: http://...` — Synced with the system proxy
- `Auto (Fallback): http://...` — The system proxy is unavailable; using the configured fallback proxy
- `Auto: OFF` — No proxy is currently available

When `otakProxy.showProxyUrl` is `false`, the URL is replaced with `Configured` (for example, `Auto: Configured`).

### Auto Detection Scope

Auto detection uses `otakProxy.detectionSourcePriority`, such as environment variables, VS Code settings, and platform proxy settings. Platform-specific behavior can differ between local Windows, macOS, Linux, WSL, containers, and remote extension hosts. Windows registry and WinHTTP actions are available only when the extension host is running on local Windows.

### Integrated Terminal Environment

When the proxy is enabled, otak-proxy sets these variables for **newly created** VS Code integrated terminals:

- `HTTP_PROXY` / `HTTPS_PROXY`
- `http_proxy` / `https_proxy` on non-Windows hosts

Existing terminals keep their current environment. Open a new terminal for the updated values to take effect. When `otakProxy.terminalOffMaskingEnabled` is enabled and proxy mode is Off, otak-proxy masks inherited proxy variables for new terminals by replacing them with empty values; this avoids VS Code-launched tools accidentally continuing to use a proxy inherited from the editor process.

## Settings

### Common Settings

```json
{
  "otakProxy.proxyUrl": "http://proxy.example.com:8080",
  "otakProxy.pollingInterval": 30,
  "otakProxy.enableFallback": true,
  "otakProxy.showProxyUrl": true,
  "otakProxy.autoTestEnabled": true,
  "otakProxy.testInterval": 60,
  "otakProxy.credentialTargetPolicy": "ask"
}
```

For stricter corporate environments, prefer:

```json
{
  "otakProxy.credentialTargetPolicy": "blockPlaintextTargets"
}
```

### Advanced Settings

```json
{
  "otakProxy.syncEnabled": true,
  "otakProxy.syncInterval": 1000,
  "otakProxy.detectionSourcePriority": ["environment", "vscode", "platform"],
  "otakProxy.maxRetries": 3,
  "otakProxy.diagnosticsEnabled": true,
  "otakProxy.automaticRemediationEnabled": true,
  "otakProxy.hostUserLockEnabled": true,
  "otakProxy.automaticRetryEnabled": true,
  "otakProxy.remediationDelayedRetryMs": 2000,
  "otakProxy.remediationFlapWindowMs": 600000,
  "otakProxy.remediationFlapMaxAttempts": 2,
  "otakProxy.remediationFlapCooldownMs": 600000,
  "otakProxy.notificationCooldownMs": 600000,
  "otakProxy.slowDiagnosticsTtlMs": 300000,
  "otakProxy.terminalOffMaskingEnabled": true,
  "otakProxy.notificationLevel": "warnings",
  "otakProxy.windowsActionsEnabled": false,
  "otakProxy.legacyEnvFirstAutoDetection": true
}
```

| Setting | Default | Description |
| --- | --- | --- |
| `otakProxy.proxyUrl` | unset | Optional fallback proxy URL used when the system proxy is unavailable |
| `otakProxy.pollingInterval` | `30` | System proxy check interval, in seconds |
| `otakProxy.enableFallback` | `true` | Fall back to the configured proxy URL when the system proxy is unavailable |
| `otakProxy.showProxyUrl` | `true` | Show the proxy URL in the status bar; set `false` to display `Configured` instead |
| `otakProxy.autoTestEnabled` | `true` | Periodically test proxy connectivity in Auto mode |
| `otakProxy.testInterval` | `60` | Automatic connection test interval, in seconds (Auto mode only; range `30`–`600`) |
| `otakProxy.syncEnabled` | `true` | Synchronize proxy settings across multiple VS Code/Cursor instances |
| `otakProxy.syncInterval` | `1000` | Sync check interval, in milliseconds (range `100`–`5000`) |
| `otakProxy.detectionSourcePriority` | `["environment", "vscode", "platform"]` | Order in which proxy detection sources are tried |
| `otakProxy.maxRetries` | `3` | Maximum retries for proxy detection when it fails |
| `otakProxy.diagnosticsEnabled` | `true` | Run sanitized diagnostics after proxy state changes and from the diagnose command |
| `otakProxy.automaticRemediationEnabled` | `true` | Enable safe automatic remediation such as bounded delayed retry and loop suppression |
| `otakProxy.hostUserLockEnabled` | `true` | Use cross-window locks before writing Git, npm, VS Code, or terminal proxy targets |
| `otakProxy.automaticRetryEnabled` | `true` | Retry one eligible apply failure after `otakProxy.remediationDelayedRetryMs` |
| `otakProxy.remediationDelayedRetryMs` | `2000` | Delay before the bounded retry used by automatic remediation |
| `otakProxy.remediationFlapWindowMs` | `600000` | Time window for detecting repeated non-converging repairs for the same issue |
| `otakProxy.remediationFlapMaxAttempts` | `2` | Maximum automatic attempts per issue fingerprint within the flap window |
| `otakProxy.remediationFlapCooldownMs` | `600000` | Cooldown after repeated remediation failures |
| `otakProxy.notificationCooldownMs` | `600000` | Minimum interval before repeating a notification for the same issue |
| `otakProxy.slowDiagnosticsTtlMs` | `300000` | Cache TTL for slow diagnostics that spawn Git, npm, or Windows commands |
| `otakProxy.terminalOffMaskingEnabled` | `true` | Mask inherited proxy env vars for new terminals when proxy mode is Off |
| `otakProxy.notificationLevel` | `"warnings"` | Notification level: `off`, `important`, `warnings`, or `all` |
| `otakProxy.windowsActionsEnabled` | `false` | Allow user-approved Windows proxy actions such as WinHTTP reset |
| `otakProxy.credentialTargetPolicy` | `"ask"` | Control authenticated proxy writes to plaintext target files: `ask`, `allowPlaintextTargets`, or `blockPlaintextTargets`; use `blockPlaintextTargets` when policy forbids credentials in tool config files |
| `otakProxy.legacyEnvFirstAutoDetection` | `true` | Keep v2-compatible Auto detection order with process env before platform settings |

## Commands

Access via the Command Palette (`Cmd/Ctrl+Shift+P`):

- `otak: Toggle Proxy`
- `otak: Test Proxy`
- `otak: Import System Proxy`
- `otak: Configure Manual Proxy`
- `otak: Toggle Proxy URL Visibility`
- `otak: Diagnose Proxy State`
- `otak: Reset WinHTTP Proxy`

## Security & Privacy

### Local Configuration Changes

- VS Code: writes the global `http.proxy` setting through the VS Code configuration API.
- Git: writes global `http.proxy` and `https.proxy` with `git config --global`.
- npm: writes user-level `proxy` and `https-proxy` with `npm config set`.
- Integrated terminals: sets `HTTP_PROXY` and `HTTPS_PROXY` for new terminals, and lowercase variants on non-Windows hosts.
- Off clears the proxy entries managed by otak-proxy. Deactivating or uninstalling the extension does not guarantee cleanup by itself; switch Off before uninstalling, or use the recovery commands in [Troubleshooting](#troubleshooting).

### Credentials

- No account or API key is required.
- If your proxy requires credentials, use an authenticated proxy URL only when necessary. otak-proxy stores the credential part in VS Code SecretStorage where available and keeps global state and sync payloads sanitized.
- Applying an authenticated proxy to VS Code, Git, or npm may still require writing credentials to those tools' plaintext configuration files (`settings.json`, `.gitconfig`, `.npmrc`) because those tools read their own config files.
- Use `otakProxy.credentialTargetPolicy` to control those writes: `ask` prompts locally, `allowPlaintextTargets` allows them, and `blockPlaintextTargets` blocks them. Use `blockPlaintextTargets` when your organization forbids credentials in tool config files.
- Passwords, authorization headers, npm tokens, Git extra headers, command output, copied diagnostics, control characters, and sync payloads are redacted before they are logged or displayed.

### Network Activity

- otak-proxy sends no telemetry and does not transmit usage data.
- Connection tests verify proxy reachability by sending HTTP `CONNECT` requests through the configured proxy to the default test hosts `www.github.com`, `www.microsoft.com`, and `www.google.com`.
- If the proxy URL contains credentials, the test sends a `Proxy-Authorization` header to the configured proxy. Test results, logs, and diagnostics redact credentials and authorization headers.
- The extension reads local environment variables, VS Code settings, Git config, npm config, and supported platform proxy settings for diagnostics and Auto detection.

## Diagnostics and Remediation Behavior

Run `otak: Diagnose Proxy State` to inspect the current proxy state. Diagnostics are read-only by default: they collect sanitized observations from VS Code, terminal environment settings, Git config, npm config, execution context, and supported Windows proxy sources. Slow command-based diagnostics are cached for `otakProxy.slowDiagnosticsTtlMs` to avoid repeated Git/npm/Windows process launches.

Diagnostics also check convergence between the selected state and the actual tool settings:

- In Auto with an active proxy, diagnostics report a managed proxy mismatch when VS Code, Git, or npm does not match the expected proxy URL.
- In Off or Auto: OFF, diagnostics report a managed proxy residual when VS Code, Git, or npm still has a proxy configured.
- In remote, WSL, container, or web-like extension hosts, unsupported local Windows checks are reported as capability limits instead of being forced.

When otak-proxy starts in Off or Auto: OFF, it also uses the disable path so stale managed VS Code, Git, or npm proxy entries can be detected and cleared instead of being silently left behind.

When `otakProxy.automaticRemediationEnabled` is enabled, otak-proxy performs only bounded safe remediation after apply operations. It retries one eligible apply failure or residual/mismatch convergence issue after `otakProxy.remediationDelayedRetryMs`, then runs fresh diagnostics. Repeated non-converging repairs are suppressed by the flap window and cooldown settings. Host/user locks prevent overlapping writers from multiple windows. Disruptive Windows actions, such as WinHTTP reset, still require an explicit user command and `otakProxy.windowsActionsEnabled`.

## Language Support

The interface follows your VS Code display language — 16 languages covering all G20 countries:

**English** · 日本語 · 简体中文 · 繁體中文 · 한국어 · Tiếng Việt · Español · Português (BR) · Français · Deutsch · हिन्दी · Bahasa Indonesia · Italiano · Русский · العربية · Türkçe

## Requirements

- VS Code **1.97.0** or newer
- Cursor is supported when it is compatible with the required VS Code extension API version.
- Git available on `PATH` (`git --version`)

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-proxy), or run:

```text
ext install odangoo.otak-proxy
```

<details>
<summary><strong>Build from source (VSIX)</strong></summary>

```bash
npm install
npx --yes @vscode/vsce package
code --install-extension otak-proxy-3.1.1.vsix
```

Reload VS Code afterwards.

</details>

## Troubleshooting

- **Proxy not working**: make sure the URL starts with `http://` or `https://`, then run `Test Proxy`.
- **Settings appear correct but tools still use the old proxy**: run `otak: Diagnose Proxy State`. Existing terminals and some VS Code process-level proxy flags require a new terminal, window reload, or full VS Code restart.
- **Proxy settings remain after switching Off or uninstalling**: switch otak-proxy Off first, then run `otak: Diagnose Proxy State`. If settings still remain, check and remove only the entries you want otak-proxy to stop managing:

  ```bash
  git config --global --get http.proxy
  git config --global --get https.proxy
  git config --global --unset http.proxy
  git config --global --unset https.proxy
  npm config get proxy
  npm config get https-proxy
  npm config delete proxy
  npm config delete https-proxy
  ```

  Also check VS Code User Settings for `http.proxy` and clear it if it should no longer be set.

- **Git not detected**: make sure Git is installed and available on `PATH` (`git --version`).
- **Auto mode does not detect changes**: check your system proxy settings and adjust `otakProxy.pollingInterval`.
- **Remote/WSL/Container windows**: Windows registry and WinHTTP actions are only available when the extension host is local Windows. Remote hosts are diagnosed as remote/workspace targets and unsupported Windows actions are skipped.

## Related Extensions

More VS Code extensions by [odangoo](https://marketplace.visualstudio.com/publishers/odangoo):

| Extension | Description |
| --- | --- |
| [**otak-paste**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-paste) | Paste optimized screenshots into Markdown and keep your repository lighter |
| [**otak-monitor**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-monitor) | Real-time CPU, memory, and disk usage in the status bar |
| [**otak-committer**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-committer) | AI-assisted commit messages, pull requests, and issues |
| [**otak-clipboard**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-clipboard) | Copy a folder or the current tab to your clipboard in two clicks |
| [**otak-clock**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-clock) | Dual time-zone clock for the status bar |
| [**otak-pomodoro**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-pomodoro) | A Pomodoro focus timer built into VS Code |
| [**otak-restart**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-restart) | Quick Extension Host and window restart from the status bar |
| [**otak-zen**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-zen) | A calm, distraction-free Zen mode for VS Code |
| [**otak-lsp**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-lsp) | Japanese morphological analysis with grammar checks, semantic highlights, and hovers |
| [**otak-usage**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-usage) | At-a-glance usage statistics for VS Code |

## License

Released under the [MIT License](LICENSE).

<div align="center">
<br>
<sub>Built by <a href="https://github.com/tsuyoshi-otake">tsuyoshi-otake</a> · <a href="https://marketplace.visualstudio.com/items?itemName=odangoo.otak-proxy">Marketplace</a> · <a href="https://github.com/tsuyoshi-otake/otak-proxy">GitHub</a> · <a href="https://github.com/tsuyoshi-otake/otak-proxy/issues">Issues</a></sub>
</div>
