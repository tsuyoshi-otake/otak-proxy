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

- **入力を正規化してから検証するときは、正規化が拒否すべき文字を消さないか確かめる。**
  `String.prototype.trim()` は末尾の `\n` も消すので、拒否していた `http://proxy.com/\n` が
  `http://proxy.com/` になり、受理された（property test の反例、#108）。proxy URL の正規化で除くのは ASCII の空白だけ。

- **本番が通らない fallback 分岐は消し、fake には本番と同じ契約を持たせる。** 初回セットアップの
  「`commitState` が無ければ `saveState`」は、テストの fake だけが通った。`calledOnce(saveStateStub)` を見る
  3 件のテストは本番が通らない経路を検査し、分岐は直した欠陥（#109 への指摘 F2）を黙って戻せた。fake に
  revision 付きの `commitState` を持たせ、「何も書かない」の検査は `saveState` と `commitState` の両方を見る（#78）。
  fake の globalState は、本番と同じくすべてのキーを残す。`proxyState` だけを残す fake では v3 の移行が完了を
  記録できず `getState()` のたびに走り、資格情報付きの設定を移行が代わりに処理するので、`getState()` の取り込みの
  分岐をテストが見ていなかった（#108、`src/test/realProxyStateManager.ts`）。すべてのキーを残す fake にすると、
  取り込みが SecretStorage に資格情報を入れる呼び出しを外すミューテーションで「a credential-bearing setting stores the
  secret and rewrites the setting without credentials」が red になった（#108）。

- **ミューテーションが単独で green なら、別の層が吸収していないか調べる。** 「トグル前のスナップショットとの差分」は、
  identity のガードが `moved` にして吸収した。ガードが守らない範囲（同じ proxy の新しい bookkeeping）でテストを
  書くと、単独で red になった（#78、テスト「same-identity bookkeeping committed inside the CAS window is kept」）。
  吸収する層は、上流の処理や再読み込みのこともある。#108 で `ErrorAggregator.addError` のマスクを外しても、Git の
  テストは manager がマスク済みの文を渡すので green だった。Configure で保存済みの URL を残す分岐を外しても、
  再読み込みが SecretStorage から資格情報を引き直し `requiresAuth` も導き直すので green だった。取り込み口のテストには
  未マスクの文を直接渡し、「残す」分岐はコマンド直後に永続化された state で確かめると、どちらも red になった（#108）。

- **テストは本番の合成そのものを呼ぶ。手順の写しを持たない。** #108 の初稿のテストは `applyProxySafely` の手順
  （state を読む → 計画 → フェンス → `applyWithSafety`）を写していて、本番が未解決の options を渡すように壊しても
  緑だった。合成を `runProxyApplyAttempt`（`src/remediation/ProxyApplyAttempt.ts`）に移して本番とテストが同じ関数を
  呼ぶと、同じミューテーションで 6 件が red になった（#108）。

- **テストの state は本番の書き込み経路（`ProxyStateManager.saveState`）で作る。** 資格情報付きの state を globalState に
  直接書くと、本番には存在しない state になる（永続化は資格情報を外して SecretStorage に分ける）。#108 の初稿はその
  state を通すために `V3MigrationService` の候補を変え、primary と衝突時の優先順位まで変えていた。存在しない state の
  ためにプロダクションコードを変えない。

- **`saveState` の後は、globalState を直接書き換えても `getState()` には見えない。** `saveState` は in-memory の state
  を設定し、`getState()` はそれを返す。テストの途中で state を動かすときは、`getState()` から見える形で動かし、守る
  不変条件を壊すミューテーションで red になることを確かめる。#108 のテスト「state moves under the open prompt」は seed を
  `saveState` に変えた後も globalState を直接書いていて、「applier が同意の後で state を読み直す」ミューテーションでも
  緑だった（独立 verifier が out/ のコピーで確認）。

- **`vscode` の API をスタブするテストは `vscode` を直接 import する。** `scripts/run-unit-tests.mjs` はテストファイル中の
  `import/require('vscode')` で host lane に振り分ける。再エクスポートするヘルパー（#108 の初稿の
  `src/test/vscodeRuntime.ts`）は振り分けをすり抜けて unit lane に残り、2 つ目の流儀になる。直接 import に直すと、
  10 件が host lane に移った（#108）。

- **別のテストと「同じ」結果を示すテストは、同じアサーションを持つ。** レビューでは、テスト名と前提ではなく
  アサーションを 1 つずつ突き合わせる。#108 の書き込み失敗のテストは、片方だけ復元するテストと前提はそろって
  いたが、ゲートの戻り値しか確かめず、同期の受信側（apply しない、`lastError`、何も書かない）を見ていなかった
  （独立 verifier が指摘、レビューでは見落とした）。受信側のアサーションを足すと、受信側のゲートを外す
  ミューテーションで red になった（#108）。

- **ガードや判断の入力を足すブリーフは、守る操作へのすべての経路を表にしてから書く。** #108 項目 1 のブリーフは、
  資格情報のゲートを既存の置き場所（起動と同期）のまま広げ、監視とトグルの経路、起動の reconcile の署名、
  結果コミットの世代を見落とした。3 つとも Codex が見つけた。書き込み関数の呼び出し元を `git grep` で列挙し、
  各行で「ガードを通るか」「判断の入力が再実行の署名に入っているか」「コミットの世代は計画と同じ読み取りか」を
  確かめてからブリーフに書く（#108）。
  表の各行は、本番でその経路が実際に走るかも確かめる。#108 項目 5、6、11 の 1 回目のレビューのブリーフは起動時の移行
  （`migrateManualUrlFromConfig`）に検証を足させたが、`activate()` が先に `getState()` を呼び、その取り込みが手動 URL を
  埋めるので、移行の本体は本番で走らなかった。実際の `ProxyStateManager` を `out/` の probe で通すと、無効な値が
  state に入り、後の保存で永続化されるのが見えた（#108）。
- **ブリーフで既存の関数を使わせるときは、その関数の副作用を読み、呼ばれる頻度と合わせて書く。** #108 項目 5、6、11 の 2 回目の
  レビューのブリーフは、`getState()` のたびに走る取り込みに `canonicalizeValidProxyUrl` を指定しつつ「ここではログを出さない」と
  書いた。この関数は無効な値で `Logger.error` を出すので、無効な設定のままだと `getState()` のたびに
  エラーが出た（検出の経路の `SystemProxyUpdateService.ts` だけで `getState()` の呼び出しが 6 か所ある）。ログを出さない
  `tryCanonicalizeProxyUrl` に分け、取り込み、起動時の確認、Configure の初期値をログを出す形に戻すミューテーションは、
  `Logger.error` を stub したテストでどれも red になった（#108）。

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

- **再エクスポートした関数は、定義したモジュールで stub する。** tsc は `export { x } from './y'` を getter に
  コンパイルする。`sinon.stub(ProxyUtils, 'testProxyConnectionParallel')` は例外を出さずに成功するが、
  `ProxyUtils.testProxyConnectionParallel` は本物の関数を返し続ける。定義元の `utils/ProxyConnectionTest` を
  stub すると、ProxyUtils 経由の呼び出しにも効く（sinon 21.1.2 と `out/utils/ProxyUtils.js` で確認、#78）。

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

- **revision を含む署名やガードは、自分の apply の結果コミット（revision +1）で必ず stale になる。**
  比べるのは apply が返す `committedRevision`、または mode と URL の identity。コマンドの flow テストは
  本物の `ProxyStateManager` と revision を進める applier を通す。stub context は revision を進めないので、
  toggle が mode を保存しない欠陥（#78 の症状をコードで再現した原因、2026-10-18 監査）は全テスト pass のまま
  v3.2.7〜v3.2.16 に出荷された。初回セットアップの署名と起動ループの署名にも同じ取り違えがあった。
- **目的の状態は apply の前にコミットし、最新の保存値には自分が決めたフィールドの差分だけを重ねる。**
  持ち主は `commitDecidedPatch`（`src/core/ApplyConvergence.ts`）で、トグルと初回セットアップが使う。
  トグルは `convergencePending: true` でコミットしてから apply する（apply 中の診断が新しい mode を読む）。
  差分は、検出の後に読み直した state と決定の差（`diffProxyState`、キーの和集合。決定で消したフィールドは消す）。
  スナップショット全体や、検出のときに読んだ値のコピーを重ねると、その後に他 writer が書いた検出・テスト結果を
  消す（#109 への Codex の指摘 F5、F2）。CAS の結果は分けて扱う: revision だけが進んだら重ね直す、mode が
  変わったら superseded、同じ mode で identity が変わったら決め直す、上限まで負けて最後の読み直し（次の項目）
  でもガードを通ったら失敗としてエラーを出す（success を返すと、何も起きないトグルになる、F4）。（#78、各分岐は
  ミューテーションで回帰テストが red になることを確認）
- **CAS を使い切ったら、最新の state をもう一度ガードにかけてから `exhausted`（失敗）と決める。**
  3 回目の負けで勝ったのが別のウィンドウのトグルや新しい検出なら、失敗ではなく `moved`（superseded か決め直し）。
  この読み直しが無かったので、他 writer の正当な変更で「トグル失敗」が出た（#111 への Codex の指摘 F6）。
  読むのは `writer.getState()` で、`superseded` の結果の `current` ではない。`commitState` が返す保存値は
  資格情報を持たないことがあり、`proxyUrlIdentity` は資格情報を含むので、identity が変わったと誤判定する
  （テスト「the moved/exhausted check reads through getState, not the superseded payload」がミューテーションで
  red になることを確認、#78）。
- **初回セットアップの完了の印（`hasInitialSetup`）は、回答を保存できたときだけ書く。** セットアップは
  `exhausted` を `moved` と同じ「終わった」に畳み、`performInitialSetup` が印を書いて、保存されなかった回答は
  二度と聞かれなかった（F7）。`askForInitialSetup()` は `exhausted` のときだけ false を返し、セットアップは
  `error.initialSetupNotSaved` を出す。次の起動で再び聞く（#78、ミューテーションで red を確認）。
- **再試行のラウンドで、ユーザーの意図を読み直した state から計算し直さない。** トグルの次の mode は今の mode
  から決まる。ラウンド 2 で計算し直すと、別のウィンドウが先に Auto を保存したときに Off をコミットし、相手の
  選択を打ち消した（テスト「a mode change before a re-decide round supersedes instead of undoing it」、修正前は `false !== true`）。`fromMode` / `nextMode` は最初の読み取りで固定し、
  mode が変わっていたら superseded にする（#78）。
- **やり直しうる決定の中で、ユーザーに見える副作用を実行しない。** トーストやプロンプトは集めておき、コミットが
  通ったラウンドの apply の後だけ実行する。決定の中で出すと、決め直すたびに出て（2 回）、失敗した
  トグルでも「トグル失敗」と並んで出た（テスト「the fallback toast fires once, only for the committed round」と
  「a failing toggle shows no fallback toast alongside the error」、#78）。
- **結果コミットの世代は、計画を作った読み取りの世代を渡して使う。applier の中で読み直さない。**
  `createFencedApply` は今の fence を `basis` として applier に渡し、`applyProxyDetailed` / `disableProxyDetailed` は
  それで `saveProxyConfigResults` / `recordApplyBlocked` をコミットする。basis が無い直接の呼び出しだけが読み直す。
  読み直すと、fence の確認と書き込みの間に別のウィンドウがコミットした新しい状態に、古い計画の結果が載る。その
  コミットで revision が進み、新しい状態自身の fenced apply が superseded になる（PR #112 への Codex の指摘。
  basis を無視する、fence を渡さない、無効化への委譲で basis を落とす、の各ミューテーションで red、#108）。
  引数を有効化と無効化の両方の分岐に通す変更は、分岐ごとにミューテーションを当てる。無効化で basis を無視する
  ミューテーションは、最初は新しいテストがすべて green のまま残った。
- **再実行を決める署名には、守る判断が読む入力をすべて入れる。** 起動の reconcile の署名（`startupEnforcementTarget`）に、
  起動のゲートと書き込み計画が読む `authRequiredProxyUrls` と split の URL（`splitRoutingIdentity`）が無かった。
  それだけが apply 中に変わると、古い判断のまま止まった（PR #112 への Codex の指摘。どちらかを外すと red、#108）。

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

## 資格情報と URL

- **SecretStorage の資格情報キーは、公開 URL の WHATWG href の sha256。保存する URL の綴りはキーに影響しない。**
  保存側（`splitProxyUrl().publicUrl`）も参照側（`getProxyPublicUrl()` → `toPublicProxyHref`）も、
  `new URL()` で userinfo を空にして直列化し直す（末尾 `/` 付き、scheme と host は小文字）。
  `http://proxy:8080`、`http://proxy:8080/`、`HTTP://PROXY:8080` は同じキーになる。生の文字列を
  `getCredentialKeyForPublicUrl` に渡したときだけ、別のキーになる。キーを引く経路を足すときは `getProxyPublicUrl` を通す
  （node で out/ を読み込んで確認、#108、2026-10-18）。

- **資格情報は proxy のアドレス（公開 URL）単位で保存・復元される。同じアドレスの URL は、どのフィールドでも
  同じ資格情報で復元される。** `hydrateStateForRuntime` は `autoProxyUrl` / `autoHttpProxyUrl` / `autoHttpsProxyUrl` を
  同じキーで引く。`HTTP_PROXY=http://proxy:3128` と `HTTPS_PROXY=http://user:secret@proxy:3128` を保存して再読み込みすると、
  3 つとも資格情報付きで復元され、書き込み計画は 1 つの URL に畳まれる（out/ の probe とテスト「same-host split: after a
  reload every written URL is one consent judged」で確認、#108）。本番で `deleteCredentialsForPublicUrl` を呼ぶ経路は無いので、
  URL から外した資格情報も復元時に付き直る。scheme ごとの資格情報を扱う変更のテストには、両 scheme が同じアドレスの
  場合を必ず入れる。

- **applied-proxy の provider が返す URL と、拡張が `http.proxy` に書いた値は一致しないことがある。** provider は
  hydrate 済みの `autoProxyUrl` を返す。同じアドレスの資格情報が SecretStorage にあれば資格情報付きになり、綴りは
  WHATWG で正規化される（ホストは小文字、既定ポートなし）。検出経路（`SystemProxyUpdateService.saveAndApplyAutoProxyState`、
  監視の経路）は検出した URL をそのまま書くので、Windows / macOS の proxy なら資格情報が無く、綴りも検出したまま。
  エコー判定を資格情報まで一致させると自分の書き込みを検出し直し、OS の proxy の変更を拾えなくなる（#29 の再発、
  out/ の probe で再現、#108）。資格情報の無い候補は、同じアドレスならエコーとして扱う。資格情報付きの候補は
  `sameProxyUrlWithCredentials`（秘密のキーと同じ `splitProxyUrl` で分解）で比べ、文字列の完全一致では比べない
  （再読み込みを通したテストで確認。完全一致に戻すと red になる、#108）。

- **資格情報が要るかどうかは、proxy のアドレスごとに記録する。** `requiresAuth` は真偽値なので、split の 2 つの
  アドレスのうち片方だけが復元された場合（SecretStorage への書き込みの失敗、片方の秘密しか持たないマシン）を区別できない。
  `authRequiredProxyUrls` に資格情報付きだった公開 URL を残し、`planUrlsMissingRequiredCredentials` が、資格情報の無い
  計画 URL のうち一覧にあり、同じ公開 URL の資格情報付き計画 URL も無いものを返す。集合に `some` を当てて不変条件を
  判定するときは、その性質が要素ごとに要るのかを確かめる（片方だけ復元するテストと書き込み失敗のテストで確認。
  `some` だけに戻すと red になる、#108）。
- **書き込みの不変条件は、すべての書き込みが通る 1 か所で守る。** 資格情報が要るアドレスを資格情報なしで書かない
  判定は `runProxyApplyAttempt` の中（計画を解決した後、同意と書き込みの前）にある。起動と同期の呼び出し元だけに
  置いていたときは、監視の到達性の経路が片方の資格情報なしで書いた（PR #112 への Codex の指摘。判定を外すと
  監視の経路のテストが red、#108）。
- **6 つの URL フィールドから導く集約フラグ（`requiresAuth`）で、計画の一部についての判定をしない。** 手動の
  fallback の資格情報だけで、資格情報の無い system proxy の apply まで拒む（3.2.16 も起動と同期で拒んでいた）。
  一覧がある state ではアドレスごとの規則だけを使い、集約規則は一覧の導入前に保存された state にだけ残す
  （集約規則を先に戻すミューテーションで「list present: no skip」が red、#108）。
- **任意の文字列から資格情報を消す規則は、`maskCredentialOccurrences`（`src/security/ProxySecretRedactor.ts`）1 か所が
  持つ。** URL の資格情報と scheme の無い資格情報の正規表現（どちらも `/g`）は非公開で、置き換える文字列は呼び出し元が
  渡す（表示とログは `user:****@`、診断と永続化は `<credentials>@`）。エラー文は `ErrorAggregator.addError` で取り込む
  ときにマスクし、`lastError` へのコミットで redaction を重ねない（`redactString` は改行を `\n` の文字列に変え、tooltip に
  そのまま出る）。正規表現を 2 か所に持っていたときは、片方だけが直されて境界がずれた（#108 項目 5、11）。
- **WHATWG の URL 解析は、special scheme の `\` を `/` として扱う。** `http://DOMAIN\user:pass@proxy:8080` は host が
  `domain`、パスが `/user:pass@proxy:8080` になり、`username` と `password` は空になる。`new URL()` の結果だけで資格情報が
  無いと判断せず、直列化した文字列にも文字列のマスクを当てる（node で確認、#108 項目 11）。
- **設定の `otakProxy.proxyUrl` が state に入る経路は、どれも同じ検証と正規化を通す。** 設定変更のハンドラ
  （`CommandRegistry.handleProxyUrlChange`）と、`getState()` の取り込み（`normalizeConfiguredManualProxyUrl`。
  `migrateOldSettings` も使う）。無効な値は state に入れず、SecretStorage にも設定にも書かない。取り込みは `getState()` の
  たびに走るので、ログを出さない形（`tryCanonicalizeProxyUrl`、`src/utils/ProxyUrlUtils.ts`）を使い、無効な設定の
  警告は起動時に 1 回だけ出す（#108）。

## ドキュメント

- **README の設定・挙動の説明は、description 文字列ではなく値を読むコードから書く。**
  `en.json` の description 自体が実装と違うことがある（`diagnosticsEnabled` は diagnose コマンドに効かない、
  `legacyEnvFirstAutoDetection` は読まれるだけで未使用）。「失敗・スキップ時は〜」のようなまとめた言い方は、
  分岐ごとに引数を確認してから書く（スキップでも理由で挙動が逆だった）。書いたら fresh-context で照合する。

- **README に載せるコマンドは、隔離した設定で実際に実行して出力を確かめる。**
  Troubleshooting の `npm config get proxy` が認証情報付きの値で失敗すること、`npm config get userconfig` が
  UUID を含むパスで失敗すること（#85 の修正漏れ）は、README 更新中に実行して初めて分かった。

- **CHANGELOG や PR の「以前は〜だった」は、main のコードで確かめてから書く。**
  #108 の URL 正規化の下書きは、`HTTP://` を「拒否されていた」と書いた。main の scheme 判定は大文字小文字を
  区別していたので、`HTTP://` は authority の検査を素通りして受理されていた。

- **処理の順序や分岐を変えたら、ARCHITECTURE.md の該当フローも同じ変更で直す。** #109 はトグルのコミットと
  apply の順を入れ替えたが、ARCHITECTURE.md の 2 か所は「apply → 保存」のまま残った（#78 の追補で直した）。
  `git grep -n -i "<機能の語>" -- README.md ARCHITECTURE.md CLAUDE.md src/test/README.md` で探す。

## VS Code ホストの前提

- **`http.proxy` は local window で APPLICATION scope。Settings Sync で他の端末へ同期される。**
  既定の同期除外は MACHINE / MACHINE_OVERRIDABLE / `ignoreSync` だけで、`http.proxy` はどれでもない。
  remote window（`http.useLocalProxyConfiguration` 既定）では、拡張の Global 書き込みが local の
  settings.json に入る。VS Code 1.106.3 と 1.141.0 の workbench bundle で確認（2026-10-18 監査）。
  VS Code の挙動を前提にする判断は、ドキュメントや推測ではなく bundle の実コードで確かめる。
  エージェントの 1 体は scope 1 を machine と読み違えて「同期されない」と結論した。

- **拡張ホストの `http` / `https` は `@vscode/proxy-agent` でパッチされる（`http.proxySupport` 既定 `override`）。**
  localhost / 127.0.0.1 以外への `http.request` は `http.proxy` → env → OS の proxy 経由になり、接続失敗は
  errno の無い "Failed to establish a socket connection to proxies" になる。loopback の fake はこの経路を
  通らないので、接続テストの判定はテストと本番で別の経路を通る（1.106.3 の proxy-agent 0.36.0、
  1.141.0 の 0.45 系で確認）。

## ツール操作

- **Bash ツールのヒアドキュメントはバックスラッシュを食う。**
  `<<'PY'` の中の `\n` / `\\` が壊れ、パッチスクリプトが無言で不一致になる。
  バックスラッシュを含むスクリプトは Write ツールでファイルに書いてから実行する。

- **Devin のシェル経由のヒアドキュメント（`node <<'EOF'`）は非 ASCII を壊す。** 文字がコンソールの
  コードページ 932 を通り、16 ロケールのうち 15 個の翻訳が `?`、U+FFFD、ダイアクリティカルマークの欠落に
  なった（テストは全部 pass、レビューで発見、#78）。非 ASCII はファイルツールで UTF-8 のファイルに書かせるか、
  ASCII だけのソースに `\u` エスケープで書かせる。確かめるときはコンソールの表示を信じず、node で
  コードポイントを読むか、UTF-8 のファイルに書き出して Read で読む。

- **Write ツールは LF で書く。作業ツリーの改行コードはファイルごとに違う。** core.autocrlf=true、
  .gitattributes なしで、2026-10-18 の `git ls-files --eol` は w/crlf 397、w/lf 191、w/mixed 25。
  編集の前に node で数え、そのファイルの改行コードを保つ（CRLF のファイルは CRLF 数と LF 数が一致する、
  LF のファイルは CR が 0）。「README は LF」「作業ツリーは CRLF」と一般化して、2 回とも間違えた（#78）。

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

- **PR を作ったら、Codex の自動レビュー（`chatgpt-codex-connector[bot]`）が届くまでマージしない。**
  #109 は作成（01:24:00Z）の 1 分 39 秒後にマージし、P2 の指摘 5 件はマージ後の 01:30:02Z に届いた。
  直しは別の PR になった。作成から 10 分ほど待ち、届いた指摘は同じ PR で直す（#78、#108、2026-10-18）。
  届き方: 指摘ありは inline comment 付きのレビューで届く（#109）。指摘なしはレビューも新しいコメントも付かない。
  要約コメント（`codex-pull-request-review-summary`）の `codex-review-state` が `"status":"completed"` と
  `"has_any_findings":false` になり、PR に 👍 のリアクションが付く（#110 は作成の 2 分 26 秒後）。
  見る場所: `gh api repos/tsuyoshi-otake/otak-proxy/issues/<N>/comments` の要約コメントと、同じ issue の `reactions`。

- **公開 Issue で項目番号を `#1` の形で書くと、同じ番号の別の Issue / PR に自動リンクする。**
  コメントでは code span で書くか、「項目 1」と書く（#108 の本文で起きた、2026-10-18）。

- `package.nls*.json` は `npm run gen:nls` の生成物。手で編集しない。
  作業ツリーで modified に見えていても中身は改行コード差だけのことがある（`git diff` で確認）。
