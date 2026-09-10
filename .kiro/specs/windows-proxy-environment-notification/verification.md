# Issue #76 実装・検証結果

2026-09-10、ローカル作業ツリーで実装完了。コミット・リリースは未実施。

## 実装

- `WindowsProxyEnvironment.ts`: 固定 PowerShell 読み取り、JSON 検証、ユーザー優先の比較、変更・削除の追跡、同時読み取りの重複排除、通知間隔制限、失敗時バックオフ、終了時の中断。
- `WindowsProxyEnvironmentNotification.ts` と `extension.ts`: ローカル Windows の起動・終了に接続。非フォーカス中は確認を省略。通知レベル off に対応。
- 16 言語の通知文。HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY のうち不一致のある変数名だけを表示し、値・認証情報は表示しない。
- 既存の検出・適用ロジックは変更していない。OS 設定の書き換えや自動再起動は行わない。

通知例:

> Windows に保存されたプロキシ環境変数（HTTP_PROXY, HTTPS_PROXY）が、現在の VS Code の環境と異なります。作業を保存し、すべての VS Code を完全に終了してから起動し直し、ターミナルも開き直してください。ウィンドウの再読み込みだけでは反映されない場合があります。

## 実行結果

| Verify | Expect | 結果 |
| --- | --- | --- |
| `npm run compile` | 型検査・生成成功 | 成功。TKW `f3c14f09c108394574a6cf088174f135` |
| `npm run lint` | ESLint・不可視文字検査成功 | 成功。TKW `b0aedcd9da6ed85984f27672ff583cb4` |
| `node node_modules/mocha/bin/mocha.js --ui tdd --require ./scripts/vscode-shim.cjs --timeout 10000 out/test/WindowsProxyEnvironment.test.js out/test/DetectedProxyValue.test.js out/test/PlatformProxyDetection.test.js out/test/TerminalEnvOffMaskOwnership.test.js` | 新規・関連単体テスト成功 | 41 件成功。TKW `26711037d59b3c24253596f72113102d` |
| `MOCHA_GREP='WindowsProxyEnvironment\|SystemProxyDetector echo\|Extension activation with first-run setup'`、`OTAK_PROXY_TEST_FAST=1` を設定して `npm test` | 隔離ホストの統合・回帰テスト成功 | 16 件成功、終了コード 0。TKW `20cc4b9da22b2cbd9d9bbee537140aa1` |
| `Get-CimInstance Win32_Process` で Node / Code / PowerShell のコマンド行を mocha / vscode-test / WindowsProxyEnvironment / リポジトリ内テストパスで絞り込む | テスト用プロセス残存 0 | 単体後・ホストテスト後とも該当 0 件 |

単体テストでは優先順位、HTTP/HTTPS の独立比較、全変数名、大小文字、空値、追加・変更・削除、資格情報非表示、同時実行、通知間隔、通知無効化、ENOENT / EACCES / ETIMEDOUT、復旧、dispose、遅延完了抑止を検証した。

統合テストでは、隔離 VS Code 上で日本語通知と検出結果不変、ツール失敗と復旧、通知未読中の継続、リモート除外、実 Windows PowerShell の JSON 応答を検証した。実 API の読み取りは約 818 ms で完了した。

## 制限・残存リスク

- 開発者の実環境変数は変更していない。変更・削除・アクセス拒否は疑似応答で検証し、実 OS 境界は読み取りだけを確認した。
- 起動前に削除された保存値は、意図的なプロセス限定設定と区別できない。初回から保存値のない変数は通知対象外。
- PowerShell が管理ポリシーで禁止されている場合は不一致を判定できず、通知せずにバックオフする。
- 起動元のランチャーも古い環境を保持する場合は、その再起動や再サインインが必要になることがある。
- ホストのテストハーネスには既存の mutex 警告と Node DEP0190 警告が出たが、対象 16 件は成功しホストは正常終了、残存プロセスは 0 件だった。
