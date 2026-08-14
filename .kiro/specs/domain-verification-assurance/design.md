# 設計書

## 1. 設計の目的と判断

本設計は、otak-proxy の状態fulなドメイン判断と外部境界について、実装とは独立した期待値、再現可能な探索、故障を注入した結合検証、及び有限状態モデル検査を一つの検証体系として実装するためのものである。

この体系は、単なるコードカバレッジを増やすものではない。以下を同時に満たすことを目的とする。

- 要件から直接導いたオラクルで本番実装を判定する。
- PBT、原子条件単位の C2、mutation testing を相互補完的に使い、欠陥検出力を測る。
- 永続化・外部連携・非同期ライフサイクルを、プロトコル互換 fake と実境界の両方で検証する。
- 実装構造を写経しない TLA+ 仕様で、interleaving、故障、論理時間、資源上限及び復旧を探索する。
- すべての結論と限界を追跡表・実行証跡・敵対的再監査に残し、リリース可否を機械的な gate と根拠に分けて判断する。

現行プロダクトのモードは **Off ↔ Auto** の二状態とする。手動 URL は Auto がシステムプロキシを検出できない際の fallback 入力であり、独立した Manual mode は設計履歴としてのみ扱う。要件・steering と過去仕様が矛盾する場合は、現行 steering を優先し、矛盾を `evidence/assumptions.md` に残す。

## 2. スコープ、非目標及び設計原則

### 2.1 対象のドメイン判断

次の判断を release-critical とし、独立オラクル、C2、mutation testing 及び少なくとも一つの形式モデル又は故障注入テストで扱う。

| ID | ドメイン判断 | 実装入口 | 主な不変条件 |
| --- | --- | --- | --- |
| DOM-MODE | Off/Auto と Auto OFF の URL 選択・toggle | `ProxyStateManager.getActiveProxyUrl`、`getNextMode` | Off と Auto OFF は有効 URL を出力しない |
| DOM-APPLY | 検出・fallback・apply/clear・収束判定 | `SystemProxyUpdateService`、`ProxyApplier`、`v3Types.deriveRuntimeApplyState` | 成功していない target を完全成功として扱わない |
| DOM-TARGET | 各設定 target の set/clear/skip/fail 集約 | `ProxyConfigTargetRunner`、`ProxyConfigStateTracker` | optional tool の未導入と実設定失敗を混同しない |
| DOM-SYNC | timestamp 競合、再主張、収束 | `ConflictResolver`、`SyncReconciler` | stale update は正当な新状態を上書きしない |
| DOM-LIFECYCLE | start/stop/cancel と遅延完了 | `SyncManager`、`ProxyMonitor`、remediation | 停止後に新しい副作用を発生させない |
| DOM-RECOVERY | lock、共有ファイル、crash/restart からの回復 | `SharedStateFile`、`InstanceRegistryStore`、`ApplyLockService` | lock 所有権・revision・secret 境界を破らない |

### 2.2 外部境界

| ID | 境界 | 主な所有者 | 永続化又はプロトコル上の性質 |
| --- | --- | --- | --- |
| BND-GSTATE | VS Code `globalState` | `ProxyStateManager`、`FlapTracker` | read-modify-write、復元、競合 |
| BND-SECRET | VS Code `SecretStorage` | `ProxyStateManager` | 値の秘匿、削除、失敗時の観測 |
| BND-VSCODE | Configuration/Memento/event/env collection | config・UI 層 | 更新、event、dispose、観測順序 |
| BND-CLI | Git/npm/pip/terminal 環境 | 各 `*ConfigManager` | argv、env、stdout/stderr、exit code、timeout |
| BND-SHARED-FS | 共有状態ファイル・watch・poll | `SharedStateFile`、`SyncManager` | temp-write/rename、破損、競合、再起動 |
| BND-REGISTRY | instance registry / mutex file | `InstanceRegistryStore` | 所有権、stale lock、解放 |
| BND-APPLY-LOCK | remediation apply lease | `ApplyLockService` | token、TTL、renew、release |
| BND-PROXY | system proxy・接続検査 | detector・monitor・connection checker | 成功、拒否、切断、遅延、timeout |
| BND-TIMER | polling、retry、refresh | monitor・sync・remediation | 同時実行上限、停止時の所有権、late completion |

### 2.3 非目標

- 本設計は production API を広く抽象化し直すリファクタリングではない。テスト不能な外部境界にだけ狭い port を追加する。
- 有限の TLC 探索を無制限の正しさの証明として主張しない。
- coverage の数値だけを release 判定に使わない。C2、mutation、形式検査、実境界証跡の全てを判定根拠にする。
- 実在の proxy 資格情報、ユーザー設定その他の secret をテスト入力又は証跡に保存しない。

### 2.4 基本原則

1. **独立性**: オラクルは `src/` の production 関数・型・定数を import しない。SUT 呼出しは adapter に隔離する。
2. **単一評価**: C2 instrumentation は対象原子条件を一回だけ評価し、短絡評価を変えない。
3. **決定性**: 故障注入、PBT seed、時刻、乱数、試行回数、並行度をすべて記録・指定可能にする。
4. **境界の忠実性**: fake は成功値だけでなくエラー分類、遅延、停止、dispose、部分書込みを再現する。
5. **最終状態の明示**: catch、skip、retry、delegate、cancel、timeout の全経路に terminal state と最終化の所有者を定義する。
6. **隔離**: 実行中の一時ファイルは repository 外の `C:\Users\developer\tmp\` 配下に限定し、公式証跡だけを明示的に spec 配下へ保存する。
7. **否定的検証**: known-bad oracle、到達可能性の逆不変条件、mutation survivor の再監査を必須にする。

## 3. 全体アーキテクチャ

```text
承認済み要件・steering・不変条件
              │
              ▼
  要件に基づく決定表 ──► 独立オラクル ──► 具体例 / PBT
              │                 │               │
              │                 └── SUT adapter ┘
              │                         │
              ▼                         ▼
 状態・境界・故障台帳 ──► 契約 / API結合 / failure injection
              │                         │
              ├──► C2 instrumentation ─┤
              ├──► mutation testing ────┤
              └──► TLA+ Action/Property ┘
                                        │
                                        ▼
        evidence JSON + rendered report + traceability verifier
                                        │
                                        ▼
                         adversarial audit / release assessment
```

設計上の依存方向は次の通りとする。

```text
requirements / decision tables ──► oracle
production implementation ───────► SUT adapter
oracle + adapter ────────────────► tests
test/fault/TLC results ──────────► evidence
evidence + manifests ────────────► traceability and release assessment
```

`oracle` から production implementation へ向かう import を禁止する。テストは oracle と adapter の両方を参照できるが、期待値の算出に adapter の結果を使ってはならない。

## 4. 成果物の配置とライフサイクル

```text
.kiro/specs/domain-verification-assurance/
  requirements.md
  design.md
  tasks.md
  formal/
    ProxyLifecycle.tla
    ProxyLifecycle.small.cfg
    ProxyLifecycle.medium.cfg
    ProxyLifecycle.reachability.cfg
    SyncConvergence.tla
    SyncConvergence.small.cfg
    SyncConvergence.medium.cfg
    SyncConvergence.reachability.cfg
  evidence/
    manifests/
      domain-decisions.json
      c2-targets.json
      mutation-scope.json
      traceability.json
    pbt/
      replay-fixtures.json
    runs/<run-id>/
      pbt.json
      c2.json
      mutation.json
      mutation-classification.json
      tlc/*.json
      commands.json
      process-cleanup.json
    state-transitions.md
    failure-matrix.md
    assumptions.md
    adversarial-audit.md
    release-assessment.md
    index.json

src/test/assurance/
  oracle/
    DomainModel.ts
    DomainOracle.ts
    DecisionTables.ts
    SUTAdapters.ts
  support/
    PbtLedger.ts
    FaultPlan.ts
    ProtocolFakes.ts
    TestClock.ts
  DomainOracle.examples.test.ts
  DomainOracle.property.test.ts
  ExternalBoundary.contract.test.ts
  FailureInjection.integration.test.ts
  Lifecycle.model.property.test.ts

scripts/assurance/
  run-pbt-replay.mjs
  run-c2.mjs
  c2-instrument.mjs
  c2-hook.cjs
  c2-runtime.cjs
  analyze-mutation.mjs
  run-tla.mjs
  verify-traceability.mjs
  run-assurance.mjs
  cleanup-test-processes.mjs
```

通常の開発テストは OS 一時領域に run ごとの証跡を出力する。`verify:assurance` は全検証が終了し、検証・redaction・識別子整合性の確認に成功した run だけを `evidence/runs/<run-id>/` と `evidence/index.json` へ昇格させる。失敗した PBT の最小反例は例外であり、失敗時にも一時証跡を残し、再現コマンドとともに保全する。公式証跡の昇格は、secret scanner と worktree 情報の記録を通過した場合に限る。

## 5. 独立オラクルと具体例ベーステスト

### 5.1 canonical model

`src/test/assurance/oracle/DomainModel.ts` は production の enum、interface、定数を import せず、テスト専用の literal union と record だけで次を表現する。

| 型 | 内容 |
| --- | --- |
| `ModeInput` | `"off" | "auto"`、auto の有効/無効、検出 URL、fallback URL |
| `TargetOutcome` | required/optional、set/clear、success/failed/skipped-unavailable/preserved-external |
| `ApplyInput` | 検出結果、接続結果、要求 target、各 target 結果、retry/cancel/timeout 状態 |
| `SyncInput` | local/remote revision・logical timestamp、到着イベント列、actor、restart 情報 |
| `LifecycleInput` | started/running/stopping/stopped/crashed/recovering、in-flight operation、deadline |
| `OracleResult` | expected next state、terminal state、許可/禁止副作用、reason code、対応要件 ID |

値の意味を固定するため、時刻は整数の論理時刻、URL は `safe://proxy/<id>` のような非秘密トークン、外部エラーは標準化された `"not-installed" | "config-error" | "timeout" | "cancelled"` で表現する。production のエラー文字列や真偽フラグを転載しない。

### 5.2 決定表とオラクル

`DecisionTables.ts` は要件から導く読みやすい行形式の決定表を持つ。例えば URL 選択は、Off、Auto+検出、Auto+fallback、Auto+有効 URL なし、Auto OFF を別行とし、期待 URL、terminal、許可される apply の有無を明記する。同期は remote-newer、local-newer、same-write、future-clock-rejected、equal-timestamp の5行以上に分ける。target 集約は required 成功、optional 未導入、required 失敗、外部所有保持、cancel/timeout を別行にする。

`DomainOracle.ts` は決定表と明文化した不変条件から `OracleResult` を導く。production 関数名、production の定数、production の boolean 条件式を参照してはならない。独立性は静的検査で保証する。

- `verify-traceability.mjs` は oracle 配下の import を解析し、`src/` への import、`out/` への import、production 型への型参照を失敗とする。
- 決定表の各行には `oracleCaseId`、requirements、前提、入力、期待結果、許可/禁止副作用を必須にする。
- URL/credential を扱う行は token 化された値だけを使い、文字列に credential らしい構文がないことを検査する。

### 5.3 SUT adapter

`SUTAdapters.ts` だけが production の型・関数・クラスを import する。adapter は canonical input を SUT 入力に変換し、実測した次状態、terminal、target ごとの副作用 log を canonical output に逆変換する薄い層である。

adapter に判断を置かないため、次を禁止する。

- expected 値を決める if/switch を置くこと。
- oracle 結果を production 入力にコピーして循環させること。
- production の private state を直接書き換えて期待結果を作ること。

adapter が必要な可観測性は、public API、注入済み port の log、明示した test-only observer に限定する。private field の読み取りが不可避な場合は、設計不足として明示し、production に観測用の read-only result を追加するか、対象を未検証に残す。

### 5.4 具体例、negative control、比較規則

具体例は各 `oracleCaseId` に対応する。最低限、正常、0/1/最大値/最大値前後、空、無効、optional tool 未導入、部分失敗、既知回帰、restart 後の復元を含める。

比較は最終値だけではない。次の tuple を比較する。

```text
(next domain state, terminal state, per-target outcome,
 allowed side effects, prohibited side effects, persisted public state)
```

negative control として、Auto OFF 時に fallback を返す、optional tool 未導入を failure と集計する、stale remote を採用する、停止後の late completion を apply する、のような既知の誤実装を oracle test に渡す。決定表テストは各誤実装を失敗として検出しなければならない。オラクル不一致が起きた場合は `oracle-disagreement` として保存し、実装の出力で期待値を更新しない。

## 6. PBT、seed、縮小反例及び replay

### 6.1 property registry

`PbtLedger.ts` と `PbtPropertyRegistry.ts`（必要なら support 配下へ配置）は、property ごとに以下を登録する。

| フィールド | 説明 |
| --- | --- |
| `propertyId` | 例: `PBT-MODE-001`。一意で安定した識別子 |
| `requirements` | 対応する DVA とドメイン要件 ID |
| `generatorVersion` | arbitrary、size、max length、precondition の版 |
| `runMode` | deterministic matrix、CI、local fast、replay、calibration |
| `oracle` | 比較する oracle case / invariant |
| `failureRedactor` | 反例を安全に保存する関数 |

対象 property は少なくとも以下とする。

- `PBT-MODE-001`: mode、検出、fallback、Auto OFF の任意組合せで oracle と SUT が一致する。
- `PBT-TARGET-001`: target 結果の順列・部分失敗で集約が完全成功を偽装せず、optional 未導入が区別される。
- `PBT-SYNC-001`: duplicate/missing/reordered event と restart を含むイベント列で stale update を採用せず、静止後に正当な revision へ収束する。
- `PBT-LIFECYCLE-001`: start/stop/cancel/late completion の列で stop 後の副作用が発生しない。
- `PBT-RECOVERY-001`: crash/restart/lease expiry/repair の列で二重 apply や所有権侵害を起こさない。
- `PBT-CAL-001`: known-bad model が失敗し、shrink され、保存反例を replay すると同じ理由で失敗する。

### 6.2 実行と証跡形式

fast-check は `fc.assert` のみで終えず、`fc.check` 又は `fc.asyncCheck` の結果を取得する。各 property run は atomic temp-write/rename で、次の JSON を一意な `runId` のファイルへ保存する。

```json
{
  "schemaVersion": 1,
  "runId": "20260814T142325Z-PBT-MODE-001-0001",
  "propertyId": "PBT-MODE-001",
  "status": "passed",
  "seed": 123456789,
  "path": null,
  "numRuns": 500,
  "numSkips": 0,
  "numShrinks": 0,
  "generatorVersion": "mode-v1",
  "counterexample": null,
  "counterexamplePath": null,
  "tool": { "name": "fast-check", "version": "recorded-at-run" },
  "requirements": ["DVA-3.1", "DVA-3.4", "DVA-3.5"],
  "redaction": "safe-token-v1"
}
```

失敗時は `status: "failed"`、元 seed、path、縮小後 counterexample、shrink 数、元の失敗メッセージを redaction 後に必ず含める。反例は JSON で lossless に表現できない値を使わない generator とし、イベント列の要素にも安定 ID を与える。

seed は以下の二層にする。

1. `replay-fixtures.json` に固定 seed matrix と既知反例を version 管理する。各 CI run は必ず全件を実行する。
2. 公式検証 run は追加 seed を暗号学的乱数で生成し、その値を同じ証跡に保存する。次回の CI は成功 seed を fixture に自動昇格せず、人が review して採用する。

`test:pbt:replay -- --artifact <path>` は artifact の `propertyId`、seed、path、generator version を検証してから単一 property を実行する。再現された失敗理由と正規化反例が artifact と一致しない場合は失敗とする。並列時は `runId` に process ID と単調 sequence を加え、同名書込みを防ぐ。

## 7. 原子条件 C2

### 7.1 対象と manifest

`evidence/manifests/c2-targets.json` は「対象 source method」、「原子条件の位置」、「対応要件」、「到達不能判定の有無」を source hash とともに持つ。初期対象は以下とする。

| C2 group | 対象 |
| --- | --- |
| C2-MODE | `ProxyStateManager.getActiveProxyUrl`、`getNextMode` |
| C2-APPLY | `SystemProxyUpdateService` の検出/fallback/再適用判断、`deriveRuntimeApplyState` |
| C2-TARGET | `ProxyConfigTargetRunner.updateProxyConfigTargetDetailed`、`ProxyConfigStateTracker` |
| C2-SYNC | `ConflictResolver.resolve`、`reconcileSharedState` |
| C2-RECOVERY | `SharedStateFile` の破損・rename retry、`InstanceRegistryStore`、`ApplyLockService` |
| C2-LIFECYCLE | `ProxyMonitor`、`SyncManager` の start/stop/in-flight guard |

manifest は AST 解析後に得た各原子条件の source span、表示式、親複合条件、対応要件、可行性分類を保存する。`&&`、`||`、`!`、ternary の guard、if/while/for/conditional expression 内の真偽部分を分析し、関数呼出し・比較・identifier・括弧内の非論理式を原子として扱う。`&&`/`||` の右辺が未評価であった場合は `unobserved` のままとする。

### 7.2 instrumentation 方式

`c2-instrument.mjs` は TypeScript Compiler API の AST transform を用い、test 専用の隔離出力にだけ次の意味保存 wrapper を挿入する。

```ts
__otakProxyC2Observe("C2-APPLY-014", originalAtomicExpression)
```

wrapper は `originalAtomicExpression` を一度だけ評価し、`Boolean(value)` の true/false 観測数を追加して同じ値を返す。これにより副作用を持つ predicate と短絡評価の意味を変えない。source と `out/` を直接変更せず、隔離 build 又は module remapping hook で instrumentation 済み JavaScript を読み込む。

`run-c2.mjs` は対象 test を serial に実行し、各条件について true count、false count、unobserved count を記録する。報告は以下を分ける。

- raw C2: manifest 全条件に対する T/F 観測率。
- feasible C2: 承認済みの `infeasible` を除いた条件に対する T/F 観測率。
- 未観測一覧: T/F の片側のみ又は未評価の source span、根拠、必要なテスト ID。

`infeasible` は invariant、型、入力 domain、TLA+ 到達不能性、又は source 内で既に証明された guard を根拠にし、requirements、証明参照、承認者を必須とする。説明だけの除外は不可とし、release-critical group の feasible C2 は 100% 未満で release gate を通さない。

## 8. Mutation testing と mutant 分析

### 8.1 実行範囲

implementation phase で `@stryker-mutator/core`、`@stryker-mutator/mocha-runner`、`@stryker-mutator/typescript-checker` を lockfile 上で同じ version に固定する。現時点の選定候補は 9.6.1 であり、導入時に registry と lockfile の解決結果を証跡へ記録する。

Stryker の対象は第2.1節の release-critical source のみに限定し、テストは独立オラクル、具体例、PBT replay、契約、failure injection の関連 suite を含める。対象外 source と理由は `mutation-scope.json` に記録する。全 repository を無差別に mutate して遅い・不明瞭な数値を出すことはしない。

### 8.2 結果分類

`analyze-mutation.mjs` は Stryker JSON report を読み、mutant ごとに以下を一意に分類する。

| 分類 | 扱い |
| --- | --- |
| killed | テストが意味のある差を検出した |
| survived | 追加テスト、実装欠陥、又は同値性証明が必要 |
| timeout | timeout 根拠と再試行結果を残す。自動的に killed としない |
| no-coverage | 未到達として欠陥検出力がない扱い |
| compile-error | tool/config か型制約の問題として根拠を残す |
| ignored | 事前に承認された対象外のみ |
| equivalent | 観測可能な差がないことを根拠付きで手動承認したもの |

各 `survived` と `equivalent` には、mutant ID、source span、operator、元/変異後、関連 DVA、到達入力、観測可能性、追加テスト案、分類者、根拠リンクを付ける。equivalent は型により未到達、要件不変条件により同一、又は意味保存であることを具体的に示す。十分な証明がなければ survived と扱う。

報告する数値は raw score、equivalent 件数、調整後 score、未分類件数である。release-critical scope では非 equivalent survivor が 0、未分類 0、調整後 score が 90% 以上であることを release gate とする。

## 9. 状態・遷移・terminal state の台帳

`evidence/state-transitions.md` を実装前に作成し、実装時に入口・test・TLA+ action を追記する。各行には state ID、owner、event、guard、side effect、persistent boundary、success/partial/fail/skip/cancel/timeout terminal、finalization owner、caller-visible result、recovery action を必須とする。

初期台帳は次の責務分割で始める。

| ID | Owner | 代表イベント | 状態遷移 | 最終化の所有者 |
| --- | --- | --- | --- | --- |
| ST-MODE | `ProxyStateManager` | toggle、state restore | off → auto / auto → off、auto enabled/disabled | state manager が戻り state を保存・返却 |
| ST-APPLY | `SystemProxyUpdateService` | detected、absent、fallback、apply result | idle → deciding → applying → applied/partial/failed/awaiting-user/cancelled | update service が aggregate result を返す |
| ST-TARGET | `ProxyConfigTargetRunner` | set/clear result | pending → configured/cleared/skipped/preserved/failed | runner が target result を返す |
| ST-SYNC | `SyncManager` | local write、remote file/watch/poll | stopped → starting → running → reconciling → running/stopped | sync manager が watcher/timer/remote action を dispose |
| ST-MONITOR | `ProxyMonitor` | start、tick、stop、late detector resolution | stopped → running → checking → running/stopped | monitor が timer と in-flight epoch を所有 |
| ST-LOCK | `ApplyLockService` | acquire、renew、release、expiry | free → held → renewed/released/expired | lock service が token を検証して release |
| ST-RECOVERY | shared file/registry | crash、restart、corrupt read | crashed → recovering → recovered/failed | recovering actor が durable state を検証し terminal を返す |

timer/polling/retry の台帳には最大 in-flight 数、dedupe key、backoff 上限、retry-after 相当の待機、stop 後に残る operation の finalization owner を記載する。現行実装に terminal state 又は late completion の所有権がないことが判明した場合は、テストで隠さず `DVA-6.6` の違反候補として evidence に残し、最小修正を設計・実装する。

## 10. プロトコル互換 fake、API結合テスト、契約テスト

### 10.1 port の追加方針

本番処理は既定で現在の Node/VS Code/CLI 実装を使い続ける。必要な箇所だけ、constructor 又は factory の optional dependency として狭い port を追加する。global mock、module cache の書換え、production と異なる専用 code path は使わない。

| Port | 適用先 | 最低限の契約 |
| --- | --- | --- |
| `CommandExecutor` | Git/npm/pip config manager、必要な detector | executable、argv、cwd、env、timeout、stdout、stderr、exit code、signal、spawn failure |
| `FileSystemPort` | shared state、registry、apply lock | read/write/open exclusive/rename/unlink/stat、watch、error code、atomicity境界 |
| `ClockSchedulerPort` | monitor、sync、retry/lease | logical now、set/clear timer、scheduled callback、dispose、in-flight token |
| `VsCodeStoragePort` | Memento、SecretStorage、Configuration、env collection | get/update/delete、change event、dispose、failure、observable update order |
| `ConnectionProbePort` | proxy connection checker | endpoint、request bytes、response/rejection/close/delay/timeout/cancel |

port は production の公開 API に不要な抽象を漏らさず、default adapter を通じて既存動作を維持する。インターフェース追加が必要な場合は、既存 constructor call site を壊さない optional parameter とし、戻り値で terminal result を観測できるようにする。

### 10.2 protocol fake と実境界の役割分担

`ProtocolFakes.ts` は単純な `true/false` stub ではなく、呼出し log、順序、遅延、error shape、cancel、dispose を提供する決定的な fake である。`FaultPlan` により「N 回目の rename で `ENOSPC`」「argv が期待順でない場合は exit code 2」「timeout より後に completion を返す」といった注入を宣言する。

| 検証 | fake | 実境界 |
| --- | --- | --- |
| CLI 契約 | Node `execFile` と同形の result/error | test executable 又は protocol fake を使い、argv/env/timeout 解釈を確認 |
| VS Code API | observable API と change event を実装 | extension-host suite で Memento/SecretStorage/config/event を確認 |
| file 同期 | 操作ごとの deterministic fault | 一意な temp directory の実 filesystem で temp-write/rename/watch/poll/corrupt read を確認 |
| proxy 接続 | response script を持つ local fake | localhost の protocol-compatible server/proxy fixture で success/refusal/close/delay を確認 |
| 時間・cancel | manual logical scheduler | 実 timeout は短く有界にして integration suite で確認 |

fake と実境界の抽象化差（Windows rename、file watcher event coalescing、CLI の locale/exit code、VS Code host の永続化 timing など）は `assumptions.md` と release assessment に明記する。

### 10.3 failure injection matrix

`evidence/failure-matrix.md` は最低限次の行を持ち、各行を test ID、PBT property、TLA action/property、証跡へ接続する。

| Fault family | 注入点 | 期待する観測可能な結果 | 復旧確認 |
| --- | --- | --- | --- |
| 境界値 | actor/target/retry/queue の 0, 1, max-1, max, max+1、空集合 | 明示的 success/partial/failure、上限超過を隠さない | 有効範囲に戻すと収束 |
| 部分失敗 | 個別 config target/永続化 write | per-target result を保持し完全成功にしない | 失敗 target のみ再試行又は利用者へ提示 |
| retry | transient CLI/file/probe failure、Retry-After 相当 | backoff・上限・reset・terminal を記録 | fault 解消後に一回だけ回復 |
| duplicate/missing/reorder | watcher/poll/sync event queue | idempotency、stale rejection、最終 revision 収束 | 静止後に一致 |
| cancel/timeout | detector/probe/write の in-flight | cancelled/timeout と owner を返し、late result を副作用に使わない | 新規 start のみで処理可能 |
| crash/restart | temp file、lock、registry、global state | durable state から復元し重複 apply/secret 漏洩なし | recovery terminal を返す |
| 資源枯渇 | `ENOSPC`、`EMFILE`、`EACCES`、lock/queue 上限 | bounded concurrency、degraded/failure terminal | resource 解放後に手順どおり回復 |

各 failure injection は fault ID、port、呼出し番号、開始/解除 logical time、持続回数、期待 terminal、許可/禁止副作用、recovery trigger を固定する。同一 fault plan は unit、integration、PBT model、TLA+ 環境 action で可能な範囲で共通の語彙を使う。

## 11. TLA+ / TLC 設計

### 11.1 モジュールと抽象化

TLA+ は TypeScript class の翻訳ではなく、要件上の責務を次の2モデルへ抽象化する。

| モジュール | 主な状態 | 目的 |
| --- | --- | --- |
| `ProxyLifecycle.tla` | actor lifecycle、mode、detected/fallback URL の有無、target outcomes、request、in-flight、retry、deadline、lock、resource usage、logical time | apply・cancel・timeout・crash/restart の Safety/Liveness を検査 |
| `SyncConvergence.tla` | actor local/shared revision、durable shared state、event queue、lease、watch/poll delivery、crash/restart、logical time | duplicate/missing/reorder と multi-actor の収束・所有権を検査 |

secret の内容は抽象化せず `Public` / `Secret` の分類だけを model 化し、public durable state に `Secret` が入らない不変条件を検査する。URL 値は `None`、`Detected`、`Fallback` の有限集合に抽象化する。wall clock は使用せず、`now \in 0..MaxTime` と Tick action による有限論理時間を使う。

### 11.2 `ProxyLifecycle` の状態と Action

主要変数は `actorState`、`requestState`、`mode`、`autoEnabled`、`source`、`targetState`、`inFlight`、`retryCount`、`deadline`、`leaseOwner`、`queueLen`、`storageUsed`、`now` とする。

Action は少なくとも以下を定義する。

- `Start`, `DetectProxy`, `SelectFallback`, `BeginApply`, `TargetSucceeded`, `TargetFailed`, `TargetSkipped`
- `ScheduleRetry`, `Tick`, `Timeout`, `Cancel`, `Stop`, `LateCompletionIgnored`
- `AcquireLease`, `RenewLease`, `ReleaseLease`, `LeaseExpires`
- `Crash`, `Restart`, `Recover`
- 環境 Action: `InjectProviderFailure`, `ClearProviderFailure`, `EnqueueEvent`, `DropEvent`, `ExhaustResource`
- `TerminalStutter`: 正当な terminal quiescence だけで許す stutter

Safety は `NoApplyWhenStopped`、`NoFalseFullSuccess`、`LeaseMutualExclusion`、`ResourceBounds`、`NoSecretInPublicState`、`TerminalHasOwner` を invariants とする。Liveness は「故障注入が最終的に止まり、期限前の retry/complete action が選ばれ続けず、actor が crash 状態のまま放置されない」という明示した環境・公平性仮定の下で、pending request が `Applied`、`Partial`、`Failed`、`AwaitingUser`、`Cancelled` のいずれかへ到達することとする。

公平性は、system action に対する `WF_vars` 又は必要な `SF_vars` を Action 単位で付与し、`InjectProviderFailure`、`DropEvent`、`Crash` のような環境 Action には無条件の公平性を与えない。環境が無限に故障を注入する限りの liveness は保証しないことを仕様コメントと `assumptions.md` に明記する。

### 11.3 `SyncConvergence` の状態と Action

主要変数は `actors`、`localState`、`durableSharedState`、`revision`、`eventQueue`、`watcherState`、`leaseOwner`、`inFlightWrite`、`now` とする。

Action は `LocalChange`、`PersistShared`、`DeliverEvent`、`DuplicateEvent`、`DropEvent`、`ReorderEvent`、`ReadShared`、`ResolveConflict`、`ReassertLocal`、`WatchTick`、`PollTick`、`StopActor`、`CrashActor`、`RestartActor`、`RecoverShared`、`ExpireLease` を持つ。

Safety は `MonotonicRevision`、`NoStaleOverwrite`、`SingleLeaseOwner`、`BoundedQueue`、`NoPostStopWrite`、`DurableStateWellFormed` とする。静止した環境、公平な poll/delivery/reconciliation、及び少なくとも一つの稼働 actor を仮定した liveness は、正当な最大 revision が全稼働 actor と durable state に収束することとする。

### 11.4 TLC config matrix と到達可能性

各モデルに small/medium/reachability config を作る。

| Config | actors | targets/queue | retry/time/resource | 探索意図 |
| --- | ---: | ---: | --- | --- |
| small | 1 | 1 | 最小境界 0/1 | terminal、空入力、cancel/timeout の網羅 |
| medium | 2 | 2 または queue 2 | retry 2、time 3、resource 0..2 | 競合、部分失敗、reorder、restart |
| reachability | 1..2 | 必要最小 | 証人が短くなる境界 | 必須状態の witness を取得 |

通常 config は BFS を既定とし、`generated states`、`distinct states`、`diameter`、queue/depth、elapsed、workers、heap、seed、fingerprint、state/symmetry constraints を保存する。simulation 又は state constraint を使う場合は未探索範囲を明示し、exhaustive 結果と混同しない。

必須状態の到達可能性は、対象状態を否定する専用 invariant を使い、**期待された invariant 違反**として TLC から witness trace を取得する。runner は「最終状態が期待した target state である」「想定外の invariant/deadlock/error ではない」を検証した場合だけ reachability run を成功と記録する。禁止状態は通常 invariant として非到達を確認する。正当な terminal state には `TerminalStutter` を用意し、terminal quiescence を deadlock と誤判定しない。

### 11.5 TLC runner と証跡

`run-tla.mjs` は TLC を直接一貫した引数で起動し、標準出力を単に保存するのではなく、以下の JSON を生成する。

```json
{
  "schemaVersion": 1,
  "module": "ProxyLifecycle",
  "config": "medium",
  "kind": "exhaustive",
  "expectedOutcome": "pass",
  "actualOutcome": "pass",
  "tlcVersion": "recorded-at-run",
  "javaVersion": "recorded-at-run",
  "command": ["tlc", "..."],
  "workers": 1,
  "seed": null,
  "generatedStates": 0,
  "distinctStates": 0,
  "diameter": 0,
  "elapsedMs": 0,
  "constraints": { "actors": 2, "targets": 2, "maxRetry": 2 },
  "unexploredScope": ["actor > 2", "unbounded logical time"],
  "counterexample": null
}
```

TLC と Java の version、config hash、tool path、command、終了 code を保存する。counterexample がある場合は TLC trace を機械可読かつ redaction 済みの形式へ正規化する。利用可能な TLC 2.19 / Java 11 の組合せを初期環境として記録するが、公式 run では実行時に再取得して上書きする。

## 12. 追跡可能性、証跡検証、敵対的再監査

### 12.1 traceability graph

`evidence/manifests/traceability.json` は ID を node、対応を edge とする。edge は requirements、boundary、fault、oracleCase、exampleTest、property、c2Condition、mutantScope、tlaAction、tlaProperty、implementation、evidence の種類を持つ。

次表は設計レベルの最小対応であり、実装時に受入基準 ID 単位へ展開する。

| 要件群 | 主な設計要素 | 主な証跡 |
| --- | --- | --- |
| DVA-1 | decision/boundary/fault manifest、根拠/除外記録 | `state-transitions.md`、`assumptions.md` |
| DVA-2 | independent oracle、決定表、negative control、SUT adapter | example/PBT result、oracle audit |
| DVA-3 | property registry、seed matrix、atomic PBT ledger、replay | `pbt.json`、replay fixture |
| DVA-4 | AST instrumentation、C2 manifest、feasibility proof | `c2.json`、unobserved list |
| DVA-5 | scoped Stryker config、classifier、equivalence proof | mutation report/classification |
| DVA-6 | state/event/terminal/persistence inventory | `state-transitions.md` |
| DVA-7 | narrow ports、protocol fake、real-boundary tests | contract/API integration results |
| DVA-8 | `FaultPlan` と failure matrix | fault injection result、recovery trace |
| DVA-9 | 2 TLA+ models、mapping/abstraction table | `.tla`、`assumptions.md` |
| DVA-10 | config matrix、TLC runner、reachability witnesses | `tlc/*.json`、trace |
| DVA-11 | temp isolation、redaction、制御済み境界テスト、process cleanup | commands/process/contract evidence |
| DVA-12 | graph validator、adversarial audit、release assessment | `traceability.json`、release record |

`verify-traceability.mjs` は、すべての DVA acceptance ID が少なくとも一つの対応 edge を持つこと、参照 file/test/property/action が存在すること、ID が一意であること、release-critical node に PBT/C2/mutation/TLA/evidence が揃うこと、孤立した test/evidence がないことを機械検査する。

### 12.2 adversarial audit

`adversarial-audit.md` は通常の成功サマリから独立して、少なくとも次を確認する。

- oracle が production を import 又は模倣していないか。
- test double が実 CLI/VS Code/filesystem/proxy の失敗形や lifecycle を省略していないか。
- TLA+ が落としている無限 domain、OS semantics、wall-clock、provider behavior、actor 数を何か。
- fairness、state constraint、symmetry、時間・資源上限によって隠れた trace は何か。
- C2 の infeasible 判定、mutation の equivalent 判定に形式的又は要件上の根拠があるか。
- survivor、timeout、no coverage、未再現のOS/provider差、late completion、競合 RMW のリスクを成功主張に混ぜていないか。

各指摘は影響、発生可能性、検出可能性、mitigation、owner、release gate への影響を持つ。リリース評価はこの監査を通過するまで作成しない。

## 13. 実行コマンドと検証順序

implementation phase で `package.json` に次の入口を追加する。個別コマンドは単独で失敗原因を局所化し、`verify:assurance` は順に実行して最終証跡を作る。

```text
npm run test:domain-oracle
npm run test:pbt:replay
npm run coverage:c2
npm run mutation:domain
npm run test:contracts
npm run test:failure-injection
npm run verify:tla
npm run verify:traceability
npm run verify:assurance
```

すべての command は unique temp root、Git global config、npm user config、VS Code profile/extensions/storage を隔離する。タイムアウト、max workers、PBT numRuns は明示設定を保存する。テスト終了後、`cleanup-test-processes.mjs` は repository path と test runner command line を照合し、残存する子 process があれば親から停止し、再列挙結果を `process-cleanup.json` に残す。通常の test runner が clean に終了したことも成功条件である。

隔離Windows VMでの実機E2Eは本仕様の対象外とする。OS又はprovider固有で制御済みの結合・extension-hostテストに再現できない差は、成功主張をせず `assumptions.md` と敵対的監査へ残存リスクとして記録する。

## 14. release gate と残存リスクの扱い

`release-assessment.md` は次の機械判定と、人によるリスク判断を分ける。

| Gate | GO の最低条件 | 未達時 |
| --- | --- | --- |
| Traceability | 全 DVA acceptance ID が有効な証跡へ到達 | NO-GO |
| Oracle/PBT | 全固定 seed と replay が通り、calibration の失敗/replay が確認済み | NO-GO |
| C2 | release-critical の feasible C2 が 100% | NO-GO |
| Mutation | 非equivalent survivor 0、未分類 0、調整後 90%以上 | NO-GO |
| Boundary/fault | 指定 fault family の対応があり、terminal/recovery が確認済み | NO-GO 又は明示的非該当 |
| TLA+/TLC | required config が通り、reachability witness と deadlock 判定が妥当 | NO-GO |
| 隔離/実環境差 | test isolation、protocol互換境界、extension-host、未再現差の明示 | NO-GO 又はCONDITIONAL GO |
| Security/process | secret 非漏洩、残存 test process なし | NO-GO |

全 gate を通過しても有限探索、OS/provider 差、未採用 seed、今後の依存更新などの残存リスクは残る。その場合は監視方法、rollback 条件、責任者を記した `CONDITIONAL GO` 又は `GO` の根拠を示す。リスク受入なしに、「未検証」を「合格」と表記しない。

## 15. 実装時の変更順序

1. manifest、state/fault inventory、oracle model/decision table、PBT ledger を追加し、独立性と negative control を最初に検証する。
2. narrow port と protocol fake を追加し、契約/API結合/failure injection test を red-first で作る。現行の lifecycle/lock/recovery の欠陥が再現した場合だけ最小の production 修正を行う。
3. C2 instrumentation と target manifest を追加し、未観測条件を実例/PBT/failure test で埋める。
4. mutation config と classifier を追加し、survivor を追加テスト・実装修正・根拠付き equivalent のいずれかへ収束させる。
5. TLA+ modules/configs/runner を追加し、実装との abstraction mapping と exploration limits を記録する。
6. traceability verifier、adversarial audit、release assessmentを実行し、goal-loop rubric の全 criterion を直接確認する。

この順序により、coverage や mutation のために実装を都合よく変えることを避け、要件・失敗モデル・独立オラクルを先に固定する。

## 16. 要件との設計適合性

| Requirement | 設計上の充足方法 |
| --- | --- |
| DVA-1 | stable ID manifest、現行 steering 優先、除外・不一致の証跡 |
| DVA-2 | production import を禁止した canonical oracle、decision table、negative control |
| DVA-3 | `fc.check` ledger、固定/追加 seed、shrink 保存、単独 replay |
| DVA-4 | AST による test-only atomic-condition instrumentation、T/F/unobserved 報告 |
| DVA-5 | scoped Stryker、個別分類、equivalence proof、score gate |
| DVA-6 | owner/guard/terminal/finalizer/recovery を含む状態台帳 |
| DVA-7 | protocol-compatible port/fake と real-boundary integration/extension-host contract |
| DVA-8 | deterministic `FaultPlan` と recovery まで含む fault matrix |
| DVA-9 | 実装構造に依存しない lifecycle/sync の2つの TLA+ 状態モデル |
| DVA-10 | config matrix、TLC statistics、reachability witness、制約/未探索範囲 |
| DVA-11 | temp/profile 隔離、redaction、制御済み境界テスト、process cleanup |
| DVA-12 | machine-checked traceability graph、adversarial audit、明示的 release gate |

## 17. 承認後に固定する実装判断

Design 承認後、Tasks フェーズでファイル単位の作業、依存追加、各 test ID、実行時間予算、証跡レビュー責任を分解する。実装開始前に変更対象の worktree 状態を再確認し、ユーザー所有の `.vscode/settings.json` は変更・上書きしない。
