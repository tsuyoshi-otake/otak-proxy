# Mutation Result

- Tool: otak-proxy deterministic source mutation harness v1 (Node v26.2.0)
- Scope: 各ドメイン決定表、永続化境界、ライフサイクル境界に対応する比較・否定・分岐反転を、隔離済みコンパイル出力に一変異ずつ適用する。全リポジトリを網羅する主張ではない。
- Raw mutation score: 100.00% (12/12 total mutants killed)
- Adjusted mutation score: 100.00% (12/12 non-equivalent mutants killed)
- Surviving mutants: 0
- Equivalent mutants: 0
- Timeouts: 0; no coverage: 0; compile errors: 0; ignored: 0; unclassified: 0

| Mutant | Operator | Status | Source | Test evidence | Equivalence analysis |
| --- | --- | --- | --- | --- | --- |
| MNT-MODE-001 | EqualityOperatorReplacement | killed | src/core/ProxyStateManager.ts | ORC-MODE-003, PBT-MODE-001 | None; behavior differs for a reachable input. |
| MNT-APPLY-001 | UnaryOperatorRemoval | killed | src/core/v3Types.ts | ORC-APPLY-001, PBT-APPLY-001 | None; behavior differs for a reachable input. |
| MNT-APPLY-002 | EqualityOperatorReplacement | killed | src/core/v3Types.ts | ORC-APPLY-002, ORC-APPLY-003, PBT-APPLY-001 | None; behavior differs for a reachable input. |
| MNT-APPLY-003 | RelationalOperatorReplacement | killed | src/core/v3Types.ts | ORC-APPLY-003, ORC-APPLY-005, PBT-APPLY-001 | None; behavior differs for a reachable input. |
| MNT-TARGET-001 | UnaryOperatorRemoval | killed | src/core/ProxyConfigTargetRunner.ts | ORC-TARGET-001, ORC-TARGET-002, PBT-TARGET-001 | None; behavior differs for a reachable input. |
| MNT-TARGET-002 | UnaryOperatorInsertion | killed | src/core/ProxyConfigTargetRunner.ts | ORC-TARGET-001, ORC-TARGET-002, PBT-TARGET-001 | None; behavior differs for a reachable input. |
| MNT-SYNC-001 | RelationalOperatorReplacement | killed | src/sync/ConflictResolver.ts | ORC-SYNC-001, ORC-SYNC-002, PBT-SYNC-001 | None; behavior differs for a reachable input. |
| MNT-SYNC-002 | RelationalOperatorReplacement | killed | src/sync/ConflictResolver.ts | ORC-SYNC-001, ORC-SYNC-002, PBT-SYNC-001 | None; behavior differs for a reachable input. |
| MNT-SYNC-003 | UnaryOperatorRemoval | killed | src/sync/ConflictResolver.ts | ORC-SYNC-005, ORC-SYNC-007, PBT-SYNC-001 | None; behavior differs for a reachable input. |
| MNT-SYNC-004 | UnaryOperatorRemoval | killed | src/sync/ConflictResolver.ts | ORC-SYNC-006, PBT-SYNC-001 | None; behavior differs for a reachable input. |
| MNT-LIFECYCLE-001 | UnaryOperatorRemoval | killed | src/monitoring/ProxyMonitor.ts | PBT-LIFECYCLE-001, F-CANCEL-001 | None; behavior differs for a reachable input. |
| MNT-PERSIST-001 | RelationalOperatorReplacement | killed | src/sync/SharedStateFile.ts | F-PERSIST-RETRY-001, CT-STATE-001 | None; behavior differs for a reachable input. |
