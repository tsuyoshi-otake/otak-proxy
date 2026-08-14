## 目的

プロキシ状態管理、fallback、複数設定対象へのapply、remediation及びmulti-instance syncを対象に、実装から独立した検証オラクルと形式モデルを整備し、テストの欠陥検出力と残存リスクを定量評価する。

## 対象

- Off／Auto／Auto OFF、system／manual fallback／directの状態遷移
- Git、VS Code、npm、pip、terminal environmentへのapply／clearと部分失敗
- connection test、retry、flap suppression、apply lock及び復旧
- globalState、SecretStorage、VS Code settings、共有ファイル及びinstance registry
- multi-instance競合解決、重複・欠落・順序逆転、crash／restart

## 成果物

- 日本語Kiro仕様: Requirements、Design、Tasks
- 実装非依存オラクルに基づく具体例テスト及びstateful PBT
- fast-check seed、counterexample path、縮小反例及びreplay証跡
- 原子条件単位のC2レポート
- mutation score、surviving mutant及びequivalent mutant分析
- プロトコル互換fakeを使うAPI結合・契約テスト
- failure-injection行列と復旧証跡
- TLA+ spec/config、複数TLC runの統計及び到達可能性証跡
- 要件から実装・検証証跡までの追跡表
- 残存リスクとGO／CONDITIONAL GO／NO-GO評価

## 合格条件

- 実行可能な対象原子条件のC2が100%
- release-criticalな非equivalent surviving mutantが0
- equivalent除外後mutation scoreが90%以上
- 全mutantと全指定故障モードが分類済み
- 期待成功のTLC runでSafety、Liveness及びdeadlock違反がない
- 必須状態に到達証人があり、禁止状態が到達不能
- lint、unit、VS Code host、契約及びfailure-injection試験が成功
- 未検証、未モデル化、仮定、探索制約・限界及び残存リスクが明示される

## 進め方

KiroのRequirements → Design → Tasksを順次レビューし、承認後に実装する。実装後はgoal-loopで各基準を直接検証し、失敗時は原因確認、修正、再検証を行う。
