# 実行環境の観測

- `npm run verify:assurance` の VS Code host レーンでは、起動ログに一過性の `Error mutex already exists` と `path` 引数の診断が出力された。
- 同じ隔離profileの後続 extension host は 454 passing、終了コード 0 で完走し、直後と最終の `cleanup-test-processes.mjs` はともに `runner-survivors=0` を記録した。
- このため本件はテスト結果の成功主張には含めず、VS Code test harness の環境差として残存リスクへ記録する。`@vscode/test-cli`、VS Code version、又は起動引数を更新する際は再現性を再確認する。
