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
