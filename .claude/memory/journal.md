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
