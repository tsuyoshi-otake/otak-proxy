<p align="center">
  <h1 align="center">otak-proxy</h1>
  <p align="center">One-click proxy management for VSCode, Git, and npm</p>
</p>

---

Toggle your proxy settings with a single click. Zero configuration required.

![](images/otak-proxy.png)

## Quick Start

1. Install the extension
2. Click the proxy indicator in the status bar
3. Choose your mode: **Off** → **Manual** → **Auto**

That's it. The extension handles Git, VSCode, and npm proxy settings automatically.

## Features

- **Three modes** — Off, Manual, or Auto (syncs with system proxy)
- **Status bar toggle** — One click to switch between modes
- **Auto-sync** — Detects system/browser proxy changes in real-time
- **Connection validation** — Tests proxy connectivity before enabling
- **i18n** — English and Japanese UI

## How It Works

### Status Bar
Click the proxy indicator to cycle through modes:

```
Off → Manual → Auto → Off
```

### Commands (Cmd/Ctrl + Shift + P)
| Command | Description |
|---------|-------------|
| Toggle Proxy | Cycle through modes |
| Test Proxy | Verify proxy connectivity |
| Import System Proxy | Detect and import system proxy |
| Configure Manual | Set a custom proxy URL |

## Status Indicators

| Indicator | State |
|-----------|-------|
| `Proxy: Off` | Disabled |
| `Manual: http://...` | Using configured proxy |
| `Auto: http://...` | Synced with system proxy |
| `Auto (Fallback): http://...` | System unavailable, using manual |
| `Auto: OFF` | Waiting for proxy availability |

## Configuration

```json
{
  "otakProxy.proxyUrl": "http://proxy.example.com:8080",
  "otakProxy.pollingInterval": 30,
  "otakProxy.enableFallback": true
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `proxyUrl` | Manual proxy URL | — |
| `pollingInterval` | System proxy check interval (sec) | 30 |
| `enableFallback` | Fall back to manual when system unavailable | true |

## Requirements

- VSCode 1.9.0+
- Git (in PATH)

## Troubleshooting

**Proxy not working?**
- Verify URL format includes protocol (`http://` or `https://`)
- Run "Test Proxy" to check connectivity
- Confirm Git is installed: `git --version`

**Auto mode not detecting changes?**
- Verify system proxy is configured correctly
- Adjust `pollingInterval` if needed

## Related Extensions

- **[otak-monitor](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-monitor)** — System resource monitoring
- **[otak-committer](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-committer)** — AI-powered commit messages
- **[otak-restart](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-restart)** — Quick reload shortcuts

## License

MIT

---

[Report Issues](https://github.com/tsuyoshi-otake/otak-proxy/issues) · [Source Code](https://github.com/tsuyoshi-otake/otak-proxy)
