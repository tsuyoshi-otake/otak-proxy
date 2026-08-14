# 要件定義書

## はじめに

本仕様は、otak-proxyのドメインモデル及び永続化・外部連携を含む状態fulな処理について、実装ロジックから独立した判定基準を構築し、テストの欠陥検出力と残存リスクを定量的に評価するための要件を定義する。

対象は、Off／Auto／Auto OFF、システムプロキシと手動fallback、複数設定対象へのapply／clear、接続検査と再試行、remediation、複数インスタンス同期、競合解決、永続化及びライフサイクルである。現行のプロダクト方針であるOff ↔ Autoの2状態切替を正とし、過去仕様に残るManual mode等の設計履歴は現行要件として扱わない。

検証は「テストが成功した」という事実だけでは完了としない。要件、オラクル、テスト、形式モデル、実装及び実行証跡を追跡可能にし、未検証範囲、仮定、探索限界及びsurviving mutantを含めてリリース判断を行う。

## 用語集

- **ドメイン判断**: 入力状態、イベント及び不変条件から、次状態、出力又は副作用の要否を決定する規則
- **独立オラクル**: 本番実装の制御フロー、条件式、定数又は本番関数の戻り値を期待値生成に再利用せず、要件と状態遷移表から結果を導出する判定器
- **具体例ベーステスト**: 要件の代表例、境界値及び既知の回帰例について、明示した入力と期待結果を検証するテスト
- **PBT**: Property-Based Testing。生成した入力列又はイベント列に対して不変条件、参照モデル又はメタモルフィック関係を検証する方法
- **seed**: PBT又は探索を再現するための乱数初期値
- **縮小後の反例**: PBTのshrink処理後に得られた、性質を破る最小化された入力又はイベント列
- **replay path**: seedと組み合わせて縮小過程又は反例を再現する識別情報
- **原子条件**: 複合判定を構成し、それ以上論理演算子で分割しない真偽式
- **C2**: 各原子条件がTrueとFalseの両方に評価されたことを確認する条件網羅
- **mutant**: 欠陥を模擬するために実装へ単一の構文又は意味変更を加えた変異体
- **surviving mutant**: テストが失敗せず、生存したmutant
- **equivalent mutant**: 観測可能な全入力で元実装と同じ意味を持つことを根拠付きで示したmutant
- **調整後mutation score**: equivalent mutantを分母から除外して算出したmutation score
- **永続化境界**: globalState、SecretStorage、VS Code設定、共有ファイル、instance registry又は外部CLI設定など、状態がプロセス外へ保存される境界
- **プロトコル互換のテスト用依存先**: 本番依存先と同じ入力、出力、エラー分類、タイムアウト及びライフサイクル契約を提供するfake又はtest double
- **failure injection**: 指定した操作回数又は状態で、遅延、例外、部分書込み、重複、欠落その他の障害を決定的に注入する検証方法
- **terminal state**: 成功、失敗、部分成功、cancelled、skippedその他、呼び出し元が処理完了として観測できる明示的な最終状態
- **Safety**: 常に維持されなければならない不変条件
- **Liveness**: 明示した環境及び公平性仮定の下で、最終的に成立しなければならない性質
- **公平性仮定**: 実行可能なActionが無期限に選択されないことを排除する仮定
- **探索制約**: 状態又は遷移の探索を有限化・削減するために設定した定数、境界、対称性、state constraintその他の条件
- **検証証跡**: 実行コマンド、tool version、設定、seed、結果、統計、反例及び分析を再検査可能な形で保存した成果物

## 要件

### 要件 1: 検証対象と根拠の固定

**ユーザーストーリー:** リリース責任者として、検証対象と正しい振る舞いの根拠を一意に特定したい。これにより、実装に合わせて期待値を後付けすることを防止できる。

#### 受入基準

1. **DVA-1.1** WHEN 検証を開始する THEN 検証システムは対象要件、ドメイン判断、状態、イベント、遷移、副作用及び永続化境界へ安定した識別子を付与する
2. **DVA-1.2** WHEN 正しい結果を定義する THEN 検証システムはsteering、承認済み要件及び明示された不変条件を根拠として記録する
3. **DVA-1.3** IF 過去仕様と現行steering又は出荷中の2状態モデルが競合する THEN 検証システムは現行steeringを優先し、競合内容を設計履歴として記録する
4. **DVA-1.4** WHEN 対象外又は非該当と判定する THEN 検証システムは理由、影響及び代替検証の有無を記録し、暗黙に除外しない
5. **DVA-1.5** WHEN 検証中に要件違反の可能性を発見する THEN 検証システムは期待結果、実測結果、最小再現条件及び影響範囲を証跡へ記録する

### 要件 2: 独立オラクルと具体例ベーステスト

**ユーザーストーリー:** 開発者として、実装と同じ誤りを期待値側へ複製しないテストを持ちたい。これにより、テストと実装が同時に誤る共通モード故障を抑制できる。

#### 受入基準

1. **DVA-2.1** WHEN ドメイン判断の期待結果を生成する THEN オラクルは本番関数、本番条件式、本番定数又は本番の結果集約処理を呼び出さない
2. **DVA-2.2** WHEN オラクルを定義する THEN オラクルは要件識別子、入力状態、イベント、前提条件、期待次状態及び期待出力を明示する
3. **DVA-2.3** WHEN 具体例ベーステストを作成する THEN テストは正常例、境界値、無効値、部分成功及び既知の回帰例を含む
4. **DVA-2.4** WHEN 実装とオラクルの結果を比較する THEN テストは最終値だけでなく、許可された副作用、禁止された副作用及びterminal stateを比較する
5. **DVA-2.5** WHEN オラクル自身を検証する THEN 検証システムは要件から直接導いた決定表と既知の誤実装に対するnegative controlを使用する
6. **DVA-2.6** IF オラクルと実装が不一致となる THEN 検証システムは実装を正として期待値を自動更新せず、要件、オラクル又は実装のどこに原因があるかを分類する

### 要件 3: Property-Based Testingの再現性と反例保存

**ユーザーストーリー:** 開発者として、ランダム生成でのみ発生した失敗を同一条件で再現したい。これにより、縮小された反例を修正及び回帰テストへ利用できる。

#### 受入基準

1. **DVA-3.1** WHEN PBTを実行する THEN 検証システムはproperty識別子、seed、実行回数、生成器設定及び実行結果を保存する
2. **DVA-3.2** WHEN PBTが失敗する THEN 検証システムは元のseed、replay path、縮小後の反例、縮小回数及び失敗した性質を保存する
3. **DVA-3.3** WHEN 保存した失敗証跡を指定する THEN 検証システムは同じ反例と失敗理由を単独コマンドで再現できる
4. **DVA-3.4** WHEN stateful PBTを実行する THEN 生成対象は単一入力だけでなく、イベント列、重複、欠落、順序逆転、競合及び再起動境界を含む
5. **DVA-3.5** WHEN PBTが成功する THEN 検証システムは成功runのseedも保存し、反例が存在しないことを明示する
6. **DVA-3.6** WHEN PBT基盤を校正する THEN 既知の誤実装に対して失敗とshrinkが発生し、保存した最小反例がreplayできることを検証する
7. **DVA-3.7** WHEN 並列PBTを実行する THEN 証跡書込みはproperty間で衝突せず、各runを一意に識別できる

### 要件 4: 原子条件単位のC2計測

**ユーザーストーリー:** 品質責任者として、判定全体の分岐だけでなく、判定を構成する各条件が両方の真偽値を取ったことを確認したい。これにより、短絡評価に隠れた未検証条件を発見できる。

#### 受入基準

1. **DVA-4.1** WHEN C2対象を定義する THEN 検証システムは各ドメイン判断を原子条件へ分解し、source位置、条件式及び対応要件を記録する
2. **DVA-4.2** WHEN 対象テストを実行する THEN 検証システムは各原子条件のTrue観測数、False観測数及び未評価数を記録する
3. **DVA-4.3** WHEN 短絡論理を評価する THEN 検証システムは右辺が未評価だった事実をTrue又はFalse観測として誤集計しない
4. **DVA-4.4** WHEN C2結果を報告する THEN 検証システムはraw C2、実行可能条件のC2及び未観測条件一覧を分けて提示する
5. **DVA-4.5** IF 原子条件が要件上の不変条件により片方の値を取れない THEN 検証システムは到達不能の根拠を記録し、根拠のない除外を認めない
6. **DVA-4.6** WHEN リリース可否を判定する THEN 実行可能な対象原子条件のC2は100%でなければならない
7. **DVA-4.7** WHEN C2を計測する THEN instrumentationはテスト用成果物だけへ適用され、本番source及び配布artifactを変更しない

### 要件 5: Mutation Testingとmutant分類

**ユーザーストーリー:** 品質責任者として、テストが実際に意味のある欠陥を検出できるか確認したい。これにより、高いコードcoverageだけでは分からない検出力を評価できる。

#### 受入基準

1. **DVA-5.1** WHEN mutation testingを実行する THEN 検証システムは対象source、mutator、tool version、設定、timeout及び実行コマンドを保存する
2. **DVA-5.2** WHEN mutantを評価する THEN 検証システムはkilled、survived、timeout、no coverage、compile error、ignored又はequivalentへ分類する
3. **DVA-5.3** WHEN mutantがsurviveする THEN 検証システムは対応要件、変異内容、到達入力、観測可能性及び追加テストの要否を分析する
4. **DVA-5.4** WHEN mutantをequivalentと分類する THEN 検証システムは型、不変条件、意味保存変換又は全入力に対する同値性の根拠を記録する
5. **DVA-5.5** IF equivalentであることを十分に示せない THEN 検証システムは当該mutantをsurviving mutantとして扱う
6. **DVA-5.6** WHEN scoreを報告する THEN 検証システムはraw score、equivalent件数、調整後score及び未分類件数を分けて提示する
7. **DVA-5.7** WHEN release-criticalなドメイン判断を評価する THEN 非equivalent surviving mutantは0でなければならない
8. **DVA-5.8** WHEN リリース可否を判定する THEN 調整後mutation scoreは90%以上かつ未分類mutantは0でなければならない

### 要件 6: 状態・イベント・遷移・永続化境界の棚卸し

**ユーザーストーリー:** 開発者として、状態fulな処理の所有者と永続化点を先に理解したい。これにより、中間状態が偶発的な最終状態になることを防止できる。

#### 受入基準

1. **DVA-6.1** WHEN 永続化又は外部連携を検証する THEN 検証システムは状態、イベント、guard、遷移、副作用、永続化境界及びterminal stateを先に台帳化する
2. **DVA-6.2** WHEN catch、skip、retry、delegate又はerror suppressionを含む分岐を台帳化する THEN 最終化の所有者と呼び出し元からの観測方法を記録する
3. **DVA-6.3** WHEN globalState、SecretStorage、VS Code設定、CLI設定、terminal environment、共有状態ファイル又はinstance registryを扱う THEN 各境界の整合性、atomicity、idempotency及び再起動時の復元規則を記録する
4. **DVA-6.4** WHEN timer、polling、retry又はrefresh flowを扱う THEN 最大並行数、in-flight重複抑止、backoff、rate-limit待機及び停止時の所有権を記録する
5. **DVA-6.5** WHEN cancellation又はtimeoutが発生する THEN 進行中処理と遅延完了結果の扱いを定義し、停止後の新規副作用を禁止するか明示的に許容・観測可能にする
6. **DVA-6.6** IF 現行実装に明示的terminal state又は復旧所有者がない THEN 検証システムはその欠落を未検証として扱わず、要件違反候補及び残存リスクとして記録する

### 要件 7: プロトコル互換依存先によるAPI結合・契約テスト

**ユーザーストーリー:** 開発者として、単純な戻り値stubだけでなく、本番依存先の契約を再現した環境で境界処理を検証したい。これにより、引数、出力形式及びエラー分類の不一致を検出できる。

#### 受入基準

1. **DVA-7.1** WHEN テスト用依存先を接続する THEN 依存先は本番と同じ入力形、出力形、終了状態、エラー種別、遅延及びライフサイクル契約を提供する
2. **DVA-7.2** WHEN Git、npm又はpip連携を検証する THEN 契約テストは実行ファイル、引数順序、環境変数、timeout、stdout、stderr及びexit codeの解釈を検証する
3. **DVA-7.3** WHEN VS Code API境界を検証する THEN 契約テストはMemento、SecretStorage、Configuration、設定変更event及びEnvironmentVariableCollectionの観測可能な契約を検証する
4. **DVA-7.4** WHEN ファイル同期境界を検証する THEN API結合テストは実filesystem上のatomic write、rename、watch、poll、破損読取り及び複数actorの競合を検証する
5. **DVA-7.5** WHEN 接続検査境界を検証する THEN API結合テストはローカルのprotocol互換proxy又はserverを用いて成功、拒否、遅延、切断及びtimeoutを検証する
6. **DVA-7.6** WHEN optional toolが利用不能である THEN 契約テストはskippedUnavailableと実config errorを区別し、利用不能を全体失敗として誤分類しないことを検証する
7. **DVA-7.7** WHEN test doubleと実境界の抽象化差がある THEN 検証システムは差分と未再現のOS又はprovider動作を残存リスクへ記録する

### 要件 8: Failure Injectionと復旧状態遷移

**ユーザーストーリー:** 運用担当者として、外部依存が不安定又は部分的に壊れた場合でも、処理が明示的な状態へ収束し復旧できることを確認したい。

#### 受入基準

1. **DVA-8.1** WHEN failure injectionを実行する THEN 検証システムは故障対象、注入時点、発生回数、継続時間及び解除条件を決定的に指定する
2. **DVA-8.2** WHEN 境界値を検証する THEN 0、1、最大値、最大値直前、最大値超過、空集合及び単一actorを該当する状態・資源上限へ適用する
3. **DVA-8.3** WHEN 複数対象の一部だけが失敗する THEN システムは成功、失敗、skip及び外部所有保持を個別に記録し、全体を誤って完全成功としない
4. **DVA-8.4** WHEN retryを検証する THEN システムは上限、backoff、成功時reset、Retry-After相当の待機及び上限到達後のterminal stateを検証する
5. **DVA-8.5** WHEN eventの重複、欠落又は順序逆転を注入する THEN システムはidempotency、stale update拒否及び最終収束を検証する
6. **DVA-8.6** WHEN cancellation又はtimeoutを注入する THEN システムはcancelled又はtimeoutの観測結果、in-flight処理の所有者、遅延完了結果及び停止後副作用を検証する
7. **DVA-8.7** WHEN crash／restartを注入する THEN システムは永続済み状態の復元、不完全なjournal又はlockの処理、重複applyの抑止及び資格情報の非漏洩を検証する
8. **DVA-8.8** WHEN ENOSPC、EMFILE、権限不足、lock枯渇又はqueue上限などの資源枯渇を注入する THEN システムは並行数を有界に保ち、明示的な失敗又はdegraded stateへ遷移する
9. **DVA-8.9** WHEN 注入した故障を解除する THEN システムは再起動の要否を含む復旧手順に従い、最新の正当な状態へ収束する
10. **DVA-8.10** WHEN failure-injection結果を報告する THEN 各指定故障モードは少なくとも1件のテスト、形式モデル又は根拠付き非該当判定へ対応する

### 要件 9: 実装から独立したTLA+モデル

**ユーザーストーリー:** 設計者として、実装コードを翻訳しただけではない形式モデルで並行状態を検証したい。これにより、テストで列挙しにくいinterleavingとライフサイクル欠陥を発見できる。

#### 受入基準

1. **DVA-9.1** WHEN TLA+仕様を作成する THEN 仕様は要件上の状態、Action、guard、不変条件及びterminal stateを定義し、実装のclass又はmethod構造をそのまま複製しない
2. **DVA-9.2** WHEN 状態fulな外部処理をモデル化する THEN 仕様は複数actor、複数target、in-flight処理、永続状態、遅延又は欠落event及び競合を表現する
3. **DVA-9.3** WHEN 時間依存処理をモデル化する THEN 仕様はwall clockではなく有界な論理時間を使用し、timeout、backoff、lease、cooldown及びstale判定の境界を表現する
4. **DVA-9.4** WHEN 資源依存処理をモデル化する THEN 仕様はretry数、queue長、in-flight数、lock数及び保存容量を有界定数として定義する
5. **DVA-9.5** WHEN ライフサイクルをモデル化する THEN 仕様はstart、running、stop／cancel、crash、restart、recovery及び明示的terminal stateを表現する
6. **DVA-9.6** WHEN 環境Actionを定義する THEN 仕様はprovider failure、event配送、actor停止及び故障解除について、システムActionと区別して仮定を明示する
7. **DVA-9.7** WHEN Livenessを定義する THEN 仕様は必要なweak又はstrong fairnessをAction単位で記述し、公平性がない場合に保証できない性質を区別する
8. **DVA-9.8** WHEN 実装との対応を示す THEN 検証システムは抽象状態・Actionと実装入口の対応及び抽象化によって失われる情報を記録する

### 要件 10: TLC探索、到達可能性及び証跡

**ユーザーストーリー:** 検証担当者として、形式検査がどの範囲をどの設定で探索したか再現したい。これにより、有限探索の成功を無制限な正しさと誤解することを防止できる。

#### 受入基準

1. **DVA-10.1** WHEN TLCを実行する THEN 検証システムはspec、config、TLC version、Java version、探索方式、worker数、heap又は主要runtime設定、seed及び実行コマンドを保存する
2. **DVA-10.2** WHEN exhaustive model checkingを実行する THEN 検証システムはgenerated states、distinct states、queue又はdepth情報、diameter、elapsed time及び終了状態を保存する
3. **DVA-10.3** WHEN simulation又は制約付き探索を実行する THEN 検証システムはseed、trace数、depth、state constraint、symmetry、fingerprint設定及び未探索範囲を保存する
4. **DVA-10.4** WHEN config matrixを定義する THEN 検証システムは異なるactor数、target数、retry上限、資源上限及び時間境界を含める
5. **DVA-10.5** WHEN Safetyを検査する THEN TLCは資格情報非漏洩、所有権保護、単調revision、lock相互排他、資源上限及び禁止状態の不変条件を検査する
6. **DVA-10.6** WHEN Livenessを検査する THEN TLCは明示した環境・公平性仮定の下で、要求がapplied、partial、failed、awaitingUser又はcancelledのいずれかのterminal stateへ到達することを検査する
7. **DVA-10.7** WHEN deadlockを検査する THEN TLCは正当なterminal quiescenceと不正な進行不能を区別し、予期しないdeadlockがないことを検査する
8. **DVA-10.8** WHEN 必須状態の到達可能性を検査する THEN 検証システムはexistential reachability run又は同等の方法で到達証人を保存する
9. **DVA-10.9** WHEN 禁止状態の到達可能性を検査する THEN 検証システムは不変条件として非到達を確認し、違反時は最短又は取得可能な反例traceを保存する
10. **DVA-10.10** WHEN TLC runが完了する THEN 検証システムは探索制約、探索限界、未探索の定数組合せ及び一般化できない結論を明示する

### 要件 11: 検証の隔離、セキュリティ及び実環境確認

**ユーザーストーリー:** 開発者として、検証が開発者マシンの実設定や資格情報を破壊せず、配布環境固有の動作も確認したい。

#### 受入基準

1. **DVA-11.1** WHEN unit、integration又はVS Code hostテストを実行する THEN 検証システムは一意な一時profile、Git global config、npm user config、storage及びextension directoryを使用する
2. **DVA-11.2** WHEN 検証証跡を保存する THEN システムはproxy資格情報、SecretStorage値、tokenその他のsecretを平文で記録しない
3. **DVA-11.3** WHEN mutation又はC2 instrumentationを実行する THEN 検証システムは一時成果物を隔離し、本番source、配布artifact及びユーザー所有の未コミット変更を上書きしない
4. **DVA-11.4** WHEN OS、実CLI、権限、永続化又はcross-process動作へ依存する性質を検証する THEN 検証システムはプロトコル互換の結合テスト、決定的failure injection及び隔離VS Code hostテストで関連する正常系及び異常系を検証する
5. **DVA-11.5** WHEN 実環境との差が残る境界を検証する THEN 検証システムはテスト環境、test doubleの抽象化、代替証跡及び未再現のOS又はprovider動作を記録する
6. **DVA-11.6** WHEN 検証方針を判定する THEN 隔離Windows VMの実機E2Eは対象外とし、実機依存の主張を行わない
7. **DVA-11.7** WHEN テストコマンドが終了する THEN 検証システムはrepository pathに一致するtest runner processを再検査し、残存processがある場合は親から停止して再検査する
8. **DVA-11.8** WHEN 検証用一時資源を破棄する THEN 検証システムは対象pathを検証し、repository外の広いdirectory又はユーザー設定を削除しない

### 要件 12: 追跡可能性、敵対的再監査及びリリース判定

**ユーザーストーリー:** リリース責任者として、成功した検査だけでなく未検証事項と限界を含めて再監査したい。これにより、証拠に基づくリリース判断を行える。

#### 受入基準

1. **DVA-12.1** WHEN 検証成果物を完成する THEN 検証システムは要件・境界・故障モードから、オラクル、具体例テスト、PBT、C2条件、mutant、TLA+ Action／Property、実装入口及び証跡までの対応表を作成する
2. **DVA-12.2** WHEN 対応表を検査する THEN 検証システムは参照先の不存在、重複ID、孤立したテスト、証跡欠落及び未対応要件を機械的に検出する
3. **DVA-12.3** WHEN 敵対的再監査を行う THEN 検証担当者はオラクル誤り、test doubleの抽象化差、未モデル化状態、環境・公平性仮定、探索制約、探索限界及びsurviving mutantを成功主張と独立に再評価する
4. **DVA-12.4** WHEN 検証に未完了項目がある THEN 評価書は未検証と検証済みを混同せず、影響、発生可能性、検出可能性及びmitigationを記録する
5. **DVA-12.5** WHEN リリース判定を行う THEN release-criticalなSafety違反、非equivalent surviving mutant、実行可能条件のC2未達又は未分類mutantが存在する場合はNO-GOとする
6. **DVA-12.6** WHEN リリース判定を行う THEN 調整後mutation scoreが90%未満、未分類mutant、重大な探索不足又はrelease-criticalな未検証境界がある場合はNO-GOとする
7. **DVA-12.7** WHEN 全release gateを満たすが環境依存又は有限探索の残存リスクがある THEN 評価書は条件、監視方法及びrollback条件を伴うCONDITIONAL GO又はGOを根拠付きで選択する
8. **DVA-12.8** WHEN 最終結果を報告する THEN 評価書は実行日時、commit、worktree状態、tool version、全検証コマンド、合否及び変更ファイルを記録する
