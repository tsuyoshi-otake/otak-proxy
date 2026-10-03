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
  開発マシンの `~/.gitconfig` を書き換える。2026-09-09 に実際に発生し、
  `~/.gitconfig` が 0 バイトのファイルとして作られた。

  ただし**既存の設定が消えるわけではない**（検証済み: `[user]` セクションを持つ
  gitconfig に対して `git config --global --replace-all http.proxy <url>` →
  `--unset-all http.proxy` を実行しても `[user]` は残る）。テストは set した値を
  unset して片付けるので、元から存在しなかった場合にだけ 0 バイトのファイルが残る。
  それでも他人のホームディレクトリを汚すので、全件実行の前に必ず:

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

- **実ツールが返さない値は、fake でも返さない。** npm（11.16.0 で確認）は認証情報付きの
  `proxy` / `https-proxy` を `config get` で返さず、`The proxy option is protected` で exit 1 にする。
  `createFakeNpmConfig` がこれを模倣していなかったので、認証情報付き URL の npm 書き込み検証と
  Off の削除が実機で必ず失敗することがテストで見えなかった（CFG-1）。#85 で fake も拒否するようにし、
  user config ファイルの中身は `readUserConfigFile` で返す。

## npm

- **npm 10.8 以降の `config get` は、redact される値をすべて拒否する。** 判定は `isProtected(key) || redact(value) !== value`。
  redact 対象は URL のパスワード、npm token、UUID。`userconfig` のパスも UUID を含むと拒否される
  （scratchpad のパスで実測）。拒否された値は user config ファイルから読み、ファイルの場所が分からない・
  読めない・認証情報付き URL として確かめられないときは推測せず fail-closed にする（#85）。
- **npm の拒否メッセージは版で文言が違う。** 10.8.0〜11.6.1 は `can not be retrieved`、11.6.2 以降は
  `cannot be retrieved`、10.7 以前は拒否せず値を表示する（npm/cli の `lib/commands/config.js` をタグごとに確認）。
  文言で分岐するときは両方に一致させ、対象の版範囲の文言をソースで確かめる。CI（Node 22）は npm 10.9.9 で、
  ローカルの npm 11 とは文言が違った（v3.2.12 の publish が止まった、#88）。
- **npm は `config delete` で最後のキーを消すと、user config ファイル自体を消す。**
  実 npm テストで削除後にファイルを読むなら、先に存在を確かめる（#85）。

## 世代フェンス

- **fence を前進させてよいのは、apply が報告した `committedRevision === fence.revision + 1` のときだけ。**
  観測した revision と identity で「自分のコミット」と判定しない。Auto OFF は identity を保ったまま
  revision を進めるので、他 writer のコミットと区別できない（#78）。
- **修復リトライのテストは本物の `createFencedApply` を通す。** fake applier だけでは
  「自分のコミットでリトライが superseded になる」欠陥が見えない（#78 で既存テストは全 pass だった）。

## 診断レポート

- **派生フィールドは `runtimeState` から導き、issue リストから別に計算しない。**
  失敗した書き込みは観測対象が無いので issue が出ず、untrusted workspace は requiresUserDecision で
  blocksConvergence ではない。別計算だと `runtimeState` と食い違う。`converged` は
  `runtimeState === 'applied'`（#78, `ee7f8a1`）。

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

## リリース

- **`v*` タグの push が publish の唯一のトリガで、不可逆。** `.github/workflows/publish-vscode.yml`
  が VS Marketplace と Open VSX の両方に publish する。タグを打つ前に CI と同じゲートを
  ローカルで通す: `npm run lint` / `npm run test:unit:parallel` / `npm run test:smoke` /
  `npm run lint:unicode:dist`。VS Code host の全件 (`npm test`) は gate ではない。

- **実物の外部ツールを叩くテストは、タグを打つ前に CI と同じ版でもローカルで回す。** CI は ubuntu-latest +
  Node 22（npm 10.9.9）で、ローカルの npm 11 だけでは版差の不具合を見逃す（#88）。npm は `~/tmp` の一時 dir に
  `<dir>/node_modules/npm`（目的の版）と `<dir>/npm.cmd`（Node 同梱の shim のコピー）を揃え、その dir を PATH の
  先頭に置く（`resolveWindowsNpmCli` がこの 2 つを要求する）。`NpmConfigManager` / `NpmUserConfigValue` の
  テストを `GIT_CONFIG_GLOBAL` / `NPM_CONFIG_USERCONFIG` を隔離して mocha で直接回す。

- **CI の unit はローカルより 1 件少なく、1 pending になる。** Windows 専用テスト
  `Windows npm path does not expand %OS% or split on &` が Linux で pending になるため（v3.2.11 と v3.2.13 のログで確認）。
  件数差がこれ以外なら調べる。

- **publish run が失敗しても、push したタグは付け替えない。** 公開前に止まったなら次の patch 版で出し、
  CHANGELOG の失敗した版に「Not published」と理由を書く（v3.2.12 → v3.2.13、#88）。

- **リリースコミットは `CHANGELOG.md` + `package.json` + `package-lock.json` の 3 ファイルだけ。**
  版上げは `npm version <x.y.z> --no-git-tag-version`（lifecycle script なし）。
  タグは annotated で `Release vX.Y.Z`。PR を main に merge してから main HEAD に打つ。

- **`vsce publish` / `ovsx publish` の成功ログは「アップロード成功」であって「公開反映」ではない。**
  実測で Open VSX 約 3 分 / Marketplace 約 5〜6 分の遅延がある。
  レジストリ API でバージョンが切り替わるまで「公開済み」と報告しない。

- **README を変えたリリースは、レジストリが配信している README まで確認する。** 版の切り替わりだけでは足りない。
  Open VSX は `https://open-vsx.org/api/<publisher>/<name>/<version>` の `files.readme`。
  Marketplace は `https://<publisher>.gallery.vsassets.io/_apis/public/gallery/publisher/<publisher>/extension/<name>/<version>/assetbyname/Microsoft.VisualStudio.Services.Content.Details`
  （`marketplace.visualstudio.com/_apis/public/gallery/publishers/.../assetbyname/...` は 404。v3.2.11 で確認）。
  Open VSX の `files.readme` は `openvsx.eclipsecontent.org` への 302 なので、curl は `-L` を付ける
  （付けないと 0 bytes になる、v3.2.13）。配信される README は、vsce が相対リンク（`LICENSE`）を
  GitHub の URL に書き換えた以外はリポジトリの README と同じになる。

## ドキュメント

- **README の設定・挙動の説明は、description 文字列ではなく値を読むコードから書く。**
  `en.json` の description 自体が実装と違うことがある（`diagnosticsEnabled` は diagnose コマンドに効かない、
  `legacyEnvFirstAutoDetection` は読まれるだけで未使用）。「失敗・スキップ時は〜」のようなまとめた言い方は、
  分岐ごとに引数を確認してから書く（スキップでも理由で挙動が逆だった）。書いたら fresh-context で照合する。

- **README に載せるコマンドは、隔離した設定で実際に実行して出力を確かめる。**
  Troubleshooting の `npm config get proxy` が認証情報付きの値で失敗すること、`npm config get userconfig` が
  UUID を含むパスで失敗すること（#85 の修正漏れ）は、README 更新中に実行して初めて分かった。

## ツール操作

- **Bash ツールのヒアドキュメントはバックスラッシュを食う。**
  `<<'PY'` の中の `\n` / `\\` が壊れ、パッチスクリプトが無言で不一致になる。
  バックスラッシュを含むスクリプトは Write ツールでファイルに書いてから実行する。

- **Write ツールは LF で書く。** 作業ツリーは CRLF（core.autocrlf=true、.gitattributes なし）なので、
  Write で丸ごと書いたファイルは CRLF に戻し、CRLF 数と LF 数が一致することを確かめる（README 更新）。

- **Write ツールは行末空白を削る。** 空白だけの行を含むパッチのアンカーは一致しなくなる。
  アンカーに空白行を入れない（#78）。

- **Write / Edit ツールは `\u` + `FEFF` の形のエスケープを、実体の BOM にして書く。** 不可視文字はテストでも
  `String.fromCodePoint(0xFEFF)` で組み立てる（`otak/no-invisible-unicode` と `lint:unicode` が検出した。rules.md 自体にも一度混入した、#85）。

- **Git Bash の `sed -i` は CRLF のファイルを LF にして書き戻す。** rules.md を `sed -i` で 1 行直したら
  全 173 行が LF になった（#88）。CRLF のファイルは node で書き換え、CRLF 数と LF 数が一致することを確かめる。

- **Git Bash の `grep -c $'\r$'` は CR を数えられない。** LF だけのファイルでも全行が一致した。
  改行コードは node で `\r\n` と `\n` の数を数えて確かめる（#85）。

- **`rm -rf` を含む Bash コマンドは権限で拒否される。** テストの隔離ディレクトリは消さず、
  実行ごとに新しい名前（`iso-<版>-<時刻>` など）で作る（#88）。

- `package.nls*.json` は `npm run gen:nls` の生成物。手で編集しない。
  作業ツリーで modified に見えていても中身は改行コード差だけのことがある（`git diff` で確認）。
