# Failure Injection Matrix

| Fault ID | 境界 | 注入 | 期待terminal state | 許可/禁止副作用 | 復旧 | 検証 |
| --- | --- | --- | --- | --- | --- | --- |
| F-BND-001 | BND-CLI/BND-TIMER | target数0/1/max-1/max/max+1、retry数0/1/max | diagnosed/failed/applied/partialのいずれか | 上限超過を成功として隠さない | 有効上限で再実行 | contract、PBT、TLA |
| F-PARTIAL-001 | BND-CLI | 5 target中1 targetがCONFIG_ERROR | partial/failed、個別outcome保持 | 完全成功は禁止 | 失敗targetだけ再試行 | contract、failure injection |
| F-RETRY-001 | BND-CLI/BND-PROXY | transient failure N回後にsuccess、Retry-After相当 | retry scheduled→applied又は上限failed | backoff/resetを記録 | fault解除後は1回収束 | failure injection、TLA |
| F-EVENT-001 | BND-SHARED-FS/BND-TIMER | duplicate/missing/reordered event | stale拒否、静止後converged | revision逆行禁止 | poll/restartで再同期 | PBT、filesystem integration、TLA |
| F-CANCEL-001 | BND-PROXY/BND-TIMER | stop/cancel後にlate completion | cancelled/stopped | stop後write禁止 | 明示startで再開 | lifecycle test、TLA |
| F-TIMEOUT-001 | BND-PROXY/BND-CLI | deadline超過、遅いsuccess | timeout | late resultを適用禁止 | 新requestのみ適用 | contract、failure injection |
| F-CRASH-001 | BND-SHARED-FS/BND-APPLY-LOCK | temp write中crash、stale lease | recovered/failed | secret/public state分離、重複apply禁止 | restart/recover | filesystem integration、TLA |
| F-RESOURCE-001 | BND-SHARED-FS/BND-APPLY-LOCK | ENOSPC/EMFILE/EACCES/lock/queue exhaustion | failed/degraded | bounded in-flight、明示error | resource解放後収束 | fault fake、TLA |

未該当を宣言する場合はfault ID、対象外の理由、代替検証、releaseへの影響を追跡表に記録する。
