# リリース評価

- 判定: **CONDITIONAL-GO**
- 判定方式: C2、mutation、TLC、traceability、全実行コマンド、process cleanup、証跡freshnessを機械gateとして評価した。
- 実機依存の成功主張は本仕様の対象外であり、制御済みテストと形式検査の範囲だけを根拠とする。

## Gate結果

- GATE-COMMANDS: PASS — 全必須コマンドが終了コード0で完了
- GATE-PROCESS-CLEANUP: PASS — 最終runner-survivors=0 の証跡
- GATE-C2: PASS — feasible C2=100%, unobserved=0
- GATE-MUTATION: PASS — score=100%, survived=0, equivalent=0
- GATE-TLA: PASS — allPassed=true, models=7
- GATE-TRACEABILITY: PASS — integrityProblems=0
- GATE-RELEASE-CRITICAL-SCOPE: PASS — 未検証のacceptance requirementなし
- GATE-FRESHNESS: PASS — C2/mutation/TLA+のsource hashが現在の入力と一致

## release条件

- CONDITIONAL-GO: 変更が状態モデル、外部境界、TLC定数、又はprovider契約を拡張する場合は、本評価を無効化して対応するテスト／モデルを追加する。rollbackは拡張機能を無効化又は既知の安定版へ戻すことで行う。

## 残存リスク

- DVA-1.5: 不一致は未発生であり、実不一致の最小再現記録はcalibration以外では未取得。
- DVA-2.3: 代表的な無効／境界値はあるが、全入力形式の無効値体系は未網羅。
- DVA-2.4: オラクルは許可／禁止副作用を定義するが、全SUT adapterが実副作用列を返して比較する構造ではない。
- DVA-2.6: 不一致分類の自動artifactは未実装。
- DVA-3.7: runId/atomic writeは実装済みだが、並列競合を専用負荷テストしていない。
- DVA-7.1: port化した境界はGit/npm/shared filesystemに限定される。
- DVA-7.2: CLI、VS Code storage、shared filesystem、local proxyのプロトコル互換境界を検査する。watch/pollと多actorの実filesystem競合は未再現として残す。
- DVA-7.4: 実filesystemのatomic write/rename/破損復旧は確認済みだが、watch/pollと多actor競合の実filesystem結合は未実施。
- DVA-7.5: CLI、VS Code storage、shared filesystem、local proxyのプロトコル互換境界を検査する。watch/pollと多actorの実filesystem競合は未再現として残す。
- DVA-7.6: CLI、VS Code storage、shared filesystem、local proxyのプロトコル互換境界を検査する。watch/pollと多actorの実filesystem競合は未再現として残す。
- DVA-7.7: CLI、VS Code storage、shared filesystem、local proxyのプロトコル互換境界を検査する。watch/pollと多actorの実filesystem競合は未再現として残す。
- DVA-8.1: テスト内注入は決定的だが、共通FaultPlan台帳／解除条件の実装は未完了。
- DVA-8.2: 主要な0/1/上限境界はPBT/TLAで扱うが、全資源型のmax-1/max/max+1は未実施。
- DVA-8.3: 決定的fault injectionで資源、retry、部分失敗、event、cancel、crash/restartを検査する。未実装の資源型とprovider固有の故障形は残存リスクとして明示する。
- DVA-8.4: retry上限、backoff、成功時resetは確認済み。Retry-After provider契約は未再現。
- DVA-8.5: 決定的fault injectionで資源、retry、部分失敗、event、cancel、crash/restartを検査する。未実装の資源型とprovider固有の故障形は残存リスクとして明示する。
- DVA-8.6: stop後の遅延完了とproxy timeoutは確認済みだが、全cancel/timeout所有者を網羅していない。
- DVA-8.7: 決定的fault injectionで資源、retry、部分失敗、event、cancel、crash/restartを検査する。未実装の資源型とprovider固有の故障形は残存リスクとして明示する。
- DVA-8.8: ENOSPC/EACCESは確認済み。EMFILE、lock枯渇、queue上限の実装結合注入は未実施。
- DVA-8.9: 決定的fault injectionで資源、retry、部分失敗、event、cancel、crash/restartを検査する。未実装の資源型とprovider固有の故障形は残存リスクとして明示する。
- DVA-8.10: 決定的fault injectionで資源、retry、部分失敗、event、cancel、crash/restartを検査する。未実装の資源型とprovider固有の故障形は残存リスクとして明示する。
- DVA-9.1: 実装非依存のlifecycle/sync有限抽象。targetごとの永続境界モデルは次段階。
- DVA-9.2: 複数actor/in-flight/event競合はモデル化済み。複数targetと全永続境界の状態は未抽象化。
- DVA-9.3: 実装非依存のlifecycle/sync有限抽象。targetごとの永続境界モデルは次段階。
- DVA-9.4: 実装非依存のlifecycle/sync有限抽象。targetごとの永続境界モデルは次段階。
- DVA-9.5: 実装非依存のlifecycle/sync有限抽象。targetごとの永続境界モデルは次段階。
- DVA-9.6: 実装非依存のlifecycle/sync有限抽象。targetごとの永続境界モデルは次段階。
- DVA-9.7: 実装非依存のlifecycle/sync有限抽象。targetごとの永続境界モデルは次段階。
- DVA-9.8: 実装非依存のlifecycle/sync有限抽象。targetごとの永続境界モデルは次段階。
- DVA-10.1: 固定seedのTLC BFS、Safety/Liveness/deadlock、期待反例到達性を記録する。無制限定数とcredential値は未探索。
- DVA-10.2: 固定seedのTLC BFS、Safety/Liveness/deadlock、期待反例到達性を記録する。無制限定数とcredential値は未探索。
- DVA-10.3: 固定seedのTLC BFS、Safety/Liveness/deadlock、期待反例到達性を記録する。無制限定数とcredential値は未探索。
- DVA-10.4: actor/retry/resource/timeは変化させたが、target数の定数行列は未実装。
- DVA-10.5: resource/epoch/単調replica/禁止状態を検査。credential値と実lock相互排他はTLAで未モデル化。
- DVA-10.6: Checking→Applied/Stopped/Failed/Crashedとsync収束を検査。partial/awaitingUser/cancelled全terminal集合は未モデル化。
- DVA-10.7: TLC deadlock検査は有効だが、抽象モデルはPulse Actionでterminalを進行可能に表現する。
- DVA-10.8: 固定seedのTLC BFS、Safety/Liveness/deadlock、期待反例到達性を記録する。無制限定数とcredential値は未探索。
- DVA-10.9: 固定seedのTLC BFS、Safety/Liveness/deadlock、期待反例到達性を記録する。無制限定数とcredential値は未探索。
- DVA-10.10: 固定seedのTLC BFS、Safety/Liveness/deadlock、期待反例到達性を記録する。無制限定数とcredential値は未探索。
- DVA-12.1: 機械検査可能な対応表と敵対的再監査を生成する。release gateは制御済み検証の結果と明示した残存リスクに基づき判定する。
- DVA-12.2: 機械検査可能な対応表と敵対的再監査を生成する。release gateは制御済み検証の結果と明示した残存リスクに基づき判定する。
- DVA-12.3: 機械検査可能な対応表と敵対的再監査を生成する。release gateは制御済み検証の結果と明示した残存リスクに基づき判定する。
- DVA-12.4: 機械検査可能な対応表と敵対的再監査を生成する。release gateは制御済み検証の結果と明示した残存リスクに基づき判定する。
- DVA-12.5: C2/mutation及びSafety gateの実行結果は敵対的監査で判定する。
- DVA-12.7: 有限探索とtest doubleの抽象化差はCONDITIONAL-GOの残存リスクとして監査結果へ記録する。
- DVA-12.8: 機械検査可能な対応表と敵対的再監査を生成する。release gateは制御済み検証の結果と明示した残存リスクに基づき判定する。
- environment-harness: VS Code host実行時のharness診断は environment-observations.md に記録した。テスト結果とcleanupは成功したが、ランチャー更新時に再確認する。
- model-abstraction: TLA+ は有限actor/時刻/resource/epoch/queueの抽象であり、無制限の値空間、credential値、実lock相互排他、全永続化targetは未探索。
- environment-assumption: sync livenessは信頼配送（MaxDrops=0）と明示したweak fairnessの仮定に依存する。loss-boundary反例はこの依存を確認している。
