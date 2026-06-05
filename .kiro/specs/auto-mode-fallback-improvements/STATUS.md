# Status: Reverted (2026-06-06)

This specification is retained as a historical record only. The
implementation it describes has been removed from the codebase.

## What was reverted

- `ProxyFallbackManager` class (`src/monitoring/ProxyFallbackManager.ts`)
  and its full test suite were deleted as dead code in commit
  `512e9d1` (chore: remove unused ProxyFallbackManager and related
  tests).
- The fallback logging helpers on `ProxyChangeLogger`
  (`logFallbackToManual`, `logAutoModeOff`, `logSystemReturn` and
  their getters/buffer) plus the `FallbackLogEvent` type were removed
  alongside the test file in a follow-up commit.

## What still ships

The user-visible `otakProxy.enableFallback` setting remains and is
honored inline by:

- `src/commands/ToggleProxyCommand.ts`
- `src/core/SystemProxyUpdateService.ts`

These call sites implement the "system → manual fallback → direct
connection" behavior directly, without the dedicated manager class.
Anything in `design.md` / `tasks.md` below that talks about the
`ProxyFallbackManager` class, its integration with `ProxyMonitor`, or
the dedicated fallback log buffer should be read as design history,
not current architecture.
