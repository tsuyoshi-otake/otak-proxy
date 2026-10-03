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

- **unit lane は worker ごとに tmpdir と Git / npm 設定を分けている（#103）。** `scripts/lib/unit-mocha.mjs` と
  `scripts/unit-worker-isolation.cjs` が持つ。runner を変えたら `npm run test:unit:isolation` を通す。後片付けは
  runner の `finally` で行い、worker の exit handler には置かない（`--bail` が worker を強制終了する）。
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

  2026-10-03 に再発（#97 の verifier）。`ConfigManagers.crossplatform.test.ts` の errorType テストは
  `http://proxy.example.com:8080` を set して**片付けない**。`~/.gitconfig` の `http.proxy` と
  `~/.npmrc` の `proxy` / `https-proxy` が残り、`git push` が名前解決できない proxy で失敗した。
  上の「テストは片付ける」は全テストには当てはまらない。**verifier や subagent に渡す rubric の mocha コマンドにも
  この env を書き**、rubric に無いテストファイルを直接回さないことも明記する。

- **ミューテーション確認は、戻す前の基準実行が緑であることを先に確かめる。** host lane を `MOCHA_GREP` で
  絞ると、既存の失敗テストにも一致することがある（`unsupported PAC` が `Auto + unsupported PAC + reachable fallback`
  に一致した）。grep は Issue 番号（`(#93)` など）で絞る（#93）。

- **host lane が mocha の集計なしで終わったら、成功扱いにしない。** 拡張ホストが exit code 0 で途中終了することがある
  （#85 の verifier と #93 で 2 回。#93 は `Extension startup OFF self-repair` の途中、#85 は位置を記録していない。原因は未特定）。
  1 回だけ再実行し、止まった位置と再実行の件数を記録する。

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
- **自分のコミットの後に置くガードは、そのコミットが書いた revision と比べる。** テスト開始時の世代と比べると、
  自分のコミットで世代が進むので常に stale になる。unreachable テスト後の解除は、このため本番で一度も
  動いていなかった（#97、end-to-end テストで発見）。`commitUnlessStaleWithRevision` が返す revision を使い、
  revision を返さない store では mode と URL の identity で比べる。
- **同じチェックの中で先にコミットしたイベントは、後のイベントを stale にする。** モニタは
  proxyTestComplete → proxyStateChanged → proxyChanged の順に出す。新しい endpoint のテスト完了を先に
  コミットすると proxyChanged が捨てられ、途中で変わった system proxy が保存だけで適用されなかった（#97）。
  `state.autoProxyUrl` と違う endpoint のテスト完了は stale にする。イベント順に関わる修正は、本物の
  `ProxyMonitor` と直列キューを通す flow テスト（`AutoModeOffVerdict.flow.test.ts`）で確かめる。
  主 URL が同じで split（HTTPS URL・bypass）だけ変わる場合も同じ（#102）。モニタは proxyChanged を出す
  チェックのテスト結果と反転に `ReportedProxyChange`（開始時の世代と新しい routing）を付け、先の handler は
  「印の世代がまだ新しく、routing が保存値と違う」ときだけ proxyChanged に任せる。世代の条件を外すと、
  proxyChanged が stale で捨てられたときに判定が両方から消える。印は保存しない（`stripGeneration`）。

## 診断レポート

- **派生フィールドは `runtimeState` から導き、issue リストから別に計算しない。**
  失敗した書き込みは観測対象が無いので issue が出ず、untrusted workspace は requiresUserDecision で
  blocksConvergence ではない。別計算だと `runtimeState` と食い違う。`converged` は
  `runtimeState === 'applied'`（#78, `ee7f8a1`）。

- **issue を足す・変えるときは、`expectsProxyDisabled`（Off、フォールバックの無い Auto: OFF）での impact を決める。**
  proxy を外す期待のときに、拡張機能が上書きしない外部設定（PAC/WPAD）を blocksConvergence にしない。
  状態に依存しない slow cache 由来の issue は、実行ごとのコピーで下げ、cache は書き換えない（#93）。

- **外部ツールの読み取り失敗を「未設定」と同じ値にしない。** 観測に `readFailed` を持たせ、informational の
  `<tool>.readUnavailable` を出し、mismatch と残留チェックは飛ばす（git #16、npm #93）。観測に項目を足したら、
  観測全体を `deepStrictEqual` で比べるテスト（`ProxyRuntimeDiagnostics.test.ts`）も直す。host lane でしか走らない。

- **「検出が変わったか」はモニタの emit とハンドラの両方で判定している。** 同じ規則で比べる
  （`DetectedProxyValue` の `detectionSplitRoutingIdentity` / `splitRoutingIdentity`）。ハンドラだけ直すと、
  split だけの変化ではイベント自体が来ない（#93）。

- **「変化があったら適用する」条件を広げたら、Auto: OFF でも通るか確かめる。** モニタは split だけの変化で
  接続テストをしないので、`proxyReachable` は undefined になり、`!== false` の判定で到達できない proxy を
  有効にしてしまう。Auto: OFF では到達性について新しい情報が無い変化は保存だけにし、回復時の apply が
  保存した値を読む（#93、verifier が発見）。Auto: OFF の各ターゲットの `*Configured` は proxy を外した結果の
  false なので、`hasKnownEnableFailure` を enable 失敗として読まない。テストの state も disable 後の
  実際の値（`*Configured: false`）で作る。`true` のままだと回帰経路を通らずに pass する（#93 の 2 回目の指摘）。

- **ExecutionContext の capability は拡張ホストの実行環境で決める。** `uiKind === Web` は UI がブラウザという意味で、
  拡張ホストは Node のリモートでもよい（`extensionKind: ["workspace"]`、`browser` エントリ無し）。判定は
  純粋関数 `deriveExecutionContext` でテストする（#93、実機は未確認）。

- **状態に入る条件と出る条件は、同じ分類で決める。** #67 で Auto: OFF に入る条件を endpoint unreachable に
  変えたが、出る条件は success のまま残り、3 つの handler の結論が食い違った（#97）。Auto: OFF は endpoint ごとの
  判定にする。unreachable で入り、alive（success、proxy の応答、proxy への TCP 接続）で出る。どちらも証明しない
  結果（接続前の timeout、DNS 失敗、テストなし）では、同じ endpoint の状態を保つ。新しい endpoint は、unreachable で
  ない限り Auto で始める。

## 排他制御

- **cross-process な排他は `src/utils/FileLease` だけを使う。** 新しく mtime ベースの
  匿名ロックファイルを書かない。所有者 token + heartbeat がないと ABA で二重保持になる
  （`formal/SharedStateCas.tla` の `TLC-CAS-LEASE-ABA` が反例を出す）。

- **`ApplyLockService` の読めない（空・途中までの）ロックは、3 つ揃ったときだけ回収する。**
  mtime が TTL より古い（壁時計。注入した `now` はレコードの期限用で、ファイルの古さには使わない）、
  再確認でも読めず mtime が同じ、rename で退避したファイルが読めない。読めたら別ウィンドウが先に回収して
  作った生きたロックなので、`fs.link`（上書きしない）で戻して `held` を返す。期限切れレコードの回収経路の
  ABA は未対応（#93 の範囲外）。

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

- **ローカルの `npm run lint:unicode` はリポジトリの CI より走査ファイル数が多い。** tracked に加えて
  新規で ignore されていないファイルも走査するため（v3.2.14 は未追跡の PBT evidence JSON 16 件で 616 / 600）。
  差が `git ls-files --others --exclude-standard | wc -l` と合わなければ調べる。

- **publish run が失敗しても、push したタグは付け替えない。** 公開前に止まったなら次の patch 版で出し、
  CHANGELOG の失敗した版に「Not published」と理由を書く（v3.2.12 → v3.2.13、#88）。

- **リリースコミットは `CHANGELOG.md` + `package.json` + `package-lock.json` の 3 ファイルだけ。**
  版上げは `npm version <x.y.z> --no-git-tag-version`（lifecycle script なし）。
  タグは annotated で `Release vX.Y.Z`。PR を main に merge してから main HEAD に打つ。

- **`vsce publish` / `ovsx publish` の成功ログは「アップロード成功」であって「公開反映」ではない。**
  実測で Open VSX 約 3〜4 分 / Marketplace 約 5〜7 分の遅延がある（v3.2.14 は約 7 分）。
  レジストリ API でバージョンが切り替わるまで「公開済み」と報告しない。
  Marketplace の判定は `https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery`（POST、
  `filterType: 7` に `<publisher>.<name>`）の `versions[0].version` で行う。版別アセット
  （`<publisher>.gallery.vsassets.io/.../extension/<name>/<version>/assetbyname/...`）は upload から 1 分以内に
  200 を返し、検索 API の切り替わりより約 5 分早い（v3.2.16）ので、公開の証拠にならない。

- **過去のコミットの author / committer は書き換えない（2026-10-03 にユーザーが決定）。** 前のアカウント名と
  勤務先ドメインのメールアドレスのコミットが残っているが、書き換えには force push が要り、既存のタグと
  リリースが壊れる。VSIX には git 履歴が入らない。リリース前チェックでは、前回から新しい ID が増えていないか
  だけを確かめて報告し、書き換えの判断はもう求めない。新しい ID が増えていたら、それは新しい指摘として扱う。

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

- **Codex の再レビュー結果は「Reviewed commit」の sha で判定する。** 結果は新しい issue comment
  （`Codex Review: Didn't find any major issues` か指摘付きのレビュー）の「Reviewed commit: <sha10>」の行で届く。
  要約表のコメント（`codex-pull-request-review-summary`）は最初のレビューで作られ、その後は上書きされる。
  「最後の codex comment に `Completed` と sha の両方」で待った待機スクリプトは結果を見落とした（#97、v3.2.15）。

- `package.nls*.json` は `npm run gen:nls` の生成物。手で編集しない。
  作業ツリーで modified に見えていても中身は改行コード差だけのことがある（`git diff` で確認）。
