<p align="center">
  <h1 align="center">otak-proxy</h1>
  <p align="center">Dead-simple proxy toggling for VSCode & Git</p>
</p>

---

Switch your proxy on and off with a single click. No hassle, no config files.

![](images/otak-proxy.png)

## What it does

- **Three-mode system** - Auto (system), Manual, or Off
- **Auto mode** - Syncs with your system/browser proxy in real-time
- **Manual mode** - Use your own fixed proxy settings
- **One-click cycling** - Click status bar to cycle: Off → Manual → Auto
- **Live monitoring** - Auto mode checks for system proxy changes
- **Connection testing** - Verify proxy works before enabling
- **Smart detection** - Finds proxy from browser, system, or environment

## Getting started

### Quick setup
The extension asks how you want to configure proxy on first launch:
- **Auto (System)** - Automatically uses your browser/system proxy
- **Manual Setup** - Set your own proxy URL
- **Skip** - Configure later

### Three modes explained

#### Off Mode
Proxy disabled - no proxy settings applied

#### Manual Mode
Uses your configured proxy URL - stays fixed until you change it

#### Auto Mode
Automatically syncs with system proxy:
- Detects browser/system proxy settings
- Checks every minute for proxy changes
- Also updates immediately when switching back to VSCode
- Perfect for network switching scenarios

### Using it
- **Click status bar** - Cycles through Off → Manual → Auto
- **Command palette** (`F1`):
  - "Toggle Proxy" - Cycle modes
  - "Test Proxy" - Test current proxy
  - "Import System Proxy" - Detect and use system proxy
  - "Configure Manual" - Set manual proxy URL

## Status indicators

- **$(circle-slash) Proxy: Off** - Proxy disabled
- **$(plug) Manual: http://...** - Using manual proxy
- **$(sync~spin) Auto: http://...** - Using system proxy (auto-sync)
- **$(sync~spin) Auto: No system proxy** - Auto mode, but no system proxy detected

## Prerequisites

- VSCode 1.9.0+
- Git installed and in PATH

## Configuration

### Manual proxy URL
Set your manual proxy in settings:
```json
{
  "otakProxy.proxyUrl": "http://proxy.example.com:8080"
}
```

### Auto mode detection sources
Auto mode checks these sources (in order):
1. Environment variables (`HTTP_PROXY`, `HTTPS_PROXY`)
2. VSCode's existing proxy setting
3. **Windows**: Internet Explorer settings (registry)
4. **macOS**: System network preferences (Wi-Fi, Ethernet, etc.)
5. **Linux**: GNOME proxy settings (gsettings)

## Troubleshooting

### Proxy won't enable?
- Check the URL format (needs `http://` or `https://`)
- Run "Test Proxy" to verify connection
- Make sure Git is installed (`git --version`)

### Settings not applying?
- VSCode might need a restart for some proxy changes
- Check you have permission to modify Git global config

## More from otak

### System & Performance
- **[otak-monitor](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-monitor)** - Live CPU, memory & disk monitoring in your status bar
- **[otak-restart](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-restart)** - Quick restart buttons for Extension Host and VSCode

### Productivity
- **[otak-committer](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-committer)** - AI-powered commit messages in 25+ languages
- **[otak-pomodoro](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-pomodoro)** - Pomodoro timer for focused work sessions
- **[otak-clock](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-clock)** - Dual timezone clock for remote teams

### Workflow
- **[otak-zen](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-zen)** - Distraction-free coding mode

## License

MIT

---

**Issues?** [Report on GitHub](https://github.com/tsuyoshi-otake/otak-proxy/issues) | **Source:** [GitHub](https://github.com/tsuyoshi-otake/otak-proxy)