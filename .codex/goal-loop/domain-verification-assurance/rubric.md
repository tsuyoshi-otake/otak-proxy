# Goal: ドメインモデルと外部境界の欠陥検出力を独立オラクル、PBT、C2、mutation testing、契約テスト及びTLA+で検証する
Workdir: C:\Codes\tsuyoshi-otake\otak-proxy
Max iterations: 8

## Criteria

- C1: 対象要件、ドメイン判断、状態、イベント、遷移、永続化境界及び故障モードに安定したIDがあり、追跡表に未対応行がない。Verify: `rtk npm run verify:traceability`。Expect: 終了コード0、未対応ID数0、指定された全故障モードが1件以上の検証又は根拠付き非該当判定に対応する。
- C2: 実装ロジックを参照しないオラクルに基づく具体例テスト及びPBTが成功し、全PBT実行のseedと失敗時の縮小反例を保存・再生できる。Verify: `rtk npm run test:domain-oracle`及び`rtk npm run test:pbt:replay`。Expect: 終了コード0、全propertyにseed証跡があり、negative controlの縮小反例が同じpathで再現する。
- C3: 対象ドメイン判断の実行可能な全原子条件についてTrueとFalseが観測される。Verify: `rtk npm run coverage:c2`。Expect: 実行可能条件のC2が100%、未観測条件数0。到達不能条件は要件上の不変条件と機械的又は論理的根拠が記録される。
- C4: mutation testingがrelease-criticalな判断の欠陥検出力を示し、全mutantが分類される。Verify: `rtk npm run mutation:domain`及びmutation分析レポートの検査。Expect: criticalな非equivalent survivorが0、equivalent除外後scoreが90%以上、unclassified survivorが0。
- C5: プロトコル互換の依存先を接続したAPI結合・契約テストとfailure injectionが、境界値、部分失敗、再試行、重複、欠落、順序逆転、キャンセル、タイムアウト、クラッシュ／再起動、資源枯渇及び復旧を明示的terminal stateまで検証する。Verify: `rtk npm run test:contracts`及び`rtk npm run test:failure-injection`。Expect: 終了コード0、故障行列の全行に観測可能な最終状態と復旧結果がある。
- C6: TLA+モデルが状態、遷移、並行性、論理時間、資源上限及びライフサイクルを独立に表現し、複数configでSafety、Liveness、deadlock及び到達可能性を検査する。Verify: `rtk npm run verify:tla`。Expect: 期待成功runに違反なし、必須状態runに到達証人あり、禁止状態は非到達で、全runのTLC version、設定、seed、generated/distinct states、diameter、制約及び未探索範囲が保存される。
- C7: リポジトリ全体の制御済み検証が成功し、テストrunnerが残存しない。Verify: `rtk npm run lint`、`rtk npm run test:unit:parallel`、`rtk npm run test:vscode:fast`、契約／failure-injection試験、及びプロセス再検査。Expect: 全コマンド終了コード0、対象runner残存数0。
- C8: 要件から証跡までの対応表と敵対的再監査により、未検証、未モデル化、抽象化、仮定、探索制約、探索限界及びsurviving mutantが明示され、リリース判定が再現可能である。Verify: `rtk npm run verify:assurance`及び最終評価書の検査。Expect: 証跡欠落0、全残存リスクに根拠と影響があり、GO／CONDITIONAL GO／NO-GOの判定規則と結果が一致する。
