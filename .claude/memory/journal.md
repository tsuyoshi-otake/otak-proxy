# Journal

Append-only log of non-trivial work. Newest entries at the bottom.

---

## 2026-09-09 — #73 形式モデルより下の層にあった原子性・事後条件の穴 4 件

**Issue**: [#73](https://github.com/tsuyoshi-otake/otak-proxy/issues/73)
**Base commit**: `cf5ad58`
**Fix commit**: `c885f9d` (branch `fix/73-atomicity-and-write-postconditions`)

### Symptom

外部レビューで、TLA+ モデルが保証している性質と実装のあいだにギャップがある箇所が 4 件指摘された。
いずれも「モデルが原子ステップとして抽象化している操作を、実装が非原子な複数ステップで実現している」
または「ポストコンディションを検証せず成功を返している」という形。

1. `SharedStateFile.compareAndSwap()` が read → compare → write を無保護で実行しており、
   2 ウィンドウが同じ version N を読んで両方 `written` を返す (lost update)。
2. `GitConfigLocking` / `InstanceRegistryStore` のミューテックスが「空ファイル + mtime で stale 判定 +
   無条件 unlink」で、ABA を許す。
3. Git / npm の書き込み検証が fail-open（設定を読み戻せないと成功扱い）。pip はそもそも読み戻していない。
4. npm の split proxy（http と https で別 URL）適用時、部分書き込み補償が「最後に書いた 1 つの値」を
   全キーの判定に使い回し、自分が書いた値を外部変更と誤認していた。

### Root cause

- ①③④ は共通して **「書いた」と「書けた」を区別していない**こと。成功パスが
  外部コマンドの終了コードだけを根拠にしていた。
- ② は **ロックファイルに所有者情報がない**こと。匿名ファイルでは
  「古い = 放棄された」としか判定できず、遅い保持者が後続のロックを消してしまう。

  ```
  A が acquire → A の作業が stale window を超過 → B が A のロックを消して自分のを作る
  → A が終了して *B の* ロックを unlink → C が入ってくる（B はまだ中にいる）
  ```

### Fix

- **`src/utils/FileLease.ts` を新設**（3 箇所の cross-process critical section の単一実装）。
  ロックファイルに `{token, pid, acquiredAt, heartbeatAt}` を書き、
  - heartbeat でリース更新（生きている保持者は stale にならない）
  - reclaim 前に再読込して内容一致を確認（横取り防止）
  - release は token 一致時のみ unlink（他人のロックを消さない）
  `GitConfigLocking` / `InstanceRegistryStore` / `SharedStateFile` の 3 箇所を移行。
  タイムアウト時の例外メッセージは既存契約 (`Timed out acquiring Git config mutex` /
  `... instance registry mutex`) をそのまま再現させ、`isGitConfigMutexTimeout` を壊さない。
- **`compareAndSwap` をリース内に入れ、version をクリティカルセクション*内*で再読込**。
  リース取得タイムアウトは `stale` として返す（新しい方を採用させる = compare に負けたのと同じ帰結）。
- **Git / npm の書き込み検証を fail-closed 化**。読み戻せない・キーが無い・値が違うはすべて失敗。
  pip は書き込み後の read-back を追加（`OperationResult.residualKeys` を新設し、
  読み戻し不能時だけ residual として報告）。
- **`PartialProxyWriteCompensation` の入力をキー単位の `PartialWriteEntry<K> = {key, value}` に変更**。
  各キーを「そのキーに書いた値」と突き合わせる。

### Verification

| 検証 | 結果 |
| --- | --- |
| `npm run lint` (eslint + invisible-unicode) | pass |
| unit (mocha, 88 files, no `--bail`) | **963 passing / 0 failing**（baseline 943 → +20 新規テスト） |
| `npm run verify:tla` | **10/10 pass**（新規 3 run を含む） |
| `npm test`（VS Code host） | 469 passing / 1 pending / **9 failing** |

VS Code host の 9 失敗は `git stash -u` で HEAD (`cf5ad58`) に戻して再実行し、
**失敗集合が完全に一致**することを確認済み（既存の失敗。routing-only 化 #63/#64 と
`ExtensionInitializer` / `SystemProxyUpdateService` / 診断の並び順に由来し、本件とは無関係）。

新規 TLC run:

- `TLC-CAS-UNGUARDED-LOST-UPDATE` — 保護なし CAS で `NoLostUpdate` 違反（バグの存在証明）
- `TLC-CAS-GUARDED` — リース保護下で safety + liveness + deadlock-free
- `TLC-CAS-LEASE-ABA` — heartbeat なし / release の所有者チェックなしで `MutualExclusion` 違反

テストプロセスの後始末も確認（残存 mocha / vscode-test プロセスなし。tsserver のみ）。

### Learning

1. **「穴を塞いだら新しい穴」を防ぐには、実装より先に緑のベースラインを記録する。**
   今回 VS Code host に 9 件の既存失敗があり、ベースラインを取っていなければ
   自分の修正が原因だと誤診していた。stash して HEAD で再実行するのが唯一確実な切り分け。

2. **fail-open を fail-closed にすると、必ず「嘘をついていたテスト」が落ちる。**
   `{stdout:'', stderr:''}` を返すだけのコマンドスタブは、書き込みが永続化されたか
   捨てられたかを区別できない。10 件の失敗はすべてこれだった。
   → 本番のポストコンディションを緩めるのではなく、**スタブを実物に忠実にする**のが正解。
   `src/test/fakeConfigStores.ts` に `createFakeGitConfig` / `createFakeNpmConfig` /
   `createFakePipConfig` を置き、set が永続化し get が読み戻し、未設定キーは
   実ツールと同じ失敗（git exit 1/5、pip `No such key`、npm `null`）を返すようにした。

3. **同じロックのバグを 3 回書いていた。** `GitConfigLocking`、`InstanceRegistryStore`、
   （欠けていた）publish lock が同一の匿名 mtime ロックパターンだった。
   cross-process な排他は 1 つのプリミティブに集約する。

4. **形式モデルが「原子」と書いている操作は、実装側の分解が抜けていないか必ず確認する。**
   既存の `SyncConvergence` は `Publish(a)` を 1 ステップとしてモデル化していたため、
   read-compare-write の競合はモデルの外にあった。`formal/SharedStateCas.tla` で
   ファイルシステム操作単位に分解して初めて反例が出た。

5. **Bash ツールのヒアドキュメントはバックスラッシュを食う。**
   `<<'PY'` の中の `\\n` や `\\` が壊れて、パッチスクリプトが無言で不一致になる。
   バックスラッシュを含むスクリプトは Write ツールでファイルに書いてから実行する。

---

## 2026-09-09 — v3.2.8 リリース（#73 の修正を公開）

**Issue**: [#73](https://github.com/tsuyoshi-otake/otak-proxy/issues/73)（PR の `Closes #73` で自動クローズ）
**PR**: [#74](https://github.com/tsuyoshi-otake/otak-proxy/pull/74)
**Release commit**: `c81df7f` (`chore(release): 3.2.8`)
**Merge commit**: `d785daa`
**Tag**: `v3.2.8`（annotated / `Release v3.2.8`）
**CI run**: [34249427770](https://github.com/tsuyoshi-otake/otak-proxy/actions/runs/34249427770)

### やったこと

3.2.7 → 3.2.8（patch。バグ修正のみで contributed command / setting の増減なし）。
`d829fa5 chore(release): 3.2.7` と同じ形（`CHANGELOG.md` + `package.json` + `package-lock.json`
の 3 ファイルだけを触るリリースコミット）を踏襲し、PR 経由で main に merge してから
main HEAD に annotated tag を打った。タグ push が publish workflow の唯一のトリガ。

### Verification

タグ push は Marketplace / Open VSX への公開を起動する不可逆操作なので、
push 前に CI と同じゲートをローカルで先に通した。

| ゲート | ローカル (Windows) | CI (Ubuntu, run 34249427770) |
| --- | --- | --- |
| `npm run lint` | pass (602 files scanned) | pass |
| unit | 963 passing / 0 failing（全件、`--bail` なし） | 905 passing（`test:unit:parallel` は `--bail` 付き） |
| `npm run test:smoke` | 4 passing | 4 passing |
| `npm run lint:unicode:dist` | pass (282 artifacts) | pass |
| `vsce package` | — | `otak-proxy-3.2.8.vsix` (157 files, 622.36 KB) |
| VS Marketplace | — | `Published odangoo.otak-proxy v3.2.8.` |
| Open VSX | — | `Published odangoo.otak-proxy v3.2.8` |

VS Code extension host の既存 9 失敗はこのリリースの gate ではない
（publish workflow が回すのは `test:unit:parallel` と `test:smoke` のみ）。

### Learning

1. **タグを打つ前に CI と同じゲートをローカルで通す。**
   v3.2.7 のときは `chore(release): 3.2.7` に対するタグ run が Linux CI で失敗し、
   修正コミット (`cf5ad58`) を足して再実行している。タグ push は publish の起動なので、
   失敗すると「タグは存在するが公開されていない」状態が残る。
   ローカルで通すべき最小セットは `lint` / `test:unit:parallel` / `test:smoke` /
   `lint:unicode:dist` の 4 つ（workflow の publish 前ステップと同じ）。

2. **`vsce publish` / `ovsx publish` の成功ログは「アップロード成功」であって
   「公開反映」ではない。** 両レジストリとも検証・インデックスのパイプラインを挟むため、
   publish 直後の API は旧バージョンを返す。実測: Open VSX は publish から約 3 分、VS Marketplace は約 5〜6 分で
   API が新バージョンを返すようになった（それまでは Open VSX が HTTP 404、
   Marketplace の latest が旧バージョン）。
   → publish ステップの成功だけを根拠に「公開済み」と報告せず、レジストリ API で
   実際にバージョンが切り替わったことを確認する。

3. **Open VSX / Marketplace のバージョン一覧に 3.2.4 と 3.2.5 が無い。**
   どちらのレジストリにも欠けているので、当時のタグ run が publish まで到達しなかった
   可能性が高い。今回とは無関係だが、リリース後にレジストリ側を確認する習慣がないと
   こうした取りこぼしに気付けない、という実例。

## 2026-10-01 — #78 残留検出と成功表示・自己修復の停止理由がつながっていない（コード側の修正）

**Issue**: [#78](https://github.com/tsuyoshi-otake/otak-proxy/issues/78)
**Base commit**: `d149845`
**Fix commit**: 未コミット (branch `fix/78-remediation-convergence-state`)

### Symptom

- 診断が `*.managedProxyResidual`（`blocksConvergence`）を出しているのに `runtimeState: applied`（成功表示）になる。
- 自己修復がどこで・なぜ止まったかを後から追えない。
- 報告者の端末で修復できなかった直接原因は**未確定**（下記「未確定のもの」）。このエントリはコードで再現できた不整合だけを扱う。

### Root cause（コードで再現できたもの）

1. **A: 修復リトライが自分自身のコミットで stale 扱いされていた。**
   apply は per-target 結果を CAS で commit し revision を +1 する。リトライは同じ generation fence を使い回すので、
   2 回目は「別の writer が書いた」と判定されて superseded → 実際には何も書かない no-op が success として返っていた。
2. **B: `deriveRuntimeApplyStateFromProxyState` が記録済みの `targetOutcomes` だけを見ていた。**
   新鮮な診断の blocker を加味しないので、記録上の成功が残留を上書きして `applied` を表示していた。
3. **C: 停止理由の記録が無かった。** retry 実施有無・停止理由・残った blocker を外から観測する手段が無い。

### Fix

- A: `createFencedApply`（`src/core/GenerationFence.ts`）が 1 リクエスト（初回 + リトライ）分の fence を持つ。
  fence を前進させるのは、apply 自身が報告した `committedRevision === fence.revision + 1` のときだけ。
  `saveProxyConfigResults` が CAS で書いた revision を返し、`ProxyApplyDetailedResult.committedRevision` で運ぶ。
  `src/extension.ts` の `applyProxySafely` がこれを使う。
- B: 観測した `blocksConvergence` issue があれば `applied` → `partial`。
  診断レポートに `recordedRuntimeState`（記録上の状態）/ `desired`（{mode, proxyEnabled}）/ `converged` を追加し、
  「desired が Off」と「実際に収束した」を分けた。
- C: `src/remediation/RemediationOutcome.ts`（stopReason 8 種: consentRequired / lockSkipped / superseded /
  converged・unverified / retryExhausted / flapSuppressed / retryDisabled / notRetryable、secret-free）。
  `ProxyRemediationService.getLastOutcome()` は attempt 順で、古い要求の遅い完了が新しい結果を上書きしない。
  `otak: Diagnose Proxy` の出力に `lastRemediation`（無ければ明示的に `null`）。
- 変えていないもの: 通知仕様（warnings 既定の抑制、mismatch の diagnostics-only、terminal advisory、lock race）、
  ステータスバー表示、所有権判定（外部値・読めない値は消さない）、リトライ上限（1 回）。

### Verification

| ゲート | 結果 |
| --- | --- |
| `tsc` | clean |
| `npm run lint` | pass（612 files、invisible Unicode なし） |
| `npm run test:unit` | 930 + 58 passing / 0 failing（ベースライン 917 + 58 → +13） |
| `npm test`（VS Code host） | 482 passing / 1 pending / 9 failing。9 件は rules.md の既知 9 件と suite・テスト名で一致。新規 #78 host テスト 7 件は全 pass |
| `npm run test:smoke` | 4 passing |
| mutation（`out/core/GenerationFence.js`） | `no-rebase` → FencedApply テスト 1 が fail / `rebase-any` → テスト 3 が fail（両 mutant kill、復元済み） |
| runner プロセス | 残存なし（`Get-CimInstance Win32_Process` で確認） |

未実施: 報告者端末での実機確認。成功扱いしない。

### 未確定のもの（報告者端末の直接原因）

仮説のみ・未検証。別 Issue 候補:

1. トグル Off の apply が `lockSkipped` でも mode Off だけは保存される。
2. トグル経路の診断がトグル前の状態を見ている。

### Learning

1. **「revision +1 かつ identity が同じ」という観測では、自分のコミットかどうか判定できない。**
   Auto OFF は mode と URL を保ったまま revision を進める（`autoModeOff` は `LogicalGeneration` の identity に入っていない）。
   書いた本人が committed revision を報告する契約にする。最初の実装は観測ベースで誤っており、
   「他 writer の Auto OFF が apply 中に入る」unit テストで検出した。
2. **修復リトライのテストは本物の fence 合成を通す。** fake applier だけのテストでは A が見えない
   （既存の v3Remediation テストは修正前から全部 pass していた）。
3. **Write ツールは行末空白を削る。** 空白だけの行を含むパッチのアンカーが一致しなくなる。アンカーに空白行を入れない。
4. **`npm run test:unit` はビルドし直す。** `out/` に mutant を入れて検証するときは、
   hermetic な `GIT_CONFIG_GLOBAL` / `NPM_CONFIG_USERCONFIG` を付けて mocha を直接叩く。

## 2026-10-02 — v3.2.10 リリース（#78 のコード側修正を公開）

**Issue**: [#78](https://github.com/tsuyoshi-otake/otak-proxy/issues/78)（`Refs #78`。報告者端末の直接原因が未確定のためオープンのまま）
**PR**: [#79](https://github.com/tsuyoshi-otake/otak-proxy/pull/79)
**Commits**: `a4507ff`（fix）、`82526cd`（memory）、`d23fb0a`（`chore(release): 3.2.10`）、`ee7f8a1`（`converged` の修正）
**Merge commit**: `f992bce`
**Tag**: `v3.2.10`（annotated / `Release v3.2.10`）
**CI run**: [36948677395](https://github.com/tsuyoshi-otake/otak-proxy/actions/runs/36948677395)

前のエントリ（2026-10-01 #78）の「Fix commit: 未コミット」は、上の `a4507ff` / `ee7f8a1` が該当する。

### やったこと

3.2.9 → 3.2.10（patch。contributed command / setting の増減なし）。
リリースコミットは 3.2.8 / 3.2.9 と同じく `CHANGELOG.md` + `package.json` + `package-lock.json` だけ。
PR を merge commit で main に入れ、main HEAD（`f992bce`）に annotated tag を打って push した。

merge 前に fresh-context レビュー（sonnet）を 1 回かけ、指摘 8 件を分類した。

| 指摘 | 判断 |
| --- | --- |
| `converged` が `runtimeState` の failed / partial / awaitingUser と食い違う | 正しい。`ee7f8a1` で `converged = runtimeState === 'applied'` に統一 |
| superseded を success=true で返す | 意図どおり（修正前の stale stub も成功形）。維持 |
| `getLastOutcome` の順序、throw 時に古い outcome が残る | 低。follow-up |
| 停止理由の曖昧さ（consentRequired が平文ポリシーも含む等） | 低 |
| superseded リトライでも flap を数える | 既存挙動 |
| fence をロック取得前に capture | 既存挙動（修正前も同じ） |
| `desired.proxyEnabled` の境界 | 診断自身の `expectsProxyDisabled` と一致 |
| トグルは apply 後に mode を保存するので、トグル中の診断がトグル前の mode で評価される | 既存の欠陥。仮説 2 の強い根拠。同期の公開順序を変えるため 3.2.10 では直さず #78 に記録 |

### Verification

| ゲート | ローカル (Windows) | CI (Ubuntu, run 36948677395) |
| --- | --- | --- |
| `npm run lint` | pass (612 files scanned) | pass (596 files scanned) |
| unit | 930 + 58 passing / 0 failing | 930 + 57 passing（`--bail` 付き。2 本目がローカルより 1 件少ない理由は未確認） |
| `npm run test:smoke` | 4 passing | 4 passing |
| `npm run lint:unicode:dist` | pass (289 artifacts) | pass (289 artifacts) |
| VS Code extension host 全件 | 483 passing / 9 failing（9 件は既知の既存失敗と同一） | —（publish workflow の gate ではない） |
| `vsce package` | — | `otak-proxy-3.2.10.vsix` (160 files, 632.68 KB) |
| VS Marketplace | API で 3.2.10 を確認（01:08:03Z。`lastUpdated` 01:07:07Z、publish から約 6 分） | `Published odangoo.otak-proxy v3.2.10.` |
| Open VSX | API で 3.2.10 を確認（01:02:59Z。publish 01:00:54Z から 2 分以内） | `Published odangoo.otak-proxy v3.2.10` |

テスト後の runner プロセス残存 0 件。

### Learning

1. **CodeRabbit / Codex は push ごとに再レビューするが、merge のブロッカーではない。**
   このリポジトリには PR CI も branch protection も無い。`ee7f8a1` の push で CodeRabbit が
   PENDING に戻ったが、直前の `d23fb0a` に対するレビューは「actionable なし」で、
   追加コミットはローカルの全ゲートを通した小さな修正だったので、待たずに merge した。
   大きな追加コミットなら再レビュー完了を待つ。
2. **レポートの真偽値フィールドは、同じ判定元から 1 回だけ計算する。**
   `converged` を issue リストから、`runtimeState` を記録 + issue から別々に計算していたため、
   「失敗した書き込みは観測対象が無いので issue が出ない」ケースで食い違った。
   派生フィールドは `runtimeState` から導く。
   → rules.md「診断レポート」に昇格。

## 2026-10-02 — README.md の最新化と英語統一

**Branch**: `docs/readme-english-refresh`（main `dad2b3e` から作成）
**Issue**: [#81](https://github.com/tsuyoshi-otake/otak-proxy/issues/81)（ユーザー依頼「README.mdを最新化して言語も英語で統一」）
**PR**: [#82](https://github.com/tsuyoshi-otake/otak-proxy/pull/82)
**Commit**: `8c4b50d`（README）

### Symptom

- README.md の Windows 環境変数チェックの説明（旧 132–134 行）だけが日本語だった。
- コードと README の食い違いが 10 件あった。

### 食い違いと修正

| # | README（修正前） | コード上の事実 | 根拠 |
| --- | --- | --- | --- |
| 1 | pip に触れていない | user `global.proxy` を書く。Windows は `py` → `python` → `python3`、それ以外は `python3` → `python`。未導入なら skippedUnavailable | `src/config/PipConfigManager.ts:70-83`、`ProxyConfigTargetRunner.ts` |
| 2 | Off は管理対象を消す | 所有 fingerprint と一致する値だけを消し、外部の値は残す (#27) | `ProxyApplier.ts:659-695`、`ValueAwareUnset.ts` |
| 3 | `ask` は「ローカルで確認」 | 公開 URL fingerprint ごと・マシンごとに 1 回確認。同意前のバックグラウンド適用はスキップ。`block` は適用全体を止める | `ProxyRemediationService.ts:529-575` |
| 4 | `ignoreSelfWrittenVSCodeProxy` が無い | 既定 true の設定として存在 | `package.json:120`、`SystemProxyDetector.ts:229-247` |
| 5 | `legacyEnvFirstAutoDetection` は v2 順序を保つ | 読み込まれるだけで、どこからも使われない（効果なし） | `V3Settings.ts:61` |
| 6 | `diagnosticsEnabled` は diagnose コマンドにも効く | apply 後の自動診断だけが見る。コマンドは設定を無視する | `ProxyRemediationService.ts:403`、`DiagnoseProxyCommand.ts:167-170` |
| 7 | 診断キャッシュの説明が一般論 | コマンドは常に最新値。自動診断も成功・リトライ・ロック待ちスキップの後は最新値。キャッシュを使うのは「失敗してリトライしない」と「認証情報ポリシーで止まった」の 2 つだけ | `ProxyRemediationService.ts:135,164,247-248,356` |
| 8 | 初回プロンプトの記載なし | Auto (System) / Manual Setup / Skip | `InitialSetupFlow.ts:26-31` |
| 9 | フォールバックの事前テストの記載が曖昧 | Auto へのトグル時、システム proxy が無ければ到達確認してから使う | `ToggleProxyCommand.ts:143-163,226-240` |
| 10 | VSIX 手順が `otak-proxy-3.1.4.vsix` と `npx @vscode/vsce` | `npm ci` → `npm run package:vsix` | `package.json` scripts |

あわせて：
- 設定表に範囲（最小–最大）を追加。
- ⚠ が「失敗またはブロック時に任意の状態のアイコンを置き換える」ことを追記。
- 言語一覧を「英語名 (自称)」に変更。
- 表現を全体的に平易にした。

ASCII 図 2 つ（トグル図、Status Indicators 図）は HEAD とバイト一致のまま。冒頭図はキャプションに pip を追加しただけ。

### Verification

- `npm run lint:unicode`: pass（612 files scanned）
- 改行: 384 行すべて CRLF（Write ツールは LF で書くので、書いたあとに変換した）
- fresh-context の rubric-verifier（sonnet）で 13 項目を照合
  - 初回: C9（診断キャッシュの説明が過大）だけ fail。軽微な指摘が 2 件（`diagnosticsEnabled` と `legacyEnvFirstAutoDetection` の文言）
  - 修正後の再判定 1 回目: 5 項目中 4 項目 pass。C9 はまだ過大（ロック待ちのスキップは最新値を読む: `ProxyRemediationService.ts:164`）
  - 再判定 2 回目: C9 pass、CRLF pass。全項目 pass
- 残存リスク: 実機での表示確認はしていない（Markdown のレンダリングは GitHub / Marketplace 依存）

### Learning

1. **README の設定説明は `package.json` / `en.json` の description を写さず、読み手のコードを確認する。**
   `diagnosticsEnabled` の description（en.json:243）は「diagnose コマンドでも」と書いているが、コマンドは設定を見ない。
   description 自体が間違っていることがある。
2. **キャッシュの有無は呼び出し元ごとに違う。** 「診断はキャッシュする」は `run()` の能力の説明で、実際の呼び出し元（コマンド、apply 成功後、失敗後、ロック待ちスキップ後）の挙動ではなかった。
   「失敗・スキップ」のようにまとめた言い方は、分岐ごとに引数を確認してから書く（スキップでも理由によって挙動が逆だった）。
3. **Write ツールは LF で書く。** CRLF の作業ツリー（core.autocrlf=true、.gitattributes なし）では、書いたあとに CRLF へ戻して件数を確認する。

## 2026-10-02 — v3.2.11 リリース（README の英語化と最新化を公開）

**Issue**: [#81](https://github.com/tsuyoshi-otake/otak-proxy/issues/81)（#82 の merge でクローズ済み。リリース PR は `Refs`）
**PR**: [#83](https://github.com/tsuyoshi-otake/otak-proxy/pull/83)
**Commits**: `4ab0a2a`（README のレビュー指摘）、`1751d97`（Issue テンプレートのリンク）、`169f52f`（`chore(release): v3.2.11`）
**Merge commit**: `08916be`
**Tag**: `v3.2.11`（annotated / `Release v3.2.11`）
**CI run**: [37003590405](https://github.com/tsuyoshi-otake/otak-proxy/actions/runs/37003590405)

前のエントリ（README の最新化）の PR #82 は `df96ce6` で merge 済み。

### やったこと

3.2.10 → 3.2.11（patch。拡張のコード変更なし）。Marketplace と Open VSX の掲載ページは VSIX 内の README を表示するので、#82 の README は新しい版を出すまで利用者に見えなかった。

1. **merge 済み #82 への Codex 指摘 2 件（P2）を修正**（`4ab0a2a`）
   - フォールバック proxy の到達確認は、ステータスバーから Auto にしてシステム proxy が無いときだけ実行される（`ToggleProxyCommand.ts`）。初回セットアップで入力した URL は確認なしで適用される（`InitialSetupFlow.handleManualSetup`）。README は「Auto にするとき」とだけ書いていて、すべての経路で確認するように読めた。
   - managed mismatch は、記録上 configured の対象（`gitConfigured` / `npmConfigured` / `vscodeConfigured`）だけが報告対象（`ProxyRuntimeDiagnostics.ts` `collectManagedConvergenceIssues`）。configured フラグは失敗・skippedUnavailable では前の値を保つ（`ProxyConfigStateTracker.ts` `nextConfiguredState`）ので、「最後の apply で」とは書かず「記録している」とした。
   - あわせて、Off 時に otak-proxy が書いていない値として残したもの（`targetOutcomes.<target> === 'preservedExternal'`）の残留は advisory（`advisoryResidualRisk`）であって失敗ではない、と追記した。
2. **Issue テンプレートのリンク修正**（`1751d97`）
   - リリース前チェック（CLAUDE.md の MUST）で、`.github/ISSUE_TEMPLATE/` の 5 ファイルが前の所有者アカウントのリポジトリを指していることが分かった。`tsuyoshi-otake/otak-proxy` に直した。
   - Discussions は無効（`hasDiscussionsEnabled: false`）なので、`config.yml` の Discussions へのリンクは削除した。
3. **リリースコミット**（`169f52f`）: `npm version 3.2.11 --no-git-tag-version` と CHANGELOG。3 ファイルだけ。

### リリース前チェックの結果（CLAUDE.md の MUST）

| 観点 | 結果 | 対応 |
| --- | --- | --- |
| tracked files の個人情報らしき文字列 | テストの fixture（example.com 等）と、上記の Issue テンプレートのリンクだけ | テンプレートは `1751d97` で修正 |
| コミット履歴の author / committer | 前のアカウント名と勤務先ドメインのメールアドレスのコミットが 50 件、`unknown` 名でローカルドメインのコミットが 2 件 | **未対応**。直すには履歴の書き換えと force push が必要で、既存タグとリリースがすべて壊れる。リポジトリはすでに public で、VSIX には git 履歴が入らないので、リリースは止めずにユーザー判断に回した |
| 公開設定・タグ・リリース | PUBLIC。`v3.2.11` タグは未作成だった。GitHub Release の最新は v3.2.9（v3.2.10 は作っていない） | 先例に合わせ、v3.2.11 も GitHub Release は作らない |
| LICENSE | MIT あり | — |

### Verification

| ゲート | ローカル (Windows) | CI (Ubuntu, run 37003590405) |
| --- | --- | --- |
| `npm run lint` | pass (612 files scanned) | pass (596 files scanned) |
| unit | 930 + 58 passing / 0 failing | 930 + 57 passing（v3.2.10 と同じく 1 件差。理由は未確認） |
| `npm run test:smoke` | 4 passing | 4 passing |
| `npm run lint:unicode:dist` | pass (289 artifacts) | pass (289 artifacts) |
| `vsce package` | — | `otak-proxy-3.2.11.vsix` (160 files, 633.13 KB) |
| VS Marketplace | API で 3.2.11 を確認（12:03:38Z。`lastUpdated` 12:02:27Z、publish 11:56:12Z から約 6 分） | `Published odangoo.otak-proxy v3.2.11.` |
| Open VSX | API で 3.2.11 を確認（11:58:13Z。11:57:27Z の時点ではまだ 3.2.10。publish 11:56:14Z から 2 分以内） | `Published odangoo.otak-proxy v3.2.11` |
| 公開された README | 両レジストリの 3.2.11 の README に、`4ab0a2a` で追加した 3 つの文言が入っていることを確認 | — |

テスト後の runner プロセス残存 0 件。PR #83 は Codex レビュー完了（指摘なし）。CodeRabbit は merge 時点でレビュー中だった（ドキュメントと版上げだけなので待たなかった）。

### Learning

1. **README を変えたリリースは、レジストリ側の README まで確認する。** 版が切り替わっても、掲載ページが新しい README か別に確かめないと「README が公開された」とは言えない。
   - Open VSX: `https://open-vsx.org/api/<publisher>/<name>/<version>` の `files.readme`。
   - Marketplace: `https://<publisher>.gallery.vsassets.io/_apis/public/gallery/publisher/<publisher>/extension/<name>/<version>/assetbyname/Microsoft.VisualStudio.Services.Content.Details`。`marketplace.visualstudio.com/_apis/public/gallery/publishers/.../assetbyname/...` は 404 だった。
   → rules.md「リリース」に追加。
2. **リリース前チェックで `.github/` の中も検索する。** 前の所有者アカウントの URL が Issue テンプレートに残っていた。ソースや README だけを見ていると見落とす。`git grep` の対象はリポジトリ全体にする。
3. **公開遅延の実測は今回も同じだった**（Open VSX 約 2 分、Marketplace 約 6 分）。rules.md の値は変えない。

## 2026-10-03 — 診断・修復まわりの不具合調査（コード変更なし）

**Issue**: なし（調査のみ。起票はユーザー判断待ち）
**基準コミット**: `d80515f`（v3.2.11 リリース後の main）

### やったこと

「他に診断不具合は無い?」への回答として、3 つのサブエージェント（収集・分類・修復）に読み取り専用で監査させた。挙がった指摘 25 件は、すべて自分で該当コードを読んで確かめた。ローカルで再現できるものは、読み取り専用のプローブで確認した。

### 確定した主な不具合（重い順）

| # | 内容 | 根拠 |
| --- | --- | --- |
| 1 | npm の設定読み取りに失敗すると（5 秒タイムアウト等）、未設定として扱われる。Auto では retryable な `npm.managedProxyMismatch` が偽で出て、無駄なリトライが走る。Off では偽の converged になる | `readNpmConfigValues` の catch が `{}` を返す |
| 2 | Windows に PAC/WPAD があると、Off でも `blocksConvergence` が出て `partial` 扱いになる。split と認証情報の検査には `expectsProxyDisabled` のガードがあるが、PAC/WPAD の検査には無い | `createUnsupportedAutoConfigIssue` の impact が固定で、`WindowsProxyDiagnostics.toIssues` も無条件 |
| 3 | 0 バイトのロックファイルが残ると、全ウィンドウの apply が `lockSkipped` のまま戻らない | `ApplyLockService.tryAcquire`: 読めないロックは常に `held`。stale 判定はパースできたときだけ |
| 4 | Auto でモニタ経由で検出 URL が変わったとき、per-scheme の古い `autoHttpProxyUrl` が残り、npm の mismatch が偽で出る（retryable） | `applyProxyDetectionResultToState` が split フィールドを更新しない。`ProxyApplier` は不一致時に split を無視するが、診断は無視しない |
| 5 | Web UI + リモートの Node 拡張ホストを、child_process が使えない環境と判定する（実環境では未確認） | `ExecutionContextDetector`: `canUseChildProcess: !isWeb` |

ほかに確定したもの（低〜中）:

- `blockPlaintextTargets` のときに Auto: OFF（到達不能）の無効化が止まり、平文認証情報の proxy が残る。toggle の Off は URL に `''` を渡すので影響しない。
- ロックの stale 回収が ABA で二重保持になる（rules.md「`FileLease` だけを使う」に反する実装）。
- ロックの I/O エラーで例外がそのまま上がる（`ioError` を返すコードが無い）。
- リトライが最大 2 回で、「at most one bounded retry」という文書と合わない。
- リトライ後の診断が失敗すると、flap バケットがリセットされる。
- apply 失敗の通知が、無関係な最上位 issue の fingerprint で間引かれる。
- pip がロックの対象に入っていない。
- 進行中の遅い診断に合流すると、`bypassSlowCache` が無視される。
- 既知シークレットの文字列置換で issue の id やキーが壊れる。
- Windows の reg / netsh の失敗で何も出ない。
- 通知に生の id が出る。
- bare `user:p@ss@host` のパスワード末尾と、PAC URL の `?token=` が漏れる。

### 否定・一部否定

| 指摘 | 結論 | 根拠 |
| --- | --- | --- |
| VS Code の `http.proxy` がワークスペース単位で設定されると、偽の mismatch が出る | 否定 | 手元の VS Code 本体（`workbench.desktop.main.js`）で、`http.proxy` の scope は APPLICATION か MACHINE だった。ワークスペースの値は適用されない |
| en/ja 以外のロケールで WinHTTP のパースが失敗する | 一部否定 | Windows 11 の CP932 環境で、日本語の出力は正しくパースされた。en/ja 以外のロケールは未確認 |

### 未確認のまま残したもの

- `channel.info` がログレベルで出なくなる件。
- netsh のエラーが stdout に出て理由が隠れる件。
- superseded のリクエストが後処理をする件（実際の影響）。
- renew で解放済みのロックが復活する件。
- FlapTracker の書き込み競合。
- `success` と `converged` の食い違い。

### Learning

1. **診断の各検査は、`expectsProxyDisabled` のガードを検査ごとに確かめる。** split と認証情報にはガードがあったが、PAC/WPAD には無かった。新しく検査を足すときは、Off / Auto: OFF での impact を決めてテストする。
2. **「読めなかった」と「未設定」を同じ値で表さない。** git は `readFailed` で区別しているが、npm と Windows のレジストリは区別していない。どちらも偽の収束、または偽のブロッカーの原因になっている。
3. **VS Code の設定 scope は、推測せず本体のバンドルで確かめられる。** `workbench.desktop.main.js` の `"<key>":{` の直前にある `scope:` を読む（1=APPLICATION, 2=MACHINE）。

## 2026-10-03 — コードベース全体の不具合・改善点の調査（コード変更なし）

**Issue**: なし（調査のみ。起票はユーザー判断待ち）
**基準コミット**: `d80515f`

### やったこと

「不具合箇所や改善が必要な箇所がないか分析して」への回答として、6 つのサブエージェント（Core / Config writers / Monitoring / Sync・Security / Commands・UI・i18n / Build・CI・Test）に読み取り専用で監査させた。指摘は 69 件。主要なものは自分で該当コードを読み、ローカルで安全に再現できるものはプローブで確かめた。

プローブ（いずれも repo に書き込みなし）:

- npm 11.16.0 を一時 `NPM_CONFIG_USERCONFIG` で実行: 認証情報付き URL を `config set proxy` した後の `config get proxy` は `The proxy option is protected, and cannot be retrieved in this way` で exit 1。認証情報なしなら値が返る。
- Node `execFile` のエラー文: `Command failed: git config ... http://alice:<pw>@proxy.example.com:8080`。argv がそのまま入る。
- `InputSanitizer.maskPassword('http://a:pw1@h1:1,http://b:pw2@h2:2')` → 2 つ目の `pw2` が残る。
- `ProxyUrlValidator.validate`: タブ入り・末尾 NUL・先頭空白は valid、末尾 `/` は「Hostname contains invalid characters」で invalid。

### 確定した主な不具合（重い順）

| # | 内容 | 根拠 |
| --- | --- | --- |
| CORE-1 | Auto でシステム proxy が途中で消えると（VPN 切断など）、proxy を外すだけでフォールバックに切り替わらない。`autoModeOff` も立たず「Auto: no proxy」表示のまま | `ExtensionProxyEventHandlers.handleProxyChanged` → `applyProxyDetectionResultToState` は `autoProxyUrl=undefined` にするだけ。フォールバック判定は `SystemProxyUpdateService.applyFallbackProxyState` と `ToggleProxyCommand` にしかない |
| CFG-1 | 認証情報付き proxy で npm の書き込み検証が必ず失敗し（ロールバック）、Off でも削除できない（`re-read failed; refusing to unset`） | npm の `config get` が private 値を拒否。`NpmConfigManager.inspectProxy` が `status:'error'` を返す。fake npm はこの拒否を模倣していない |
| CFG-2 | git が UNKNOWN / LOCKED で失敗すると、エラー通知にパスワードが平文で出る | `GitConfigErrorClassifier` が `errorMessage` をそのまま返し、`showAggregatedErrors` → `UserNotifier.showError` にマスクがない |
| UI-1 | Auto 中に「Configure Manual Proxy」で URL を入れても何も適用されず、表示も変わらない | `ConfigureUrlCommand.applyManualModeChange` が `mode !== Manual` で return。Manual は `getState()` で必ず Auto に移行される |
| BUILD-1/3/4 | PR CI がない。`workflow_dispatch` で任意ブランチから publish でき、タグと `package.json` の版の一致も確認しない。先頭 8000 バイトに NUL があるファイルは invisible Unicode 検査をすり抜ける | `publish-vscode.yml` のトリガ、`check-invisible-unicode.mjs` の `isBinary` |

ほかに確定したもの（グループ別）:

- **状態の整合性・競合**: `commitState` の check と write の間に await がありロストアップデート（CORE-2）。apply 結果が revision のずれだけで捨てられる（CORE-3）。migration 失敗時の古いスナップショット書き戻し（CORE-5）。共有ファイル CAS の基準が「最後に観測した版」ではなく「今読んだ版」（SYNC-1）。publish lease タイムアウトで publish を黙って捨てる（SYNC-2）。未来タイムスタンプ判定が version 比較より先（SYNC-9）。古い接続テスト結果が新しい世代で刻印される（MON-3）。
- **データ消失**: SecretStorage への保存失敗でも migration が公開 state を書き、旧シークレットを削除する。通知は衝突時だけ（CORE-4）。
- **監視の負荷・堅牢性**: `isCheckInProgress` が立ちっぱなしになり得る（MON-4）。フォーカスのたびに接続テスト（MON-8）。テスト間隔が 60 秒ではなく 90 秒（MON-9）。リトライにジッタ・上限・停止がない（MON-10）。初期値 false で偽の「到達可能になった」イベント（MON-11）。リモート変更のたびに差分を見ずに apply（SYNC-4）。
- **秘密情報**: Logger のマスクが 1 つ目の認証情報だけ（MON-12）。
- **入力検証**: URL 入力の trim・inline 検証がない、末尾 `/` のエラー文言が誤解を招く、タブ・NUL が通る（UI-2 / SYNC-3）。
- **表示・i18n**: 「Off モードに切り替えます」と言うが実際は Auto OFF（UI-3）。フォールバック URL を「System Proxy」と表示（UI-4）。ほか UI-5, 9〜12。
- **ビルド・テスト基盤**: VS Code host テストと contracts / failure-injection が CI で走らない（BUILD-2）。7 日ルールと audit が未強制（BUILD-5）。publish job の secrets 分離なし（BUILD-6）。検査後に `vscode:prepublish` が `out/` を再生成（BUILD-7）。evidence の pbt JSON が毎回作業ツリーを汚す（BUILD-10）。lint の警告が gate にならない（BUILD-11）。到達不能らしい 3.1 GB の loose blob（BUILD-12、サイズのみ確認）。
- **死んだコード**: `escapeGitValueRegex` と `exactGitConfigValuePattern` の重複でテストが未使用側を守っている（CFG-9）。`SharedStateFile.recover()` に本番の呼び出しなし（SYNC-7）。`isStartupTestStillPending` に本番の呼び出しなし（CORE-12）。

### 否定・仕様判断が要るもの

| 指摘 | 結論 | 根拠 |
| --- | --- | --- |
| CFG-3: VS Code の Off がワークスペースの `http.proxy` を読んで Global 値を消し損ねる | 否定（主シナリオ） | 前回確認したとおり `http.proxy` の scope は APPLICATION / MACHINE で、ワークスペース値は適用されない。残るのは Off で `""` を書き残す件だけ（軽微） |
| MON-1: 接続テスト 1 回の失敗で Auto: OFF にする | 挙動は確定、仕様判断が必要 | 何回の失敗で無効化すべきかが仕様に書かれていない |
| CORE-9: 同じ proxy アドレスで認証情報を外しても、保存済みの認証情報が再び付く | 挙動は確定、仕様判断が必要 | `persistManualProxySecret` は public URL が変わったときだけ削除する。意図した再利用かどうかが不明 |

### 未確認のまま残したもの

CORE-6/7/8（タイミング依存）、SYNC-5/6/8/10/11/12、MON-5（一部確認）/6/7、CFG-4/5/6/7、UI-7、BUILD-9 の原因特定。いずれもエージェントの追跡のみで、自分ではコードを読み切っていないか、実機（macOS / マルチユーザー Linux / Volta）が必要。

### Learning

1. **実ツールが拒否・秘匿する値は、fake でも同じように拒否させる。** npm は認証情報付きの `proxy` を `config get` で返さない。`createFakeNpmConfig` はこれを模倣しておらず、テストのコメント「npm 11.x masks credentials」は認証情報なしの URL でテストすることで回避していた。そのため CFG-1 がテストで見えなかった。→ rules.md「外部ツールのスタブ」に追加。
2. **`execFile` のエラー文には argv がそのまま入る。** 認証情報付きのコマンドが失敗したときの文字列は、表示の境界（通知）でマスクする。呼び出し元ごとのマスクは漏れる（CFG-2）。
3. **「システム proxy なし」の解決は入口ごとに実装されている。** 起動・toggle にはフォールバック判定があるが、モニタのイベント経路にはない（CORE-1）。新しい入口を足すときは同じ resolver を通す。
4. **compaction 後、バックグラウンドエージェントの output ファイルは 0 バイトのことがある。** 結果はセッションの transcript（jsonl）の tool result から取り出せる。

## 2026-10-03 — #85 モニタ経路のフォールバックと、認証情報付き npm proxy の検証・削除

**Issue**: #85
**コミット**: `9884649`（修正・テスト・README）。PR #86（merge commit で main に入れる）

### 症状

- CORE-1: Auto 中にシステム proxy が消えると（VPN 切断など）、proxy を外すだけで手動 URL（Auto のフォールバック）を使わない。フォールバックに到達できなくても Auto OFF にならない。
- CFG-1: 認証情報付き proxy で、npm への書き込み後の検証が必ず失敗してロールバックされる。Off でも npm の proxy を削除できない（`npm proxy re-read failed; refusing to unset`）。

### 原因

- CORE-1: フォールバック判定は起動時（`SystemProxyUpdateService.applyFallbackProxyState`）と toggle にしかなく、モニタのイベント経路（`handleProxyChanged`）には無かった。
- CFG-1: npm 11 の `config get` は、redact される値（URL のパスワード、npm token、UUID）を含む値をすべて拒否する（exit 1）。`NpmConfigManager.inspectProxy` はこれを読み取り失敗として扱っていた。fake npm がこの拒否を模倣していなかったので、テストで見えなかった。

### 修正

- `resolveManualFallback(state)` を公開し、`ExtensionInitializer` がモニタ経路の `handleProxyChanged` に注入する。結果が engaged なら fast path を通らずに適用し、パスワードを伏せて `fallback.usingManualProxy` を通知する。resolver の例外は notConfigured として扱う。revision 付きコミットなので、フォールバックのテスト中に入った toggle が勝つ。
- npm が拒否したキーだけ、user config ファイル（`npm config get userconfig` が返すパス）から読む。ファイルの読み込みは 1 回の inspection につき 1 回。`NpmUserConfigValue.readTopLevelNpmrcString` が ini 6 の decode を再現する。
- ファイルの値がパスワード付き URL でなければ、他の layer の値とみなして fail-closed（CONFIG_ERROR）にする。ファイルが無い・読めないとき、userconfig のパス自体を npm が拒否したとき（UUID を含むパス）も同じく fail-closed にし、ファイルの場所は推測しない。
- fake npm に拒否を模倣させ、user config ファイルを ini の書き出し形式で返すようにした。
- README: 途中で消えたときのフォールバック、npm の user config 読み取りと fail-closed を説明し、Troubleshooting を `npm config list` に変えた。

### 検証

- `npm run lint`（ESLint + lint:unicode、614 files）が clean。
- unit lane は 946 + 71 passing。実 npm 11.16.0 を隔離した userconfig で使うテスト 2 件を含む。
- VS Code host lane は 491 passing / 1 pending / 9 failing。失敗 9 件は変更前の baseline と同じ集合で、#85 のテストは含まない。
- smoke は 4 passing。テストランナーの残存プロセスは無し。
- 独立した verifier（fresh context、10 項目の rubric、sonnet）の初回判定は、C1 だけ fail（rules.md に BOM の実体が混入）。直したあとに C1 を再判定し、全項目 pass。
- 未確認: OS の proxy 設定や VPN を実際に変えて、システム proxy を消す実機確認はしていない。

### 学び

1. README 更新中に Troubleshooting のコマンドを実際に実行して、`npm config get userconfig` も UUID を含むパスでは拒否されることが分かった。修正の漏れだったので、fail-closed を明示してテストを追加した。→ rules.md「ドキュメント」「npm」
2. Edit ツールも、バックスラッシュ u FEFF の形のエスケープを BOM の実体にして書く。この学びを rules.md に書いた行そのものに BOM が混入し、verifier の lint で検出された。→ rules.md「ツール操作」
3. npm は、最後のキーを `config delete` すると user config ファイル自体を消す。→ rules.md「npm」
4. Git Bash の `grep -c` で CR を数える方法は使えない。LF だけのファイルでも全行が一致した。→ rules.md「ツール操作」
5. verifier の host lane の初回実行が途中で切れた（mocha の summary なし）。原因は特定していない。完走した再実行は baseline と一致した。

### 残留リスク

- project レベルの `.npmrc` が別の認証情報付き URL で上書きしていても、user ファイルの値を有効値とみなす。どの project config が効くかは、プロセスの cwd で決まる。
- Off のときに確かめられない値は、errorType UNKNOWN（`npm proxy re-read failed; refusing to unset`）で報告され、CONFIG_ERROR にはならない。値は残る。
- モニタ経路では、PAC/WPAD のときにフォールバックを使わない。`ToggleProxyCommand` にある判定の重複は範囲外とした（#85 に明記）。
- フォールバックが無いとき、モニタ経路では `autoModeOff=false` のままだが、起動時は true になる。仕様の不整合として報告だけにした。

## 2026-10-03 — v3.2.12 の公開失敗（#88）と v3.2.13 リリース（#85 + #88 を公開）

**Issue**: [#88](https://github.com/tsuyoshi-otake/otak-proxy/issues/88)（#89 の merge でクローズ）、[#85](https://github.com/tsuyoshi-otake/otak-proxy/issues/85)（`Refs`）
**PR**: [#87](https://github.com/tsuyoshi-otake/otak-proxy/pull/87)（3.2.12 のリリース）、[#89](https://github.com/tsuyoshi-otake/otak-proxy/pull/89)（修正）、[#90](https://github.com/tsuyoshi-otake/otak-proxy/pull/90)（3.2.13 のリリース）
**Commits**: `21d9384`（`chore(release): v3.2.12`）、`b1ffef7`（修正）、`89da4ac`（版範囲のコメント修正）、`0ca554d`（`chore(release): v3.2.13`）
**Merge commits**: `5d683f8`（#87）、`9aa402c`（#89）、`cd6de03`（#90）
**Tags**: `v3.2.12`（`5d683f8`、**未公開**）、`v3.2.13`（`cd6de03`、annotated / `Release v3.2.13`）
**CI runs**: [37089775512](https://github.com/tsuyoshi-otake/otak-proxy/actions/runs/37089775512)（v3.2.12、Unit tests で失敗）、[37091020182](https://github.com/tsuyoshi-otake/otak-proxy/actions/runs/37091020182)（v3.2.13、成功）

### 症状

`v3.2.12` タグの publish run が Unit tests で止まった。失敗したテストは `real npm: a credentialed URL is set, verified, read and removed (#85)`、メッセージは `Failed to read/write npm configuration; residual remains: proxy, https-proxy`。VSIX の作成より前なので、どちらのレジストリにも何も出ていない。ローカル（Windows、npm 11.16.0）のゲートは 4 つとも通っていた。

### 原因

- CI は Node 22.23.3 に同梱の **npm 10.9.9** で動く。npm 10.9.9 は認証情報付きの値の `config get` を `... option is protected, and can not be retrieved in this way` で拒否する。
- #85 の `isProtectedGetRefusal` は npm 11.16.0 の文言 `cannot be retrieved` しか見ていなかった。拒否として認識されず、user config ファイルも読まれず、npm 10 では CFG-1 が直っていなかった。テストだけの問題ではなく、Node.js 22 の npm を使う利用者に効く本番の不具合。
- npm/cli の `lib/commands/config.js` をタグごとに確認した結果: 10.7.0 以前は値を表示する（redact による拒否なし）。10.8.0〜11.6.1 は `can not be retrieved`。11.6.2 以降は `cannot be retrieved`。
- ローカルの検証は npm 11 だけで、CI の npm の版でテストしていなかった。

### 対応

1. Issue #88 を作り、`isProtectedGetRefusal` を `/can ?not be retrieved/` にした（`b1ffef7`）。fake npm に `refusalWording` を足し、書き込み→検証→読み戻し→Off の往復と、userconfig のパス拒否の fail-closed を両方の文言で回す。README とコメントは「npm 10.8 and later」。npm 10.9.9 の ini 5.0.0 と npm 11.16.0 の ini 6.0.0 は `lib/ini.js` が同一なので、user config の読み取りもそのまま使える。
2. 独立 verifier の指摘で、版の境目（11.6.1 / 11.6.2）をコメントに正確に書いた（`89da4ac`）。
3. `v3.2.12` タグは付け替えず（`git tag` の man page が公開済みタグの付け替えを勧めない）、3.2.13 として出した。CHANGELOG では 3.2.12 を「Not published」とした（`0ca554d`）。

### リリース前チェックの結果（CLAUDE.md の MUST）

| 観点 | 結果 | 対応 |
| --- | --- | --- |
| tracked files の個人情報らしき文字列 | v3.2.11 以降の追加行は `*.example.com` と `127.0.0.1` の fixture だけ | — |
| コミット履歴の author / committer | v3.2.11 以降は既存と同じ ID と GitHub の merge コミットだけ。前のアカウント名と勤務先ドメインのメールアドレスのコミットは既存のまま | **未対応**（ユーザー判断待ちのまま。v3.2.11 のエントリと同じ） |
| 公開設定・タグ・リリース | PUBLIC。タグは v3.2.12（未公開）まで。GitHub Release の最新は v3.2.9 | 先例に合わせ GitHub Release は作らない |
| LICENSE | MIT あり | — |

### Verification

修正の確認:

| 項目 | 結果 |
| --- | --- |
| 修正前の再現 | 実物の npm 10.9.9（`~/tmp/otak85/npm10` に隔離して用意）で、2 件の real npm テストが CI と同じメッセージで失敗。fake の `can not` テストも修正前は失敗 |
| 修正後 | `NpmConfigManager` + `NpmUserConfigValue` のテストが、実物の npm 10.9.9 と 11.16.0 の両方で 43 passing |
| 独立 verifier（sonnet、fresh context、6 項目） | 全項目 pass。`out/` のコピーで旧 regex に戻すと CI と同じエラーになることも確認 |
| PR #89 のレビュー | Codex 完了（`b1ffef7`、指摘なし）。#90 は Codex の利用上限と CodeRabbit の rate limit でレビューなし（版上げと CHANGELOG だけ） |

v3.2.13 のリリース:

| ゲート | ローカル (Windows) | CI (Ubuntu, run 37091020182) |
| --- | --- | --- |
| `npm run lint` | pass (614 files scanned) | pass (598 files scanned) |
| unit | 946 + 74 passing / 0 failing | 946 + 73 passing / 1 pending（Windows 専用テスト。学び 3） |
| `npm run test:smoke` | 4 passing | 4 passing |
| `npm run lint:unicode:dist` | pass (291 artifacts) | pass (291 artifacts) |
| `vsce package` | — | `otak-proxy-3.2.13.vsix` (161 files, 637.06 KB) |
| VS Marketplace | API で 3.2.13 を確認（02:56:42Z。`lastUpdated` 02:56:30Z、publish 02:50:50Z から約 6 分） | `Published odangoo.otak-proxy v3.2.13.`（02:50:50Z） |
| Open VSX | API で 3.2.13 を確認（02:53:52Z。02:51:43Z の時点ではまだ 3.2.11。publish 02:50:52Z から 3 分以内） | `Published odangoo.otak-proxy v3.2.13`（02:50:52Z） |
| 公開された README | 両レジストリの 3.2.13 の README は同一（30,406 bytes）。vsce が `LICENSE` への相対リンク 2 か所を GitHub の URL に書き換えた以外は main の README と同じ。#85 と #88 の文言 3 つも入っている | — |

テスト後の runner プロセス残存 0 件（残っていた node は VS Code の tsserver だけ）。

### Learning

1. ローカルと CI で外部ツールの版が違う（ローカル npm 11.16.0 / CI npm 10.9.9）。実物の外部ツールを叩くテストは、タグを打つ前に CI と同じ版でもローカルで回す。→ rules.md「リリース」
2. npm の拒否メッセージは版で文言が違う（`can not` / `cannot`）。エラー文言で分岐するときは、対象の版範囲の文言をソースで確認する。→ rules.md「npm」
3. CI とローカルの unit 件数の 1 件差（v3.2.10 から「理由は未確認」）は、Windows 専用テスト `Windows npm path does not expand %OS% or split on &` が Linux で pending になるため。v3.2.13 と v3.2.11（run 37003590405）の CI ログで、このテストが `1 pending` になっていることを確認した。→ rules.md「リリース」
4. publish run が失敗してもタグは残る。公開前に止まったならタグは付け替えず、次の patch で出して CHANGELOG に未公開と書く。→ rules.md「リリース」
5. `rm -rf` を含む Bash コマンドは権限で拒否された。テストの隔離ディレクトリは消さずに、実行ごとに新しく作る。→ rules.md「ツール操作」
6. Open VSX の `files.readme` は `openvsx.eclipsecontent.org` への 302。curl に `-L` が無いと README が 0 bytes になり、確認が成り立たない。→ rules.md「リリース」
7. Git Bash の `sed -i` は CRLF のファイルを LF にして書き戻した（rules.md の全行）。CRLF のファイルは node で直す。→ rules.md「ツール操作」
8. 公開遅延は今回も同じ（Open VSX 3 分以内、Marketplace 約 6 分）。rules.md の値は変えない。

### 残留リスク

- エラー文言で拒否を判定しているので、npm が将来また文言を変えると同じ失敗になる。その場合は CONFIG_ERROR で fail-closed（値は消さない・漏らさない）。
- #85 の残留リスク（project `.npmrc` の上書き、Off で確かめられない値の errorType、PAC/WPAD、実機での VPN 切断の未確認）はそのまま。

## 2026-10-03 — 過去のコミット履歴の author / committer は書き換えないと決定

**Issue**: なし（リリース前チェックの指摘への判断）

### 経緯

v3.2.11 から、リリース前チェック（CLAUDE.md の MUST）で、前のアカウント名と勤務先ドメインのメールアドレスの
コミットが履歴に残っていることを「未対応・ユーザー判断待ち」として報告していた（v3.2.11 のエントリで 50 件と、
`unknown` 名のコミットが 2 件）。

### 判断

ユーザーが「書き換えなくていい」と決定した。推奨も「書き換えない」だった。理由は次のとおり。

- 書き換えには履歴の書き換えと force push が要り、既存のタグ（v3.2.13 まで）とリリースがすべて壊れる。
- リポジトリはすでに public で、書き換えても既に取得された履歴は消えない。
- Marketplace / Open VSX に出している VSIX には git 履歴が入らない。

### 今後

リリース前チェックでは、前回から新しい author / committer の ID が増えていないかだけを確かめて報告する。
既存のコミットについて書き換えの判断はもう求めない。→ rules.md「リリース」

## 2026-10-03 — #93 診断の誤った状態（npm 読み取り失敗、Off の PAC/WPAD、読めないロック、古い split URL、web UI）

**Issue**: [#93](https://github.com/tsuyoshi-otake/otak-proxy/issues/93)
**コミット**: `42c4211`（修正・テスト）。PR [#94](https://github.com/tsuyoshi-otake/otak-proxy/pull/94)（merge commit で main に入れる）

### 症状

1. npm の `config list --json` が失敗すると（タイムアウト、PATH に npm が無い）、「npm に proxy が無い」と扱われた。Auto では偽の `npm.managedProxyMismatch` でリトライし、Off では残留チェックが何も見ずに収束扱いになり得た。
2. Windows の PAC/WPAD が、Off（と、フォールバックの無い Auto: OFF）でも `blocksConvergence` になり、何も適用しないはずなのに `runtimeState` が `partial` になった。
3. 空や途中までのロックファイル（`open('wx')` と書き込みの間でプロセスが死んだ）が残ると、どのウィンドウも永久に `lockSkipped` になった。
4. モニタが新しい proxy を検出しても、前回の `autoHttpProxyUrl` / `autoHttpsProxyUrl` / 検出 bypass が state に残り、npm を古い https 値と比べて偽の mismatch を出した。
5. UI がブラウザ（`uiKind === Web`）で拡張機能がリモートの Node ホストで動くとき、child_process とレジストリが必要なチェックがすべて無効になり、ホストが `web` と報告された（実機では未確認）。

### 原因

1. `readNpmConfigValues()` が catch で `{}` を返し、「読めない」と「未設定」が同じ値になっていた。git は #16 で `readFailed` と informational の `git.readUnavailable` に分けていた。
2. PAC/WPAD の issue は `impact: 'blocksConvergence'` 固定で、split proxy や認証情報のチェックにある `expectsProxyDisabled` のガードが無かった。Windows の PAC/WPAD は状態に依存しない slow cache から来る。
3. `tryAcquire` は読めないロックを古さを見ずに `held` にしていた。`tryCreateLock` は `open('wx')` 後の書き込みが失敗すると 0 バイトのファイルを残した。
4. `ProxyDetectionResult` と `detectProxyWithRetry` が split フィールドを落とし、`applyProxyDetectionResultToState` は更新もクリアもしなかった。さらに `ProxyMonitor` は主 URL が変わったときしか `proxyChanged` を出さず、ハンドラも主 URL だけで「変化なし」と判定していた。
5. `ExecutionContextDetector.detect()` が capability と場所を `uiKind` だけから導いていた。この拡張機能は `browser` エントリが無く `extensionKind: ["workspace"]` なので、常に Node の拡張ホストで動く。

### 修正

1. npm の観測に `readFailed` を足し、読み取り失敗は informational の `npm.readUnavailable`（npm が対象のときだけ）にして、mismatch と残留チェックを飛ばす。16 ロケールに理由文を足した。
2. `expectsProxyDisabled` のとき、PAC/WPAD の issue を実行ごとのコピーで informational に下げる（`asProxyDisabledUnsupportedAutoConfig`）。cache の issue は書き換えない。proxy が期待される Auto では `blocksConvergence` のまま。
3. 読めないロックは、mtime が TTL より古く（壁時計）、再確認でも読めず mtime が同じときだけ回収する。rename のあとで退避したファイルが読めたら、別ウィンドウが先に回収して作った生きたロックを動かしたことになるので、`fs.link`（上書きしない）で戻して `held` を返す。書き込み失敗時は自分のファイルを消してから例外を投げる。
4. 検出結果に `httpUrl` / `httpsUrl` / `bypass` を通し、ハンドラが state に入れる（proxy が無ければクリア）。モニタの emit とハンドラの「変化なし」判定は、`DetectedProxyValue` の同じ規則（`routingSplit`）で split の同一性を比べる。単一 proxy の http/https の写しは数えない。Auto: OFF で主 URL が同じで新しい接続テストが無い検出は、保存だけにして apply しない（verifier の指摘、下記）。保存の経路でも検出種別と split フィールドを保存し、到達性の回復時の apply がそれを読む。新しいテスト結果付きの検出は従来どおり。
5. capability は拡張ホストの実行環境（Node かどうか）から導く。web UI でも `remoteName` から場所とホスト種別を決め、`uiKind` は `web` のまま報告する。純粋関数 `deriveExecutionContext` に分けてテストした。

### 検証

- 各修正を 1 つずつ戻すミューテーション 11 件（5 項目）を、戻す前の基準実行が緑であることを確かめてから実行し、11 件とも対象テストが落ちた（KILLED）。ソースはバイト単位で元に戻ることを確認。
- `npm run lint`、`test:unit:parallel`（976 + 74 passing）、`test:smoke`、`lint:unicode:dist` が通過。
- VS Code host lane は 502 passing / 1 pending / 9 failing。1 回目は `Extension startup OFF self-repair` の途中で mocha の集計なしに止まり（189 件で終了、拡張ホストは exit code 0）、1 回だけ再実行して完走した。失敗は変更前の baseline と同じ 9 件。
- 独立 verifier（fresh context、sonnet）: 1 回目は 11 基準すべて pass だったが、項目 4 の回帰を 1 件見つけた。Auto: OFF（到達できず proxy を外した状態）で split だけが変わると、モニタは接続テストをしないので `proxyReachable` が undefined になり、`!== false` の判定で到達できない proxy を有効にしていた。1 回目の修正（split の変化を Auto: OFF では apply 扱いにしない）は再確認で不十分と判定された。disable 後は各ターゲットの `*Configured` が false になり、`hasKnownEnableFailure` が先に apply へ送っていた。新テストは setup の `*Configured: true`（disable 後にはあり得ない状態）で pass していた。2 回目の修正で「Auto: OFF・主 URL が同じ・テスト結果なし」を保存だけの経路にし、テストを disable 後の実際の state で作り直した。ガードの 3 条件と保存フィールドを戻すミューテーション 4 件はすべて KILLED。2 回目の再確認は 7 基準すべて pass。低優先度の指摘 2 件: (1) 起動後の最初のポーリング（自動テスト無効）で、保存済みの Auto: OFF のまま同じ URL を検出すると、以前は検証なしに proxy を有効にしていた（ステータスは Auto: OFF のまま）。今は外したままになる。PR と CHANGELOG で開示。(2) Auto: OFF で 407 / 403 / timeout canary のテスト結果付きの同 URL 検出は、`autoModeOff` が true のまま enable=true で apply される。既存の挙動で今回の範囲外。
- テストランナーの残存プロセス: 各 gate とミューテーションの後に `mocha|vscode-test` のプロセスを確認し、残存なし。
- 未確認: 項目 5 の実機（ブラウザ UI + リモートホスト）。PAC/WPAD の実際の Windows 設定。

### 学び

1. 観測オブジェクトに項目を足すと、`deepStrictEqual` で観測全体を比べているテストが落ちる（`ProxyRuntimeDiagnostics.test.ts` の npm）。host lane で初めて見えた。→ rules.md「診断レポート」
2. 「変化があったら適用する」判定は、モニタの emit とハンドラの両方にある。片方だけ直すと、split だけの変化はイベント自体が来ない。両方を同じ関数で比べる。→ rules.md「診断レポート」
3. 読めないロックを mtime で回収すると、回収どうしが競合して生きたロックを動かす ABA になる。rename のあとで中身を確かめて戻す。→ rules.md「排他制御」
4. `MOCHA_GREP` で host lane を絞るとき、grep が既存の失敗テスト（`Auto + unsupported PAC + reachable fallback`）にも一致した。ミューテーションの基準実行が緑でないと判定が成り立たないので、grep は Issue 番号で絞る。→ rules.md「検証・回帰」
5. ExecutionContext の capability は `uiKind` ではなく拡張ホストで決まる。→ rules.md「診断レポート」
6. host lane が mocha の集計なしで途中終了したのは 2 回目（1 回目は #85 の verifier）。今回は `Extension activation with first-run setup` の直後、`Extension startup OFF self-repair`（実 git と activate/deactivate を使う）の途中で、拡張ホストが exit code 0 で終わった。再実行は baseline と一致した。原因は特定していない。→ rules.md「検証・回帰」
7. 「変化があったら適用する」条件を広げると、Auto: OFF でも apply に入る。split だけの変化は接続テストが走らず到達性が不明なので、`proxyReachable !== false` が真になる。条件を広げたら Auto: OFF の経路も確かめる。→ rules.md「診断レポート」
8. テストの state を実際には起きない値で作ると、回帰経路を通らずに pass する。Auto: OFF のテストが `*Configured: true` のままだったので、1 回目の修正が不十分なことをテストが見逃した。ミューテーションも同じ state で走るので KILLED になり、検出できなかった。state はその状態に至る操作の結果（disable 後は `*Configured: false`）で作る。→ rules.md「診断レポート」

### 残留リスク

- 項目 5 は faked `vscode.env` の unit テストだけ。remoteName の無い web UI + Node ホスト（serve-web など）は `localUi` と報告される（capability は正しい）。
- Auto: OFF で 407 / 403 / timeout canary の失敗テスト付き検出が、`autoModeOff` を true のまま proxy を有効にする（既存、verifier の指摘）。
- Auto: OFF のガードの `Boolean(result.proxyUrl)`（proxy が無い検出では fallback の解決を飛ばさない）はテストで固定していない。モニタは「proxy なし → proxy なし」を emit しないため、到達する経路を確認できなかった防御。
- 期限切れロックの回収経路の ABA は既存のまま（範囲外）。読めないロックの経路も、3 ウィンドウの競合や、確認中に相手が書き込み途中のときは二重保持が残り得る。`fs.link` が使えないファイルシステムでは生きたロックを失い得る。
- 通知の変化: Off / Auto: OFF の PAC/WPAD ではロックスキップ通知が出なくなった（#30 の規則の帰結、#93 のコメントで開示）。https だけ・bypass だけの変化で「システム proxy が変わりました」が出るようになった（`SystemProxyUpdateService` と同じ）。`RemediationOutcome` も `blocksConvergence` で判定するので、Off / Auto: OFF の PAC/WPAD はそこでも収束扱いになった。

## 2026-10-03 — v3.2.14 リリース（#93 の診断修正を公開）

**Issue**: [#93](https://github.com/tsuyoshi-otake/otak-proxy/issues/93)（`Refs`、#94 の merge でクローズ済み）
**PR**: [#95](https://github.com/tsuyoshi-otake/otak-proxy/pull/95)（3.2.14 のリリース）
**Commits**: `d0328a7`（`chore(release): v3.2.14 (#93)`）
**Merge commit**: `43dac17`（#95）
**Tag**: `v3.2.14`（`43dac17`、annotated / `Release v3.2.14`）
**CI run**: [37095729454](https://github.com/tsuyoshi-otake/otak-proxy/actions/runs/37095729454)（成功）

### 内容

#93 の 5 件（npm 読み取り失敗、Off / Auto: OFF の PAC/WPAD、読めないロック、古い split URL、web UI）と README の追記を公開した。リリースコミットは `CHANGELOG.md` / `package.json` / `package-lock.json` の 3 ファイルだけ。

### リリース前チェックの結果（CLAUDE.md の MUST）

| 観点 | 結果 | 対応 |
| --- | --- | --- |
| tracked files の個人情報らしき文字列 | v3.2.13..v3.2.14 の追加行（`package-lock.json` を除く）にメールアドレス・UUID・ローカルのユーザーパス・トークン・社内向け IP の一致なし | — |
| コミット履歴の author / committer | v3.2.13..v3.2.14 は既存の ID と GitHub の merge コミットだけ。新しい ID なし | 書き換えない（2026-10-03 の決定） |
| 公開設定・タグ・リリース | PUBLIC。タグは v3.2.13 まで。GitHub Release の最新は v3.2.9 | 先例に合わせ GitHub Release は作らない |
| LICENSE | MIT あり | — |

PR #94 のボット: CodeRabbit は要約だけで inline の指摘なし、Codex は利用上限でレビューなし。#95 もレビューなし（版上げと CHANGELOG だけ）。

### Verification

| ゲート | ローカル (Windows) | CI (Ubuntu, run 37095729454) |
| --- | --- | --- |
| `npm run lint` | pass (616 files scanned) | pass (600 files scanned。差の 16 は学び 1) |
| unit | 976 + 74 passing / 0 failing | 976 + 73 passing / 1 pending（Windows 専用テスト） |
| `npm run test:smoke` | 4 passing | 4 passing |
| `npm run lint:unicode:dist` | pass (293 artifacts) | pass (293 artifacts) |
| `vsce package` | — | `otak-proxy-3.2.14.vsix` (161 files, 640.34 KB) |
| VS Marketplace | API で 3.2.14 を確認（04:22:14Z。`lastUpdated` 04:21:35Z、publish 04:14:47Z から約 7 分。04:21:14Z の時点ではまだ 3.2.13） | `Published odangoo.otak-proxy v3.2.14.`（04:14:47Z） |
| Open VSX | API で 3.2.14 を確認（04:18:39Z。`timestamp` 04:14:49Z） | `Published odangoo.otak-proxy v3.2.14`（04:14:49Z） |
| 公開された README | 両レジストリの 3.2.14 の README は同一（30,804 bytes）。vsce が `LICENSE` への相対リンク 2 か所を GitHub の URL に書き換えた以外は main の README と同じ。#93 の追記も入っている | — |

extension-host lane は #94 で同じコードに対して実行済み（502 passing / 1 pending / 9 failing、9 件は既知の baseline）。版上げだけのこの PR では再実行していない。テスト後の runner プロセス残存 0 件（残っていた node は VS Code の tsserver だけ）。

### Learning

1. ローカルの `npm run lint:unicode` はリポジトリの CI より多いファイルを数える。tracked に加えて「新規で ignore されていない」ファイルも走査するため。今回の差 16 は未追跡の `.kiro/specs/domain-verification-assurance/evidence/runs/latest/pbt/*.json`（tracked 607 + 未追跡 16 − binary 7 = 616、CI は 607 − 7 = 600）。→ rules.md「リリース」
2. Marketplace の反映は今回約 7 分（v3.2.13 は約 6 分）。Open VSX は 4 分以内。rules.md の Marketplace の値を「約 5〜7 分」にした。→ rules.md「リリース」
3. 新しく学んだ失敗はなし。前回までの rules（3 ファイルのリリースコミット、annotated タグ、`curl -L`、レジストリ API での確認）でそのまま通った。

### 残留リスク

#93 のエントリの残留リスクがそのまま公開された:

- 項目 5（web UI）は unit テストだけで、実際のブラウザ UI では試していない。
- PAC/WPAD の扱いは実機の Windows 設定では確かめていない。
- Auto: OFF での 407 / 403 / timeout canary の失敗テスト付き検出が proxy を有効にする既存の問題（verifier の指摘、未対応）。
- 期限切れロックの ABA、読めないロックの 3 ウィンドウ競合と `fs.link` の制約。
- 通知と挙動の変化（Off / Auto: OFF の PAC/WPAD でロックスキップ通知が出ない、https / bypass だけの変化で通知が出る、`RemediationOutcome` の収束扱い）。
- `0379c62` のコミットメッセージの「13 mutations killed」は誤りで、正しくは 15（11 + 4）。force push を避けて修正していない。journal の #93 エントリは正しい件数。

## 2026-10-03 — #97 Auto: OFF のまま proxy を有効にする経路の調査と起票（コード変更なし）

**Issue**: [#97](https://github.com/tsuyoshi-otake/otak-proxy/issues/97)（起票、未修正）
**基準コミット**: `fb74a0b`（main）

### 症状

#93 の独立 verifier の指摘: `Auto: OFF` で、407 / 403 / timeout canary などの失敗テスト結果付きの検出を受けると、`autoModeOff` が `true` のまま proxy が有効になる。

### 原因（コード読み）

`updateAutoModeFromTestResult` は success のときだけ `autoModeOff` を `false` にする。`handleProxyChanged` の `shouldEnable` と `applyReachabilityChange` は `isProxyEndpointReachable`（endpoint unreachable 以外は到達可）で判断する。#67 で Auto OFF の条件を endpoint unreachable に限ったが、戻す条件は success のまま残った。end-to-end では、Auto: OFF（proxy なし）から新しい system proxy が現れて最初のテストが 407 / timeout のとき、`handleProxyTestComplete` は stale、`handleProxyStateChanged` は URL 違いで捨て、`handleProxyChanged` だけが apply する。

### Verification

| 項目 | 結果 |
| --- | --- |
| handler 単体の再現 | 一時テスト 2 件（Auto: OFF + 同じ URL + 407、Auto: OFF（proxy なし）+ 新しい URL + timeout）で、どちらも `applyProxySettings(url, true)` が 1 回、apply 時点と終了時の `autoModeOff` が `true` |
| 一時テストの後始末 | `git checkout` でソースを戻し、`tsc` で `out/` を作り直して `REPRO` が 0 件。mocha プロセスの残存なし |
| モニタのイベント列 | コード読みだけ。拡張ホスト・実機では未確認 |

### Learning

1. 失敗の分類を変えたら（#67）、状態に入る条件だけでなく、状態から出る条件も同じ分類で見直す。`Auto: OFF` に入る条件は endpoint unreachable に変わったが、出る条件は success のままで、3 つの handler の結論が揃わなくなった。→ rules.md「診断レポート」には書かない（#97 の仕様判断待ち。決まったら rules に昇格する）。

### 残留リスク

- 仕様（A: 到達可の失敗で Auto ON にする / B: success まで有効にしない）が未決。#97 で判断を求めている。

## 2026-10-03 — #97 Auto: OFF は proxy が生きている証明があるときだけ外す（PR #99）

**Issue**: [#97](https://github.com/tsuyoshi-otake/otak-proxy/issues/97)
**PR**: [#99](https://github.com/tsuyoshi-otake/otak-proxy/pull/99)（未マージ）
**コミット**: `a9ab986`（fix/97-auto-off-proven-recovery、基準 `543be4b`）

### 症状

- Auto: OFF のまま、407 / 403 / timeout canary の結果が付いた検出で proxy が有効になる（#97 の起票内容）。
- 逆に、407 / 403 / 5xx や接続後の timeout では、proxy が動いているのに Auto: OFF から戻らない。接続前の timeout や DNS 失敗では、reachability の反転だけで Auto に戻ることがあった。

### 原因

- Auto: OFF に入る条件は endpoint unreachable（#67）だった。出る条件は、テスト完了では success だけ、反転と `handleProxyChanged` では `isProxyEndpointReachable`（unreachable 以外）で、分類が揃っていなかった。
- end-to-end テストを書く途中で、既存のフェンス不具合が 2 件見つかった。
  1. 同じチェックで先に来る proxyTestComplete のコミットが revision を進め、後の proxyChanged が stale として捨てられていた。途中で変わった system proxy は保存されるだけで、適用されなかった。
  2. unreachable テスト後の解除ガードは、テスト開始時の世代と比べていた。自分のコミットで世代が進むので常に stale になり、解除は本番で一度も動いていなかった。

### 修正

- `proxyEndpointVerdict` を追加した。判定順は unreachable → alive（success / `proxyEndpointOk` / `proxyConnected`）→ unknown。
- `TestResult.proxyConnected` を追加した。2 つの tester が proxy への TCP 接続を記録する。
- `updateAutoModeFromTestResult` を `applyEndpointVerdict` に置き換えた。Auto: OFF の間は何も有効にしない。Auto: OFF から戻るテスト完了の handler が、同じ手順で apply する。
- フェンス修正 D: 別 endpoint のテスト完了は stale にする。
- フェンス修正 R: `stateStillFromTest` は、自分のコミットが書いた revision と比べる。

### Verification

| 項目 | 結果 |
| --- | --- |
| 実装前の新規・変更テスト | 34 failing（red） |
| 対象ファイル | 92 passing |
| `npm run lint` / `test:smoke` / `lint:unicode:dist` | pass / 4 passing / clean |
| `npm run test:unit:parallel` | 1101 passing、0 failing |
| `npm test`（拡張ホスト） | 502 passing、9 failing（既知の baseline と同じ 9 件） |
| ミューテーション | 14 件中 14 件 killed |
| 独立 verifier（rubric 10 項目） | 10/10 pass |

### 事故: 実機の `~/.gitconfig` と `~/.npmrc` にテスト値が残った

- 症状: `git push` が `Could not resolve proxy: proxy.example.com` で失敗した。
- 原因: verifier が flaky テストを切り分けるため、`ConfigManagers.crossplatform.test.js` を隔離 env なしの mocha で 3 回実行した。このファイルの errorType テストは、実物の git / npm に `http://proxy.example.com:8080` を set して片付けない。16:34:43 に `~/.gitconfig` の `http.proxy`、16:34:47 に `~/.npmrc` の `proxy` / `https-proxy` が書かれた（mtime と verifier の transcript で確認）。私の rubric が「mocha (same flags)」と書き、隔離 env を渡していなかった。
- 対処: 両ファイルを `~/tmp/otak97/config-backup-20261003/` に退避した。続けて `git config --global --unset http.proxy`、`npm config delete proxy` / `https-proxy`（`--location=user`）を実行した。`~/.npmrc` は空になり、npm が削除した。その後 push に成功した。
- 書き込み前の値: 残っていない。テスト前は proxy 設定が無かったと判断した（未証明）。根拠は 3 点。`~/.npmrc` に他のキーが無かった。Windows の system proxy は無効（ProxyEnable 0、PAC なし）。当日それまでの push はプロキシなしで通っていた。

### Learning

1. 自分のコミットの後のガードは、そのコミットが書いた revision と比べる → rules.md「世代フェンス」。
2. 同じチェックで先にコミットしたイベントは、後のイベントを stale にする → rules.md「世代フェンス」。
3. 状態に入る条件と出る条件は同じ分類で決める（#97 調査時の Learning を昇格）→ rules.md「診断レポート」。
4. verifier の rubric にも隔離 env を書く。`ConfigManagers.crossplatform` は書いた値を片付けない → rules.md「検証・回帰」の既存ルールに追記。

### 残留リスク

- TCP 接続を受けるが中継できない proxy は alive と判定する。
- テストが何も証明しない新 endpoint は適用する（#67 の規則）。
- 実ネットワーク・実 VPN 切替では未確認。
- 拡張ホストの 1 回が集計なしで途中終了した。unit lane では `ConfigManagers.crossplatform` の errorType テストが 3 回中 1 回失敗した（この差分の外）。未検証の仮説: parallel の worker が 1 つの隔離 gitconfig を共有していて、lock が競合している。
- 未修正: 同じ URL の split 変化と、同じチェックのテストが重なると、proxyChanged が stale になる（#93 の経路）。follow-up Issue を提案中。
- `ConfigManagers.crossplatform` は隔離なしでは実物の設定を書き、片付けない。follow-up の候補。

## 2026-10-03 — #97 Codex 指摘 3 件の修正（795c1bd）と v3.2.15 リリース

**Issue**: [#97](https://github.com/tsuyoshi-otake/otak-proxy/issues/97)
**PR**: [#99](https://github.com/tsuyoshi-otake/otak-proxy/pull/99)（修正、merge `a1f2e08`）、[#100](https://github.com/tsuyoshi-otake/otak-proxy/pull/100)（3.2.15 のリリース、merge `cd4f8cd`）
**Commits**: `795c1bd`（Codex 指摘の修正）、`4dd2d53`（`chore(release): v3.2.15 (#97)`）
**Tag**: `v3.2.15`（`cd4f8cd`、annotated / `Release v3.2.15`）
**CI run**: [37110778012](https://github.com/tsuyoshi-otake/otak-proxy/actions/runs/37110778012)（成功。CI の unit は 1036 + 73 passing / 1 pending（Windows 専用テスト）、smoke 4 passing、`otak-proxy-3.2.15.vsix`（161 files, 643.11 KB））

### Codex 指摘 3 件（PR #99、a9ab986 へのレビュー）

| 指摘 | 症状 | 根本原因 | 修正 |
| --- | --- | --- | --- |
| P1 TLS | `https:` proxy で証明書・プロトコルが失敗しても Auto: OFF が外れる | TLSSocket は TCP 接続の時点（ハンドシェイク前）に `connect` を出す。`proxyConnected` が立ち、判定が alive になった | `trackProxyConnect` は TLSSocket では `secureConnect` を待つ |
| P2 URL の書き方 | 大文字のホスト名や既定ポート付きで同じ proxy が届くと、テストなしで Auto: OFF が外れる | 前回と今回の URL を文字列で比べ、新しい endpoint と見なした | `proxyUrlIdentity()` で比べる。保存だけの経路で検出した書き方も保存する |
| P2 回復の公開順 | 回復の apply が終わる前に、他のウィンドウへ `autoModeOff: false` が公開される | 回復だけが「保存して公開 → apply」の順だった | 他の apply 経路と同じく `convergencePending: true` で保存 → apply → 解除して公開。共通部分を `clearPendingThenPublish` に抽出 |

### Verification

| 項目 | 結果 |
| --- | --- |
| 実装前の新規・変更テスト | 16 failing（red） |
| 対象 3 ファイル | 94 passing |
| ミューテーション（新しいガード） | 9 件中 9 件 killed（1 件目の生存は toggle テストの assert を `notCalled` に強めて kill） |
| Codex 再レビュー（795c1bd） | 「Didn't find any major issues」（08:17Z） |
| CodeRabbit | 590a469 まで指摘なし。795c1bd は 1 時間 1 回の枠切れでレビューなし |
| リリースゲート（`chore/97-release-3.2.15`、2 回目） | lint pass / unit 1036 + 74 passing、0 failing / smoke 4 passing / unicode:dist clean（294 files） |
| 拡張ホスト（795c1bd） | 502 passing / 1 pending / 9 failing（既知の baseline）。同じコードで 2 回、集計なしの途中終了 |
| リリース前チェック（CLAUDE.md の MUST） | v3.2.14..v3.2.15 の追加行に個人情報らしき文字列なし（ホストは example.com / 127.0.0.1 / .invalid / 公開サイトだけ）。新しい author / committer ID なし。PUBLIC。LICENSE（MIT）あり |
| VS Marketplace | API で 3.2.15 を確認（08:54:32Z。`lastUpdated` 08:54:14Z、upload 08:48:35Z から約 6 分。08:53:40Z の時点ではまだ 3.2.14） |
| Open VSX | API で 3.2.15 を確認（08:52:33Z。`timestamp` 08:48:38Z、約 4 分。08:51:22Z の時点ではまだ 3.2.14） |
| 公開された README | 両レジストリの 3.2.15 の README は同一（31,370 bytes）。vsce が `LICENSE` への相対リンク 2 か所を GitHub の URL に書き換えた以外は v3.2.15 の README と同じ。TLS の追記（`must also finish the TLS handshake`）も入っている |

### 1 回目の unit ゲートの失敗（#97 の外）

- 症状: `GitConfigLocking.aba` の「a slow holder does not release a lock it no longer owns」が `FileLeaseTimeoutError: Timed out acquiring Git config mutex` で失敗し、`--bail` で 965 passing のまま止まった。失敗したのは `await first`（compiled の 100 行目）。最初の保持者が 35 秒（`CONFIG_COMMAND_TIMEOUT_MS * 2 + 5_000`）以内にロックを取れなかった。
- 原因（仮説、未証明）: Git config のミューテックスは `os.tmpdir()/otak-proxy.gitconfig.mutex` の 1 ファイルで、parallel の全 worker が実物の git 書き込みで共有している（`ConfigManagers.crossplatform` / `ConfigWriteVerification` / `ErrorCases` / `security` など 14 ファイル）。他の worker が 35 秒保持したか、取り合いで負け続けた。この suite の teardown は他の worker のロックも無条件に unlink する。
- 根拠: 単体では 5 回中 5 回成功（各 0.2 秒弱）。全体の再実行は成功。`FileLease` / `GitConfigLocking` は `c885f9d` 以降変更なし。
- 対応: リリースは続行した。PR #100 の本文とリリースコミットに記録した。follow-up の候補（ミューテックスのパスをテストごとに隔離する。task_952fbe6c の `ConfigManagers.crossplatform` の hermetic 化と同じ系統）。

### Learning

1. Codex の再レビュー結果は、新しい issue comment「Codex Review: Didn't find any major issues」と「**Reviewed commit:** `<sha10>`」で届く。要約表のコメント（`codex-pull-request-review-summary`）は最初のレビュー時に作られて上書きされるので、`created_at` で探しても新しい結果は見つからない。待機スクリプトは「最後の codex comment に `Completed` と sha」の両方を要求したため、結果を見落として TIMEOUT になった。判定は「Reviewed commit」の sha で行う。→ rules.md「レビューボット」
2. 共有の一時ファイルに依存するテストは、parallel lane で他のファイルと競合しうる。ゲートの失敗が差分の外なら、単体での再現と全体の再実行の両方を記録してから進む（再実行の成功だけを根拠にしない）。→ 既存の rules.md「検証・回帰」の範囲。新しいルールは追加しない。

### 残留リスク

- TCP 接続を受けるが中継できない proxy は alive と判定する。
- テストが何も証明しない新 endpoint は適用する（#67 の規則）。
- `https:` proxy の成功側（TLS ハンドシェイクが通る場合）はテストしていない（証明書と鍵をリポジトリに置く必要がある）。
- 実ネットワーク・実 VPN 切替では未確認。
- 拡張ホスト lane の集計なしの途中終了（原因不明）。unit lane の `GitConfigLocking.aba` と `ConfigManagers.crossplatform` の flake。
- 未修正: 同じ URL の split 変化と、同じチェックのテストが重なると proxyChanged が stale になる（#93 の経路）。

## 2026-10-03 — #102 同じ URL の split 変化が、同じチェックのテストで捨てられる不具合の修正（PR #104）

**Issue**: [#102](https://github.com/tsuyoshi-otake/otak-proxy/issues/102)
**PR**: [#104](https://github.com/tsuyoshi-otake/otak-proxy/pull/104)（マージ済み、merge commit `025a49b`）
**コミット**: `6757708`（fix/102-split-change-same-check、基準 `2867a78`）

### 症状

- 主 URL が同じまま、scheme 別の HTTPS URL か bypass リストだけが変わったチェックで、同じチェックが接続テストか reachability の反転も出すと、変化が保存も適用もされない。前の HTTPS URL / bypass が残り、同じチェックで Auto: OFF から戻ると古い routing が適用される。

### 原因

- モニタは proxyTestComplete → proxyStateChanged → proxyChanged の順に出す。先の handler のコミットが revision を進め、proxyChanged が世代フェンスで stale として捨てられた。
- モニタはチェックの時点で新しい routing を記録済みなので、次のチェックでも変化として報告しない。変化は失われたままになる。
- #97 で入れた「別 endpoint のテスト完了は stale」は主 URL の比較なので、同じ URL の split 変化には効かない。

### 修正

- モニタは、proxyChanged を出すチェックのテスト結果と反転イベントに `ReportedProxyChange { startedGeneration, routing }` を付ける。付けるのは世代フェンスがあり、変化を報告するチェックだけ。
- `isLeftToProxyChange`: 印があり、その世代がまだ新しく（proxyChanged がフェンスを通る）、routing が保存値と違うときだけ、先の handler は proxyChanged に任せる。それ以外は従来どおり。
- proxyChanged はテスト結果を持っているので、判定と routing を一緒に適用する。印は `stripGeneration` で外してから保存する。保存だけの分岐は status bar を更新するようにした。
- 通知の変化（PR と CHANGELOG に明記）: この経路は system proxy の変化として適用され、"Proxy configured" と "System proxy changed"、unreachable なら "Proxy disabled" が出る。Auto: OFF からの回復は無音で古い値を適用していた。

### Verification

| 項目 | 結果 |
| --- | --- |
| 修正前の新規 flow テスト | 4 failing、11 passing（red、4 件とも #102 suite） |
| `AutoModeOffVerdict.flow`（修正後） | 15 passing |
| `ExtensionProxyEventHandlers` + `ProxyMonitor` | 121 passing（新規 9 + 3） |
| ミューテーション（compiled JS） | 13 件中 13 件 killed |
| `npm run lint` / `test:smoke` / `lint:unicode:dist` | pass / 4 passing / clean |
| `npm run test:unit:parallel` | 1055 + 74 passing、0 failing |
| `npm test`（拡張ホスト） | 502 passing、1 pending、9 failing（基準と同じ 9 件） |
| 独立 verifier（rubric 9 項目） | 9/9 pass |
| テストランナーの残存プロセス | なし |

### Learning

1. 先のイベントが後のイベントを stale にする問題は、主 URL だけでなく split（HTTPS URL・bypass）でも起きる。先のイベントに「後のイベントが運ぶ変化」の印を付け、後のイベントがフェンスを通るときだけ任せる → rules.md「世代フェンス」の既存ルールに追記。
2. 任せる条件には「印の世代がまだ新しい」を必ず入れる。入れないと、後のイベントが stale で捨てられたとき、先のイベントも何もしないので判定が両方から消える（ミューテーション M1 で確認）。

### 残留リスク

- scheduler のテストがチェック開始から proxyChanged までの間にコミットすると、proxyChanged はまだ stale になる（scheduler の結果には印がない。`pollingInterval > connectionTestInterval` のときだけ）。
- 先の handler と proxyChanged の間に toggle / sync がコミットすると、判定は stale のイベントと一緒に消える。状態はその writer のもの。Off で何も有効にならないことはテストで固定した。
- 実ネットワーク・実 VPN 切替では未確認。

## 2026-10-03 — #103 unit lane の parallel worker ごとに tmpdir と Git / npm 設定を分ける（PR #105）

**Issue**: [#103](https://github.com/tsuyoshi-otake/otak-proxy/issues/103)
**PR**: [#105](https://github.com/tsuyoshi-otake/otak-proxy/pull/105)（#104 の後にマージ）
**コミット**: `e42121e`（fix/103-unit-worker-isolation、基準 `2867a78`）

### 症状

- v3.2.15 の 1 回目の unit ゲートで `GitConfigLocking.aba` の slow-holder テストが `Timed out acquiring Git config mutex` で失敗した（単体では 5/5 成功、全体の再実行も成功）。
- `scripts/run-unit-tests.mjs` は hermetic ディレクトリを消さないので、unit 実行ごとに system temp に `otak-proxy-unit-*` が 1 つ残っていた（この時点で 33 個）。

### 原因

- Git config の mutex は `os.tmpdir()/otak-proxy.gitconfig.mutex` の固定パスで、parallel の全 worker が同じ tmpdir と同じ hermetic gitconfig / npmrc を使っていた。実物の git で書く worker 同士と、インストール済みの拡張がこの 1 ファイルを取り合い、ABA suite はこのファイルを unlink・上書き・mtime 変更する。
- probe（`scripts/fixtures/unit-isolation/`）で確認した: 修正前は 2 worker（別 pid）が tmpdir、mutex パス、gitconfig、npmrc をすべて共有していた。

### 修正（テスト基盤のみ、`src/` は無変更）

- `scripts/lib/unit-mocha.mjs` の `runUnitMocha()`: run ディレクトリを作って hook に渡し、mocha 終了後に結果に関係なく消す。
- `scripts/unit-worker-isolation.cjs`（mocha `--require`、shim より前）: プロセスごとのディレクトリを作り、`TEMP` / `TMP` / `TMPDIR` / `GIT_CONFIG_GLOBAL` / `NPM_CONFIG_USERCONFIG` / `npm_config_userconfig` を向ける。root が無ければ何もしない（直接の mocha 実行は従来どおり）。
- 後片付けは runner が持つ。`--bail` は worker pool を強制終了するので、worker の exit handler は当てにならない（Issue の提案「worker が終了時に消す」からの変更、PR に明記）。
- `npm run test:unit:isolation` を追加し、`test:mvp` に組み込んだ。CLAUDE.md の Testing に隔離と範囲外（直接 mocha、拡張ホスト lane）を書いた。

### Verification

| 項目 | 結果 |
| --- | --- |
| hook 前（runner の純粋な抽出のみ）の検査 | 9 failures（tmpdir・mutex・gitconfig・npmrc 共有、run ディレクトリ残留） |
| hook 後の検査 | pass（2 worker） |
| ミューテーション（隔離の壊し方 8 通り） | 8/8 で検査が失敗 |
| `npm run test:unit:parallel` × 3 | 各回 1036 + 74 passing、0 failing、mutex timeout なし |
| `GitConfigLocking.aba` | 3/3 pass（slow-holder 62〜77 ms） |
| `otak-proxy-unit-*` の数 | 各回の前後で 33 のまま |
| `npm run lint` | pass |
| テストランナーの残存プロセス | なし |
| 独立 verifier（rubric 10 項目） | 10/10 pass（M8 は共有の検出ではなく mocha の異常終了で kill） |

### Learning

1. mocha `--parallel` の worker は `--require` を読む。プロセスごとの環境（tmpdir・設定ファイル）はここで分けられる。モジュール読み込み時に `os.tmpdir()` を固定する定数（`GIT_CONFIG_MUTEX_PATH`）も、hook がテストモジュールより先に動くので worker ごとになる。
2. worker の後片付けは exit handler に置かない。`--bail` は pool を強制終了する。親（runner）が run ディレクトリを `finally` で消す。
3. 「worker ごとに分かれている」は、別 pid の 2 worker が実際に何を見たかを probe で記録して確かめる。1 worker で 2 ファイルを走らせた結果では何も比べられないので、pid が 2 つあることも検査の条件にする。

### 残留リスク

- 拡張ホスト lane と直接の mocha 実行は system temp のままで、mutex パスは共有のまま。`scripts/assurance` の runner も未変更。
- 過去の実行が残した `otak-proxy-unit-*`（33 個）は消していない（ユーザーの判断待ち）。
- 隔離の検査は system temp の `otak-proxy-unit-*` を前後で比べるので、別の unit 実行と同時に走らせると誤って失敗する。

## 2026-10-03 — v3.2.16 リリース（#102 の split 変化の修正を公開、#103 のテスト基盤を同梱）

**Issue**: [#102](https://github.com/tsuyoshi-otake/otak-proxy/issues/102)、[#103](https://github.com/tsuyoshi-otake/otak-proxy/issues/103)（どちらも `Refs`、#104 / #105 の merge でクローズ済み）
**PR**: [#106](https://github.com/tsuyoshi-otake/otak-proxy/pull/106)（3.2.16 のリリース）
**Commits**: `a5ea926`（`chore(release): v3.2.16 (#102)`）
**Merge commit**: `1d627d3`（#106）
**Tag**: `v3.2.16`（`1d627d3`、annotated / `Release v3.2.16`）
**CI run**: [37119143768](https://github.com/tsuyoshi-otake/otak-proxy/actions/runs/37119143768)（成功）

### 内容

#102（主 URL が同じままの scheme 別 HTTPS URL / bypass の変化が、同じチェックの接続テストか reachability の反転と重なると捨てられた不具合）の修正と、その通知の変化を公開した。#103 は unit lane のテスト基盤だけで、VSIX の中身には影響しない。リリースコミットは `CHANGELOG.md` / `package.json` / `package-lock.json` の 3 ファイルだけ。README は v3.2.15 から変更なし。

### リリース前チェックの結果（CLAUDE.md の MUST）

| 観点 | 結果 | 対応 |
| --- | --- | --- |
| tracked files の個人情報らしき文字列 | v3.2.15..v3.2.16 の追加行（`package-lock.json` を除く、21 files）のホストは github.com と example.com 系だけ。メールアドレス・UUID・ローカルのユーザーパス・トークン・社内向け IP の一致なし | — |
| コミット履歴の author / committer | v3.2.15..main は既存の ID（`otak@odangoo.com` の 2 表記）と GitHub の merge コミットだけ。新しい ID なし | 書き換えない（2026-10-03 の決定） |
| 公開設定・タグ・リリース | PUBLIC。タグは v3.2.15 まで。GitHub Release の最新は v3.2.9 | 先例に合わせ GitHub Release は作らない |
| LICENSE | MIT あり | — |

### Verification

| ゲート | ローカル (Windows) | CI (Ubuntu, run 37119143768) |
| --- | --- | --- |
| `npm run lint` | pass (623 files scanned) | pass (607 files scanned。差の 16 は未追跡の PBT evidence JSON) |
| unit | 1055 + 74 passing / 0 failing | 1055 + 73 passing / 1 pending（Windows 専用テスト） |
| `npm run test:smoke` | 4 passing | 4 passing |
| `npm run lint:unicode:dist` | pass (294 artifacts) | pass (294 artifacts) |
| `vsce package` | — | `otak-proxy-3.2.16.vsix` (161 files, 643.8 KB) |
| VS Marketplace | `extensionquery` で 3.2.16 を確認（11:25:42Z。`lastUpdated` 11:25:30Z、upload 11:19:40Z から約 6 分。11:24:40Z の時点ではまだ 3.2.15。版別アセットは 11:20:33Z から 200（学び 1）） | `Published odangoo.otak-proxy v3.2.16.`（11:19:40Z） |
| Open VSX | API で 3.2.16 を確認（11:23:08Z。`timestamp` 11:19:42Z、約 3.5 分。11:22:37Z の時点ではまだ 3.2.15） | `Published odangoo.otak-proxy v3.2.16`（11:19:42Z） |

extension-host lane は #104 で #102 のコードに対して実行済み（502 passing / 1 pending / 9 failing、9 件は既知の baseline）。版上げだけのこの PR では再実行していない。unit ゲートの前後で system temp の `otak-proxy-unit-*` は 33 のまま（#103 の後片付けが効いている）、mutex timeout なし。テスト後の runner プロセス残存 0 件。

### Learning

1. Marketplace の版別アセット（`.../extension/otak-proxy/3.2.16/assetbyname/Microsoft.VisualStudio.Services.Content.Details`）は upload から 1 分以内（11:20:33Z）に 200 を返したが、拡張の検索 API（`extensionquery`）の最新版は 11:25:42Z まで 3.2.15 のままだった。版別アセットの 200 は公開の証拠にならない。公開の判定は `extensionquery` の `versions[0].version`（と `lastUpdated`）で行う。→ rules.md「リリース」
2. 新しく学んだ失敗はほかになし。rules.md「リリース」の手順（3 ファイルのリリースコミット、annotated タグ、CI との件数差 lint 16 / unit 1 pending、レジストリ API での確認）でそのまま通った。
3. #103 の後、v3.2.15 の 1 回目のゲートで出た `GitConfigLocking.aba` の mutex timeout は、このリリースのゲートでは出なかった（1 回の観測で、再発しないことの証明ではない）。

### 残留リスク

#102 / #103 のエントリの残留リスクがそのまま公開された:

- scheduler のテストがチェック開始から proxyChanged までの間にコミットすると、proxyChanged はまだ stale になる（`pollingInterval > connectionTestInterval` のときだけ）。
- 先の handler と proxyChanged の間に toggle / sync がコミットすると、判定は stale のイベントと一緒に消える。
- 拡張ホスト lane と直接の mocha 実行は system temp の mutex を共有したまま。過去の実行が残した `otak-proxy-unit-*`（33 個）は未削除（ユーザーの判断待ち）。
- 実ネットワーク・実 VPN 切替では未確認。

## 2026-10-18 — 全体監査（バグバウンティ形式、HEAD d4f59a5 / v3.2.16、コード変更なし）

### 症状

依頼は「この拡張の不具合や改善点を探す」。6 分野（セキュリティ、並行性と同期、設定 writer、検出と接続テスト、UI とコマンド、ビルドとサプライチェーン）を sonnet エージェント 6 体で並行に調べ、上位の主張は自分で再現した。#108（2026-10-17 22:41Z 起票、このセッションの外）と重複する指摘は除いた。

### 原因（確定したもの）

1. **トグルが mode を保存しない（Critical）。** `ToggleProxyCommand.ts:280` のガード `isStaleGeneration(started, latest) && latest.mode !== state.mode` が、apply 自身の結果コミット（revision +1）を他 writer の変更と取り違え、`saveProxyState` を飛ばす。Off→Auto は git / npm / VS Code に書くが、保存 mode は off、ステータスバーも OFF、モニタは起動しない。Auto→Off も逆向きに同じ。open #78「トグル 1 回後も Proxy: Off のまま設定が残る」の直接原因。14bbc08（#17、v3.2.7 以降）。同じ取り違えが `InitialSetupFlow.ts:55`（初回セットアップの回答が捨てられ、二度と聞かれない）と `extension.ts:377`（起動時 apply が毎回 3 回走る）にもある。
2. **末尾 `/` 付きの proxy URL を拒否する。** `ProxyHost.ts:66` が `/ ? #` を含む authority をホスト名エラーにし、`http://proxy:8080/` の検出は「proxy なし」になる（ログ 1 行だけ）。`_` を含むホスト名、生の `%` を含むパスワードも同じ。
3. **接続テストの CONNECT が VS Code の proxy パッチを通る。** `ProxyConnectRequest.ts:36-41` の `http.request` は拡張ホストで @vscode/proxy-agent に包まれる（`http.proxySupport` 既定 `override`）。proxy 自身の URL も `http.proxy` → env → OS の proxy 経由になり、ECONNREFUSED は errno の無い "Failed to establish a socket connection to proxies" に変わって `unknown` 判定になる。Auto: OFF に入る唯一の入力 `unreachable` が出ない。別の proxy を経由した場合は判定を誤り、テスト対象の認証情報を経由先へ送る。
4. **`http.proxy` は local window で APPLICATION scope。** Settings Sync の既定除外は MACHINE / MACHINE_OVERRIDABLE / ignoreSync だけなので、同期される（Off の `''` も同期される）。remote window では USER 書き込みが local の settings.json に入る。
5. **パスワードが UI とログに出る。** git の失敗時、Node のメッセージ "Command failed: git config ... <URL>" を `GitConfigErrorClassifier.ts:43,82` がそのまま返し、エラー通知とステータスバー tooltip（`StatusBarDisplay.ts:43` → `StatusBarTooltip.ts:27`）に平文で出る。`DOMAIN\user:pw@host` 形式は `InputSanitizer.maskPassword` を素通りし、Output channel に出る。
6. **その他。** invisible-Unicode スキャナは NUL 1 バイトでファイルを丸ごとスキップし、U+3164 を検出しない。v3.2.1 は workflow_dispatch（767b736）で公開され、後のタグ v3.2.1（b198755）の run は "already published" で success になった。数値設定に文字列を入れると monitor が 1 ms 間隔で空回りし、検出が止まる。

### 修正

なし（調査のみ。`src/` は無変更）。issue の起票はユーザーの判断待ち（公開 repo なので、セキュリティ項目は private advisory を推奨）。

### Verification

- トグル: 本物の `ProxyStateManager` / `ProxyApplier` / `createFencedApply` / `executeToggleProxy`（writer と notifier だけ stub）で、Off→Auto は `persisted off rev1 -> off rev2 | success=true | statusBar ["off"] | monitorStarts=0 | writes vscode/git/npm.setProxy`。Auto→Off は `auto -> auto`、writes は unsetProxy 3 件。2 体のエージェントが独立に同じ結果を出した。
- 末尾 `/`: `HTTP_PROXY=http://proxy.corp.com:8080/` で `detectSystemProxyWithSource()` が `null`。`/` なしでは検出する。
- proxy-agent: VS Code 1.106.3（proxy-agent 0.36.0）と 1.141.0（0.45 系、`node_modules.asar`）のソースで `useProxySettings`、`isLocalhost`（localhost と 127.0.0.1 だけ除外）、失敗時の例外文言を確認した。`http.proxySupport` の既定は両方 `override`。拡張ホスト内では未実行（エージェントが VS Code の proxy-agent を Node で読み込んで再現した）。
- Settings Sync / remote: 1.141.0 の workbench で `scope:s?1:2`（`G8o(s=!0,o=!0)`）、除外の述語 `ignoreSync||i===2||i===7`、remote の USER 書き込み先 `if(i===2||i===7||i===3)return 2 ... return 1`（USER_LOCAL）を確認した。実 Settings Sync と実 remote では未実行。
- パスワード表示: 壊れた `.gitconfig` で git 書き込みを失敗させ、通知文字列にパスワードが含まれることを確認した（自分とエージェントで計 2 回、エージェントは実 git）。
- スキャナ: `String.fromCodePoint` で作ったフィクスチャで、NUL ありは exit 0 で「1 skipped as binary」、NUL なしは exit 1。
- リリース: `gh run view 30320482241`（dispatch、767b736、Published v3.2.1）と `30602322737`（tag v3.2.1 = b198755、"already published. Skipping"、success）。
- 隔離: git / npm を呼ぶ再現は `GIT_CONFIG_GLOBAL` / `NPM_CONFIG_USERCONFIG` / `OTAK_PROXY_LOCK_DIR` を scratchpad に向けた。テスト runner は使っていない。

### Learning

1. 「自分のコミットの後のガードは committedRevision と比べる」は rules.md にあったが、toggle、初回セットアップ、起動ループの 3 箇所は直っていなかった。コマンドのテストは revision を進めない stub context を使うので、全テスト pass のまま出荷された。→ rules.md「世代フェンス」
2. VS Code の `http.proxy` は local window で APPLICATION scope で、Settings Sync で同期される。remote window からの Global 書き込みは local の settings.json に入る。エージェントの 1 体は scope 1 を machine と読み違えて「同期されない」と結論した。VS Code の挙動を前提にする判断は bundle の実コードで確かめる。→ rules.md「VS Code ホストの前提」
3. 拡張ホストの `http` / `https` は proxy-agent でパッチされ、loopback の fake はこれを通らない（localhost / 127.0.0.1 は DIRECT）。接続テストの判定は、テストと本番で別の経路を通る。→ rules.md「VS Code ホストの前提」
4. #108 は監査の途中に外部で起票された。起票の直前に open / 直近の issue を取り直して重複を除く。

### 残留リスク

- トグル不具合は実 VS Code ホストでは未実行（モジュール単位で本物の部品を使用）。#78 の報告症状とは一致する。
- Settings Sync、Remote-SSH / WSL、マルチユーザー Linux、macOS / Linux の platform 検出は未実行。
- 接続テストの経路は VS Code の proxy-agent を Node で動かした再現だけで、拡張ホスト内では未実行。

### 追記: Issue への反映（同日）

- ユーザーの指示（「Issue更新して」）で、#78 に直接原因のコメント（https://github.com/tsuyoshi-otake/otak-proxy/issues/78#issuecomment-6243068785）、#108 に追加指摘 7〜16 のコメント（https://github.com/tsuyoshi-otake/otak-proxy/issues/108#issuecomment-6243069914）を投稿した。#108 は公開のセキュリティレビュー Issue なので、セキュリティ項目も載せた。個人情報に近い文字列の指摘（Snyk の org ID、evidence のホスト名とユーザーパス）は公開 Issue に書いていない。
- #108 の本文と既存コメントでは、作成時の文字コード変換で `—` と範囲の `〜` が `?` になっていた（本文 7 箇所、コメント 15 箇所）。API で取り直した本文が読んだときと同じであることを確かめてから PATCH で直し、取り直して期待値と一致することを確認した。`??` 演算子の 2 文字は残した。
- Verification: 投稿した 2 件のコメントを API で取り直し、下書きと完全に一致した（末尾の改行だけ正規化）。
- Learning: Windows で gh に本文を渡すときは、UTF-8 のファイルを `--body-file` / `--input` で渡し、投稿後に API で取り直して照合する。CP932 に無い文字（`—`、`–`、`〜`）が `?` に化けた実例が #108 にあった（化けた経路は未確認）。

## 2026-10-18 — #78 トグルが選んだ mode を保存しない不具合の修正（#108 項目 7、PR #109）

**Issue**: [#78](https://github.com/tsuyoshi-otake/otak-proxy/issues/78)（#108 の項目 7）
**PR**: [#109](https://github.com/tsuyoshi-otake/otak-proxy/pull/109)
**コミット**: `6be1d00`（fix/78-toggle-saves-mode、基準 `d4f59a5`。監査記録 `ae30516` も同じブランチ）
**分担**: 実装は Devin（tmux の隣のペイン）。レビュー、検証、コミット、PR は Claude Code。

### 症状

- Off → Auto で Git / VS Code / npm に proxy を書くが、保存される mode は `off` のまま。ステータスバーも Off で、モニタは起動しない。Auto → Off は proxy を消すが `auto` のまま。ウィンドウを再読み込みすると古い mode に戻る（v3.2.7、14bbc08 以降）。
- 初回セットアップの質問を表示している間に、起動時の apply の結果コミットが入ると、回答が捨てられる。`hasInitialSetup` が立つので、二度と聞かれない。
- 起動時の apply が、起動のたびに最大 3 回走る。

### 原因

- 3 箇所とも revision を identity として比べていた。apply は自分の結果を per-target でコミットして revision を進める。そのため、トグルのガード、初回セットアップの署名、起動ループの署名が、自分の書き込み（または revision だけを進める書き込み）を他 writer の変更と取り違えた。
- トグルは apply の後に保存していたので、apply 中の診断はトグル前の mode を読んだ（#78 の仮説 2）。ガードとは独立した不整合。

### 修正

- トグルは apply の前に、目的の状態を `convergencePending: true` で `commitProxyState`（revision 付きの CAS）にコミットする。
  - コミットする状態は、最新の保存値に、トグルが変えたフィールドだけ（`changedToggleFields`）を重ねたもの。
  - CAS が失敗したら最新値に重ね直し、最大 3 回まで試す。superseded にするのは、他 writer が mode を変えたときだけ。
- Off は apply の前にモニタを止め、Auto は apply の後に始める。
- apply の後は `clearPendingThenPublish` が、論理 identity が目的のままのときだけ flag を外して publish する。この関数は `ExtensionProxyEventHandlers` から `src/core/ApplyConvergence.ts` へ、変更なしで移した（owner `'toggle'`）。
- `CommandContext` に `commitProxyState` と `publishProxyState` を追加した。
- `setupStateSignature` と起動時の署名から `revision` を外した。起動ループは `src/core/StartupEnforcement.ts` の `reconcileStartupProxyApply` に移し、unit lane でテストする（`getActiveProxyUrl` は引数で受け取る）。拡張の export は変えていない。
- CHANGELOG に Fixed を 4 件書いた。古い版が保存 mode を食い違わせたままにした場合は、更新後に 1 回トグルすれば合う、とも書いた。

### Verification

| 項目 | 結果 |
| --- | --- |
| 修正前のロジック | 起動ループのテストは `3 !== 1`。初回セットアップのテストは `manualProxyUrl` が `undefined`。generation suite は元のガードで red |
| ミューテーション | 次の 4 件とも、#78 のテストが少なくとも 1 件 red になる: CAS の失敗で常に superseded、apply の後にコミット、コミット前にモニタ開始、スナップショット全体を重ねる |
| `npm run lint` | pass |
| `npm run test:unit:parallel` | 1058 + 74 passing、0 failing |
| `npm test`（拡張ホスト） | 513 passing、1 pending、9 failing（基準と同じ 9 件） |
| `npm run test:smoke` | 4 passing |
| 独立 verifier（rubric C1〜C10） | 10/10 pass |
| テストランナーの残存プロセス | なし |

### Learning

1. 目的の状態を apply の前にコミットするときは、最新の保存値に、自分が変えたフィールドだけを重ねる。スナップショット全体を重ねると、スナップショットから CAS までに他 writer が書いた検出・テスト結果を消す（ミューテーションで、回帰テスト 2 件が red になることを確認）。→ rules.md「世代フェンス」に追記した。
2. CAS の失敗を一律に superseded にしない。revision だけを進める書き込み（apply の結果、テスト結果）は、同じ決定の下で起きる。superseded にするのは、決定のフィールド（mode）が変わったときだけ（ミューテーションで確認）。
3. 実装した側（Devin）の最初の版は、スナップショット全体を重ねていた。レビューで指摘して直させた後、この観点を rubric（C10）に加えてから独立 verifier に渡した。

### 残留リスク

- コミットの間に同じ mode の書き込みが 3 回入ると、トグルはログに警告を出して諦める。ステータスバーは保存値を表示し、apply はしない。
- Off → Auto が store からコピーする検出フィールドは、検出時に読んだ値で重ねる。その読み取りからコミットまでに入ったモニタの結果は上書きされる。
- 報告者の端末では未確認。確認したのは、本物の `ProxyStateManager` を使う generation テストまで。

### 追記: Issue の訂正コメント（同日）

- ユーザーの指示（「登録されていIssueに考慮漏れや矛盾がないかチェック」）で、#78 と #108 を `d4f59a5` で読み直した。訂正コメントを 2 件投稿した:
  - #78: https://github.com/tsuyoshi-otake/otak-proxy/issues/78#issuecomment-6243975189
  - #108: https://github.com/tsuyoshi-otake/otak-proxy/issues/108#issuecomment-6243975413
- #78 の訂正:
  - 「直接原因」を「コードで再現した原因（報告者の端末では未確認）」に改めた。
  - 症状と操作の対応を逆に訂正した。Off 表示なのに値が残るのは Off → Auto。
  - 仮説 2 はガードの帰結ではなく、独立した不整合。
  - `committedRevision` と比べる方針はトグルでは使えない（`applyProxySettings` は boolean を返す）。
  - 初回セットアップの不一致の原因は、並行する別の書き込み。
  - 受け入れ条件 6〜8 と、更新後に 1 回トグルが必要な場合の案内を追加した。
- #108 の訂正:
  - 誤り 11 件を訂正した。例: 項目番号の `#1` 形式が別の Issue に自動リンクする、git に `http.noProxy` という設定は無い、`ProxyRuntimeDiagnostics` が読むのは VS Code の `http.noProxy`、マスク漏れの範囲、接続テストは 3 本並行で約 90 秒間隔。
  - 13 段の解決順序と、それぞれの受け入れ条件を書いた。
  - 仕様の判断が必要な 2 件を分けた（検出した bypass を書き込むか、Off で手で設定した同じ値も消すか）。
- Verification: 2 件とも API で取り直し、下書きと一致した（末尾の改行だけ違う）。
- Learning: 公開 Issue で項目番号を `#1` の形で書くと、同じ番号の別の Issue / PR に自動リンクする。コメントでは code span で書くか、「項目 1」と書く。→ rules.md「ツール操作」に追記した。

## 2026-10-18 — #108 項目 8 実在する proxy URL を 1 つの正規形で受け付ける（PR #110）

**Issue**: [#108](https://github.com/tsuyoshi-otake/otak-proxy/issues/108)（項目 8、訂正コメントの A4）
**PR**: [#110](https://github.com/tsuyoshi-otake/otak-proxy/pull/110)
**コミット**: `5069155`（fix/108-proxy-url-canonical-form、基準 `f3286fe`）
**分担**: 実装は Devin（tmux の隣のペイン）。レビュー、検証、コミット、PR は Claude Code。

### 症状

- ブラウザの URL パーサが受け付ける次の URL を、拡張は不正として捨てた。検出は「proxy なし」になった。
  - 末尾の `/`（`HTTP_PROXY=http://proxy.corp.com:8080/`）
  - host 名の `_`（`http://squid_proxy:3128`、Docker のサービス名）
  - userinfo の生の `%`（`http://user:100%@proxy:8080`）
- 認証付きの split URL（`autoHttpProxyUrl` / `autoHttpsProxyUrl`）は、保存すると末尾に `/` が付き、再読み込み後の apply が `invalidProxyUrl` で止まった（A4）。
- SecretStorage との往復で、`%` を含むパスワードが壊れた。`100%` は不正な URL になり、`a%41b` は `aAb` に化けた。

### 原因

- `validateProxyAuthoritySyntax` は `http(s)://` の後ろを path ごと authority として検査し、`/` を拒否した。scheme の正規表現は大文字小文字を区別したので、`HTTP://` は authority の検査を丸ごと素通りした。
- `DNS_HOSTNAME_PATTERN` が `_` を拒否した。
- `validateCredentials` は userinfo を `decodeURIComponent` するので、16 進 2 桁が続かない `%` で例外になった。
- `InputSanitizer.removeCredentials` は `new URL().toString()` を返すので、path `/` が付く。
- `buildProxyUrlWithCredentials` は復号済みの資格情報を WHATWG の setter に渡すが、setter は `%` を encode しない。

### 修正

- `canonicalizeProxyUrl`（`src/validation/ProxyUrlValidator.ts`）は次の 4 つを行う。
  - 前後の ASCII 空白を除く。
  - scheme を小文字にする。
  - userinfo の孤立した `%` を `%25` にする。
  - ちょうど `/` だけの path を落とす。
- タブ・CR・LF は trim しない。シェルのメタ文字として拒否のまま。
- `validate` は正規形を検査し、有効なら `normalizedUrl` で返す。
- 次の取り込み口は、正規形を保存して適用する（`canonicalizeValidProxyUrl`）。
  - 検出
  - `otak: Configure Manual Proxy`
  - 初回セットアップの手入力
  - `otakProxy.proxyUrl` の変更
- `DNS_HOSTNAME_PATTERN` に `_` を加えた。IP リテラルはこのパターンに来ない。
- `buildProxyUrlWithCredentials` は、setter の前に `%` を `%25` にする。`%` を含まない資格情報では、出力がバイト単位で同じ。
- 保存済みの認証付き URL の末尾 `/` は残し、その形が検証を通るようにした。以前の版が保存した state は、バイト単位で同じまま。
- レビューで CHANGELOG を直した。Devin の版は `HTTP://` を「拒否されていた URL」に含めていた。main では、`HTTP://` は authority の検査を飛ばして受け付けられていた。

### Verification

| 項目 | 結果 |
| --- | --- |
| 修正前のロジック | 新しいテストのうち 15 件が落ちる。末尾 `/` の検出は `actual was null`、再読み込みした split state は `invalidProxyUrl` で止まる |
| ミューテーション | `buildProxyUrlWithCredentials` の `%` エスケープを外すと、資格情報のテストが 4 件落ちる（縮小した反例はパスワード `"% "`） |
| 資格情報テストの入力範囲 | fast-check 4.3.0 の `fc.string()` は ASCII だけを生成する。全 Unicode の grapheme と `%` `@` `:` `/` `?` `#` 空白に広げ、seed 固定のテストで非 ASCII と astral の code point が入ることを確かめた |
| `npm run lint` | pass（ESLint と `lint:unicode`、629 ファイル） |
| `npm run test:unit:parallel` | 1087 + 74 passing、0 failing |
| `npm test`（拡張ホスト） | 513 passing、1 pending、9 failing（基準と同じ 9 件） |
| `npm run test:smoke` | 4 passing |
| 独立 verifier（rubric C1〜C9） | 1 回目は C5 が fail（資格情報の property が ASCII だけだった）。テストを直した 2 回目は 9/9 pass |
| テストランナーの残存プロセス | なし |

### Learning

1. SecretStorage の資格情報キーは、公開 URL の WHATWG href（末尾 `/` 付き、scheme と host は小文字）の sha256。保存側（`splitProxyUrl().publicUrl`）も参照側（`getProxyPublicUrl()`）も WHATWG で直列化し直すので、state に保存する URL の綴りはキーに影響しない。レビューでは保存側だけを読んで「綴りを変えると資格情報が見つからなくなる」と書きかけた。node で 3 つの綴りを比べ、同じキーになることを確かめた。生の文字列をそのまま `getCredentialKeyForPublicUrl` に渡したときだけ、別のキーになる。→ rules.md に追記した。
2. 正規化で `String.prototype.trim()` を使うと、末尾の改行も落ちる。今まで拒否していた URL を受け付けてしまう（property test の反例 `http://proxy.com/\n`）。除くのは ASCII の空白だけにする。→ rules.md に追記した。
3. 「今まで拒否されていた」と書く前に、main のコードで確かめる。scheme の正規表現は大文字小文字を区別していたので、`HTTP://` はかえって検査を素通りしていた。→ rules.md に追記した。
4. PR を作ったら Codex の自動レビューを待ってからマージする。#109 は作成の 1 分 39 秒後にマージし、指摘 5 件はマージ後に届いた。→ rules.md に追記した。

### 残留リスク

- `validation.proxyUrl.hostnameInvalid` の文言（16 言語）は、まだ「英数字、ドット、ハイフンのみ」。`_` も通るので不正確。T11（honest UI）の locale 作業で直す。
- 大文字の scheme で保存済みの状態は、更新後の最初の検出で小文字になる。そのとき、再 apply と「システム proxy が変わった」通知が 1 回ずつ起きる。
- 認証付き URL の保存形は末尾 `/` 付きで、正規形と違う。単一の URL は復元時に `buildProxyUrlWithCredentials` が `/` を落とすので、検出結果との比較には響かない。
- 認証付き split URL の資格情報は、再読み込み後に SecretStorage から戻らない（T03）。
- split 値の片側だけが不正なとき（例 `HTTP_PROXY=http://proxy:99999`）は、その側を警告付きで捨て、HTTPS 側を両方に使う。この方針は変えていない。
- 確認したのはユニットテストと VS Code ホストのテストまで。実際の proxy では試していない。

## 2026-10-18 — #78 PR #109 への Codex の指摘 5 件を直す（PR #111）

**Issue**: [#78](https://github.com/tsuyoshi-otake/otak-proxy/issues/78)（#108 の項目 7）
**PR**: [#111](https://github.com/tsuyoshi-otake/otak-proxy/pull/111)（指摘元は [#109](https://github.com/tsuyoshi-otake/otak-proxy/pull/109) のレビュー）
**コミット**: `c85cc8c`（fix/78-toggle-followups、基準 `b961457`）
**分担**: 実装は Devin（tmux の隣のペイン）。レビュー、検証、コミット、PR は Claude Code。

### 症状（#109 のマージ後に届いた Codex の指摘、すべて P2）

- F4: CAS が 3 回とも負けると、トグルは警告をログに出すだけで success を返した。保存も apply もしないのに、ユーザーにはエラーが出ない。
- F3: Auto は `convergencePending` を外す前にモニタを起動した。`startSystemProxyMonitoring` の即時チェックが、pending のままの state をコミットして他のウィンドウへ publish できた。
- F5: トグルは、検出のときに読んだ検出フィールドをコミットにコピーした。トグルの検出の後、コミットの前に入った新しい検出（proxy B）や新しいチェック時刻を、古いコピー（proxy A）で上書きした。
- F2: 初回セットアップは、質問の前に読んだオブジェクトを丸ごと保存した。質問の間に他の writer がコミットした `lastError`、`convergencePending`、`lastTestResult`、`*Configured` が巻き戻った。
- F1: 起動時の署名に `requiresAuth` が入っていなかった。`applyStartupProxyState` は未認証の apply を飛ばす判定で `requiresAuth` を読むので、`requiresAuth` だけが変わったときに再実行しなかった。

### 原因

- 「決めた差分を最新の state に重ねてコミットする」処理の持ち主がいなかった。トグルは独自の CAS ループを持ち、初回セットアップは丸ごと保存した。
- CAS を使い切った分岐（exhausted）に、失敗という終端状態が無かった。success として返っていた。
- トグルは検出の前に読んだ state を基に決め、検出の結果は別にコピーしていた。
- 起動時の署名の項目が、`applyStartupProxyState` が読む入力と揃っていなかった。

### 修正

- `commitDecidedPatch`（`src/core/ApplyConvergence.ts`）を、決めた差分のコミットの唯一の持ち主にした。
  - 1 回の試行ごとに読み直す。最大 3 回。
  - 呼び出し側のガードが最新の state を拒否したら、何も書かずに `moved` を返す。
  - それ以外は revision 付きでコミットする。競合に負けたら、新しい state に重ね直す。
  - patch で `undefined` のキーはフィールドを消す。タイマーは使わない（重ね直しはネットワークの再試行ではない）。
- `diffProxyState` は、キーの和集合で差分を作る。決定で消したフィールドは消える。
- トグル:
  - 最初の読み取りで `fromMode` と `nextMode` を固定する。
  - 各ラウンド（最大 3）は、必要なら検出を走らせてから読み直し、そのコピーで決める。
  - コミットするのは `diffProxyState(basis, decided)` と `convergencePending: true`。ガードは「basis と同じ mode、同じ論理 identity」。
  - committed: Off はモニタを止めてから設定を消す。Auto は apply し、flag を外して publish してから、モニタを起動する（F3）。
  - moved で mode が違う: superseded（従来どおり）。moved で mode が同じ: 新しい state で決め直す（F5）。
  - exhausted、またはラウンドを使い切った: 「トグル失敗」のエラーを出し、`success: false`。何も apply しない（F4）。
- 決定が出したい通知（「manual proxy を使用」のトースト、システム proxy の設定プロンプト、manual proxy のプロンプト）は集めておき、コミットが通ったラウンドの apply の後だけ実行する。
- 初回セットアップは、決めたフィールドの差分だけを `commitDecidedPatch` でコミットする。ガードは今までの `setupStateSignature`（F2）。`commitState` の無い manager 向けの丸ごと保存は持たない。configureUrl の分岐は、保存の直前に読み直した state を保存したまま。
- `startupEnforcementTarget` に `requiresAuth` を加えた（F1）。
- 消した関数: `copyDetectedProxyState`、`changedToggleFields`、`commitToggleDesiredState`、`prepareNextMode`、`applyPreparedState`。
- CHANGELOG は、最初の #78 の項目に 1 文を足した（保存できないトグルは、黙って何もしないのではなくエラーを出す）。
- ドキュメント（ユーザーの指示「README.md やドキュメント更新も忘れずにね」）:
  - ARCHITECTURE.md のトグルの 2 つの手順は「apply → 保存」のままだった（#109 でも直していなかった）。今の順序（コミット → apply → flag を外して publish → モニタ起動、superseded / 決め直し / 失敗）に書き直した。
  - README の Troubleshooting に「Failed to toggle proxy mode」の項目を足した。

### レビューで直させた点

1. 各ラウンドで `fromMode` と `nextMode` を計算し直していた。ラウンド 1 が同じ mode の `moved` で終わった後、別のウィンドウが Auto を保存すると、ラウンド 2 は `nextMode = Off` を計算して Off をコミットし、相手の選択を打ち消した（generation suite のテスト「a mode change before a re-decide round supersedes instead of undoing it」、修正前は `false !== true`）。
2. 決定の中で通知していた。決め直すたびにトーストが出て（2 回）、失敗したトグルでも「トグル失敗」と並んで出た（テスト「the fallback toast fires once, only for the committed round」と「a failing toggle shows no fallback toast alongside the error」）。
3. 初回セットアップに「`commitState` が無ければ `saveState`」の分岐があった。本番の `ProxyStateManager` は常に `commitState` を持つので、この分岐を通るのはテストの fake だけだった。`calledOnce(saveStateStub)` を見る 3 件のテストは本番が通らない経路を検査していて、分岐は F2 を黙って戻せた。
4. 「トグル前のスナップショットとの差分」のミューテーションが、単独では green だった。identity のガードが `moved` にして吸収した。ガードが守らない範囲（同じ proxy の新しい bookkeeping）でテスト「same-identity bookkeeping committed inside the CAS window is kept」を足し、単独で red になることを確かめた。
5. ARCHITECTURE.md の最初の書き直しは、apply の通知（ProxyApplier の「proxy configured」「proxy disabled」）を落とし、入口を内部関数の名前にし、superseded を「失敗」に分類していた。

### Verification

| 項目 | 結果 |
| --- | --- |
| 修正前（main のロジック） | 新しいテストのうち 11 件が落ちる。例: `a published state carried convergencePending`、CAS を使い切った後の `success` が `true !== false`、B ではなく A が保存される、起動の再実行が `1 !== 2` |
| 修正前（この変更の最初の版） | 意図のテストが `false !== true`（トグルが Off に向きを変えた）。トーストのテストは、2 回出る、エラーと並んで出る |
| ミューテーション | 9 件とも、単独で少なくとも 1 件のテストが red になる: モニタ起動を flag の解除より前、使い切りで success、検出前のスナップショットとの差分、署名から `requiresAuth` を外す、セットアップが質問前のオブジェクトを保存、決定側のキーだけで差分、ラウンドごとに `fromMode`/`nextMode` を計算し直す、決定の中でトースト、セットアップの丸ごと保存を戻す |
| `npm run lint` | pass（ESLint と `lint:unicode`、630 ファイル） |
| `npm run test:unit:parallel` | 1095 + 74 passing、0 failing |
| `npm test`（拡張ホスト） | 526 passing、1 pending、9 failing（基準と同じ 9 件） |
| `npm run test:smoke` | 4 passing |
| 独立 verifier | C1〜C13（コードとテスト）13/13 pass。C14（ドキュメント）pass。C14 の改行コードの条件は rubric 側の誤りを直して再判定した |
| verifier の後 | テスト名の接頭辞 4 件と不要な `!` を消した。コンパイル後の `InitialSetupFlow.js` はバイト単位で同じ。コンパイル後のテストは、その 4 件のタイトルだけが違う。compile と lint は pass |
| テストランナーの残存プロセス | なし |

### Learning

1. 再試行のラウンドで、ユーザーの意図を読み直した state から計算し直さない。トグルの次の mode は今の mode から決まるので、計算し直すと向きが逆になる。→ rules.md「世代フェンス」に追記した。
2. やり直しうる決定の中で、ユーザーに見える副作用を実行しない。集めておき、コミットが通った後に実行する。→ rules.md「世代フェンス」に追記した。
3. 本番が通らない fallback 分岐は、本番の経路を検査しないテストを生む。fake に本番と同じ契約を持たせ、分岐は消す。→ rules.md「検証・回帰」に追記した。
4. ミューテーションが単独で green なら、別の層が吸収していないか調べ、その層が守らない範囲でテストを書く。→ rules.md「検証・回帰」に追記した。
5. tsc の再エクスポート（`export { x } from './y'`）は getter になる。`sinon.stub(ProxyUtils, 'testProxyConnectionParallel')` は例外を出さずに成功するが、`ProxyUtils.testProxyConnectionParallel` は本物の関数を返し続ける。定義元の `utils/ProxyConnectionTest` を stub すると、ProxyUtils 経由でも効く。Devin が報告し、sinon 21.1.2 と `out/utils/ProxyUtils.js` で確かめた。→ rules.md「外部ツールのスタブ」に追記した。
6. 「決めた差分だけを重ねる」の既存ルールを、今の持ち主（`commitDecidedPatch`）と CAS の 3 つの結果に合わせて書き直した。→ rules.md「世代フェンス」。
7. 自分の作業ミス: Devin への指示書と docs の rubric に「README と ARCHITECTURE.md は LF」と書いた。Git Bash の `grep -c $'\r$'` が 0 を返したのを信じたが、rules.md にこの grep は当てにならないとすでに書いてある。node で数えると、作業ツリーは CRLF（index は LF）。Devin の編集は CRLF を保っていた。rubric を直して verifier に訂正を送った。新しいルールは足さない（既存のルールを守る）。

### 残留リスク

- 検出とフォールバックの到達性テストは、ラウンドごとに走り直すことがある（最大 3 ラウンド）。
- configureUrl の分岐は、直前に読み直した state を丸ごと保存する。読み直しから保存までの短い窓は残る。
- `sameLogicalIdentity` は per-scheme の URL（`autoHttpProxyUrl` / `autoHttpsProxyUrl`）を比べない。コミットの窓でそれだけが変わった場合、トグルの patch は触れないので値は残るが、決め直しは起きない。
- `applyStartupProxyState` の skip 時の保存は、丸ごと保存のまま。
- 確認したのはユニットテストと VS Code ホストのテストまで。実際の複数ウィンドウでは試していない。

## 2026-10-18 — #78 PR #111 への Codex の指摘 2 件（F6、F7）を直す

**Issue**: [#78](https://github.com/tsuyoshi-otake/otak-proxy/issues/78)（#108 の項目 7）
**PR**: [#111](https://github.com/tsuyoshi-otake/otak-proxy/pull/111)（指摘は `c85cc8c` へのレビュー）
**コミット**: `9ee938a`（fix/78-toggle-followups、基準 `36c9584`）
**分担**: 実装は Devin（tmux の隣のペイン）。レビュー、検証、コミット、PR は Claude Code。

### 症状（`c85cc8c` への Codex の指摘、どちらも P2）

- F6: `commitDecidedPatch` は 3 回目の CAS に負けると、勝った state をガードにかけずに `exhausted` を返した。勝ったのが別のウィンドウのトグル（別の mode）や新しい検出（別の proxy）でも、トグルは「Failed to toggle proxy mode」を出した。本来は superseded か決め直しになる。
- F7: 初回セットアップのコミットが 3 回とも revision だけの書き込みに負けると、セットアップは黙って戻り、`performInitialSetup` が `hasInitialSetup` を立てた。ユーザーが選んだ Auto / Manual は保存されないまま、二度と聞かれなかった。

### 原因

- F6: 3 回目の負けの後に、最新の state をガードにかける読み取りが無かった。「上限まで負けた」と「他 writer が mode や proxy を変えた」を区別していなかった。
- F7: `commitSetupDecision` は boolean を返し、`exhausted` と `moved` を同じ「終わった」に畳んでいた。`askForInitialSetup` は `Promise<void>` で、呼び出し側は結果を見ずにセットアップ完了の印を書いた。保存できなかったという途中の状態が、完了という終端状態になっていた。

### 修正

- `commitDecidedPatch` は 3 回目の負けの後に `writer.getState()` でもう一度読み、ガードが拒否したら `moved`（その state 付き）、通ったときだけ `exhausted` を返す。`superseded` の結果の `current` は使わない。`ProxyStateManager.commitState` が返すのは保存値で、hydrate された資格情報を持たないことがある。`proxyUrlIdentity` は資格情報を含むので、ガードは identity が変わったと誤判定する。タイマーは使わず、試行は 3 回のまま。
- `ToggleProxyCommand` は変更なし。既存の分岐（別の mode の `moved` は superseded、同じ mode の `moved` は決め直し、`exhausted` は失敗）が、新しい結果の意味のまま正しく動く。
- 初回セットアップ: `commitSetupDecision` は `'committed' | 'moved' | 'exhausted'` を返す。`exhausted` では `error.initialSetupNotSaved` を「出力ログを確認」「ウィンドウを再読み込み」の提案付きで 1 回出し、何も apply せず、`otakProxy.proxyUrl` も書かない。`handleAutoSetup` / `handleManualSetup` / `askForInitialSetup` は `Promise<boolean>` を返し、false は `exhausted` のときだけ。`moved` は従来どおり完了扱い（別の writer が設定した）。
- `ExtensionInitializer.askForInitialSetup` は結果を返す。`performInitialSetup`（`src/extension.ts`）は true のときだけ `hasInitialSetup` を書き、false なら警告をログに出して false を返す（次の起動で再び聞く）。initializer が無い経路は変えていない。
- 新しいキー `error.initialSetupNotSaved` を 16 ロケールに足した（`error.toggleFailed` の直後）。
- ロケールのテスト「Translation values should contain no replacement or placeholder characters」を足した。U+FFFD、2 個以上続く `?`、文字に挟まれた `?` を拒否する。
- ドキュメント: ARCHITECTURE.md（トグル図の手順 5 と 7、ToggleProxyCommand の Flow の 4 と 6、ExtensionInitializer のセットアップ経路）、README の Troubleshooting（新しいメッセージの項目を「Failed to toggle proxy mode」の隣に）、CHANGELOG（#78 の 2 項目をその場で直した）。

### レビューで直させた点

1. 15 ロケールの翻訳が壊れていた。ar / hi / ko は全部の文字が `?`、ja / ru / zh-cn / zh-tw は U+FFFD の文字化け、tr / vi は一部が `?`、de / es / fr / it / pt-br はダイアクリティカルマークが落ちていた。原因は、Devin が値を書いたスクリプトを `node <<'EOF'` のヒアドキュメントで渡したこと。非 ASCII がコンソールのコードページ 932 を通って変換された。テストは全部 pass で、見つけたのはレビュー（node で値をコードポイントとして読んだ）。UTF-8 のファイルに書いたスクリプトで書き直させ、16 個すべてを UTF-8 のダンプで読んで確かめた。同じ壊れ方を検出するテストを足した（修正前の版で "ja.error.initialSetupNotSaved contains a U+FFFD replacement character" で落ちる）。
2. テストの補助関数 `activateWithStubbedApi` は何も activate しない。`stubVscodeApiAndCreateContext` に改名させ、`performInitialSetup` を型の必須メンバーにして `!` を消させた。
3. `exhausted` の説明が「basis は実際には動かなかった」だった。revision は動いている。成り立つのは「最新の state がまだガードを通る」なので、そう書き直させた（ドキュメントコメント、コードのコメント、ARCHITECTURE.md の手順 7）。
4. CHANGELOG の最初の #78 の項目の「only when the state never actually settled somewhere new」は意味が取りにくい。別のウィンドウが保存した mode や proxy は失敗ではない、と平易に書き直させた。

### Verification

| 項目 | 結果 |
| --- | --- |
| 修正前（`c85cc8c` のロジック） | 3 回目に mode が変わるコミットのテストが `'exhausted' !== 'moved'`。最後の試行のトグルのテスト 2 件とセットアップの `moved` のテストが `false !== true`。ロケールのテストは壊れた翻訳で U+FFFD を報告して落ちる |
| ミューテーション | 4 件とも単独で red: 最後の読み直しを消す（4 件）、`superseded` の `current` でガード（資格情報のテスト）、セットアップの `exhausted` を `moved` 扱い（exhausted の 2 件、"an unsaved answer must resolve false"）、`hasInitialSetup` を結果に関係なく書く（activation のテスト）。セットアップの exhausted の 2 件は、`Promise<void>` の旧契約ではコンパイルできないので、旧動作を戻す 3 番目のミューテーションを修正前の代わりにした |
| `npm run lint` | pass（ESLint と `lint:unicode`、630 ファイル） |
| `npm run test:unit:parallel` | 1098 + 74 passing、0 failing |
| `npm test`（拡張ホスト） | 533 passing、1 pending、9 failing（基準と同じ 9 件） |
| `npm run test:smoke` | 4 passing |
| 独立 verifier | D1〜D9 すべて pass。各ミューテーションを out/ のコピーで再現し、16 個の翻訳をコードポイントで読んだ |
| 翻訳 | 16 個の値をファイルのバイトからコードポイントとして読んだ。U+FFFD と `?` は無い。ar はアラビア文字、hi はデーヴァナーガリー、ko はハングル、ja はかなと漢字、ru はキリル文字、zh-cn / zh-tw は漢字。ラテン文字のロケールはダイアクリティカルマーク付き |
| テストランナーの残存プロセス | なし |

### Learning

1. CAS を使い切った後は、最新の state をもう一度ガードにかけてから失敗と判定する。読むのは `getState()` で、`superseded` の結果の `current` ではない（資格情報を持たないことがある）。→ rules.md「世代フェンス」に追記した。
2. 保存できなかった操作を完了として記録しない。結果の型で `exhausted` を区別し、完了の印は成功したときだけ書く。→ rules.md「世代フェンス」に追記した。
3. Devin のシェル経由のヒアドキュメントは非 ASCII を壊す。非 ASCII はファイルツールで UTF-8 のファイルに書かせ、確かめるときはコンソールの表示ではなく、node でコードポイントを読むか、UTF-8 のファイルに書き出して読む。→ rules.md「ツール操作」に追記した。
4. 自分の作業ミス: rules.md の「作業ツリーは CRLF」は一般化しすぎだった。`git ls-files --eol` では w/crlf 397、w/lf 191、w/mixed 25（2026-10-18）。前の項目の Learning 7 で書いた「作業ツリーは CRLF」は README.md と ARCHITECTURE.md については正しいが、全体には当てはまらない。`extensionActivationNonBlocking.test.ts` は LF のまま。→ rules.md「ツール操作」の項目を、ファイルごとの改行コードを保つ形に直した。
5. 翻訳の壊れは、lint（ESLint と `lint:unicode`）、型検査、キーの数をそろえるテストのどれでも見つからなかった。見つけたのは、レビューで node を使って値を読んだとき。→ 同じ壊れ方を検出するロケールのテストを足した（rules.md には足さない。テストが守る）。

### 残留リスク

- 検出とフォールバックの到達性テストは、ラウンドごとに走り直すことがある（最大 3 ラウンド）。
- configureUrl の分岐は、直前に読み直した state を丸ごと保存する。
- `sameLogicalIdentity` は per-scheme の URL を比べない。
- 新しいメッセージの 15 個の翻訳は、ネイティブの確認を受けていない。
- 確認したのはユニットテストと VS Code ホストのテストまで。実際の複数ウィンドウでは試していない。

## 2026-10-18 — #108 項目 1 資格情報の同意とポリシーが、書き込むすべての URL を判定する（PR #112）

**Issue**: [#108](https://github.com/tsuyoshi-otake/otak-proxy/issues/108)（項目 1）
**PR**: [#112](https://github.com/tsuyoshi-otake/otak-proxy/pull/112)
**コミット**: `de43ff6`（fix/108-credential-consent-all-urls、基準 `3e4542c`）
**分担**: 実装は Devin（tmux の隣のペイン）。レビュー、検証、コミット、PR は Claude Code。

### 症状

- scheme ごとの proxy（`HTTP_PROXY=http://proxy:3128`、`HTTPS_PROXY=http://user:secret@proxy:3128`）で、同意のプロンプト、`otakProxy.credentialTargetPolicy`、未認証スキップが判定したのは primary（資格情報の無い HTTP 側）だけだった。apply は state を読み直し、HTTPS 側の資格情報付き URL を `.npmrc` の `https-proxy` とターミナルの `HTTPS_PROXY` に書いた。プロンプトは出ず、`blockPlaintextTargets` でも止まらなかった。
- split の URL の資格情報は SecretStorage に入らず、永続化で取り除かれた。ウィンドウを再読み込みすると HTTPS 側は資格情報を失い、起動時の apply は資格情報の無い URL を書いた。
- VS Code の `http.proxy` のエコー抑止は資格情報を外した形で比べたので、資格情報だけが違う値や、資格情報を足した値を、自分の書き込みとして無視した。

### 原因

- 判定と書き込みが別々に state を読んでいた。`ProxyRemediationService` は呼び出し側の URL だけを判定し、`ProxyApplier.resolveApplyOptions` が判定の後で state を読み直して split の URL と bypass を決めた。判定した集合と書いた集合が同じだという保証が無かった。
- in-lock の再試行と収束の再試行は `{ silent: true }` だけを渡し、kind、split の URL、bypass を落としていた。applier はそれを、その時点の state から補っていた。
- split のフィールド（b3bce25、2026-09-05）は永続化のサニタイズにだけ足され、`persistProxySecrets`、`hydrateStateForRuntime`、`proxyUrlsHaveCredentials` は扱っていなかった。
- `isSelfWrittenVSCodeValue` は資格情報を外した形で比べていた。

### 修正

- `src/core/ProxyApplyPlan.ts`（新規）: 旧 `ProxyApplier.resolveApplyOptions` の規則から I/O を除いた `resolveProxyApplyOptions`、計画が書く URL の集合 `proxyApplyPlanUrls`、そのうち資格情報付きの `proxyApplyPlanCredentialUrls`。
- `src/remediation/ProxyApplyAttempt.ts`（新規）: `runProxyApplyAttempt` は state を 1 回だけ読み、その値から世代フェンス（`captureLogicalGeneration` → `createFencedApply`）と書き込み計画を作って `applyWithSafety` に渡す。`applyProxySafely`（`src/extension.ts`）はこれを呼ぶだけ。依存は remediation → core の向きだけ（`src/core` から `src/remediation` への import は無い）。
- `ProxyApplier`: `resolveApplyOptions` を削除。渡された計画をそのまま書く。
- `ProxyRemediationService`: 計画のうち資格情報付きの URL をすべて判定する。`blockPlaintextTargets` は 1 つでもあれば止め、silent の apply はスキップし、プロンプトは 1 回、承認すると URL ごとに同意を記録する。キーは従来どおり資格情報を外した URL の `publicFingerprint` なので、既存の同意はそのまま一致する。2 つの再試行は計画全体に `silent: true` を足して渡す。
- `ProxyStateManager` は split の URL の資格情報を SecretStorage に保存・復元する。`proxyUrlsHaveCredentials` は split のフィールドも見るので、`requiresAuth` も追従する。`shouldSkipUnauthenticatedApply` は計画の URL の集合を受け取り（文字列 1 つなら従来どおり）、起動時の apply と同期の受信側がそれを使う。
- `SystemProxyDetector.isSelfWrittenVSCodeValue`: 候補が適用中の URL と資格情報まで含めた正規形で一致するか、資格情報を持たずに同じ proxy のアドレスを指すときだけ、拡張自身の書き込みとして無視する。資格情報が違う値と、資格情報を足した値は検出する。
- `src/core/AppliedProxyProvenance.ts`（新規）: `appliedProxyInfoFromState` は、`extension.ts` が provider として直書きしていた対応づけ（Auto の URL と検出元、3.2.2 より前の state の fallback の規則）。本番とテストが同じ関数を呼び、検出器は `ProxyState` を知らないまま。
- ドキュメント: README（`ignoreSelfWrittenVSCodeProxy`、`credentialTargetPolicy` の `ask`）、ARCHITECTURE.md（フォルダ構成、ProxyApplier の説明、ProxyApplyAttempt の節、監視と同期のフロー）、CHANGELOG。

### レビューで直させた点

1. テストのレーン回避。`src/test/vscodeRuntime.ts` が `vscode` を再エクスポートし、`scripts/run-unit-tests.mjs` の振り分け（テストファイル中の `import/require('vscode')`）をすり抜けて unit lane に残っていた。ファイルを消させ、テストは `vscode` を直接 import する（host lane の 10 件）。
2. テストが本番の合成の写しを検査していた。テスト内の `applySafely` は `applyProxySafely` の手順を写したもので、`extension.ts` が未解決の options を `applyWithSafety` に渡しても、どのテストも落ちなかった。合成を `runProxyApplyAttempt` に移させ、本番とテストが同じ関数を呼ぶ。同じミューテーションで 6 件が red になる。
3. `V3MigrationService.findCredentialCandidates` の変更を戻させた。split のフィールドは v3 移行（29cd8c9、2026-07-04）より後に足され、永続化は当初から split の資格情報を取り除くので、保存済みの state に split の資格情報は無い。変更は、テストが資格情報付きの state を globalState に直接書いたことの埋め合わせで、primary と衝突時の優先順位まで変えていた。テストは `saveState` で state を作る。
4. Issue の再現手順そのもの（1 つの proxy、HTTPS だけ資格情報付き）がテストされていなかった。テストは 2 つのホストを使っていた。同じホストのテストを 3 件足させた（初回ウィンドウの拒否、`blockPlaintextTargets`、再読み込み後の 3 つの場面）。Devin の初稿は hydrate 済みの state から options を作り、プロンプトを通らないまま green になった（hydrate すると HTTP 側も資格情報付きになり、split にならない）。本番の検出と同じく、生のフィールドから作らせた。
5. ARCHITECTURE.md が古いままだった（フォルダ構成に新しいモジュールが無い、監視と同期のフローが `ProxyApplier.applyProxy()`）。直させた。小さな片付け（`as never`、未使用の引数、`consentKeyFor` のコメント）。README の `ask` の説明は「URL ごとに 1 回」と読めたので、「proxy のアドレスごとに 1 回、1 回のプロンプトで apply のすべての資格情報付き URL」に直させた（同意のキーはアドレス単位）。
6. エコー抑止の回帰（レビューで発見）。T03 は `isSelfWrittenVSCodeValue` を「資格情報まで含めて一致したときだけ抑止」に変えた。比較相手は provider が返す hydrate 済みの `autoProxyUrl` で、SecretStorage に同じアドレスの資格情報（手動 URL のものなど）があると資格情報付きになる。一方、検出経路は検出した URL をそのまま `http.proxy` に書く（Windows / macOS の proxy なら資格情報なし）。自分の書いた値をエコーと認識できず、`vscode` ソースの値として検出し、後で OS の proxy が変わっても拾えなくなる（#29 の再発）。out/ の probe で再現した（main は公開 URL で比べるので抑止される）。資格情報を持たない候補は、同じアドレスならエコーとして扱う規則に直させた。原因は自分の T03 ブリーフで、Issue が求めたのは「同じ proxy の別の資格情報を検出する」だけなのに、「外した資格情報も検出する」まで書いていた。
7. テスト 5（プロンプト中に state が動く）が不変条件を守っていなかった（独立 verifier が発見）。03b で seed を `saveState` に変えた結果、`getState()` は in-memory の state を返し、プロンプト中の生の `globalState.set` は見えなくなった。「applier が同意の後で state を読み直して計画を作る」ミューテーションでも green のままだった。revision を変えずに `getState()` から見える形（`getState` のスタブ）で動かさせ、同じミューテーションで red になることを記録させた。
8. provider の対応づけの置き場所。Devin は `appliedProxyInfoFromState` を `src/config/SystemProxyDetector.ts` に置き、`src/core/types` から値（`ProxyMode`）を import した。main では `src/config` から `src/core` への import はすべて型だけで、検出器は `AppliedProxyProvider` の契約を通してしか適用中の proxy を見ていなかった。state の意味（どの mode、どのフィールド、fallback の規則）は state の持ち主の知識なので、`src/core` のモジュールに移させた。

### Verification

- `npm run lint`: 0 で終了（`lint:unicode` 634 ファイル、検出なし）。
- `npm run test:unit:parallel`: 1098 + 74 passing、0 failing。
- `npm test`: 547 passing / 1 pending / 9 failing。9 件はすべて既知（ExtensionInitializer 3、SystemProxyUpdateService 1、ProxyOwnership.integration 3、FailureInjection.integration 1、ProxyRuntimeDiagnostics 1）。#108 のスイートは 7 + 3 件、エコー抑止のスイートは 13 件、すべて pass。
- `npm run test:smoke`: 4 passing。実行後、テストのプロセスは残っていない。
- fail-before（Devin のレポート）: テスト 1〜3、6、8 は修正前に red。エコーの回帰テストは T03 の規則で red（`+ 'http://corp.example.com:8080' - null`）。
- ミューテーション（独立 verifier が out/ のコピーで再実行）: applier が `getState()` から計画を作り直す → テスト 5 だけ red。未解決の options を渡す → 6 件 red。同意が primary だけを判定 → 5 件 red。split の資格情報を保存しない → 2 件 red。エコーの (b) を外す → 回帰テストが red。
- 独立 verifier（sonnet、ルーブリック 11 項目）: 1 回目は C6 が fail（テスト 5）。03d・03e の後の 2 回目は 11 項目すべて pass。
- 改行: 変更・新規の 16 ファイルはすべて CRLF で一様、`git ls-files --eol` は `i/lf`（`core.autocrlf=true`）。

### Learning

1. テストは本番の合成そのものを呼ぶ。写しを検査すると、本番の合成が壊れても緑のまま。→ rules.md「検証・回帰」に追記した。
2. テストの state は本番の書き込み経路（`saveState`）で作る。本番に存在しない state を通すためにプロダクションコードを変えない。→ rules.md「検証・回帰」に追記した。
3. `vscode` の API をスタブするテストは `vscode` を直接 import する。→ rules.md「検証・回帰」に追記した。
4. 資格情報は proxy のアドレス単位で保存・復元される。同じアドレスの URL はどのフィールドでも同じ資格情報で復元され、外した資格情報も付き直る。scheme ごとの資格情報のテストには、同じアドレスの場合を入れる。→ rules.md「資格情報と URL」に追記した。
5. 自分の作業ミス: T03 のブリーフは split の資格情報をアドレス単位の既存の保存に載せるよう指示したが、同じアドレスの場合を書かなかった。Devin のテストも 2 つのホストを使って、その場合を避けていた。再現手順に書いた値をそのままテストに使うよう、ブリーフで指定する。
6. エコー抑止の比較相手（provider が返す hydrate 済みの URL）と、実際に `http.proxy` に書いた値は一致しないことがある。検出経路は検出した URL をそのまま書く。→ rules.md「資格情報と URL」に追記した。
7. 自分の作業ミス: ブリーフに Issue の要求より強い保証（外した資格情報も検出）を書き、それが自分の書き込みを壊した。仕様は Issue の要求文から書き、強い保証を足すときは、拡張自身の書き込みがその条件に当たらないかを先に確かめる。
8. seed を `saveState` に変えると、in-memory の state がテスト中の `globalState` の書き換えを隠す。state を動かすテストは、`getState()` から見える形で動かし、ミューテーションで red になることを確かめる。→ rules.md「検証・回帰」に追記した。

### 残留リスク

- 1 つの proxy で HTTPS にだけ資格情報がある場合、再読み込み後は 3 つのフィールドがすべて資格情報付きで復元され、起動時の apply は資格情報付きの URL を全ターゲットに書く（同意の判定は通る）。次の検出が生の split との差を見つけて split を apply し直すので、起動ごとに apply が 2 回になる。scheme ごとに資格情報を分けるには、scheme ごとの資格情報の記録が要る。仕様の判断としてユーザーに確認する。
- 外した資格情報は、SecretStorage の値が消えるまで付き直る（primary は以前から、split もこの変更から）。本番で `deleteCredentialsForPublicUrl` を呼ぶ経路は無い。
- 同じアドレスで資格情報が違う 2 つの URL は区別できない。秘密の値も同意の記録も 1 つを共有する。
- VS Code の `http.proxy` から手で資格情報を外した値は、今もエコーとして無視される。拡張自身の検出経路の書き込みと区別できないため。区別するには、実際に書いた値（所有権の記録の fingerprint など）と比べる必要がある。
- テスト専用の fallback（`applyProxySettings` が無いときの `context.proxyApplier.applyProxy`）は計画も同意も通らない。本番は常に `applyProxySettings` を設定する。
- 確認したのはユニットテストと VS Code ホストのテスト（Git / npm の fake）まで。実際に認証する proxy では試していない。

## 2026-10-18 — #108 項目 1 PR #112 への Codex の指摘 2 件を直す

**Issue**: [#108](https://github.com/tsuyoshi-otake/otak-proxy/issues/108)（項目 1）
**PR**: [#112](https://github.com/tsuyoshi-otake/otak-proxy/pull/112)（指摘は `1e6572d` へのレビュー）
**コミット**: `0e776cc`（fix/108-credential-consent-all-urls）
**分担**: 実装は Devin（tmux の隣のペイン）。レビュー、検証、コミット、PR は Claude Code。

### 症状（`1e6572d` への Codex の指摘、どちらも P2）

- エコー抑止の比較が綴りに左右される。永続化は `new URL(...).toString()` で資格情報を外し、hydrate は `new URL` で URL を組み立て直す。そのため、再読み込み後の `http://user:pass@PROXY.EXAMPLE.COM:80` は `http://user:pass@proxy.example.com` として戻る。VS Code の `http.proxy` には元の綴りが残りうる（再読み込み前の書き込みや、hydrate を経ていない別ウィンドウの書き込み）。比較 (a) は `canonicalizeProxyUrl` の完全一致で、ホストの大文字小文字も既定ポートも揃えない。比較 (b) は、候補が資格情報付きなので通らない。結果として、自分が書いた値を `vscode` ソースの proxy として検出する（#29 の再発）。main は公開 URL（WHATWG で正規化）で比べていたので、この PR で入れた回帰。
- `requiresAuth` は 1 つの真偽値で、どの URL に資格情報が要るかを持たない。2 つのアドレスに資格情報がある split で、片方だけが復元される場合がある。SecretStorage への書き込みが失敗すると `storeJson` は false を返し、`persistProxySecrets` はそのまま続行する。片方の秘密だけを持つ別マシンも同じ。このとき `some` の判定が通り、もう片方のアドレスを資格情報なしで書いてしまう。

### 原因

- 永続化と hydrate を通る URL は WHATWG で正規化される。エコー判定の比較に使った正規形（`canonicalizeProxyUrl`：scheme の小文字化と末尾 `/` だけ）は、それと違った。
- 「資格情報が要るのに復元できない URL は書かない」という不変条件を、URL ごとの情報を持たない 1 つの真偽値で近似した。`some` は「計画のどれかが資格情報付き」しか見ず、資格情報が要るのはどの URL かを見ない。

### 修正

- `sameProxyUrlWithCredentials`（`src/utils/ProxyUrlIdentity.ts`）を追加した。資格情報ストアが秘密のキーに使う `splitProxyUrl` で両方を分解し、公開 URL とデコード後の資格情報が一致すれば同じ値とみなす。エコー判定の (a) をこの関数に替えた。(b) は変えていない。
- `ProxyState.authRequiredProxyUrls` を追加した。資格情報を持っていた URL フィールドの公開 URL の一覧で、userinfo は含まない。`requiresAuth` と同じく永続化と同期の対象。
  - `setRequiresAuthFromLiveUrls` はライブのフィールドから作り直す。
  - 保存と hydrate では、ライブの資格情報付き URL と既存の一覧の和を取り、どのフィールドにも残っていない URL を除く。一覧は並べ替え、空なら持たない。変更前に保存された state は 1 バイトも変わらない。
  - `shouldSkipUnauthenticatedApply` は、従来の規則（変更前に保存された state 用）に加えて、資格情報を持たない計画 URL がこの一覧に入っていればスキップする。
- 6 つの URL フィールドの一覧を `STATE_URL_FIELDS` の 1 か所にまとめた。`proxyUrlsHaveCredentials`、一覧の導出、ゲートの 3 か所がこれを読む。

### レビューで直させた点

1. 同一性の関数が `splitProxyUrl` と同じこと（公開 URL の正規化、資格情報のデコード）を自前で実装し、URL を 2 回パースしていた。秘密のキーと比較の定義がずれないよう、`splitProxyUrl` の上に作らせた。
2. README の `ignoreSelfWrittenVSCodeProxy` の説明に「再読み込みが値を書き換えても認識される」とあった。再読み込みは `http.proxy` を書き換えないうえ、3.2.16 も綴りを無視して比べていた。この文を削らせた。同じ理由で、CHANGELOG の綴りの正規化についての括弧書きも削らせた。
3. README の新しい箇条書きに「同期で別マシンから state が来た場合」とあった。同期は同じマシンのグローバルストレージを通してウィンドウ間で行うので、確実な原因（SecretStorage への保存の失敗）に替えさせた。
4. ARCHITECTURE.md が `requiresAuth` を「アドレスの一覧」と書いていた。真偽値と一覧を分けて書かせた。
5. 独立 verifier（この修正への 1 回目、通算 3 回目）の指摘: 書き込み失敗のテストはゲートの戻り値しか確かめておらず、同期の受信側を通していなかった。片方だけ復元するテストと同じく `applyRemoteSyncState` まで通し、apply されないこと、`lastError`、何も書かれないことを確かめさせた。本番の挙動は、verifier が `out/` に当てた probe で正しいと確認済み。

### Verification

- `npm run lint`: exit 0（`lint:unicode` は 634 ファイルを走査、検出なし）
- `npm run test:unit:parallel`: 1098 + 74 passing、0 failing
- `npm test`: 574 passing / 1 pending / 9 failing。9 件は既知の失敗だけ。#108 のスイートはすべて pass
- `npm run test:smoke`: 4 passing
- ミューテーション（`out/` に当てて戻した）:
  - エコー判定 (a) を `===` に戻す → 再読み込みの 2 テストが red（実装者と verifier が再現）
  - ゲートを `some` だけに戻す → 片方だけ復元の 2 テストがゲートのアサーションで red（実装者とレビュアーが再現）
  - 受信側のゲートを外す → 同じ 2 テストが受信側のアサーションで red（実装者とレビュアーが再現）
  - 一覧を永続化から外す → 2 アドレスのテストが red（実装者の報告）
- 独立 verifier（11 項目）: この修正への 1 回目（通算 3 回目）は C4 (ii) で fail（テストが受信側を通していない）。テストを直した後の 2 回目（通算 4 回目）で全項目 pass

### Learning

1. 永続化や hydrate を通る URL を、完全一致の文字列で比べない。保存側は WHATWG で正規化する（ホストの小文字化、既定ポートの除去）。比べるときも、秘密のキーと同じ分解（`splitProxyUrl`）を通す。→ rules.md「資格情報と URL」に追記した。
2. 集合への `some` で不変条件を判定するときは、その性質が集合の要素ごとに要るのかを確かめる。要素ごとに要るなら、要素ごとの情報を持つ。→ rules.md「資格情報と URL」に追記した。
3. 自分の作業ミス: 03d でエコー規則を直したとき、比較に使う正規形が永続化の正規形と同じかを確かめなかった。ルーブリックにも綴りの違いの観点がなかった。URL を比べる変更のブリーフとルーブリックには、再読み込み（永続化と hydrate）を通した値を必ず入れる。もう 1 つ、ルーブリックの「(ii) も (i) と同じ」を、レビューではテスト名と前提だけで確かめ、観測（受信側、`lastError`、書き込みなし）まで同じかを読まなかった。「同じ」と書いた条件は、アサーションを 1 つずつ突き合わせる。→ rules.md「検証・回帰」に追記した。

### 残留リスク

- 3.2.16 以前に保存された state には `authRequiredProxyUrls` が無く、従来の `some` の規則しか効かない。3.2.16 は split の資格情報を保存していなかった。そのため更新後も、split の URL が資格情報付きで検出し直されて保存されるまでは、3.2.16 と同じく資格情報なしの split URL を書きうる。
- ライブの URL から一覧を作り直す経路（検出、トグルの fallback、Auto Off）は、hydrate できなかったアドレスを一覧から外す。`requiresAuth` と同じ扱いで、そのマシンの検出結果を正とする。
- 診断（`ProxyRuntimeDiagnostics.collectCredentialIssues`）は主 URL しか見ないので、片方だけ復元された場合を報告しない。apply はスキップされ、`lastError` は記録される。
- 確認したのはユニットテストと VS Code ホストのテスト（Git / npm の fake）まで。実際の SecretStorage の書き込み失敗は試していない。


## 2026-10-18 — #108 項目 1 PR #112 への Codex の再レビューの指摘 3 件を直す

**Issue**: [#108](https://github.com/tsuyoshi-otake/otak-proxy/issues/108)（項目 1）
**PR**: [#112](https://github.com/tsuyoshi-otake/otak-proxy/pull/112)（指摘は `1330af5` へのレビュー）
**コミット**: `f6e28d1`（fix/108-credential-consent-all-urls）
**分担**: 実装は Devin（tmux の隣のペイン）。レビュー、検証、コミット、PR は Claude Code。

### 症状（`1330af5` への Codex の指摘、3 件とも P2）

- A: アドレスごとのスキップ判定（`shouldSkipUnauthenticatedApply`）は、起動と同期の受信側でしか呼ばれていなかった。監視の到達性の経路（false → true）とトグルは `runProxyApplyAttempt` を直接通るので、split の片方の資格情報だけが復元され、その片方に同意がある場合、もう片方のアドレスを資格情報なしで書いた。
- B: 起動の reconcile の署名（`startupEnforcementTarget`）は主 URL と `requiresAuth` しか比べていなかった。起動のゲートと書き込み計画が読む `authRequiredProxyUrls` と split の URL だけが最初の apply 中に変わると、最新の state でゲートを通し直さずに終わった。
- C: `ProxyApplier.applyProxyDetailed` / `disableProxyDetailed` は、結果をコミットする世代を apply の始めに `getState()` から読み直していた。fence の確認とこの読み取りの間に別のウィンドウが新しい状態をコミットすると、古い計画の結果が新しい状態に対してコミットされ、その revision の前進で新しい状態自身の fenced apply が superseded になった。

### 原因

- A: 「資格情報が要るアドレスを資格情報なしで書かない」という書き込みの不変条件を、すべての書き込みが通る関数ではなく、呼び出し元の一部（起動、同期）に置いた。
- B: ゲートに入力（一覧、split の URL）を足したとき、そのゲートを再実行するかを決める署名を更新しなかった。
- C: 計画（とその世代）を 1 回の読み取りから作る設計にしたが、結果コミットの世代だけが applier の中の 2 回目の読み取りに残っていた。

### 修正

- A1: `planUrlsMissingRequiredCredentials(state, planUrls)`（`src/utils/ProxyStateSanitizer.ts`）を追加した。資格情報の無い計画 URL のうち、公開 URL が `authRequiredProxyUrls` にあり、同じ公開 URL の資格情報付き計画 URL も無いものを、並べ替えて返す。後半の条件は、同じホストの split（資格情報が HTTPS 側にだけある、再読み込み前の state）を拒まないため。`shouldSkipUnauthenticatedApply` は、一覧がある state ではこの規則だけを使い、`requiresAuth` の集約規則は一覧の無い state（一覧の導入前に保存されたもの）にだけ残した。集約規則は 6 つの URL フィールドから導くので、手動の fallback の資格情報だけで、資格情報の無い system proxy まで拒んでいた（3.2.16 も起動と同期で拒んでいた）。
- A2: `runProxyApplyAttempt` は、計画を解決した後、同意と書き込みの前に `planUrlsMissingRequiredCredentials` を呼ぶ。足りないアドレスがあれば、警告を 1 行出し、`UNRESOLVED_LOCAL_CREDENTIAL_ERROR` を `commitUnlessStale`（読み取りの世代）で `lastError` に記録し、`proxyReachable` は変えずに `success: false` を返す。無効化は判定しない。state の引数は `StateWriter` に広げた。
- B: `startupEnforcementTarget` に `authRequiredProxyUrls` と `splitRoutingIdentity(state)` を足した。
- C: `createFencedApply` は今の fence を 4 つ目の引数 `basis` として applier に渡す。`applyProxyDetailed` / `disableProxyDetailed` は basis があればそれで `saveProxyConfigResults` / `recordApplyBlocked` をコミットし、無い直接の呼び出しだけ読み直す。有効化から無効化への委譲も basis を渡す。`DetailedApply` と `ProxyApplyDetailedDelegate` が引数を宣言し、`applyProxySafely` のラムダが渡す。`ProxyApplyOptions` に世代のフィールドは足していない（計画のまま）。
- Docs: README（スキップは監視、トグル、同期、起動のすべての apply に効く）、ARCHITECTURE.md（ProxyStateManager の記述、ProxyApplyAttempt の Gate / Basis / 起動の署名）、CHANGELOG（同意の項目を修正、結果コミットの項目を追加）。

### レビューで直させた点

1. 自分のミューテーション 7 種のうち、無効化で basis を無視するものだけが、新しいテスト 11 件と unit lane をすべて green のまま通った。有効化から無効化への委譲で basis を落とすミューテーションは、その部分集合（委譲の経路だけ読み直しになる）なので、同じく通るはずだった。`applyProxyDetailed('', false, …, basis)` で、古い basis ならコミットしない、今の basis なら `basis.revision + 1` でコミットする（陽性対照）テストを足させた。足した後は、無効化で basis を無視するミューテーションと委譲で落とすミューテーションの両方で、このテストが red になった。
2. `planMissesRequiredCredentials`（一覧の関数を真偽値にするだけの包み）を消させた。本番の呼び出しは同じモジュールの 1 か所だけで、ARCHITECTURE.md は包みの名前を書いていたが、attempt が呼ぶのは一覧の関数だった。テストは返る一覧そのものを確かめる形にした。
3. 03i の検証中、Devin の unit lane が task 04 の古いビルド出力（`out/test/security/CredentialDisplayMasking.test.js`）を拾った。このブランチにソースが無い出力なので、その 2 ファイルだけを消させた。

### Verification

- `npm run lint`: exit 0（`lint:unicode` は 634 ファイルを走査、検出なし）
- `npm run test:unit:parallel`: 1101 + 74 passing、0 failing
- `npm test`: 586 passing / 1 pending / 9 failing。9 件は既知の失敗だけ。#108 のスイートはすべて pass
- `npm run test:smoke`: 4 passing。実行後、テストのプロセスは残っていない
- ミューテーション（`npm run compile` の後、`out/` に当てて戻した。すべて red になった）:
  - attempt のゲートを外す → 3 件 red（`autoDetection`、`manual`、監視の到達性の経路）
  - 集約規則を一覧より先に置く → ゲート表の一覧ありの行が red
  - 署名から一覧を外す、split を外す → それぞれのテストが red
  - 有効化で basis を無視する → 3 件 red。無効化で無視する → 1 件 red。委譲で basis を落とす → 1 件 red。fence を渡さない → ホスト 1 件と unit 1 件が red
- 独立 verifier（sonnet、ルーブリック 14 項目 = これまでの 11 項目 + attempt のゲート、起動の署名、結果の basis）: この修正への 1 回目（通算 5 回目）で全項目 pass。新しい 3 項目のミューテーションは verifier も自分で当て、レビュアーと同じ結果だった
- 改行: main からの変更 24 ファイルはすべて CRLF で一様、index は `i/lf`

### Learning

1. 書き込みの不変条件は、すべての書き込みが通る 1 か所で守る。呼び出し元ごとのゲートは経路を漏らす。→ rules.md「資格情報と URL」に追記した。
2. 集約フラグで計画の一部についての判定をしない。→ rules.md「資格情報と URL」に追記した。
3. 結果コミットの世代は計画を作った読み取りの世代を渡して使い、applier の中で読み直さない。引数を有効化と無効化の両方の分岐に通す変更は、分岐ごとにミューテーションを当てる。→ rules.md「世代フェンス」に追記した。
4. 再実行を決める署名には、守る判断が読む入力をすべて入れる。→ rules.md「世代フェンス」に追記した。
5. 自分の作業ミス: T03 のブリーフは、ゲートを既存の置き場所（起動と同期）のまま広げ、監視とトグルの経路、起動の署名、結果コミットの世代を見落とした。3 つとも Codex が見つけた。ガードや判断の入力を足すブリーフは、守る操作への経路を `git grep` で表にしてから書く。→ rules.md「検証・回帰」に追記した。

### 残留リスク

- attempt でのスキップは `lastError` だけを記録し、`proxyReachable` は接続テストの結果のまま残す。起動と同期のスキップは従来どおり `proxyReachable: false` も記録する。
- 一覧の無い state（3.2.16 までに保存されたもの）では、集約規則は起動と同期でだけ効き、監視とトグルの apply は 3.2.16 と同じく判定しない。
- ライブの URL から一覧を作り直す経路（検出、トグルの fallback、Auto Off）は、hydrate できなかったアドレスを一覧から外す（前回の記録と同じ）。同じアドレスの資格情報の無い観測を「資格情報を外した」と読むかは仕様の判断で、最終報告でユーザーに聞く。
- 結果コミットが捨てられても、古い計画の書き込みは対象に残る。別のウィンドウの apply が後から書けば上書きされるが、書き込みの順序が逆になると、対象は古い計画の値のまま残りうる。fence の確認と書き込みは原子的でない（従来から）。
- 確認したのはユニットテストと VS Code ホストのテスト（Git / npm の fake）まで。実際の認証 proxy と SecretStorage の書き込み失敗は試していない。

## 2026-10-18 — #108 項目 5、6、11 と低の 2 件: パスワードを通知、tooltip、ログ、入力ボックスに出さない

**Issue**: [#108](https://github.com/tsuyoshi-otake/otak-proxy/issues/108)（項目 5、6、11、低の「Configure の入力ボックスの初期値」と「settings.json の `otakProxy.proxyUrl` の検証」）
**PR**: [#113](https://github.com/tsuyoshi-otake/otak-proxy/pull/113)
**コミット**: `baddb39`（fix/108-credential-redaction）
**分担**: 実装は Devin（tmux の隣のペイン）。レビュー、検証、コミット、PR は Claude Code。

### 症状

- 項目 5: `InputSanitizer` の資格情報の正規表現に `/g` が無く、1 つの文字列の 2 個目以降の `//user:pass@` が残った。scheme の無い資格情報の境界は `[\s=]` だけで、`/`、`:`、`@` の直後に空白なしで続く裸の資格情報が Output channel に出た。正規表現は `ProxySecretRedactor` にも別に定義され、境界がずれていた。
- 項目 6: `SystemProxyUpdateService` の `Using fallback proxy` と `Testing fallback proxy` のログは、マスクしていない URL を Logger に渡していた（Logger の中のマスク頼み）。
- 項目 11: git の書き込みが失敗すると、分類器が Node のエラー文（`Command failed: git config --global --replace-all http.proxy http://user:pass@…`）をそのまま返し、エラー通知、`lastError`、ステータスバーの tooltip に平文のパスワードが出た。`maskPassword` は `http://DOMAIN\user:pass@proxy:8080` を `http://domain/user:pass@…` に変え、パスワードを残した。
- 低: `otak: Configure Manual Proxy` の入力ボックスの初期値が `state.manualProxyUrl`（資格情報付き）だった。settings.json の `otakProxy.proxyUrl` の変更は検証を通らずに state に入り、同期で他のウィンドウに伝わった。
- レビュー中に見つけたもの: `ProxyStateManager.getState()` は、state に手動 URL が無いと、設定の `otakProxy.proxyUrl` を検証も正規化もせずに取り込み（`hydrateManualProxyUrl` → `normalizeConfiguredManualProxyUrl`。`migrateOldSettings` も同じ関数）、後の保存でそのまま永続化した。`extension.ts` の `migrateManualUrlFromConfig` は `getState()` の後に呼ばれるので、本番では本体が走らない。

### 原因

- 任意の文字列から資格情報を消す規則（正規表現と境界）が 2 か所（`InputSanitizer`、`ProxySecretRedactor`）にあり、片方だけが直されていた。
- エラー文が通知、`lastError`、tooltip に入る口（`ErrorAggregator`）でマスクしておらず、呼び出し元ごとのマスクに頼っていた。
- `maskPassword` は `new URL()` で解析してから userinfo を置き換える。WHATWG の解析は special scheme の `\` を `/` として扱うので、`DOMAIN\user:pass@` はパスの一部になり、userinfo として扱われなかった。
- 設定の値が state に入る経路が 3 つ（設定変更のハンドラ、`getState()` の取り込み、起動時の移行）あり、どこにも検証が無かった。

### 修正

- `ProxySecretRedactor.ts` の `maskCredentialOccurrences(text, maskUserinfo)` に、URL の資格情報と scheme の無い資格情報の正規表現（どちらも `/g`、非公開）をまとめた。置き換える文字列は呼び出し元が渡す（表示とログは `user:****@`、診断と永続化は `<credentials>@`）。scheme の無い資格情報の境界に `/`、`:`、`@`、`\` を足した。`InputSanitizer.maskPassword` と `ProxySecretRedactor.redactString` はこの関数を使う。1 つの URL の表示形式（`http://user:****@proxy:8080/`）は main と同じ。
- `ErrorAggregator.addError` が取り込むときにマスクする。Git / npm / pip の manager も返すエラーをマスクする。`ProxyConfigStateTracker` は集約した文をそのまま `lastError` にコミットし、コミット時の 2 回目の redaction（改行を `\n` の文字列に変えていた）をやめた。
- fallback の 2 つのログは、マスクした URL を渡す。
- Configure の入力ボックスの初期値は、保存された URL の資格情報の無い正規形（`tryCanonicalizeProxyUrl(publicUrl) ?? ''`）。同じ公開 URL をそのまま確定すると、保存された資格情報を残す。資格情報付きの URL は資格情報を置き換え、資格情報の無い別の URL は資格情報を持たない。保存の前に `setRequiresAuthFromLiveUrls` で `requiresAuth` と `authRequiredProxyUrls` を作り直す。
- 設定変更のハンドラは、無効な値を保存も同期もせず、既存の無効 URL のエラーを 1 回出す。有効な値は正規形で保存し、`requiresAuth` と一覧を作り直す。
- `normalizeConfiguredManualProxyUrl` は最初に `tryCanonicalizeProxyUrl` で検証、正規化する。無効な値は `''` を返し、SecretStorage にも設定にも書かない。`extension.ts` の移行は、無効な設定を起動時に 1 回、マスクした値で `Logger.warn` するだけにした（`warnOnInvalidConfiguredProxyUrl`）。検証は、ログを出さない `tryCanonicalizeProxyUrl`（`src/utils/ProxyUrlUtils.ts`）に置き、`canonicalizeValidProxyUrl` はそれに委ねてから失敗をログに出す。取り込み、起動時の警告、Configure の入力ボックスの初期値はログを出さない形を使う。
- Docs: `README.md`（Configure の入力の段落と、`otakProxy.proxyUrl` の設定の行。初期値に資格情報を出さないこと、無効な設定を拒否または無視すること）、`ARCHITECTURE.md`（起動時の確認、`getState()` の検証、設定変更のハンドラ、Configure の流れ、`***:***` をやめて実際のマスクの形式、資格情報の正規表現の持ち主が 1 か所、集約に入るときのマスク）、`CHANGELOG.md`（`[Unreleased]` の項目）。

### レビューで直させた点

1. 1 回目のレビュー（7 点）:
   - コミット時の `redactString` が改行を `\n` の文字列に変え、tooltip に `\n` がそのまま出た。取り込み時のマスクだけにし、tooltip のテストは `state.lastError` から `getStatusBarDisplay` と `buildStatusBarTooltip` を通す形にした。
   - `/g` の正規表現を export していた（`lastIndex` の状態が呼び出しをまたぐ）。関数 1 つの export にした。
   - 初期値の到達しない分岐が、資格情報付きの文字列を返す形だった。無効な値は `''` にした。
   - 設定変更のハンドラが `requiresAuth` を作り直さず、資格情報付きの URL を資格情報の無い別の URL に置き換えても `requiresAuth: true` が残った。
   - ほかに、テストの一時ディレクトリの削除漏れ、property test の実行回数の固定、起動時の移行の検証（下の 3 で誤りと分かった）。
2. 2 回目のレビュー（5 点）:
   - ミューテーションが 12 種中 2 種生き残った。取り込み時のマスクを外しても（`aggNoMask`）関連の 150 件が green だった（Git のテストは manager がマスク済みの文を渡していた）。`ErrorAggregator.addError` に未マスクの複数行の文を直接渡すテストを足させた。再確定で保存された URL を残す分岐を外しても（`keepCredsOff`）28 件が green だった（再読み込みが SecretStorage から資格情報を引き直し、`requiresAuth` も導き直す）。コマンドの直後に永続化された state の印を確かめさせた。
   - 1 回目のレビューの「起動時の移行を検証する」は、本番で到達しない分岐を直させていた（自分の作業ミス）。`out/` の probe で、`getState()` の取り込みが無効な値（`"not a proxy url"`）と非正規形（`HTTP://PROXY.EXAMPLE:3128/`）を state に入れ、後の保存で永続化することを確かめ、取り込みの関数を直させた。移行の分岐は消させた。
   - 設定の置き換えのテストが stub の `saveProxyState` に渡った値を見ていた。実際の `ProxyStateManager` の再読み込みを通す形にし、in-memory の context を作る部品を Configure のテストと共有させた。
   - ARCHITECTURE.md の「資格情報は `***:***` に置き換える」は、どのマスクも出さない形式だった。実際の形式に直させた。
3. 3 回目のレビュー（5 点）:
   - 取り込みの検証に使った `canonicalizeValidProxyUrl` は、無効な値で `Logger.error` を出す。取り込みは `getState()` のたびに走る（検出の経路の `SystemProxyUpdateService.ts` だけで呼び出しが 6 か所ある）ので、無効な設定のままだと Output channel にエラーが出続けた。2 回目のレビューのブリーフは「ここではログを出さない」と書きながら、ログを出す関数を指定していた（自分の作業ミス）。ログを出さない `tryCanonicalizeProxyUrl` を `ProxyUrlUtils` に置き、`canonicalizeValidProxyUrl` はそれに委ねてログを残す形にさせた。
   - 共有の部品の globalState が `proxyState` 以外のキーを捨てていた。v3 の移行が完了を記録できず `getState()` のたびに走り、資格情報付きの設定を移行が処理するので、取り込みの資格情報の分岐をテストが見ていなかった。本番と同じくすべてのキーを残す形にさせた。
   - 移行の経路のテストの mode の assert は、旧版の有効フラグが無いと値に関係なく成り立っていた（Property 4 がフラグ付きで両方の値を引くので、そちらに任せた）。非正規形の行は、本番の経路（手動 URL の無い保存済みの state）でも走らせた。
   - 取り込みのテストが改行の保持を確かめていなかった。入力の行の区切りが本当の改行のまま残ることを assert させた。
   - Configure の入力ボックスの初期値の計算も、ログを出さない形にした（開くたびに検証の失敗を記録していた）。
4. 4 回目のレビュー（1 点）: ミューテーション 18 種のうち、初期値の計算をログを出す形に戻すもの（`prefillLoud`）だけが生き残り、Configure のテスト 36 件が green だった。保存された値が無効なまま Configure を開いても `Logger.error` と `Logger.warn` が呼ばれないこと（`notCalled`）を assert させた。最初の版は「Proxy URL validation failed」で始まる呼び出しだけを見ていたので、ブリーフどおり厳密な形に直させた。

### Verification

- `npm run lint`: exit 0。`No invisible Unicode characters found (repository files: 636 scanned)`。
- `npm run test:unit:parallel`: exit 0。1113 passing と 74 passing、失敗 0。
- `npm test`: 601 passing、1 pending、9 failing。失敗は既知の 9 件と完全に一致（ExtensionInitializer 3、SystemProxyUpdateService 1、ProxyOwnership.integration 3、FailureInjection.integration 1、ProxyRuntimeDiagnostics 1）。
- `npm run test:smoke`: exit 0。4 passing。
- ミューテーション（`npm run compile` の後、`out/` に当てて戻した）: 18 種すべて red。unit レーン 9 種（取り込みのマスクを外す、Git の manager のマスクを外す、コミット時の 2 回目の redaction、直列化した URL をそのまま返す、scheme の無い資格情報の境界を狭める、取り込みで制御文字をエスケープ、起動時の確認がログを出す、警告をマスクしない、警告を消す）。host レーン 9 種（初期値をそのまま返す、初期値の計算がログを出す、再確定で保存された資格情報を捨てる、Configure と設定変更のハンドラが印を作り直さない、ハンドラと取り込みが検証しない、取り込みがログを出す、取り込みが SecretStorage に入れない）。初期値の計算がログを出すものは 1 回目に生き残り、4 回目のレビューで足したテストで red になった。
- 独立 verifier（sonnet、ルーブリック 11 項目）: 11 項目すべて pass。verifier は 4 つのスイートを自分で流し直し、fail-before のミューテーションも `out/` の複製で再現した。上の 4 行の数字は verifier が観測した値。
- 改行: 変更した 23 ファイルすべてで行末が揃っている（単独の CR 0、U+FFFD 0）。`git ls-files --eol` では変更した追跡ファイルすべてが `i/lf`。

### Learning

1. ガードや検証を足す前に、守る経路が本番で到達するかを確かめる。今回は `activate()` が `getState()` を先に呼ぶので、移行の本体は走らなかった。→ rules.md「検証・回帰」に追記した。
2. 再読み込みで効果が隠れる分岐（保存された値を「残す」分岐など）は、ミューテーションで確かめる。assert は再読み込みの後でなく、永続化された state か、秘密を返さない SecretStorage での再読み込みで行う。→ rules.md「検証・回帰」に追記した。
3. 任意の文字列の資格情報のマスクは、`maskCredentialOccurrences` 1 か所が持つ。エラー文は `ErrorAggregator` に入るときにマスクし、表示の直前にもう一度 redaction しない。→ rules.md「資格情報と URL」に追記した。
4. WHATWG の URL 解析は special scheme の `\` を `/` に変えるので、`DOMAIN\user:pass@host` は userinfo にならない。`new URL()` の結果だけでマスクを判断しない。→ rules.md「資格情報と URL」に追記した。
5. 設定の `otakProxy.proxyUrl` が state に入る経路（設定変更のハンドラ、`getState()` の取り込み）は、どれも同じ検証と正規化を通す。`getState()` のたびに走る取り込みは、ログを出さない形を使う。→ rules.md「資格情報と URL」に追記した。
6. ブリーフで既存の関数を使わせるときは、その関数の副作用（ログ、通知、書き込み）を読んでから、呼ばれる頻度と合わせて書く。→ rules.md「検証・回帰」に追記した。
7. テストの fake の globalState は、本番と同じくすべてのキーを残す。`proxyState` だけを残す fake では v3 の移行が毎回走り、移行が代わりに処理するので、取り込みの分岐をテストが見なくなる。→ rules.md「検証・回帰」の既存の規則（fake には本番と同じ契約を持たせる）に追記した。

### 残留リスク

- `setRequiresAuthFromLiveUrls` は、資格情報を hydrate できなかったアドレスの印を落とす（検出の経路と同じ、既存の方針）。
- `maskPassword` は、全体が URL として解析できる文字列（パス付きの URL で始まり空白を含むもの）をパーセントエンコードした形で返す（main から同じ）。`ErrorAggregator` がすべてのエラー文を `maskPassword` に通すようになったので、そうした文で始まるエラーは通知でパーセントエンコードされて見える。秘密は残らない。
- 無効な設定の警告は、起動時に 1 回だけ出る。起動後に設定を無効な値に変えた場合は、既存の無効 URL のエラーが出る。
- `V3MigrationService` は、検証していない設定の値から資格情報を SecretStorage に移す（今回の範囲外、後続の課題）。
- 確認したのはユニットテストと VS Code ホストのテストまで。実際の認証 proxy と、SecretStorage の書き込み失敗は試していない。

## 2026-10-18 — #108 項目 5、6、11 PR #113 への Codex の指摘（「/」を含むパスワードがマスクされない）を直す

**Issue**: [#108](https://github.com/tsuyoshi-otake/otak-proxy/issues/108)（項目 5、6、11）
**PR**: [#113](https://github.com/tsuyoshi-otake/otak-proxy/pull/113)（指摘は `979714a` へのレビュー）
**コミット**: `2fd78c9`（fix/108-credential-redaction）
**分担**: 実装は Devin（tmux の隣のペイン）。レビュー、検証、コミット、PR は Claude Code。過剰マスクの表の 1 行と、コメントと ARCHITECTURE.md の過剰マスクの記述は Claude Code が直した。

### 症状（`979714a` への Codex の指摘、P1）

- パスワードにエンコードされていない `/` を含む URL（`http://user:pa/ss@host:8080`）がマスクされなかった。`new URL()` が例外を投げるので、`showInvalidProxyUrl`（`src/commands/ConfigureUrlCommand.ts`）はエラー詳細に `maskPassword(value)` の結果、つまりパスワードそのものを出した。Logger と `ProxySecretRedactor` も同じパターンを使う。main の `maskPassword` のフォールバック `(\/\/[^:@]+):([^@]+)@` はこれをマスクしていた。

### 原因

- T04 で main の `maskPassword` のフォールバックを共有パターンに置き換えたとき、古い経路と新しい経路が何をマスクするかを同じ入力で比べなかった。共有パターンの userinfo（`[^/\s]+`）は整形式の URL だけを想定しており、パーサーが拒む形（`/`、`?`、`#` をそのまま含むパスワード）を落とした。

### 修正

- `URL_CREDENTIAL_PATTERN` に 2 つ目の選択肢 `[^/\s:@]+:(?:(?!:\/\/)\S)*` を足した。整形式の選択肢の後に試す。パスワードの並びは `/`、`?`、`#`、`\`、`@` を含んでよく、並びの最後の `@` で終わる。次の `://` はまたがないので、走査は線形のまま（`x://a:b` を 14 万文字: 約 1 ms。上限なしでは 1.6 s、main のフォールバックは 1.2 s）。
- 受け入れた過剰マスク: ポートの後、同じ空白なしの並びに `@` がある形は、`/` を含むパスワードと区別できない。`http://user:12/ss@host:8080` と `http://localhost:3000/@vite/client` はどちらも正しい URL で、どちらもマスクする（`http://localhost:****@vite/client`）。main は後者の単独の URL をそのまま出し、文中の同じ形は過剰マスクしていた。
- テスト: `maskPassword` と `redactString` の完全一致の表（`/`、`?`、`#` の行、今の出力を保つ行、過剰マスクの 2 行）、埋め込みパスワードの property に `urlSlash` の形、線形時間のテスト（`'x://a:b'.repeat(40000)` で 1 回 1000 ms 未満）、`showInvalidProxyUrl` のエラー詳細にパスワードが出ないことを確かめるホストのテスト。
- Docs: ARCHITECTURE.md の Credential Masking、CHANGELOG。README のマスクの記述は端末の環境変数と `npm config list` だけで、この修正で誤りにならない（`git grep` で確認）。

### レビューで直させた点

1. Devin のコードとテストのコメントは、過剰マスクを「main のフォールバックと同じ」と書いていた。`new URL()` が通る単独の URL（`http://localhost:3000/@vite/client`）は、main ではそのまま、このブランチでは過剰マスクになる。T04 で、host のある URL も直列化した後に共有パターンを通すようにしたため（`DOMAIN\user` の対策）。レビュアーがこの行を表に足し、コメントと ARCHITECTURE.md の記述を直した。

### Verification

- `npm run lint`: exit 0（`lint:unicode` は 636 ファイルを走査、検出なし）
- `npm run test:unit:parallel`: 1115 + 74 passing、0 failing（レビュアーの再実行）。実行後、テストのプロセスは残っていない
- `npm test`: 602 passing / 9 failing。9 件は既知の失敗だけ。新しい `showInvalidProxyUrl` のテストは pass（Devin の実行）
- `npm run test:smoke`: 4 passing（Devin の実行）
- Fail-before: 表、property、`showInvalidProxyUrl` のテストが修正前のパターンで red（Devin の記録）
- ミューテーション（レビュアーが `src` に当てて `tsc` し、unit lane で実行して戻した。property は 200 回）: 2 つ目の選択肢を外す → property が red（`urlSlash` の反例）。`://` の上限を外す → 線形時間のテストが red（約 10 s）。選択肢を入れ替える → scoped registry の行が red。Devin はホストの lane でも、2 つ目の選択肢を外すと `showInvalidProxyUrl` のテストが red になることを確かめた
- 計算量: 14 万文字の入力 6 種で main と比べた。`a.a.a…` の並びは main もこのブランチも二乗（約 6 s）。原因はスキームの部分 `\b[a-z][a-z0-9+.-]*:\/\/` で、main の `usernameOnlyPattern` も同じ形を持つ
- 改行: 変更した 5 ファイルはすべて CRLF で一様

### Learning

1. マスクやバリデーションの古い経路を共有の実装に置き換えるときは、同じ入力の表で古い経路と新しい経路の出力を比べる。→ rules.md「資格情報と URL」に追記した。
2. 区切りまで戻る貪欲な並びは、次の開始点をまたがないように上限を付け、時間を測るテストで守る。→ rules.md「資格情報と URL」に追記した。
3. 自分の作業ミス: T04 のレビューで、main の `maskPassword` のフォールバックを共有パターンに置き換えることを、マスクする入力を比べずに受け入れた。Codex が見つけた。

### 残留リスク

- main と同じくマスクしない: scheme の無い `user:pa/ss@host`、`/` を含むユーザー名だけのトークン（`http://to/ken@host`）、パスワードに `/` を含む `DOMAIN\user`（`maskPassword`。`redactString` は scheme 付きの形ならマスクする）、`http://user:p@s/s@host` の後半（`s/s`。`http://user:p@s/s@host` は host が `s` の正しい URL として読める）。
- main と違ってマスクしない: 文中の、空白をそのまま含むパスワード（`err http://user:pa ss@host:8080 x`）と、単独の同じ URL の `redactString`。並びを空白で止めるのは、単語をまたいでマスクしないため。バリデーターは `/` も空白もそのまま含む URL を拒むので、そうした URL は保存されず、対象にも書かれない。出るのは、外部の値（環境変数、エラー文）を文に含めた場合だけ。
- `a.a.a…` のような長い並びで、スキームの部分の走査が二乗になる（main と同じ）。14 万文字で約 6 s。フォローアップに回す。

## 2026-10-19 — #108 項目 5、6、11 PR #113 への Codex の再レビューの指摘 2 件と、レビューと独立検証で見つけた 4 件を直す

**Issue**: [#108](https://github.com/tsuyoshi-otake/otak-proxy/issues/108)（項目 5、6、11）
**PR**: [#113](https://github.com/tsuyoshi-otake/otak-proxy/pull/113)（指摘は `89f4f7f` へのレビュー）
**コミット**: `2426b8c`（fix/108-credential-redaction）
**分担**: 実装は Devin（tmux の隣のペイン、04h〜04n の 7 回）。レビュー、main との差分ファジング、修正案のシミュレーション、検証、コミット、PR は Claude Code。`maskPassword` の 2 回目のマスクのコメント、v3 移行のテスト (b) のコメント、04m の後の折り返しの崩れ 4 か所は Claude Code が直した。

### 症状

1. Codex P1（`ProxySecretRedactor.ts:23`）: パスワードに空白をそのまま含む URL（`failed http://user:pa ss@host:8080`）が、`maskPassword` でも `redactString` でもマスクされなかった。前回の修正で足した選択肢を含め、userinfo の選択肢はどれも空白で止まる。main の `maskPassword` のフォールバック `(\/\/[^:@]+):([^@]+)@` はこれをマスクしていた。
2. Codex P2（`ProxyStateManager.ts:374`）: `getState()` は最初に `V3MigrationService.migrateIfNeeded` を呼ぶ。移行は `otakProxy.proxyUrl` を検証せずに読み、無効な資格情報入りの値（`http://user:secret@proxy:8080/path`）を SecretStorage に保存し、設定を書き換えていた。
3. レビューで見つけた 1 件目: パスワードの先頭が `/`、`?`、`#`、`\` の単独の URL（`http://user:/abc@host:8080`）が、`maskPassword` で `http://user/abc@host:8080` と出た（main も同じ）。URL パーサーは `user:` を host と空のポートとして読み、パスワードをパス側へ移す。直列化した文字列には `user` の後の `:` が無いので、パターンが見つけられない。`showInvalidProxyUrl` のエラー詳細に届く。
4. レビューで見つけた 2 件目（main との差分ファジング）: 生成した 20 万件の入力のうち 17,380 件で、main の `maskPassword` はパスワードを隠し、このブランチは出した（`http://user:pa ss/x@host:8080`、`err http://user:pa<LF>ss@host x`、`git: u:SEC'k#RET@host x` など）。
5. レビューで見つけた 3 件目（property の生成器を確かめていて見つけた）: 先頭が `/`、`?`、`#`、`\` で、空白も含むパスワード（`http://user:/pa ss@host:8080`）が `http://user/pa%20ss@host:8080` と出た（main も同じ。04j の案だけでは 20 万件中 420 件が漏れた）。
6. 独立検証（ルーブリック r4）で見つかった 4 件目: `maskPassword` が、main ではマスクしていたトークン風のユーザー名を出した。`http://ghp_SECRET:@proxy:8080` が `http://ghp_SECRET:****@proxy:8080/` と出た（main は `http://****@proxy:8080/`）。04k の作業ツリーを main と比べると、ユーザー名の位置の生成器 50 万件で 210,412 件、広い生成器 3 つ（各 50 万件）で 17、25、9 件が回帰だった。

### 原因

1. 前回、「文中の、空白をそのまま含むパスワードはマスクしない。バリデーターが拒むので保存されない」を残留リスクとして受け入れた。拒んだ値そのものがエラー詳細とログに載る経路を見落としていた。
2. 設定を state や SecretStorage に入れる経路を、設定変更のハンドラと `getState()` の取り込みの 2 つと考えていた。v3 移行は `getState()` の中で、検証より先に設定を読んでいた。
3. `maskPassword` は値をパースしてからマスクしていた。パーサーが値を別の意味に読むと、資格情報の形が直列化した文字列から消える。埋め込みパスワードの property の生成器は、パスワードを固定の接頭辞（`pw`）で始めていたので、先頭が区切り文字の形を一度も作らなかった。
4. T04 の最初のコミットで、main の `maskPassword` のフォールバック 2 つ（`(\/\/[^:@]+):([^@]+)@` と `(^|[\s=])([^\s@:/]+):([^\s@/]+)@`。値がパースできないか host が無いときに当てていた）を、整形式の userinfo を想定した共有パターンに置き換えた。その後のレビューでは手で選んだ表で main と比べていたので、表に無い形（空白と `/` を両方含むパスワード、改行をまたぐパスワード、引用符を含む scheme の無い形）の回帰が残っていた。
5. 生の文字列のマスク（症状 3 の修正）は、共有パターンの選択肢がマッチする形しか消せない。空白を含むとどの選択肢もマッチせず、値はパースできる（`user` が host、ポートが空）ので、パースの経路に入る。
6. 3 か所あった。(a) 表示用のコールバックは、パスワードが空でも `user:` を残した。(b) 最初の `:` より前に生の `@` があっても `user:` を残した。パターンの userinfo は最後の `@` まで進むので、`err http://TOKEN@proxy:8080,user@corp x` では `TOKEN@proxy` が user になる（main は最初の `@` より前を隠していた）。(c) 04i から、`maskPassword` は先にマスクした文字列をパースしていた。マスクがパーサーの読む host と userinfo を変えることがある。`http://TOKEN:@h?a:b@host` は、パーサーにとってはユーザー名だけの `TOKEN` で host は `h`（authority は `?` で終わる）だが、先にマスクすると `http://TOKEN:****@host` になり、そのパースではパスワード付きのユーザー名 `TOKEN` になる。main は書いた値のパース結果で経路を決めていた。レビュアーの差分ファジングは、パスワードの位置と、パスワードの無いトークン（`scheme://TOKEN@host`）しか作っていなかったので、空のパスワード（`TOKEN:@`）と、authority が `?`、`#`、`\` で切れる形の回帰が見えなかった。

### 修正

- `URL_CREDENTIAL_PATTERN` に 3 つ目の選択肢 `[^/\s:@]+:[^@/\r\n]*` を足した。最後に試す。最初の `@` で止まり（空白を含む並びが最後の `@` まで進むと、同じ行の後ろにメールアドレスがあるときに host を飲み込む）、`/` と改行をまたがない（後ろの URL や次の行に入らない）。
- 表示用のコールバックは、userinfo に `:` が無いとき、パスワードが空のとき、最初の `:` より前に生の `@` があるときに userinfo 全体を `****` にする（`http://ghp_SECRET:@proxy:8080` → `http://****@proxy:8080/`）。それ以外は `user:****` にする。
- `maskPassword` は、経路を main と同じく書いた値のパース結果で決める。パースの経路では、生の文字列を先にマスクし（`premasked`）、そのパース結果は、host、ユーザー名、パスワードの有無（空かどうか）が書いた値のパース結果と同じときだけ使う。違えば書いた値のパース結果を使う。どちらでも、パーサーのパスワード（無ければユーザー名だけの userinfo）をマスクし、直列化した文字列をもう一度マスクする（パーサーがタブを取り除いた後に資格情報の形が現れる: `http://proxy/u:p<TAB>ass@h` → `http://proxy/u:pass@h`）。パースの経路は main のパースの経路が隠したものを隠し、マスクした文字列のパースは、書いた値のパースが見逃す形も覆う（`http://DOMAIN\user:pa\ss@proxy:8080` は `http://domain/user:****@proxy:8080`。main はパスワードを出していた）。04k まであった「`maskPassword` は `redactString` がマスクするものを必ずマスクする」という主張は取り下げ、コメントから消した。
- `ProxySecretRedactor.maskLooseCredentials` を足した。main のフォールバック 2 つと同じ意味で、どちらも全ての出現に当て（main は最初の 1 つだけ）、左から右への 1 回の走査で書いた（main の正規表現は 14 万文字の入力で 1.6 秒と 2.4 秒かかった）。表示用のマスクだけが使う。`//x:` から次の `@` まで、空白・`/`・改行をまたいで過剰にマスクするので、診断用の `redactString` には使わない（main でも使っていなかった）。
- `maskPassword` は、main がフォールバックを当てていた経路（書いた値がパースできない、または host が無い）と、パース結果に userinfo が無く、書いた値の authority が空のポートで終わるとき（タブと改行を除いてから判定する。パーサーと同じ）に、`maskLooseCredentials(premasked, '****')` を返す。これらの値は書いたままの形で出る（`http://user:pa/ss@host:8080` → `http://user:****@host:8080`、`http://user:/abc@host:8080` → `http://user:****@host:8080`、`http://host:/path` は `http://host:/path` のまま）。
- `V3MigrationService.migrateIfNeeded` は、設定を `tryCanonicalizeProxyUrl(...) ?? ''` で 1 回だけ正規化し、資格情報の候補と設定の書き換えの両方にその結果を使う。無効な値は書かれたまま残し、SecretStorage にも何も入れない。
- 受け入れた過剰マスク: ポートの後、同じ行で `/` より前に `@` を含む文が続く形（`see http://proxy:8080 is down, mail admin@corp` → `see http://proxy:****@corp`）。表示用では、`//x:` から次の `@` まで（main と同じ）。
- テスト: 空白の行・先頭が区切り文字の行・過剰マスクの行を足した完全一致の表、空白入りパスワードの property（英小文字、数字、空白、タブ、`:?#\%!$&'()*+,;=~._-` から作り、出力を完全一致で確かめる）、埋め込みパスワードの property に `urlLeadingSeparator` の形、2 回目のマスクを固定する行、線形時間のテストに入力 2 つ、main 以上にマスクすることを固定するスイート（完全一致の表、authority の形の property、scheme の無い形の property、`maskLooseCredentials` の線形時間のテスト、main がマスクしていたトークン風のユーザー名の 12 行の表、空のパスワードか無しのトークン風のユーザー名の property）、`showInvalidProxyUrl` のホストのテストに `http://user:/abc@host:8080`、`http://user:pa ss/x@host:8080`、`http://user:/pa ss@host:8080`、v3 移行のホストのテスト 2 件（(a) 無効な設定は書かれたまま、secret は保存されず、移行は完了する。(b) 正しいが正規形でない設定は移行され、取り込まれる）。
- Docs: ARCHITECTURE.md（Credential Masking、`ProxyStateManager.getState`）、CHANGELOG（#108 のマスクの項目）。

### レビューで直させた点

1. 04h の Devin の報告は「テスト (b) は修正前にも失敗した。2 つ目の不具合」と書いていた。同じ報告のミューテーション（移行を生の読み取りに戻す）では (b) は pass していた。レビュアーがホストの lane で同じミューテーションを当て直し、(a) だけが red、(b) は pass を確かめた。SecretStorage のキーはパースした公開 URL の sha256 なので、設定の綴りに依らない。(b) は回帰を防ぐテストで、生の読み取りとは区別しない。コメントをそう書き直した。
2. 04h の後のレビューで、先頭が区切り文字のパスワードの漏れ（症状 3）を node の表で見つけ、04i で直させた。前回の表の 4 行の期待値は、04i でパーサーの形（末尾の `/`）に直し、04l で書いたままの形に戻した（経路を書いた値で決めるので、パースできない値は書いたまま出る）。
3. `maskPassword` の 2 回目のマスクのコメント: `DOMAIN\user` は生の文字列のマスクで先に消えるので、2 回目のマスクが要る理由をタブの例に書き直した（Claude Code）。
4. 04i の検証の後、レビュアーが main のビルドとこのブランチの `maskPassword` を同じ生成器の入力で比べ（差分ファジング）、症状 4 を見つけた。直し方（main のフォールバックを線形の走査で戻し、main と同じ経路でだけ当てる）を 30 万件でシミュレーションして回帰 0 件を確かめてから、04j で Devin に実装させた。指示の property の生成器を確かめる途中で症状 5 を見つけ、空のポートの規則を足した案を 20 万件でシミュレーションして漏れ 0 件を確かめてから、同じ指示に入れた。
5. 04j の走査は、レビュアーの総当たり（`/ : @ = 空白 LF a` の長さ 8 以下、672 万件）とランダム 200 万件で、正規表現と結果が一致した。ただし 2 か所が二乗だった。パス 1 は user が空のときも `@` を探してから捨て、次の `//` で同じ範囲を探し直していた。パス 2 は `:` の探索が run の外まで進んでいた。138 万文字の入力で 4.6〜6.9 秒かかった（13.8 万文字では 60 ms で、既存の 1000 ms の上限では見えなかった）。04k で直させ、138 万文字の入力 4 つを線形時間のテストに足させた。
6. 04j のコメントの誤り: 空のポートの分岐に「main もここでフォールバックを当てていた」と書いていた（main はこの形のパスワードを出していた）。残留リスクのコメントと ARCHITECTURE.md は、`maskPassword` が 2 つ目の残留を文中でも覆うように読めた（覆うのは単独の URL だけ）。04k で直させた。
7. ルーブリック r4 の独立検証が症状 6 を見つけた。レビュアーはユーザー名の位置の生成器（トークンだけの userinfo、空のパスワード、authority の切れ目、後ろに続く userinfo らしい文字列）を足し、修正案を preload のパッチで実装して main と比べた。全ての経路で生の文字列のパターンを当てる案は 1,820 件の回帰。マスク後のパースを使わない案（D2）は回帰 0 件だが、`DOMAIN\user` の形の覆いを失い、パスワードの位置で `redactString` が隠すものを 507 件出した。案 E（経路を書いた値で決め、マスク後のパースは host、ユーザー名、パスワードの有無が一致するときだけ使う）は、5 つの生成器の 250 万件で回帰 0 件、トークン風のユーザー名の総当たり 41,472 件で漏れ 0 件（main は 21,888 件）、パスワードの位置で `redactString` が隠すものを出すのは 2 件だった。案 E を 04l で Devin に実装させた。
8. 04j〜04l のコメント、テスト名 2 つ、ARCHITECTURE.md は、比べる相手を「main」と書いていた（27 行）。マージすると main はこのコードそのものになり、「main と同じ」が意味を失う。「pre-#108 の masker」（3.2.16。`git log v3.2.16..main` で 2 つのマスクのファイルに変更なし）に直させた。あわせて、`redactString` の残留の一覧に、改行をそのまま含むパスワード（`http://user:pa<LF>ss@host`。選択肢 3 は改行で止まる。main の `redactString` も出していた）が抜けていたので足させた。`maskPassword` はこれをマスクする（単独の URL はパーサーが改行を除き、文中は `maskLooseCredentials`）。04m。
9. ルーブリック r5 の独立検証が、`InputSanitizer.ts` と `ProxySecretRedactor.ts` のコメント 2 か所の誤りを見つけた。どちらも「2 つのマスカーは同じ箇所を見つけ、違うのは置き換える文字列だけ」と書いていた。04g 以降の `maskPassword` はパーサーの見方と `maskLooseCredentials` も使うので、片方だけがマスクする形がある（`http://user:pa ss/x@host:8080` は `maskPassword` だけ、`https://u:SEC@k?RET@host:8080` の `RET` は `redactString` だけがマスクする）。「共有のパターンを使うが、カバー範囲は違う（ARCHITECTURE.md の Credential Masking）」に直させた。04n。

### Verification

- Devin（04j）: lint（不可視 Unicode なし、636 ファイル）、unit 1122 + 74 passing、`npm test` 604 passing・9 failing（既知の 9 件と同じ）、smoke 4 passing。04i の形に戻すと、新しい表、property 2 つ、ホストのテストの 4 件が red。ミューテーション m1〜m7（空のポート以外の B1 を外す、authority のパスだけにする、各パスを正規表現に戻す、全てのパース経路でパスを当てる、B2 を外す、B2 でタブと改行を除かない）はすべて red。
- Devin（04k）: lint、unit 1122 + 74 passing（`maskLooseCredentials` の線形時間のテストは 82 ms）、smoke 4 passing。04j の走査に戻すと線形時間のテストが 6,331 ms で red。ミューテーション m8（user が空かを見る前に `@` を探す）6,357 ms、m9（`:` の探索に上限が無い）6,427 ms で red。
- Devin（04l）: lint（不可視 Unicode なし、636 ファイル）、対象の 5 ファイル 104 passing、unit 1124 + 74 passing、ホストの 3 件 passing、smoke 4 passing、`npm test` 604 passing・9 failing（既知の 9 件と同じ）。修正前の作業ツリーでは、新しい 12 行の表の 1〜8 行目と 11 行目が red（9、10、12 行目は修正前も pass）、新しい property が `http://SECRET:@proxy:8080` で red。ミューテーション M1〜M10（空のパスワードの規則を外す、生の `@` の規則を外す、マスク後のパースを常に使う、host・ユーザー名・パスワードの有無の一致を 1 つずつ外す、マスク後の値で経路を決める、空のポートの分岐を外す、2 回目のマスクを外す、書いた値のパースを常に使う）はすべて red。
- Devin（04m）: `main` を指す語は 0 件（`do/main` の入力値は除く）、lint、マスクのテストファイル 23 passing（名前を変えた 2 件を含む）、unit 1124 + 74 passing、改行は 8 ファイルとも一様。
- レビュアー（04m の後のビルド）: パスワードの位置の 50 万件のうち、`redactString` がパスワードを隠す 431,211 件で `maskPassword` が出すのは 2 件。どちらも残留リスクに書いた `@` と `?` の形（`https://o'k:SEC@k?RET@host:8080` など）。
- レビュアー（04k のビルド）: 2 つの走査を main の正規表現（グローバル）と比べ、総当たり 6,725,601 件（`/ : @ = 空白 LF a`、長さ 8 以下）とランダム 200 万件（タブ、VT、U+0085、U+00A0、U+1680、U+2028、U+3000、U+FEFF を含む 20 文字種、長さ 30 以下）で、パス 1、パス 2、合成のどれも差分 0。138 万文字の入力 4 つは 5〜23 ms。
- レビュアー（04l のビルド、main との差分ファジング）: 広い生成器 3 つ、パスワードの位置、ユーザー名の位置（各 50 万件、計 250 万件）で回帰 0 件（main がマーカーを出したのは 362,610 / 363,061 / 362,901 / 56,925 / 238,017 件）。トークン風のユーザー名の総当たり 41,472 件で漏れ 0 件（main は 21,888 件）。probe-r5 の 41 行（P1〜P16、U1〜U12、T1〜T10）はすべて期待どおりで、`maskLooseCredentials` の 138 万文字の入力 4 つは 4〜17 ms。
- Devin（04n）: 同じ主張の grep（`same occurrences` など）は 0 件、compile と lint は exit 0、2 ファイルとも CRLF で一様。
- 独立検証: ルーブリック r5 は 11 項目中 10 項目が pass、C6 (d)（コメントの主張）が fail（レビューで直させた点 9）。04n の後のルーブリック r6: 11 項目すべて pass（compile と lint、probe の 41 行、unit 1124 + 74 passing、ホストのテスト 3 件、v3 移行が設定を 1 回だけ読むこと、`maskPassword` の構造とコメント、ドキュメント、変更範囲と改行、テストのプロセスが残らないこと、main との差分ファジング 250 万件で回帰 0（検証者が別の生成器で試した約 440 万件でも 0）、`maskLooseCredentials` の 138 万文字の入力は 24 ms 以下）。
- 改行: 変更した 8 ファイルは CRLF か LF で一様（`V3MigrationService.ts` は LF のまま）

### Learning

1. 「バリデーターが拒む」は、マスクの漏れを残留リスクとして受け入れる理由にならない。拒んだ値はエラー詳細とログに載る。→ rules.md「資格情報と URL」の、古い経路と新しい経路を比べるルールに追記した。
2. 古い経路と比べるときは、手で選んだ表だけでは足りない。同じ生成器の入力で古い経路と新しい経路の出力を比べ、古い経路だけが隠した件数を数える（差分ファジング）。手で選んだ表で 2 回直した後も、20 万件中 17,380 件の回帰が残っていた。→ 同じルールに追記した。
3. 設定を読む経路は、ハンドラと取り込みだけでなく、`'proxyUrl'` を `src` 全体で grep して数える。v3 移行が検証より先に読んでいた。→ rules.md の `otakProxy.proxyUrl` のルールに追記した。
4. 文字種を広げる property の生成器は、区切り文字を値の先頭と末尾にも置く。→ rules.md に追記した。
5. 正規表現を手書きの走査に置き換えるときは、結果の一致だけでなく、探索した範囲を探し直す経路が無いかを読む。線形時間のテストの入力は、ベクトル化された `indexOf` の速さを見込んで大きくする。→ rules.md に追記した。
6. 差分ファジングの生成器は、マスクする値の位置ごとに作る（パスワードの位置と、ユーザー名の位置）。経路の分岐（パースするか、文字列でマスクするか、どちらのパース結果を使うか）は、古い経路と同じ値（書いた値）で決める。先にマスクした値で分岐すると、マスクがパーサーの読み方を変え、ユーザー名の位置で 50 万件中 210,412 件の回帰になった。→ rules.md に追記した。
7. 自分の作業ミス: T04 で main のフォールバックを置き換えたとき、生成した入力で比べなかった。前回、空白入りパスワードの漏れを残留リスクとして受け入れた（Codex が P1 で指摘）。04h の指示では、ミューテーション m5 で選択肢 2 と 3 が同じ位置で両方マッチすると予想したが、そうなる入力は無く、観測できなかった。ルーブリック r3 の C2 で、`redactString` の出力にも `****` を期待した（`redactString` は `<credentials>` を出す）。04i で、先にマスクしてからパースする形に変えたとき、main の経路の決め方が変わることを確かめなかった。トークンの差分ファジングで、空のパスワードと authority が切れる形を作らなかった（独立検証が見つけた）。

### 残留リスク

- `redactString`（診断用）でマスクしない（どれも main と同じ）: パスワードに空白と `/` を両方そのまま含む形（`http://user:pa ss/x@host`）、改行をそのまま含むパスワード（`http://user:pa<LF>ss@host`）、空白と `@` を両方含むパスワードの最初の `@` より後ろ（`http://user:pa ss@w@host` の `w`）、scheme の無い `user:pa ss@host`。
- `maskPassword`（表示用）でマスクしない: 文中の、空白と `@` を両方含むパスワードの最初の `@` より後ろ（`err http://user:pa ss@w@host x` の `w`）、scheme の無い、空白を含むパスワード（`user:pa ss@host`）、パーサーが authority を後ろの `?` や `#` で切るときの、パスワードの生の `@` より後ろ（`https://u:SEC@k?RET@host:8080` の `RET`。`redactString` はマスクする）。どれも main と同じ。
- 前回の残留リスク「文中の、空白をそのまま含むパスワード」は、この修正で取り下げた。
- 二乗になる走査（フォローアップ）: スキームの部分の `a.a.a…`（main と同じ）、共有の scheme の無いパターンの `'=a:b'` の繰り返し（14 万文字で約 6 秒。main の `maskPassword` は同じ入力で 2.4 秒）。

## 2026-10-19 — #108 項目 14 と低のビルド: 不可視文字のスキャンの穴を塞ぎ、公開を main 上の tag だけにし、PR で CI を動かす

**Issue**: [#108](https://github.com/tsuyoshi-otake/otak-proxy/issues/108)（項目 14、低のビルド）
**PR**: [#114](https://github.com/tsuyoshi-otake/otak-proxy/pull/114)
**コミット**: `b970895`（fix/108-release-gates）
**分担**: 実装は Devin（tmux の隣のペイン。下書き 10a〜10e、ブランチへの適用と検証 10f）。事前確認（actions の SHA と公開日、`@vscode/test-cli` が設定ファイルを評価するプロセス、`npm audit`）、レビュー、`src/test/README.md` の追記、コミット、PR は Claude Code。

### 症状

1. `scripts/check-invisible-unicode.mjs` は、先頭 8000 バイトに NUL を含むファイルを binary として飛ばした。不可視文字と NUL を 1 バイトずつ含むファイルは `0 scanned, 1 skipped as binary` で exit 0 になった。
2. 検出表は U+3164（HANGUL FILLER）など Default_Ignorable の一部と、U+2800（点字の空白）を検出しなかった。
3. publish workflow の `lint:unicode:dist` は `vsce package` より前にあった。`vsce package` は `vscode:prepublish`（`npm run compile`）で `out/` を作り直すので、出荷される `out/` はスキャンの後に作られていた。
4. 公開物と tag が一致しなかった。v3.2.1 は `workflow_dispatch`（main の 767b736）で公開され、後で tag `v3.2.1`（b198755）から走った run は `--skip-duplicate` で "already published. Skipping" になり success になった。actions は tag（`@v4`）で参照し、job に `timeout-minutes` が無かった。
5. PR で動く CI が無く、Dependabot と `npm audit` も無かった。`.vscode-test.mjs` が作るプロファイル（`otak-proxy-vscode-test-*`）は実行後に残った（この端末で 226 個、約 3.2 GB）。

### 原因

1. binary の判定を「NUL を含むか」で行っていた。テキストの拡張子のファイルでも NUL 1 バイトで走査から外れ、走査が 0 件でも失敗にしていなかった。
2. 検出表は、既知の攻撃で使われた範囲を手で並べたもので、Unicode の Default_Ignorable_Code_Point の集合を基準にしていなかった。
3. dist スキャンを package の前に置いていた。package が compile をやり直すことを考えていなかった。
4. publish workflow は `workflow_dispatch` でも動き、ref が tag か、tag が `package.json` の version と一致するか、main 上のコミットかを確かめていなかった。`--skip-duplicate` が公開済みを成功にした。
5. CI は publish workflow の中にしかなかった。`.vscode-test.mjs` はプロファイルを作るだけで消していなかった。

### 修正

- 検出表（`scripts/lib/invisible-unicode.mjs`）: Unicode 16.0（17.0 でも同じ）の Default_Ignorable_Code_Point 全体と U+2800 を、範囲ごとにコメント付きで固定した。BOM（先頭）と、絵文字の後の異体字セレクタ 1 個の例外はそのまま。テストは実行中の Node の `\p{Default_Ignorable_Code_Point}` を列挙し、表に無いコードポイントがあれば名指しして失敗する。
- スキャナ（`scripts/check-invisible-unicode.mjs`）: binary の判定を拡張子だけにした。NUL は `c0-control` の検出として報告し、ファイルは最後まで走査する。走査が 0 件ならどのモードでも exit 1。`--dir <path>` を足した（存在しない・ディレクトリでないパス、`--dist` や明示したパスとの併用は usage を出して exit 2）。拡張子で飛ばしたファイルと読めなかったファイルは別に数える。
- publish workflow: トリガは `v*` の tag の push だけ。build job は `npm ci` の前に `scripts/release/check-release-ref.mjs` で、`GITHUB_REF` が `refs/tags/v` + `package.json` の version であること（`GITHUB_REF_TYPE` があれば `tag`）と、tag のコミットが `origin/main` の祖先であることを確かめる（履歴を全部取得し、main を明示して fetch する）。package の後に VSIX を `$RUNNER_TEMP` に展開して `--dir` で走査し、同じ VSIX を artifact にする。`check-tokens` job が 2 つの secret を先に確かめ、registry ごとの publish job（`needs: [build, check-tokens]`）が artifact を公開する。`--skip-duplicate` は workflow と `deploy` / `deploy:ovsx` から外した。`uses:` はすべて 40 桁の SHA と版のコメントで固定し（checkout v7.0.1、setup-node v7.1.0、upload-artifact v7.0.2、download-artifact v8.0.2。どれも公開から 3 日以上）、全 job に `timeout-minutes`、全 checkout に `persist-credentials: false`、`permissions: contents: read`。
- CI（`.github/workflows/ci.yml`、新規）: PR と main への push で、`npm ci`、lint、unit（並列）、xvfb の smoke、package、VSIX の `--dir` 走査、`npm audit --audit-level=critical`。取り消すのは PR の古い実行だけ。
- Dependabot（`.github/dependabot.yml`、新規）: npm と github-actions を毎週。`cooldown` は 3 日。cooldown はセキュリティ更新の PR には効かないことをファイルに書いた。自動 merge はしない。
- `.vscode-test.mjs`: 同期の `process.on('exit')` でプロファイルを消す。`@vscode/test-cli` 0.0.11 はこのファイルを CLI のプロセスでだけ評価し（拡張ホストの runner は `VSCODE_TEST_OPTIONS` で設定を受け取る）、CLI は `process.exit` するので、非同期の削除は走らない。
- テスト: 検出表の境界の行と Default_Ignorable の網羅テスト、スキャナの CLI テスト 8 件、`check-release-ref` のテスト 10 件（本物の一時リポジトリで祖先を判定する。コミットの署名は無効）、workflow のポリシーテスト 7 件（トリガ、SHA の固定、permissions、timeout、persist-credentials、publish job の needs、`--skip-duplicate`）。
- Docs: CLAUDE.md（Supply-Chain Lint、Release Pipeline の節を新設、テストのプロファイルの削除）、`src/test/README.md`（プロファイルの削除）、CHANGELOG（Security）。

### レビューで直させた点

1. 10d の下書きは、Kaithi の記号（U+110BD〜U+110CD）と Egyptian の format controls（U+13430〜U+1343F）を Default_Ignorable として表に入れ、網羅テストがそれを確かめると書いていた。レビュアーが Node 26 で `\p{Default_Ignorable_Code_Point}` を全コードポイントについて評価し、どちらも含まれないことを確かめた（U+110BD と U+110CD は Prepended_Concatenation_Mark、U+110BE〜U+110C2 は見える文字、U+13430〜U+1343F は導出で除外される）。10e で外させ、両方向（Node の集合が表に含まれる: 漏れ 0、表の Default_Ignorable を名乗る 10 カテゴリが Node の集合に含まれる: 非該当 0）を確かめさせた。
2. 10d の `check-release-ref.mjs` は `GITHUB_REF_NAME` で tag を判定していた。branch の名前でもあるので、`v3.2.17` という名前の branch が通る。`GITHUB_REF`（`refs/tags/v<semver>`）と `GITHUB_REF_TYPE` だけで判定させ、`run()` に version を注入できるようにしてテストを足させた。チェックは `actions/setup-node` の後（固定した Node）、`npm ci` の前に置かせた。
3. 10d は token の確認を registry ごとの job に移していた。`OVSX_PAT` が無いと、Marketplace にだけ公開してから Open VSX の job が失敗する。公開の前に両方を確かめる `check-tokens` job に戻させた。
4. 10d の checkout は `persist-credentials` が既定（true）のままで、CI の concurrency は main への push も取り消した。全 checkout を false に、取り消しを PR だけにさせた。Dependabot には、cooldown がセキュリティ更新の PR に効かないことを書かせた（GitHub のドキュメントの文を引用させた）。
5. ポリシーテストを、読めない形で失敗する（fail closed）ように強めさせた: コメント行を除いてから読む、`jobs:` の後に top-level のキーがあれば失敗する、版のコメントも必須、`permissions:` は `contents: read` だけで `: write` が無い、publish の `on:` は tag の push だけ、全 checkout に `persist-credentials: false`、publish job は `build` と `check-tokens` の両方を needs にする。あわせて、スキャナの集計が読めなかったファイルを「拡張子で飛ばした」と数えていたのを分けさせ、`--dir` に存在しないパスを渡すとスタックトレースで落ちたのを usage と exit 2 にさせた。`releaseRef.test.ts` のコミットには `-c commit.gpgsign=false` を付けさせた（system の Git 設定が署名を強制しうる）。
6. 10f（ブランチへの適用）で Devin が 2 件を直した: スキャナのテストの `!stderr.includes('at ')` が usage の英文（"that"）に一致した（スタックの行の正規表現 `/^\s*at\s/m` に変えた）。publish workflow のコメントに `--skip-duplicate` の文字列があり、ポリシーテストが失敗した（コメントを言い換えた）。
7. `src/test/README.md` の hermetic の説明に、プロファイルの削除を足した（Claude Code。Devin は「説明はまだ正しい」として変えていなかった）。

### Verification

- Devin（10f、適用前の main 298b5bb の上）: テストだけを先に入れた fail-before は、`InvisibleUnicode.test.js` 2 failing（新しい境界の行と網羅テスト）、`InvisibleUnicodeScanner.test.js` 7 failing / 1 passing（`--dir` のテストは、古いスキャナがパスを明示したパスとして読んだので偶然 pass）、`releaseRef.test.js` はモジュールが無く suite ごと失敗、`releaseWorkflowPolicy.test.js` 6 failing / 1 passing（permissions は元から満たしていた）。ソースを入れた後は 16 / 8 / 10 / 7 passing。
- Devin（10f）: lint（不可視 Unicode の走査 640 件、検出 0）、unit 1128 + 74 passing（1 回目は T04 のブランチの古いビルドで 1 件失敗。消して再実行）、smoke 4 passing（プロファイルの数は前後とも 226）、`npm test` 586 passing・1 pending・9 failing（既知の 9 件と同じ）、`lint:unicode:dist` 308 件で検出 0、`package:vsix` の VSIX（166 ファイル）を展開して `--dir` で 159 件、検出 0。`check-release-ref` を本物の tag で 4 通り: `refs/tags/v3.2.16` と `v3.2.16^{commit}` は exit 0、`refs/tags/v3.2.15` は version の不一致、`refs/heads/v3.2.16`（`GITHUB_REF_TYPE=branch`）は tag でない、main に無いコミットは祖先でない、でそれぞれ exit 1。
- レビュアー: 下書き 13 ファイルとブランチのファイルが一致すること（`cmp`）、main（7cc4543）への rebase で衝突なし、変更した 15 ファイルの改行が一様（作業ツリーは CRLF、index は LF）、`out/` に対応するソースの無いビルドが 0 件。
- 独立検証（rubric-verifier、sonnet、C1〜C13）: 1 回目は 11/13 が pass。C8（CHANGELOG の `### Security` の項目が `(#108)` で終わらず、`Release pipeline hardening (#108):` と先頭に置いていた）と C12（Devin の報告書の Docs 節が、私の足した `src/test/README.md` の 2 行を「変更なし」と書いていた）が fail。項目の末尾を `... cooldown (#108).` に直してコミットを差し替え（afe0ae3 → b970895、差分は CHANGELOG の 1 行だけ）、報告書を訂正した。2 回目（C0 = 差し替えの差分が CHANGELOG の 1 行だけであること、C8、C12 の縮小版）は全 pass。1 回目の実測: lint exit 0（642 件を走査、検出 0）、unit 1151 + 74 passing、smoke 4 passing、`npm test` 604 passing・1 pending・9 failing（既知の 9 件と同じ）、プロファイルの数は smoke と `npm test` の前後とも 226、変更した 15 ファイルはすべて作業ツリー CRLF・index LF・孤立 CR なし。検証用の fixture ディレクトリ（`%TEMP%\verify108-*`、2 KB）は権限で削除できず残った。
- CI（この PR が最初の実行）: ci.yml の初回（Linux、run 39145311201、3 分 25 秒）は success。lint（不可視 Unicode の走査 626 件、検出 0。ローカルの 642 件との差 16 件は、この端末にだけある未追跡の PBT の evidence 16 件と同じ数）、unit 1151 + 73 passing・1 pending（`%OS%` を使うテストが Linux で skip。Devin の予想どおり）、smoke 4 passing、package、VSIX の `--dir` 走査 159 件・検出 0、`npm audit --audit-level=critical`（critical 0）。audit の件数は 21（moderate 3、high 18）で、ローカル（npm 11.16.0）の high 17 件より 1 件多い。差は `ovsx`（`@vscode/vsce` に依存）で、CI の Node 22.23.3 付属の npm だけがこれを数える。

### Learning

1. 外部仕様の表（Unicode のプロパティなど）は、実物で両方向に確かめる。表 ⊇ 実物（漏れ 0）と、表のうちその性質を名乗る行 ⊆ 実物（非該当 0）。Devin の 10d は 2 つの範囲を Default_Ignorable と書き、網羅テストは片方向（漏れ）しか見ないので通っていた。→ rules.md「検証・回帰」に追記した。
2. ブランチを切り替えたら、対応するソースの無い `out/` のビルドを消してからテストを回す。`tsc` は消えたソースの出力を消さず、unit lane は `out/test/**/*.test.js` をすべて拾う。T04 のブランチのビルド（`CredentialDisplayMasking.test.js`、`realProxyStateManager.js`）が T10 のブランチで失敗した。→ rules.md に追記した。
3. `.vscode-test.mjs` は `vscode-test` の CLI のプロセスでだけ評価され、CLI は `process.exit` する。後片付けは同期の `exit` リスナーで書く。→ rules.md「VS Code ホストの前提」に追記した。
4. 「無いこと」を確かめるアサーションは、部分文字列ではなく形で書く。`includes('at ')` は usage の英文に一致した。
5. 自分の作業ミス: T10 のブランチを作るとき、前のブランチの `out/` のビルドを消さなかった（Devin の 1 回目の unit が失敗した）。CHANGELOG の項目の issue 番号が先頭にあるのを受け入れ、Devin の報告書の Docs 節も私の追記に合わせて直さなかった（どちらも独立検証で fail）。rubric の文言は自分で書いたものでも、コミットの前に照合する。

### 残留リスク

- VS Code ホストの全件（`npm test`）は CI で走らない。既知の 9 件の失敗があるので、CI は unit と smoke（`@smoke` の 4 件）だけを走らせる。ホストのテストの大半は、今もローカルでしか走らない。
- `npm audit` の high 17 件（ローカルの npm 11.16.0。CI の Node 22.23.3 付属の npm は `ovsx` も数えて 18 件。dev 依存。直すには `@vscode/test-cli@0.0.15` と `@vscode/vsce@4.0.0` の semver-major の更新が要る）。CI は critical だけで失敗する。
- publish の environment の保護（required reviewers など）はリポジトリの設定で、このコミットでは付けていない。
- registry ごとに job を分けたので、片方だけ失敗したらその job だけを re-run できる。`--skip-duplicate` が無いので、公開済みの registry の job をもう一度走らせると失敗する（まだ試していない）。
- 低のビルドのうち、VS Code ホストのテストの同期状態が `out/test` に書かれること、PBT の evidence が追跡対象のディレクトリに溜まること、参照されないアセット、`clean` スクリプトと `--max-warnings 0` は、このコミットでは扱っていない（フォローアップ）。
- 既存の 226 個のプロファイル（約 3.2 GB）は残っている。この変更の前に作られたもので、消すかはユーザーが決める。
