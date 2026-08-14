# Goal Loop Journal

## 2026-08-14 domain-verification-assurance

- Phase 0: ユーザーが実施計画を承認。通常のRequirements → Design → Tasks承認ゲートで進行する。
- Baseline: 独立オラクル、seed／縮小反例保存、原子条件C2、mutation testing、契約テスト共通基盤及びTLA+モデルは未整備。
- Constraint: `.vscode/settings.json`の既存変更はユーザー所有として保持する。
- Tracking: GitHub Issue #42を作成。
- Requirements: 12要件、90受入基準を生成。識別子は90件すべて一意。`npm run lint:unicode`は成功。
- Requirements approval: ユーザーの「おｋ」を要件承認として受領。Designフェーズへ遷移した。
- Design: 独立オラクル、PBT証跡/C2/mutation、境界portとfault plan、TLA+/TLC、追跡表・release gateの設計を作成。実装・test sourceはDesign承認まで変更しない。
- Design approval: ユーザーの「じゃあ進めて」をDesign承認として受領。Tasksフェーズへ遷移した。
- Tasks: 13の依存順タスク、各Verify/Expect、全DVA要件群への対応、制御済み検証と最終release gateを定義した。Tasks承認までproduction/test実装は開始しない。
- Verification policy: ユーザー指示により、外部仮想マシンでの実行は本仕様の検証対象から外し、制御済みのunit、extension-host、契約、failure-injection及び形式検査で評価する。
- Tasks validation: requirements.md の90受入基準すべてが tasks.md に少なくとも1回対応することを確認。`spec.json` 構文検証と `npm run lint:unicode` は成功。
- Tasks approval: ユーザーの「おｋ」をTasks承認として受領。Issue #42に紐付けてimplementationを開始した。
- Implementation: 独立オラクル、固定seed PBTとreplay、C2 instrumentation、隔離mutation、protocol互換契約／failure injection、TLA+/TLC、traceability verifier、敵対的監査を実装した。状態停止後のlate completionを捨てるため、`ProxyMonitor`にlifecycle epoch guardを追加した。
- Policy update: ユーザー指示により外部仮想マシン実行を検証対象から外し、仕様・設計・タスク・監査gate・`CLAUDE.md`を制御済み検証方針へ更新した。
- Final verification: `npm run verify:assurance` は全check成功、runner-survivors=0、C2 24/24（100%）、mutation 12/12 killed（score 100%、surviving/equivalent 0）、TLC 7/7、traceability integrity-problems 0（90 requirements、unverified 0）となった。`npm run test:unit:parallel` も726+25 passing、runner-survivors=0で完走した。
- Audit: `adversarial-audit.json` はCONDITIONAL-GO。有限TLA+探索、test doubleとOS/providerの抽象化差、未採用入力領域を明示した残存リスクとして記録し、実機依存の成功主張は行わない。

## 2026-08-15 domain-verification-assurance

- Iteration 1 fail: C5のライフサイクル取消し試験で、epoch guardが`start()`前に直接実行される検査呼出しまで無効化した。Investigate: guardの目的は「停止済みか」ではなく「呼出し時点と完了時点の世代が一致するか」の照合である。Verify: `F-CANCEL-001`で停止前の実行と停止後のlate completion破棄を別々に観測した。
- Iteration 2 pass: C1–C8を直接実行して確認。`npm run verify:assurance`、`npm run test:unit:parallel`、`npm run lint:unicode`、`npm run verify:traceability`、`npm run audit:assurance`、プロセス再検査はすべて終了コード0だった。
- Independent verifier: 現行の開発者ポリシーがsubagent起動を許可していないため、独立fresh-context verifierは利用不可。各rubricのVerifyを主担当が直接実行した。
- Terminal state: pass。C2は24/24、mutationは12/12 killed、TLCは7/7、traceabilityはunverified 0、runner-survivorsは0。外部VM E2Eはユーザー指示により対象外であり、成功として主張しない。

## 2026-08-15 release-3.2.5

- Release iteration 3 fail: `v3.2.4` のLinux publish workflow（run 31818783246）はregistry公開前のUnit testsで `ORC-SYNC-005` に失敗した。証拠: remote timestamp `now + 30_001` は、SUTが別途採取した時刻との差が1 ms以上になると30秒許容範囲内になる。
- Investigate: `ConflictResolver` は自身の `Date.now()` と30秒のdrift上限を使う。テストが時計を固定せず最大値+1を渡すと、scheduler遅延で非決定的になる。
- Iteration 3 fix/pass: 値を `now + 60_000` にして上限外を明示した。`npm run test:domain-oracle`、`npm run verify:assurance`、runner cleanupは終了コード0。`v3.2.4` tagは不変の失敗記録として保持し、修正済み成果物は `v3.2.5` として公開する。
