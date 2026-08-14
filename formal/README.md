# TLA+ / TLC モデル検査

このディレクトリのモデルは TypeScript 実装を import せず、承認済みの状態・イベント・境界の棚卸しから定義した有限抽象です。

- `ProxyLifecycle.tla` は、開始・検査・適用・停止・タイムアウト・クラッシュ／再起動・遅延完了、論理 epoch、再試行、論理時間、資源上限を扱います。
- `SyncConvergence.tla` は、論理版、任意順序配送、重複、欠落、有限キュー、収束条件を扱います。

通常の `reliable-*` / `small` / `medium` 構成は Safety、Liveness、deadlock を検査します。`reachability` と `loss-boundary` は意図的に不変条件を破る構成であり、必須状態または仮定を外した禁止状態が到達可能であることを反例トレースで検証します。これらは製品不具合を示す失敗ではなく、検査器が到達性を実際に探索したことを示す期待反例です。

`npm run verify:tla` は TLC のバージョン、spec/config ハッシュ、探索方式、固定 seed、generated/distinct states、diameter、探索制約、期待結果と反例の有無を `.kiro/specs/domain-verification-assurance/evidence/runs/latest/tla.*` に保存します。

有限抽象のため、actor 数、論理時刻、epoch、キュー、drop 回数、資源数は各 `.cfg` の定数までしか探索しません。実 OS の時刻、無制限メッセージ列、実ネットワーク、実ファイルシステム、外部ツールのプロトコル詳細はこのモデルの対象外であり、結合テスト・failure injection・実機 E2E で補完します。
