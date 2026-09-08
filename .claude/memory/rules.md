# Rules (otak-proxy)

作業開始時に必ず読むこと。検証済みの学びだけを載せる。誤りが判明したものは削除する。

## 検証・回帰

- **実装に触る前に、緑のベースラインを記録する。**
  `npm run test:unit:parallel` と `npm test`（VS Code host）の両方。
  VS Code host には現在 **9 件の既存失敗**がある（`ExtensionInitializer` 3、
  `SystemProxyUpdateService` 1、`ProxyOwnership.integration` 3、`FailureInjection.integration` 1、
  `ProxyRuntimeDiagnostics` 1）。自分の変更のせいだと誤診しないこと。
  切り分けは `git stash -u` → HEAD で再実行 → 失敗集合を diff。

- **`npm run test:unit:parallel` は `--bail` 付き。** 失敗の全体像が見えない。
  全件を見たいときは `out/test/**/*.test.js` から VS Code 依存と `.integration.` を除いた
  一覧を作り、`npx mocha --require ./scripts/vscode-shim.cjs --ui tdd --exit` を直接叩く。

- **mocha を直接叩くときは `GIT_CONFIG_GLOBAL` / `NPM_CONFIG_USERCONFIG` を自分で設定する。**
  分離を用意しているのは `scripts/run-unit-tests.mjs` と `.vscode-test.mjs` の側であって
  mocha ではない。`npx mocha ...` を直に実行すると `GitConfigManager.test.ts` の
  Basic Operations / Round Trip が **実物の `git config --global`** を叩き、
  開発マシンの `~/.gitconfig` を書き換える。2026-09-09 に実際に発生（`~/.gitconfig` が
  0 バイトになり `user.email` が消えた）。全件実行の前に必ず:

  ```
  GIT_CONFIG_GLOBAL=<temp>/gitconfig NPM_CONFIG_USERCONFIG=<temp>/npmrc npx mocha ...
  ```

- **テスト後にプロセスが本当に終了したか確認する。** `Get-CimInstance Win32_Process` で
  `mocha|vscode-test` を grep。残っていたら CPU を焼き続ける。

## 外部ツールのスタブ

- **`{stdout:'', stderr:''}` を返すだけのコマンドスタブは書かない。**
  書き込みが永続化されたか捨てられたかを区別できず、fail-closed なポストコンディションを
  検証できない。`src/test/fakeConfigStores.ts` の
  `createFakeGitConfig` / `createFakeNpmConfig` / `createFakePipConfig` を使う。
  set が永続化し、get が読み戻し、未設定キーは実ツールと同じ失敗
  （git exit 1 / 5、pip `No such key`、npm は `null` を print）を返す。

- **ポストコンディションが落ちたテストは、本番側を緩めて直さない。** スタブを実物に近づける。

## 排他制御

- **cross-process な排他は `src/utils/FileLease` だけを使う。** 新しく mtime ベースの
  匿名ロックファイルを書かない。所有者 token + heartbeat がないと ABA で二重保持になる
  （`formal/SharedStateCas.tla` の `TLC-CAS-LEASE-ABA` が反例を出す）。

- **`FileLease` のタイムアウトメッセージは契約。** `Timed out acquiring <name>`。
  `isGitConfigMutexTimeout` がこの文字列に依存している。`name` を変えない。

- **`syncDir` にファイルを増やすときは 2 つ確認する。**
  `SharedStateFile.recover()` が `TEMP_FILE_SUFFIX` を含むファイルを掃除すること、
  `FileWatcher` が state file の basename でフィルタしていること。
  publish lock を `sync-state.lock`（`.tmp` ではない）にしているのはこのため。

## 形式モデル

- **モデルが 1 ステップに抽象化している操作は、実装の分解を疑う。**
  `SyncConvergence` は `Publish(a)` を原子としており、read-compare-write の競合は
  モデルの外だった。ファイルシステム操作単位に分解した `SharedStateCas.tla` で初めて反例が出た。

- 新しい TLC run は `scripts/assurance/run-tla.mjs` の `runs` に追加する。
  バグの存在証明（`invariant-violation` を expected にする run）と
  修正後の証明（`success`）を対にすると回帰に強い。

## ツール操作

- **Bash ツールのヒアドキュメントはバックスラッシュを食う。**
  `<<'PY'` の中の `\n` / `\\` が壊れ、パッチスクリプトが無言で不一致になる。
  バックスラッシュを含むスクリプトは Write ツールでファイルに書いてから実行する。

- `package.nls*.json` は `npm run gen:nls` の生成物。手で編集しない。
  作業ツリーで modified に見えていても中身は改行コード差だけのことがある（`git diff` で確認）。
