# Status: Partially reverted (2026-06-06)

The bulk of this specification (ProxyUrlValidator, InputSanitizer,
ErrorAggregator, UserNotifier and friends) is alive and in active use
under `src/validation/` and `src/errors/`. Two pieces below were
removed as dead code.

## What was reverted

- **`ProxyUrl` data model** (`src/models/ProxyUrl.ts`, design.md §"ProxyUrl",
  tasks.md task 4): never referenced from production code; only its
  own unit test depended on it. Parsing and validation responsibility
  lives in `ProxyUrlValidator` instead. Removed in commit `7739413`.
- **`ValidationError` interface** (design.md §"ValidationError",
  tasks.md task 3.3): unused at runtime. `ProxyUrlValidator` surfaces
  errors as plain `string[]` via `ValidationResult.errors`. Removed
  alongside the rest of the dead-code sweep.

Read the corresponding sections of `design.md` / `tasks.md` as design
history, not current architecture. Everything else in this spec still
matches what ships.
