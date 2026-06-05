# Status: Partially reverted (2026-06-06)

The multi-instance sync feature itself is shipping and active. One
type referenced by this spec was removed during a dead-code sweep.

## What was reverted

- **`ISyncStatusProvider` interface** (`src/sync/SyncStatusProvider.ts`,
  design.md §"Implementation Plan" row for Requirements 6.1-6.4):
  `SyncStatusProvider` was the only implementer and nothing depended
  on the interface as a contract. Removed in commit `9d3ede7`
  (`refactor(sync): tidy SyncStatusProvider and prune barrel
  exports`). The concrete `SyncStatusProvider` class is unchanged and
  fully implements the behavior described in this spec.

The `sync/index.ts` barrel was also slimmed in the same commit to
re-export only the four symbols `extension.ts` actually consumes
(`SyncManager`, `SyncConfigManager`, `SyncStatusProvider`,
`registerSyncStatusCommand`). All other types are still importable
directly from their originating modules.
