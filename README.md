<div align="center">

# otak-proxy

**One-click proxy switching for VS Code, Git, npm, and integrated terminals.**  
otak-proxy lets you flip proxy modes from the status bar, follows your system proxy automatically, and keeps every open VS Code/Cursor window in sync.

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

Working behind a corporate proxy usually means editing several configuration files by hand: VS Code settings, the Git config, the npm config, and the environment variables your terminals inherit. Keeping them aligned — and remembering to turn them all off again — is tedious and error-prone. **otak-proxy reduces the whole workflow to a single status-bar click** and keeps VS Code, Git, npm, and new integrated terminals in step, with an Auto mode that follows your system proxy in the background.

![otak-proxy](images/otak-proxy.png)

## Quick Start

### Auto Mode (System Proxy)

1. **Install** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-proxy).
2. Click the status bar and select **Auto**.
3. otak-proxy applies the system proxy to VS Code, Git, npm, and new integrated terminals.

### Manual Mode

1. **Install** the extension.
2. Click the status bar and select **Manual**.
3. Enter your proxy URL (for example: `http://proxy.example.com:8080`).

In both modes, otak-proxy updates proxy settings for VS Code, Git, and npm, and sets proxy environment variables for new VS Code integrated terminals.

## Capabilities

- **Three modes**: Off, Manual, and Auto — cycle through them with one click.
- **Auto mode**: reads the system proxy and applies changes in the background.
- **Manual mode**: uses the exact proxy URL you enter.
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

Click the proxy indicator to cycle through modes:

```
Off → Manual → Auto → Off
```

### Status Indicators

- `Proxy: Off` — Proxy is disabled
- `Manual: http://...` — Using the configured manual proxy
- `Auto: http://...` — Synced with the system proxy
- `Auto (Fallback): http://...` — The system proxy is unavailable; using the manual proxy
- `Auto: OFF` — No proxy is currently available

When `otakProxy.showProxyUrl` is `false`, the URL is replaced with `Configured` (for example, `Manual: Configured`).

### Integrated Terminal Environment

When the proxy is enabled, otak-proxy sets these variables for **newly created** VS Code integrated terminals:

- `HTTP_PROXY` / `HTTPS_PROXY`
- `http_proxy` / `https_proxy` on non-Windows hosts

Existing terminals keep their current environment. Open a new terminal for the updated values to take effect. When `otakProxy.terminalOffMaskingEnabled` is enabled and proxy mode is Off, otak-proxy masks inherited proxy variables for new terminals by replacing them with empty values; this avoids VS Code-launched tools accidentally continuing to use a proxy inherited from the editor process.

## Settings

```json
{
  "otakProxy.proxyUrl": "http://proxy.example.com:8080",
  "otakProxy.pollingInterval": 30,
  "otakProxy.enableFallback": true,
  "otakProxy.showProxyUrl": true,
  "otakProxy.autoTestEnabled": true,
  "otakProxy.testInterval": 60,
  "otakProxy.syncEnabled": true,
  "otakProxy.syncInterval": 1000,
  "otakProxy.detectionSourcePriority": ["environment", "vscode", "platform"],
  "otakProxy.maxRetries": 3,
  "otakProxy.diagnosticsEnabled": true,
  "otakProxy.automaticRemediationEnabled": true,
  "otakProxy.notificationLevel": "warnings",
  "otakProxy.credentialTargetPolicy": "ask",
  "otakProxy.windowsActionsEnabled": false
}
```

| Setting | Default | Description |
| --- | --- | --- |
| `otakProxy.proxyUrl` | unset | Manual proxy URL |
| `otakProxy.pollingInterval` | `30` | System proxy check interval, in seconds |
| `otakProxy.enableFallback` | `true` | Fall back to the manual proxy when the system proxy is unavailable |
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
| `otakProxy.remediationFlapWindowMs` | `600000` | Time window for detecting repeated non-converging repairs for the same issue |
| `otakProxy.remediationFlapMaxAttempts` | `2` | Maximum automatic attempts per issue fingerprint within the flap window |
| `otakProxy.remediationFlapCooldownMs` | `600000` | Cooldown after repeated remediation failures |
| `otakProxy.notificationCooldownMs` | `600000` | Minimum interval before repeating a notification for the same issue |
| `otakProxy.slowDiagnosticsTtlMs` | `300000` | Cache TTL for slow diagnostics that spawn Git, npm, or Windows commands |
| `otakProxy.terminalOffMaskingEnabled` | `true` | Mask inherited proxy env vars for new terminals when proxy mode is Off |
| `otakProxy.notificationLevel` | `"warnings"` | Notification level: `off`, `important`, `warnings`, or `all` |
| `otakProxy.windowsActionsEnabled` | `false` | Allow user-approved Windows proxy actions such as WinHTTP reset |
| `otakProxy.credentialTargetPolicy` | `"ask"` | Control authenticated proxy writes to plaintext target files: `ask`, `allowPlaintextTargets`, or `blockPlaintextTargets` |
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

- Updates VS Code, Git, and npm proxy settings.
- Sets `HTTP_PROXY` and `HTTPS_PROXY` environment variables for new integrated terminals.

### Credentials

- No account or API key is required.
- If your proxy requires credentials, include them in the URL you provide. otak-proxy stores the credential part in VS Code SecretStorage when possible and stores only the public URL in global state and sync payloads.
- Applying an authenticated proxy to VS Code, Git, or npm can still write credentials to plaintext target files (`settings.json`, `.gitconfig`, `.npmrc`) because those tools read their own config files. With `otakProxy.credentialTargetPolicy: "ask"` this requires local consent; use `"blockPlaintextTargets"` in stricter environments.
- Passwords, authorization headers, npm tokens, Git extra headers, command output, copied diagnostics, control characters, and sync payloads are redacted before they are logged or displayed.

### Network Activity

- otak-proxy only checks whether the proxy is reachable before enabling it; it sends no telemetry and transmits no usage data.

## Language Support

The interface follows your VS Code display language — 16 languages covering all G20 countries:

**English** · 日本語 · 简体中文 · 繁體中文 · 한국어 · Tiếng Việt · Español · Português (BR) · Français · Deutsch · हिन्दी · Bahasa Indonesia · Italiano · Русский · العربية · Türkçe

## Requirements

- VS Code **1.97.0** or newer
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
npm run package
code --install-extension otak-proxy-3.0.0.vsix
```

Reload VS Code afterwards.

</details>

## Troubleshooting

- **Proxy not working**: make sure the URL starts with `http://` or `https://`, then run `Test Proxy`.
- **Settings appear correct but tools still use the old proxy**: run `otak: Diagnose Proxy State`. Existing terminals and some VS Code process-level proxy flags require a new terminal, window reload, or full VS Code restart.
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
