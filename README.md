<p align="center">
  <h1 align="center">otak-proxy</h1>
  <p align="center">Proxy settings for VS Code, Git, npm, and integrated terminals.</p>
</p>

---

Use the status bar to switch proxy modes. Auto mode follows your system proxy; Manual mode uses the proxy URL you enter.

![otak-proxy](images/otak-proxy.png)

## Quick Start

### Auto Mode (System Proxy)

1. Install the extension.
2. Click the status bar and select **Auto**.
3. otak-proxy applies the system proxy to VS Code, Git, npm, and new integrated terminals.

### Manual Mode

1. Install the extension.
2. Click the status bar and select **Manual**.
3. Enter your proxy URL (for example: `http://proxy.example.com:8080`).

In both modes, otak-proxy updates proxy settings for VS Code, Git, and npm. It also sets proxy environment variables for new VS Code integrated terminals.

## Features

- **Modes** — Off, Manual, and Auto.
- **Auto mode** — Reads the system proxy and applies changes in the background.
- **Manual mode** — Uses the proxy URL you enter.
- **Status bar control** — Switch modes from the VS Code status bar.
- **Connection test** — Checks whether a proxy can be reached before enabling it.
- **Integrated terminals** — Sets `HTTP_PROXY` and `HTTPS_PROXY` for new VS Code terminals.
- **URL display setting** — Hide the proxy URL in the status bar when needed.
- **UI languages** — English, Japanese, Chinese (Simplified), Chinese (Traditional, Taiwan), Korean, and Vietnamese.

UI language follows your VS Code display language.

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

When proxy is enabled, otak-proxy sets these variables for **newly created** VS Code integrated terminals:

- `HTTP_PROXY` / `HTTPS_PROXY`
- `http_proxy` / `https_proxy`

Existing terminals keep their current environment. Open a new terminal for the updated values to take effect.

## Configuration

```json
{
  "otakProxy.proxyUrl": "http://proxy.example.com:8080",
  "otakProxy.pollingInterval": 30,
  "otakProxy.enableFallback": true,
  "otakProxy.showProxyUrl": true
}
```

### Settings

- **`otakProxy.proxyUrl`**: Manual proxy URL (default: unset)
- **`otakProxy.pollingInterval`**: System proxy check interval, in seconds (default: `30`)
- **`otakProxy.enableFallback`**: Fall back to the manual proxy when the system proxy is unavailable (default: `true`)
- **`otakProxy.showProxyUrl`**: Show the proxy URL in the status bar (default: `true`). Set this to `false` to display `Configured` instead of the actual URL.

## Commands

Access via the Command Palette (`Cmd/Ctrl+Shift+P`):

- `otak: Toggle Proxy`
- `otak: Test Proxy`
- `otak: Import System Proxy`
- `otak: Toggle Proxy URL Visibility`

## Requirements

- VS Code 1.9.0 or higher
- Git available on PATH

## Installation

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-proxy).
2. Click the status bar and choose **Auto** or **Manual**.

## Security & Privacy

### Local Configuration Changes

- Updates VS Code, Git, and npm proxy settings.
- Sets `HTTP_PROXY` and `HTTPS_PROXY` environment variables for new integrated terminals.

### Credentials

- No account or API key is required.
- If your proxy requires credentials, include them in the URL you provide.
- Passwords are masked when proxy URLs are shown in the UI or logs.

### Network Activity

- otak-proxy checks whether the proxy is reachable before enabling it.

## Troubleshooting

- **Proxy not working**: Make sure the URL starts with `http://` or `https://`, then run `Test Proxy`.
- **Git not detected**: Make sure Git is installed and available on PATH (`git --version`).
- **Auto mode does not detect changes**: Check your system proxy settings and adjust `otakProxy.pollingInterval`.

## Related Extensions

- **[otak-monitor](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-monitor)** — Real-time system monitoring in VS Code.
- **[otak-committer](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-committer)** — AI-assisted commit messages, pull requests, and issues.
- **[otak-restart](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-restart)** — Quick reload shortcuts.
- **[otak-clock](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-clock)** — Dual time zone clock for VS Code.
- **[otak-pomodoro](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-pomodoro)** — Pomodoro timer in VS Code.
- **[otak-zen](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-zen)** — Minimal, distraction-free VS Code UI.

## License

MIT License. See the [LICENSE](LICENSE) file for details.

## Links

- **[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-proxy)**
- **[GitHub](https://github.com/tsuyoshi-otake/otak-proxy)**
- **[Issues](https://github.com/tsuyoshi-otake/otak-proxy/issues)**
