# 状態・イベント・遷移・永続化境界台帳

本台帳は、実装から独立した検証対象の状態機械を先に固定する。`terminal state` は呼出し元が結果として観測でき、最終化の所有者が明確な状態だけを指す。

| ID | Owner | Event / Guard | 遷移と副作用 | 永続化境界 | terminal state と最終化所有者 | 復旧 |
| --- | --- | --- | --- | --- | --- |
| ST-MODE | `ProxyStateManager` | toggle / current mode | Off→Auto、Auto→Off。Auto OFFはURLなし | BND-GSTATE、BND-SECRET | `saved` 又は `inMemoryFallback`。state managerが返却・保存 | 次のreadでsecretをhydrateし、旧ManualをAutoへ移行 |
| ST-APPLY | `SystemProxyUpdateService` | detected / absent / fallback reachable | deciding→applying→applied/partial/failed/awaitingUser | BND-GSTATE、BND-CLI、BND-VSCODE | aggregateをcallerへ返す。serviceがstatus更新を所有 | 次回poll又は明示applyで最新検出値を再評価 |
| ST-TARGET | `ProxyConfigTargetRunner` | set/clear result | pending→configured/cleared/skippedUnavailable/preservedExternal/failed | BND-CLI、BND-VSCODE | target resultをrunnerが返す | failedだけ再試行又は利用者判断、skipは失敗にしない |
| ST-SYNC | `SyncManager` | start/watch/poll/local write/remote event | stopped→starting→running→reconciling→running/stopped | BND-SHARED-FS、BND-REGISTRY、BND-TIMER | `stopped` はmanagerがwatcher/timerをdispose後に観測 | poll/restartでshared stateを再読込し競合解決 |
| ST-MONITOR | `ProxyMonitor` | start/tick/stop/detector completion | stopped→running→checking→running/stopped | BND-TIMER、BND-PROXY | `stopped` はmonitorがtimerを解放。in-flightのlate completionは副作用禁止 | 新しいstartでのみcheckを再開 |
| ST-LOCK | `ApplyLockService` | acquire/renew/release/expiry | free→held→renewed/released/expired | BND-APPLY-LOCK | release/expiryをlock serviceがtoken確認して最終化 | stale leaseを拒否し新ownerがacquire |
| ST-RECOVERY | `SharedStateFile`/registry | corrupt read/crash/restart | crashed→recovering→recovered/failed | BND-SHARED-FS、BND-REGISTRY | recovery callerが状態を検証しterminalを返す | temp/invalid stateを隔離し正当なdurable stateを採用 |

## catch・skip・retryの所有権

| 分岐 | 所有者 | 呼出し元への観測 | 禁止事項 |
| --- | --- | --- | --- |
| optional CLI が未導入 | target runner | `skippedUnavailable`、`success: true` | 全体を設定失敗と集約しない |
| individual target failure | target runner / applier | `failed`とerror type | 完全成功を返さない |
| retry/backoff | 各外部境界のowner | attempt数、次回時刻、上限terminal | 無制限再試行、stop後再試行 |
| publish失敗のsuppress | update service | logと保存済みstate、callerはapply結果 | publish失敗をapply成功証明にしない |
| cancel/timeout | operation owner | `cancelled`/`timeout`、late completionの無視 | stop後の新規設定write |

## 現行実装で再検証する候補

- `SyncManager` と `ProxyMonitor` のstopはtimerを解除するが、すでに開始済みの非同期処理のlate completionを抑止するepochを持つか、failure injectionで確認する。
- `ApplyLockService` のrenewは所有tokenとatomic writeの境界をfailure injectionで確認する。
- globalStateのread-modify-write競合は、複数actorのshared storageモデルではatomic mergeを仮定せず、残存リスクとして評価する。
