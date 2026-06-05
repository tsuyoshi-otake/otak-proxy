# Status: Partially reverted (2026-06-06)

The Auto-mode connection-testing feature itself is alive (see
`ProxyConnectionTester`, `ProxyTestScheduler`, and the `autoTestEnabled`
configuration). One supporting class was removed during a dead-code
sweep.

## What was reverted

- **`StateChangeDebouncer`** (`src/errors/StateChangeDebouncer.ts`,
  formerly used to implement Property 8 "consecutive state change
  notifications collapse to the final state"): never wired into the
  runtime; its only callers were tests. The class and three test
  files (unit, property-based, and the auto-mode integration suite
  that depended on it) were deleted in commit `39adecd`.

Property 8 itself is therefore not currently enforced. If the
behavior becomes necessary again, it should be reintroduced at the
notification or status-update layer rather than as a generic
event-stream debouncer. Treat sections of `design.md` / `tasks.md`
that mention `StateChangeDebouncer` as design history.
