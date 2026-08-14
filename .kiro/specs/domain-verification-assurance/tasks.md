# 実装タスク

## 実施方針

- Tracking Issue: [#42](https://github.com/tsuyoshi-otake/otak-proxy/issues/42)
- 本タスクは承認後にのみ実装する。Design承認時点では test source、production source、依存関係、配布 artifact を変更しない。
- 既存の `.vscode/settings.json` はユーザー所有の未コミット変更であり、全タスクを通じて変更しない。
- 各タスクは自身の `Verify` と `Expect` を満たして初めて完了とする。test command 終了後は repository path に紐づく runner process を確認・cleanup し、結果を記録する。
- `DVA-*` は [要件定義書](requirements.md) の受入基準を指す。個別 ID の最終対応は task 14 の traceability verifier が機械検査する。

## 実装順序と依存関係

```text
1 inventory ──► 2 evidence base ──► 3 oracle ──► 4 PBT
                       │                   │           │
                       ├──► 5 ports ──► 6 contracts ──► 7 failures
                       │                                      │
                       ├──► 8 C2 ─────────────────────────────┤
                       ├──► 9 mutation ───────────────────────┤
                       └──► 10/11 TLA+ ───────────────────────┤
                                                              ▼
                                    12 scripts/CI ─► 13 audit/release
```

## Tasks

- [ ] 1. 状態・境界・故障モードの台帳を固定する

  - [ ] 1.1 `evidence/manifests/domain-decisions.json` を作成し、`DOM-MODE`、`DOM-APPLY`、`DOM-TARGET`、`DOM-SYNC`、`DOM-LIFECYCLE`、`DOM-RECOVERY` に安定 ID、根拠、production 入口、release-critical 性を付与する。
    - 現行 steering の Off ↔ Auto 2状態を正とし、Manual mode は設計履歴として明示する。
    - _Requirements: DVA-1.1, DVA-1.2, DVA-1.3, DVA-1.4_

  - [ ] 1.2 `evidence/state-transitions.md` を作成し、各状態ful owner について state、event、guard、副作用、永続化境界、terminal state、最終化の所有者、呼出し元の観測方法、復旧を列挙する。
    - `ProxyStateManager`、`SystemProxyUpdateService`、`ProxyConfigTargetRunner`、`SyncManager`、`ProxyMonitor`、`ApplyLockService`、共有状態ファイル、instance registry を含める。
    - catch/skip/retry/delegate/suppression の全分岐を明示的な terminal state に接続する。
    - _Requirements: DVA-1.1, DVA-1.5, DVA-6.1, DVA-6.2, DVA-6.3, DVA-6.4, DVA-6.5, DVA-6.6_

  - [ ] 1.3 `evidence/failure-matrix.md` と `evidence/assumptions.md` を作成し、境界値、部分失敗、retry、duplicate/missing/reorder、cancel、timeout、crash/restart、資源枯渇、復旧を stable fault ID で定義する。
    - 各行に注入点、開始/解除条件、期待 terminal state、許可/禁止副作用、復旧 trigger、該当しない場合の理由を持たせる。
    - _Requirements: DVA-1.4, DVA-6.3, DVA-6.4, DVA-6.5, DVA-8.1, DVA-8.2, DVA-8.3, DVA-8.4, DVA-8.5, DVA-8.6, DVA-8.7, DVA-8.8, DVA-8.9, DVA-8.10_

  - Verify: `npm run verify:traceability -- --stage inventory`（task 12 で追加）
  - Expect: stable ID の重複、未根拠の除外、terminal state の未所有が0件である。

- [ ] 2. 隔離された証跡基盤と共通テスト支援を実装する

  - [ ] 2.1 `src/test/assurance/support/PbtLedger.ts`、redaction、source commit/worktree snapshot、atomic JSON write を実装する。
    - 各 run は一意な `runId` と temp-write/rename を用い、並列実行で衝突しないことを保証する。
    - proxy URL の credential、SecretStorage 値、tokenその他のsecretを記録前に禁止又は redaction する。
    - _Requirements: DVA-3.1, DVA-3.2, DVA-3.5, DVA-3.7, DVA-11.2, DVA-11.3_

  - [ ] 2.2 `TestClock.ts`、`FaultPlan.ts`、一意な temp root/profile/config helper を実装する。
    - clock、scheduler、fault 回数、遅延、resource limit を決定的に指定できるようにする。
    - Git global config、npm user config、VS Code profile/extensions/storage を test ごとに隔離する。
    - _Requirements: DVA-8.1, DVA-11.1, DVA-11.8_

  - [ ] 2.3 `scripts/assurance/cleanup-test-processes.mjs` を実装し、test command の終了後に repository path と command line を照合して残存 process を検出・親からcleanup・再検査する。
    - 対象外の process や広い directory を削除しない。
    - _Requirements: DVA-11.7, DVA-11.8_

  - Verify: 作為的に並列 ledger run と secret らしい値を投入する support test を実行する。
  - Expect: JSON は衝突せず、secret は raw 値を含まず、一時資源と残存 process がない。

- [ ] 3. 実装から独立したドメインオラクルと具体例テストを実装する

  - [ ] 3.1 `oracle/DomainModel.ts`、`DecisionTables.ts`、`DomainOracle.ts` を追加する。
    - production source/type/constant を import しない literal-only canonical model とする。
    - mode/fallback、target 集約、sync conflict、lifecycle/recovery の input、expected state、terminal、許可/禁止副作用を決定表に記述する。
    - _Requirements: DVA-2.1, DVA-2.2, DVA-2.4, DVA-2.5, DVA-2.6_

  - [ ] 3.2 `oracle/SUTAdapters.ts` を追加し、canonical input/output と本番実装の変換だけを実装する。
    - adapter 内の期待値判断、private state 操作、oracle 結果を使った期待値の循環を禁止する。
    - _Requirements: DVA-2.1, DVA-2.4_

  - [ ] 3.3 `DomainOracle.examples.test.ts` を作成し、正常、境界、無効、部分成功、既知回帰、restart 回復を oracle と SUT の tuple で比較する。
    - tuple は next domain state、terminal、per-target outcome、許可/禁止副作用、persisted public state とする。
    - _Requirements: DVA-1.5, DVA-2.2, DVA-2.3, DVA-2.4_

  - [ ] 3.4 known-bad implementation を oracle calibration 専用に追加し、Auto OFF fallback、optional tool の誤分類、stale remote 採用、stop 後 late completion の適用を必ず検出する negative control test を作成する。
    - 不一致時は実装を正として期待値を更新しない `oracle-disagreement` 証跡を作る。
    - _Requirements: DVA-2.5, DVA-2.6_

  - Verify: `npm run test:domain-oracle`
  - Expect: production import 検査、全決定表、具体例、negative control が成功する。

- [ ] 4. stateful PBT、seed保存、shrink、replayを実装する

  - [ ] 4.1 property registry と `evidence/pbt/replay-fixtures.json` を追加し、固定 seed matrix、generator version、property ID、既知縮小反例を version 管理する。
    - CI/local fast/replay/calibration の numRuns と timeout を明示する。
    - _Requirements: DVA-3.1, DVA-3.3, DVA-3.5, DVA-3.6_

  - [ ] 4.2 `DomainOracle.property.test.ts` を実装する。
    - `PBT-MODE-001`、`PBT-TARGET-001`、`PBT-SYNC-001`、`PBT-LIFECYCLE-001`、`PBT-RECOVERY-001` を `fc.check` / `fc.asyncCheck` で実行する。
    - event列には duplicate、missing、reorder、conflict、restart を含め、oracle/invariant と SUT を比較する。
    - _Requirements: DVA-2.4, DVA-3.1, DVA-3.2, DVA-3.4, DVA-3.5, DVA-3.7, DVA-8.5, DVA-8.7_

  - [ ] 4.3 known-bad model に対する `PBT-CAL-001` を実装する。
    - failure、shrink、seed/path/counterexample の保存、保存 artifact からの同一 failure replay を検証する。
    - _Requirements: DVA-3.2, DVA-3.3, DVA-3.6_

  - [ ] 4.4 `scripts/assurance/run-pbt-replay.mjs` と `test:pbt:replay` を追加する。
    - artifact の property ID、seed、path、generator version を検証して単独 replay し、正規化した反例と失敗理由を比較する。
    - _Requirements: DVA-3.3, DVA-3.7_

  - Verify: `npm run test:pbt:replay -- --fixture all` および calibration artifact を指定した replay。
  - Expect: 成功 run の seed と反例なしが保存され、calibration の最小反例は単独 command で再現される。

- [ ] 5. 外部境界に狭いproduction portとプロトコル互換fakeを追加する

  - [ ] 5.1 Git/npm/pip config manager と必要な detector に optional `CommandExecutor` を導入する。
    - default は現行の Node `execFile` 実装とし、executable、argv、cwd、env、timeout、stdout、stderr、exit code、signal、spawn failure を失わない。
    - _Requirements: DVA-7.1, DVA-7.2, DVA-7.6, DVA-11.3_

  - [ ] 5.2 shared state、instance registry、apply lock に必要最小の `FileSystemPort` を導入する。
    - read/write/open-exclusive/rename/unlink/stat/watch と Node error code を観測でき、既定 adapter は現行 filesystem を維持する。
    - _Requirements: DVA-6.3, DVA-7.1, DVA-7.4, DVA-8.7, DVA-8.8_

  - [ ] 5.3 monitor/sync/retry/lease に必要最小の `ClockSchedulerPort`、VS Code state を扱う箇所に `VsCodeStoragePort`、接続検査に `ConnectionProbePort` を導入する。
    - start/stop/dispose、in-flight token、Memento/SecretStorage/Configuration/event/env collection、timeout/cancel を production と同じ観測可能な契約で表現する。
    - _Requirements: DVA-6.4, DVA-6.5, DVA-7.1, DVA-7.3, DVA-7.5_

  - [ ] 5.4 `ProtocolFakes.ts` を実装し、返り値だけでなく call log、順序、遅延、error shape、dispose、部分書込みを `FaultPlan` で再現する。
    - fake と実境界の差を `assumptions.md` に記録する。
    - _Requirements: DVA-7.1, DVA-7.7, DVA-8.1_

  - Verify: 各 default adapter を使う既存 unit test と protocol fake の契約テストを実行する。
  - Expect: 既存 caller の互換性を保ち、fake が本番と異なる成功専用 API を導入していない。

- [ ] 6. API結合・契約テストを実装する

  - [ ] 6.1 `ExternalBoundary.contract.test.ts` で CLI 契約を実装する。
    - Git/npm/pip の executable、argv 順序、env、timeout、stdout/stderr、exit code、`NOT_INSTALLED` と実config error の区別を確認する。
    - _Requirements: DVA-7.1, DVA-7.2, DVA-7.6_

  - [ ] 6.2 VS Code host contract suite を実装する。
    - Memento、SecretStorage、Configuration、設定変更 event、EnvironmentVariableCollection の storage/lifecycle を実 extension host で検証する。
    - _Requirements: DVA-7.3, DVA-11.1, DVA-11.2_

  - [ ] 6.3 一意な temp directory の実filesystemを用い、atomic write/rename/watch/poll、破損読取り、二actor競合を検証する API結合テストを実装する。
    - _Requirements: DVA-6.3, DVA-7.4, DVA-8.5, DVA-8.7_

  - [ ] 6.4 localhost の protocol-compatible server/proxy fixture を追加し、success、refusal、connection close、delay、timeout、cancel を検証する。
    - _Requirements: DVA-7.5, DVA-8.6_

  - Verify: `npm run test:contracts` と対象 VS Code host suite。
  - Expect: 全境界で protocol contract と実境界の観測結果が evidence に保存される。

- [ ] 7. failure injection とライフサイクル復旧検証を実装し、検出した欠陥を最小修正する

  - [ ] 7.1 `FailureInjection.integration.test.ts` と `Lifecycle.model.property.test.ts` を作成する。
    - 0/1/max-1/max/max+1、空集合、部分 target failure、retry/backoff/reset、Retry-After 相当、duplicate/missing/reorder、cancel/timeout、crash/restart、ENOSPC/EMFILE/EACCES/lock/queue limit、fault 解消後の recovery を実行する。
    - _Requirements: DVA-8.1, DVA-8.2, DVA-8.3, DVA-8.4, DVA-8.5, DVA-8.6, DVA-8.7, DVA-8.8, DVA-8.9, DVA-8.10_

  - [ ] 7.2 stop/cancel 後の late completion を red-first で検証する。
    - `ProxyMonitor` と `SyncManager` の in-flight 処理が stop 後に新規副作用を起こす場合だけ、epoch/generation guard 又は additive cancellation port を最小限追加する。
    - `ApplyLockService` の renew/write/release に所有権又は atomicity 違反が再現した場合だけ、atomic update と lost-lease の観測を追加する。
    - _Requirements: DVA-6.4, DVA-6.5, DVA-6.6, DVA-8.4, DVA-8.6, DVA-8.7, DVA-8.9_

  - [ ] 7.3 部分失敗、skip、外部所有保持の aggregation と recovery terminal を SUT/Oracle の両方で検証する。
    - 成功、partial、failed、awaiting-user、cancelled、timeout を呼出し元が観測できることを確認する。
    - _Requirements: DVA-2.4, DVA-6.2, DVA-8.3, DVA-8.4, DVA-8.9_

  - Verify: `npm run test:failure-injection` と関係する PBT replay。
  - Expect: fault matrix の各行に少なくとも一つの成功/失敗/recovery 証跡があり、偶発的な中間状態を terminal としない。

- [ ] 8. 原子条件単位のC2 instrumentationと計測を実装する

  - [ ] 8.1 `evidence/manifests/c2-targets.json` と source hash 検査を作成する。
    - `ProxyStateManager`、`SystemProxyUpdateService`、`deriveRuntimeApplyState`、target runner/tracker、conflict/reconciler、shared file/registry/lock、monitor/sync lifecycle の atomic condition を requirements と対応付ける。
    - _Requirements: DVA-4.1, DVA-4.5_

  - [ ] 8.2 `c2-instrument.mjs`、`c2-hook.cjs`、`c2-runtime.cjs` を実装する。
    - TypeScript Compiler API で複合 guard の atomic expression を一回だけ wrapper し、short-circuit の未評価を false/true に誤集計しない。
    - source と配布 artifact を一切変更せず、repository 外の隔離された test artifact だけを実行する。
    - _Requirements: DVA-4.2, DVA-4.3, DVA-4.7, DVA-11.3_

  - [ ] 8.3 `run-c2.mjs` と `coverage:c2` を実装する。
    - raw C2、feasible C2、true/false/unobserved count、未観測 source span、infeasible 根拠を JSON/Markdown へ出力する。
    - feasible release-critical 条件を100%にする具体例/PBT/failure test を追加する。
    - _Requirements: DVA-4.2, DVA-4.4, DVA-4.5, DVA-4.6_

  - Verify: `npm run coverage:c2`
  - Expect: release-critical の feasible C2 が100%、unobserved/infeasible の根拠が全件保存される。

- [ ] 9. mutation testing、survivor/equivalent分析を実装する

  - [ ] 9.1 Stryker の必要 package を lockfile で固定し、`stryker.conf` と `evidence/manifests/mutation-scope.json` を追加する。
    - scope は release-critical domain source と関係 test に限定し、対象外と timeout を明記する。
    - _Requirements: DVA-5.1, DVA-5.2_

  - [ ] 9.2 `analyze-mutation.mjs` を実装する。
    - killed/survived/timeout/no-coverage/compile-error/ignored/equivalent を全 mutant で一意に分類し、survivor と equivalent の根拠・関連要件・入力・追加テスト要否を出力する。
    - 証明が不十分な equivalent は survivor として扱う。
    - _Requirements: DVA-5.2, DVA-5.3, DVA-5.4, DVA-5.5, DVA-5.6_

  - [ ] 9.3 mutation suite を実行し、survivor を追加テスト、最小実装修正、又は根拠付き equivalent のいずれかで収束させる。
    - release-critical 非equivalent survivor 0、未分類0、調整後 score 90%以上を達成する。
    - _Requirements: DVA-5.7, DVA-5.8_

  - Verify: `npm run mutation:domain`
  - Expect: report、classification、raw/adjusted score、全 survivor/equivalent の根拠が保存され、release gate 値を満たす。

- [ ] 10. `ProxyLifecycle` の独立TLA+モデルとTLC検査を実装する

  - [ ] 10.1 `formal/ProxyLifecycle.tla` を実装する。
    - actor、mode、auto state、detected/fallback source、targets、in-flight、retry/deadline/lease/resource、logical time、start/stop/cancel/crash/restart/recovery を抽象モデルにする。
    - system action と provider failure/event delivery/actor failure/resource exhaustion の環境 action を分ける。
    - _Requirements: DVA-9.1, DVA-9.2, DVA-9.3, DVA-9.4, DVA-9.5, DVA-9.6_

  - [ ] 10.2 Safety/Liveness/Deadlock/Reachability property と fairness を追加する。
    - `NoApplyWhenStopped`、`NoFalseFullSuccess`、`LeaseMutualExclusion`、`ResourceBounds`、`NoSecretInPublicState`、`TerminalHasOwner` を検査する。
    - fault が最終的に止まる環境仮定下で pending request が terminal に到達する liveness を定義し、保証しない環境を明記する。
    - 正当 terminal stutter と異常 deadlock を区別する。
    - _Requirements: DVA-9.7, DVA-10.5, DVA-10.6, DVA-10.7_

  - [ ] 10.3 small/medium/reachability config を追加する。
    - actor数、target数、retry、time、resource limit の異なる設定で exhaustive 検査し、逆 invariant の期待違反から required-state witness を取得する。
    - _Requirements: DVA-9.8, DVA-10.4, DVA-10.8, DVA-10.9_

  - Verify: `npm run verify:tla -- --module ProxyLifecycle`
  - Expect: 正常configがSafety/Liveness/deadlock検査を通り、reachability configが期待する証人だけを生成する。

- [ ] 11. `SyncConvergence` の独立TLA+モデルとTLC検査を実装する

  - [ ] 11.1 `formal/SyncConvergence.tla` を実装する。
    - 複数actor、local/shared durable state、revision、event queue、duplicate/drop/reorder、watch/poll、lease、in-flight write、crash/restart/recovery、logical time を model 化する。
    - _Requirements: DVA-9.1, DVA-9.2, DVA-9.3, DVA-9.4, DVA-9.5, DVA-9.6_

  - [ ] 11.2 `MonotonicRevision`、`NoStaleOverwrite`、`SingleLeaseOwner`、`BoundedQueue`、`NoPostStopWrite`、`DurableStateWellFormed` と収束 liveness を追加する。
    - 静止環境、fair poll/delivery/reconciliation、稼働actorの仮定を明示する。
    - _Requirements: DVA-9.7, DVA-10.5, DVA-10.6, DVA-10.7_

  - [ ] 11.3 small/medium/reachability config で conflict、reorder、欠落、restart、lease expiry を探索する。
    - _Requirements: DVA-9.8, DVA-10.4, DVA-10.8, DVA-10.9_

  - Verify: `npm run verify:tla -- --module SyncConvergence`
  - Expect: normal configの禁止状態は非到達であり、reachability configは期待した収束/復旧の証人を保存する。

- [ ] 12. 実行スクリプト、TLC証跡、CI統合を実装する

  - [ ] 12.1 `scripts/assurance/run-tla.mjs` を実装する。
    - TLC/Java version、spec/config hash、exploration kind、workers、heap、seed、generated/distinct states、diameter、elapsed、constraints、unexplored scope、counterexample を JSON へ正規化する。
    - TLCの expected reachability failure と unexpected failure を区別する。
    - _Requirements: DVA-10.1, DVA-10.2, DVA-10.3, DVA-10.10_

  - [ ] 12.2 `verify-traceability.mjs` と `run-assurance.mjs` を実装する。
    - 全DVA acceptance ID、boundary、fault、oracle/test/property/C2/mutant/TLA action/property/implementation/evidence の参照存在、一意性、孤立を検証する。
    - 成功runだけを redaction/整合性検査後に公式 evidence へ昇格する。
    - _Requirements: DVA-1.1, DVA-1.4, DVA-11.2, DVA-12.1, DVA-12.2, DVA-12.8_

  - [ ] 12.3 `package.json` に `test:domain-oracle`、`test:pbt:replay`、`coverage:c2`、`mutation:domain`、`test:contracts`、`test:failure-injection`、`verify:tla`、`verify:traceability`、`verify:assurance` を追加する。
    - 通常 unit/VS Code test mode の既存分離、timeout、parallel数、temp isolation を維持する。
    - _Requirements: DVA-3.3, DVA-4.7, DVA-5.1, DVA-7.1, DVA-10.1, DVA-11.1, DVA-11.3, DVA-11.7_

  - Verify: `npm run verify:traceability` と小規模 `npm run verify:tla`。
  - Expect: evidence schema と既存 test routing を壊さず、必要な探索統計/制約が欠落なく保存される。

- [ ] 13. 追跡表、敵対的再監査、release assessmentを完成し、全検証を実行する

  - [ ] 13.1 `traceability.json` と rendered report を acceptance ID 単位で完成させる。
    - 要件、境界、故障モード、oracle、example、PBT、C2、mutant、TLA action/property、implementation、evidence を辿れるようにする。
    - _Requirements: DVA-12.1, DVA-12.2_

  - [ ] 13.2 `adversarial-audit.md` を作成する。
    - oracle 共通モード、fakeの抽象化差、未モデル化状態、環境/fairness仮定、探索制約/限界、C2 infeasible、surviving/equivalent mutant、未再現のOS/provider差を独立に再監査する。
    - _Requirements: DVA-1.4, DVA-5.3, DVA-5.4, DVA-7.7, DVA-9.8, DVA-10.3, DVA-10.10, DVA-12.3, DVA-12.4_

  - [ ] 13.3 `release-assessment.md` を作成し、GO/CONDITIONAL GO/NO-GO を gateごとに判定する。
    - Safety違反、非equivalent survivor、実行可能C2未達、未分類mutant、90%未満の調整後score、release-critical境界又は探索の未検証を NO-GO とする。
    - 有限探索やOS差の残存リスクには監視・rollback条件・責任者を記録する。
    - _Requirements: DVA-4.6, DVA-5.7, DVA-5.8, DVA-10.10, DVA-11.5, DVA-12.4, DVA-12.5, DVA-12.6, DVA-12.7, DVA-12.8_

  - [ ] 13.4 goal-loop rubric の全 criterion を直接検証する。
    - lint、compile、unit、VS Code host、oracle、PBT replay、C2、mutation、contracts、failure injection、TLA、traceability、process cleanup を実行し、run IDs と結果を journal に記録する。
    - 失敗は原因を分類して修正し、該当verificationを再実行する。未解消事項を成功として扱わない。
    - _Requirements: DVA-1.5, DVA-3.3, DVA-4.6, DVA-5.8, DVA-8.10, DVA-10.10, DVA-11.7, DVA-12.1, DVA-12.2, DVA-12.8_

  - Verify: `npm run verify:assurance`、`npm run lint`、`npm run test:unit`、`npm test`。
  - Expect: 全 gateの合否、未検証範囲、仮定、探索限界、survivor、worktree、tool version、実行command がrelease assessmentに記録される。

## 完了条件

- 全 task が完了し、task 13 の traceability verifier が全受入基準を有効な証跡へ解決する。
- release-critical domain で feasible C2 100%、非equivalent survivor 0、未分類mutant 0、調整後mutation score 90%以上である。
- 指定された fault family、TLA+ Safety/Liveness/deadlock/reachability、実境界と未再現のOS/provider差を未検証と混同せずに記録する。
- `.vscode/settings.json` を含むユーザー所有の既存変更を保持し、secret と残存 test process を残さない。
