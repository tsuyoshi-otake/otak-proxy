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
