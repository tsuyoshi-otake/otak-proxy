# 検証済みのプロジェクト規則

- `[lifecycle]` `ProxyMonitor` の開始・停止境界をまたいで完了する非同期検出結果は、世代（epoch）を照合して破棄する。古いライフサイクルの結果を新しいライフサイクルへ公開してはならない。検証: `F-CANCEL-001` と `npm run verify:assurance`（2026-08-15）。
- `[assurance]` リリース判断用の統合証跡は `npm run verify:assurance` で生成し、各テスト実行後に `scripts/assurance/cleanup-test-processes.mjs` が runner survivor 0 件を記録する。検証: `assurance-run.json` の `allPassed=true`（2026-08-15）。
- `[testing]` コンポーネント自身が時刻を採取する future-timestamp 判定は、実時間の `max+1` 境界を直接使わない。時計を注入・固定するか、scheduler 遅延より十分大きい余裕を持つ値を使う。検証: Linux CI run 31818783246 の `ORC-SYNC-005` と 3.2.5 の再検証（2026-08-15）。
- `[concurrency]` lease を更新中の lock record が一時的に読めない場合、lock path が存在する限り競合側は `held` として fail closed する。部分書込みを I/O failure や再取得可能状態として扱わない。検証: Linux CI run 31819660784 と `ApplyLockService.lease.test.ts`（2026-08-15）。
