<div align="center">

# otak-proxy

**Switch the proxy for VS Code, Git, npm, pip, and integrated terminals with one click.**
otak-proxy toggles between Auto and Off from the status bar, follows your system proxy automatically, and keeps every open VS Code/Cursor window in sync.

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

Working behind a corporate proxy usually means editing several configuration files by hand: VS Code settings, the Git config, the npm config, the pip config, and the environment variables your terminals inherit. Keeping them aligned, and remembering to turn them all off again, is tedious and error-prone. **otak-proxy turns this into a single status bar click.** It keeps VS Code, Git, npm, pip, and new integrated terminals in step, and its Auto mode follows your system proxy in the background.

```text
  VS Code status bar (left side)
  ─────────────────────────────────────────────────────────────────
  …  ⟳ Auto: http://proxy.example.com:8080  │  ⚠ 0  ⓘ 0  │  main …
  ─────────────────────────────────────────────────────────────────
     ▲ click to switch between Off and Auto; VS Code, Git, npm,
       pip, and new integrated terminals are updated together
```

## Quick Start

### Auto Mode

1. **Install** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-proxy).
2. On first launch, otak-proxy asks how to configure the proxy. Choose **Auto (System)** to follow the system proxy. You can also choose **Manual Setup** to enter a fallback proxy URL and switch to Auto, or **Skip** and click the status bar later to switch to **Auto**.
3. otak-proxy applies the system proxy to VS Code, Git, npm, pip, and new integrated terminals.
4. Click the status bar again to switch **Off** and clear the proxy settings that otak-proxy manages.

### Optional Fallback Proxy

1. Run `otak: Configure Manual Proxy`.
2. Enter a fallback proxy URL (for example, `http://proxy.example.com:8080`).

Auto mode uses this URL when no system proxy is detected, including when the system proxy disappears while VS Code is running. When you switch to Auto from the status bar and no system proxy is found, or when Auto notices that the system proxy has disappeared, otak-proxy first tests the fallback proxy and uses it only if it is reachable. A URL entered during first-run setup is applied without this test. If the URL includes credentials, read [Security & Privacy](#security--privacy) before allowing otak-proxy to write it to VS Code, Git, npm, or pip configuration files.

## Capabilities

- **Two-state toggle**: switch between Off and Auto from the status bar.
- **Auto mode**: reads the system proxy and applies changes in the background.
- **Optional fallback proxy**: uses a configured proxy URL when no system proxy is detected.
- **Connection test**: `otak: Test Proxy` checks whether a proxy is reachable.
- **Automatic connection testing**: in Auto mode, periodically checks that the active proxy is still reachable. Auto turns off (`Auto: OFF`) only when the proxy cannot be reached at all (the connection is refused or there is no route to it), and turns back on as soon as a test shows that the proxy answers again, even with an error such as `407` or `403`, or accepts the connection and then times out (an `https:` proxy must also finish the TLS handshake). A timeout or DNS failure before the proxy is reached, or a TLS failure, proves neither, so Auto keeps its current state. A newly detected system proxy is tested on its own and starts in Auto unless it cannot be reached.
- **Diagnostics and safe remediation**: records sanitized diagnostics, retries an eligible failed apply once, and stops repeating repairs when another tool keeps rewriting the settings.
- **Ownership-aware cleanup**: Off removes only the values otak-proxy wrote; values set or changed by you or other tools are kept.
- **Credential-aware storage**: stores proxy credentials in VS Code SecretStorage where available and keeps synced and global state free of credentials.
- **Windows diagnostics**: reads WinINET, WinHTTP, PAC, and WPAD state without changing Windows settings. WinHTTP reset is available only as a command you run and confirm.
- **Multi-instance sync**: shares proxy settings across all open VS Code/Cursor windows.
- **Integrated terminals**: sets `HTTP_PROXY` and `HTTPS_PROXY` for new VS Code terminals.
- **URL visibility**: hide the proxy URL in the status bar when needed.
- **Localized interface**: the UI follows your VS Code display language, in 16 languages.

## How It Works

### Status Bar

Click the proxy indicator to switch between the two states:

```text
         click              click
  ┌─────┐ ────▶ ┌──────┐ ────▶ ┌─────┐
  │ Off │        │ Auto │        │ Off │  …
  └─────┘        └──────┘        └─────┘
```

There is **no separate Manual mode**. A URL entered with `otak: Configure Manual Proxy` is stored as the **Auto fallback** and is used when no system proxy is detected. Manual mode states saved by older versions are migrated to Auto when they are loaded.

### Status Indicators

```text
  ┌──────────────────────────────────────────┐
  │ ⊘ Proxy: Off                             │  proxy disabled; managed settings cleared
  ├──────────────────────────────────────────┤
  │ ⟳ Auto: http://proxy.example.com:8080    │  following the detected system proxy
  ├──────────────────────────────────────────┤
  │ ⌁ Auto (Fallback): http://192.168.1.2:88 │  no system proxy; using your configured
  │                                          │  fallback URL (plug icon)
  ├──────────────────────────────────────────┤
  │ ⚠ Auto: PAC unsupported                  │  PAC / GNOME auto / similar auto-config
  │                                          │  was detected; otak-proxy cannot resolve it
  ├──────────────────────────────────────────┤
  │ ⌁ Auto (Fallback, ignoring PAC): url     │  unsupported auto-config; using your
  │                                          │  configured fallback and saying so
  ├──────────────────────────────────────────┤
  │ ⊘ Auto: OFF                              │  no reachable proxy right now; retested
  │                                          │  automatically in the background
  ├──────────────────────────────────────────┤
  │ ⚠ Auto: http://proxy.example.com:8080    │  last apply failed on some target —
  │                                          │  hover for details
  ├──────────────────────────────────────────┤
  │ ⚠ Auto (blocked)                         │  apply was refused (for example an
  │                                          │  untrusted workspace); desired Auto
  │                                          │  is not treated as applied
  └──────────────────────────────────────────┘
```

The glyphs above stand for the VS Code codicons `$(circle-slash)` (⊘), `$(sync)` (⟳), `$(plug)` (⌁), and `$(warning)` (⚠). When the last apply failed or was blocked, ⚠ replaces the usual icon of the current state.

When `otakProxy.showProxyUrl` is `false`, the URL is replaced with `Configured` (for example, `Auto: Configured`). Set it back to `true`, or use the **Show URL** link in the tooltip, to display the address.

The detailed hover tooltip is enabled by default. The otak-proxy status bar items sit on the left side so their tooltips do not cover VS Code notifications on the right. Set `otakProxy.statusBarTooltip` to `false` to hide the tooltip.

### Auto Detection Scope

Auto detection tries the sources in `otakProxy.detectionSourcePriority`: environment variables, VS Code settings, and platform proxy settings. Behavior can differ between local Windows, macOS, Linux, WSL, containers, and remote extension hosts. Windows registry and WinHTTP actions are available only when the extension host runs on local Windows.

PAC, WPAD, and GNOME `mode=auto` are reported as **detected but unsupported** (`kind: pac|wpad`, capability `unsupported`), not as "no proxy". otak-proxy does not include a PAC/WPAD engine. When the fallback URL is used instead, the status bar says that the auto-config is being ignored.

Windows: `ProxyEnable=0` with `AutoConfigURL` is reported as unsupported PAC. A registry `AutoDetect=1` bit without `AutoConfigURL` is reported as unsupported WPAD as a **registry observation only**; whether WPAD was the effective path has not been confirmed on a test machine.

macOS: network services are listed with `networksetup -listallnetworkservices`, skipping disabled services (marked `*`). A usable web or secure web proxy on any listed service is used; an enabled auto-proxy URL is reported as unsupported PAC. If listing fails, the three well-known services `Wi-Fi`, `Ethernet`, and `Thunderbolt Ethernet` are checked instead. **Which service is the effective default route has not been verified on a macOS test machine.**

### Integrated Terminal Environment

When the proxy is enabled, otak-proxy sets these variables for **newly created** VS Code integrated terminals:

- `HTTP_PROXY` / `HTTPS_PROXY`
- `http_proxy` / `https_proxy` on non-Windows hosts

Existing terminals keep their current environment; open a new terminal to pick up the updated values.

When proxy mode is Off and `otakProxy.terminalOffMaskingEnabled` is enabled, otak-proxy masks `HTTP_PROXY` / `HTTPS_PROXY` (and the lowercase variants on non-Windows hosts) in new terminals by setting them to empty values. This stops tools launched from VS Code from using a proxy inherited from the editor process. `NO_PROXY` / `no_proxy` / `ALL_PROXY` / `all_proxy` are left unchanged unless otak-proxy wrote them earlier.

### Windows Environment Variable Check

On local Windows, otak-proxy compares the saved user and system values of `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` with the environment of the running VS Code process. When they differ, it shows a warning that lists only the variable **names**. Values and credentials are never shown.

- If a variable is saved for both the user and the system, the user value is compared.
- The check runs at startup and about every 60 seconds while the VS Code window is focused. The same mismatch is reported only once, and at most one warning is shown every 5 minutes. If the saved values cannot be read, the check waits longer between attempts (up to about 15 minutes).
- A variable is compared only after a saved value has been seen for it. A value that exists only in the VS Code process from startup cannot be told apart from an intentional temporary setting, so it is not reported. Removing a saved value after it has been seen is reported.
- The check is read-only. It does not change environment variables and does not affect Auto detection or proxy application.
- Set `otakProxy.notificationLevel` to `"off"` to turn the warning off.

If you see the warning, save your work, quit every VS Code window, start VS Code again, and open new terminals. Reloading the window may not refresh the environment. If the launcher or shell that starts VS Code still has the old environment, you may also need to restart it or sign out and back in.

## Settings

### Common Settings

```json
{
  "otakProxy.proxyUrl": "http://proxy.example.com:8080",
  "otakProxy.pollingInterval": 30,
  "otakProxy.enableFallback": true,
  "otakProxy.showProxyUrl": true,
  "otakProxy.statusBarTooltip": true,
  "otakProxy.autoTestEnabled": true,
  "otakProxy.testInterval": 60,
  "otakProxy.credentialTargetPolicy": "ask"
}
```

For stricter corporate environments, use:

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
  "otakProxy.ignoreSelfWrittenVSCodeProxy": true,
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
  "otakProxy.windowsActionsEnabled": false
}
```

| Setting | Default | Description |
| --- | --- | --- |
| `otakProxy.proxyUrl` | unset | Optional fallback proxy URL, used when no system proxy is detected |
| `otakProxy.pollingInterval` | `30` | System proxy check interval in seconds (range `10`–`300`) |
| `otakProxy.enableFallback` | `true` | Use the fallback proxy URL when no system proxy is detected |
| `otakProxy.showProxyUrl` | `true` | Show the proxy URL in the status bar; when `false`, `Configured` is shown instead |
| `otakProxy.statusBarTooltip` | `true` | Show the detailed hover tooltip on the status bar item |
| `otakProxy.autoTestEnabled` | `true` | Periodically test proxy connectivity in Auto mode |
| `otakProxy.testInterval` | `60` | Automatic connection test interval in seconds, Auto mode only (range `30`–`600`) |
| `otakProxy.syncEnabled` | `true` | Synchronize proxy settings across VS Code/Cursor windows |
| `otakProxy.syncInterval` | `1000` | Sync check interval in milliseconds (range `100`–`5000`) |
| `otakProxy.detectionSourcePriority` | `["environment", "vscode", "platform"]` | Order in which proxy detection sources are tried |
| `otakProxy.ignoreSelfWrittenVSCodeProxy` | `true` | Ignore VS Code's `http.proxy` when it holds the value otak-proxy wrote, so that value is not detected again as a system proxy |
| `otakProxy.maxRetries` | `3` | Maximum retries when proxy detection fails (range `0`–`10`) |
| `otakProxy.diagnosticsEnabled` | `true` | Run read-only, sanitized diagnostics automatically after each proxy apply; `otak: Diagnose Proxy State` works regardless of this setting |
| `otakProxy.automaticRemediationEnabled` | `true` | Enable safe automatic remediation, such as one delayed retry and loop suppression |
| `otakProxy.hostUserLockEnabled` | `true` | Take cross-window locks before writing Git, npm, VS Code, or terminal proxy settings |
| `otakProxy.automaticRetryEnabled` | `true` | Retry one eligible failed apply after `otakProxy.remediationDelayedRetryMs` |
| `otakProxy.remediationDelayedRetryMs` | `2000` | Delay before the automatic retry, in milliseconds (range `250`–`30000`) |
| `otakProxy.remediationFlapWindowMs` | `600000` | Time window for detecting repeated repairs that do not fix the same issue |
| `otakProxy.remediationFlapMaxAttempts` | `2` | Maximum automatic attempts per issue within the flap window |
| `otakProxy.remediationFlapCooldownMs` | `600000` | Cooldown after repeated remediation failures |
| `otakProxy.notificationCooldownMs` | `600000` | Minimum interval before the same diagnostic issue is notified again |
| `otakProxy.slowDiagnosticsTtlMs` | `300000` | How long results of slow diagnostics that run Git, npm, or Windows commands are cached |
| `otakProxy.terminalOffMaskingEnabled` | `true` | When Off, set `HTTP_PROXY`/`HTTPS_PROXY` to empty values in new terminals; `NO_PROXY` is changed only if otak-proxy wrote it |
| `otakProxy.notificationLevel` | `"warnings"` | Diagnostic notification level: `off`, `important`, `warnings`, or `all` |
| `otakProxy.windowsActionsEnabled` | `false` | Allow Windows proxy actions that you confirm, such as WinHTTP reset |
| `otakProxy.credentialTargetPolicy` | `"ask"` | How to handle a proxy URL with credentials, which may be written to plaintext config files: `ask`, `allowPlaintextTargets`, or `blockPlaintextTargets` (see [Credentials](#credentials)) |
| `otakProxy.legacyEnvFirstAutoDetection` | `true` | Kept for compatibility with v2 settings. It currently has no effect; the detection order comes from `otakProxy.detectionSourcePriority`, which checks environment variables first by default |

## Commands

Open the Command Palette (`Cmd/Ctrl+Shift+P`) and run:

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
- Git: writes the global `http.proxy` with `git config --global`. Git uses this single key for both HTTP and HTTPS remotes (HTTPS goes through CONNECT). `https.proxy` does not route traffic, so otak-proxy does not write it; Off still removes a leftover `https.proxy` that otak-proxy owns.
- npm: writes the user-level `proxy` and `https-proxy` with `npm config set`. When `npm config get` refuses to print a proxy URL that contains a password (as npm 10.8 and later do), otak-proxy reads that value from the npm user config file (`.npmrc`) to confirm the write and to decide what Off may remove. If the value cannot be confirmed there (for example, when it is set only in a project or global `.npmrc`), Off keeps it and reports the npm target as failed.
- pip: writes the user-level `global.proxy` with `python -m pip config --user` (trying `py`, `python`, then `python3` on Windows, and `python3`, then `python` elsewhere). pip stores one URL for both HTTP and HTTPS. This target is skipped when Python or pip is not installed.
- Integrated terminals: sets `HTTP_PROXY` and `HTTPS_PROXY` for new terminals, plus the lowercase variants on non-Windows hosts.
- Off removes only the values that otak-proxy wrote and that have not changed since. Values that you or other tools set or changed are kept.
- Deactivating or uninstalling the extension does not clean up these settings by itself. Switch Off before uninstalling, or follow [Troubleshooting](#troubleshooting).

### Credentials

- No account or API key is required.
- Use a proxy URL with credentials only when your proxy requires them. otak-proxy stores the credential part in VS Code SecretStorage where available and keeps global state and sync data free of credentials.
- VS Code, Git, npm, and pip read their own configuration files, so applying a proxy URL with credentials writes those credentials in plaintext to files such as `settings.json`, `.gitconfig`, `.npmrc`, and the pip user config file.
- `otakProxy.credentialTargetPolicy` controls this:
  - `ask` (default): asks once per proxy on each machine before writing. Background applies are skipped until you allow it.
  - `allowPlaintextTargets`: writes without asking.
  - `blockPlaintextTargets`: never applies a proxy URL with credentials. Use it when your organization forbids credentials in tool config files.
- Passwords, authorization headers, npm tokens, Git extra headers, command output, copied diagnostics, control characters, and sync data are redacted before they are logged or displayed.

### Network Activity

- otak-proxy sends no telemetry and does not transmit usage data.
- Connection tests check reachability by sending HTTP `CONNECT` requests through the configured proxy to the default test hosts `www.github.com`, `www.microsoft.com`, and `www.google.com`.
- If the proxy URL contains credentials, the test sends a `Proxy-Authorization` header to the configured proxy. Test results, logs, and diagnostics redact credentials and authorization headers.
- For diagnostics and Auto detection, the extension reads local environment variables, VS Code settings, the Git config, the npm config (including the npm user config file when npm will not print a proxy URL with a password), and supported platform proxy settings.

## Diagnostics and Remediation Behavior

Run `otak: Diagnose Proxy State` to inspect the current proxy state. Diagnostics are read-only: they collect sanitized observations from VS Code, the terminal environment, the Git config, the npm config, the execution context, and supported Windows proxy sources. The command always reads fresh values. Diagnostics also run automatically after each proxy apply. They read fresh values after a successful apply, after a retry, and when the apply was skipped because another window holds the apply lock. They reuse cached results of slow command-based checks (up to `otakProxy.slowDiagnosticsTtlMs` old) in two cases: when an apply failed and is not retried, and when the credential policy stopped the apply. This keeps Git, npm, and Windows commands from launching again right after the failure.

Diagnostics also check whether the actual tool settings match the selected state:

- In Auto with an active proxy, diagnostics report a mismatch when VS Code, Git `http.proxy`, or npm no longer holds the expected proxy URL. This check covers only the targets that otak-proxy has recorded as configured. A leftover Git `https.proxy` is reported for information only, because Git does not route traffic through it.
- In Off, or in Auto while it shows `Auto: OFF`, diagnostics report a residual when VS Code, Git, or npm still has a proxy configured. A value that otak-proxy left in place when it cleared proxy settings, because otak-proxy did not write it, is reported as an advisory, not as a failure. An unsupported auto-config setting (PAC, WPAD, or GNOME `mode=auto`) is reported for information only in these states, because otak-proxy neither uses nor changes it.
- When Git or npm cannot be read (for example, the command is not on `PATH` or times out), diagnostics report that for information and skip the mismatch and residual checks for that tool, instead of treating it as having no proxy.
- In remote, WSL, container, or web extension hosts, local Windows checks that cannot run there are reported as capability limits instead of being forced.

When otak-proxy starts in Off or `Auto: OFF`, it runs the same disable path as switching Off, so leftover VS Code, Git, or npm proxy entries that otak-proxy manages are detected and cleared.

When `otakProxy.automaticRemediationEnabled` is enabled, remediation after an apply is limited and safe:

- An eligible apply failure, residual, or mismatch is retried once after `otakProxy.remediationDelayedRetryMs`, followed by fresh diagnostics.
- If repairs keep failing for the same issue, further attempts are suppressed for the flap window and cooldown.
- Locks shared by all windows prevent two windows from writing at the same time.
- Disruptive Windows actions, such as WinHTTP reset, still require you to run the command and enable `otakProxy.windowsActionsEnabled`.

The diagnostics report keeps the recorded result and the fresh observation apart:

- `recordedRuntimeState` is what the last apply recorded. `runtimeState` also counts convergence-blocking issues found in this run, so a recorded success with a fresh residual is reported as `partial`, not `applied`.
- `desired` is the selected mode, and `converged` says whether the tool settings actually match it. Selecting Off does not by itself mean the settings were cleared. `converged` is `true` only when `runtimeState` is `applied`, so a failed or blocked apply is never reported as converged.
- `lastRemediation` is the outcome of the most recent proxy apply in this VS Code window: per-target results, whether the retry ran, the stop reason (`converged`, `unverified`, `retryExhausted`, `retryDisabled`, `notRetryable`, `flapSuppressed`, `lockSkipped`, `superseded`, or `consentRequired`), and the IDs of the remaining blockers. It never contains proxy URLs, credentials, or command output, and it is `null` until the first apply in the window finishes.

## Language Support

The interface follows your VS Code display language. 16 languages are available, covering the main languages of every G20 country:

English · Japanese (日本語) · Simplified Chinese (简体中文) · Traditional Chinese (繁體中文) · Korean (한국어) · Vietnamese (Tiếng Việt) · Spanish (Español) · Brazilian Portuguese (Português) · French (Français) · German (Deutsch) · Hindi (हिन्दी) · Indonesian (Bahasa Indonesia) · Italian (Italiano) · Russian (Русский) · Arabic (العربية) · Turkish (Türkçe)

## Requirements

- VS Code **1.97.0** or newer
- Cursor, when it supports the required VS Code extension API version
- Git on `PATH` (`git --version`)
- Optional: Python with pip, if you want otak-proxy to manage the pip proxy

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-proxy), or run this in the Quick Open box (`Cmd/Ctrl+P`):

```text
ext install odangoo.otak-proxy
```

<details>
<summary><strong>Build from source (VSIX)</strong></summary>

```bash
npm ci
npm run package:vsix
code --install-extension otak-proxy-<version>.vsix
```

Replace `<version>` with the `version` in `package.json`, then reload VS Code.

</details>

## Troubleshooting

- **The proxy does not work**: make sure the URL starts with `http://` or `https://`, then run `otak: Test Proxy`.
- **Settings look correct, but tools still use the old proxy**: run `otak: Diagnose Proxy State`. Existing terminals and some VS Code process-level proxy settings need a new terminal, a window reload, or a full VS Code restart.
- **A warning says saved Windows proxy environment settings differ from this VS Code process**: quit every VS Code window, start VS Code again, and open new terminals (see [Windows Environment Variable Check](#windows-environment-variable-check)).
- **Proxy settings remain after switching Off or uninstalling**: switch otak-proxy Off first, then run `otak: Diagnose Proxy State`. If settings still remain, check them and remove only the entries you no longer want:

  ```bash
  git config --global --get http.proxy
  git config --global --get https.proxy
  git config --global --unset http.proxy
  git config --global --unset https.proxy
  npm config list
  npm config delete proxy
  npm config delete https-proxy
  python -m pip config --user get global.proxy
  python -m pip config --user unset global.proxy
  ```

  `npm config list` shows `proxy` and `https-proxy` with any password masked; npm refuses `npm config get` for a proxy URL that contains one. On Windows, use `py -m pip` if `python` is not on `PATH`. Also check `http.proxy` in your VS Code User Settings and clear it if it should no longer be set.

- **Git is not detected**: make sure Git is installed and on `PATH` (`git --version`).
- **Auto mode does not pick up changes**: check your system proxy settings and adjust `otakProxy.pollingInterval`.
- **Remote, WSL, or container windows**: Windows registry and WinHTTP actions are available only when the extension host runs on local Windows. Remote hosts are diagnosed as remote targets, and Windows actions are skipped.

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
