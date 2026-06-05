# Test Infrastructure

このディレクトリには otak-proxy 拡張機能のテストが含まれます。

## 二系統のテスト実行

このリポジトリには独立した2つのテストランナーがあります。詳細な
コマンドと環境変数は [CLAUDE.md](../../CLAUDE.md) の "Testing" 節を
参照してください。

- **VS Code 拡張ホストテスト** (`vscode-test`)
  - `.vscode-test.mjs` から起動。VS Code API が必要なテスト、`extension.*`
    系、`/integration/` 配下、`*.integration.*`、`VscodeConfigManager` を
    取り込むテストはこちらで実行される。
  - ハーメティック化: 各実行ごとに一意の `--user-data-dir` /
    `--extensions-dir` を作成し、`GIT_CONFIG_GLOBAL` と
    `NPM_CONFIG_USERCONFIG` でグローバル設定を sandbox に隔離する。
- **純粋 Node ユニットテスト** (`scripts/run-unit-tests.mjs`)
  - 上記いずれにも該当しないテストを Mocha 直叩きで実行。
  - 必要なら `scripts/vscode-shim.cjs` が最小限の `vscode` モジュールを
    供給する。
  - `npm run test:unit:parallel` で並列実行。

二つのランナーは補集合関係になるよう揃えてあり、すべての `*.test.ts`
ファイルは少なくとも一つのランナーで実行されます。両方のフィルタを変える
場合は片側だけ動かさないこと(片方からも片方からも漏れるテストファイル
が生まれます)。

## テスト種別と命名規則

| 種別 | サフィックス | 目的 |
|---|---|---|
| ユニット | `*.test.ts` | 個別関数・クラスのテスト |
| プロパティベース | `*.property.test.ts` | fast-check による普遍的性質の検証 |
| 統合 | `*.integration.test.ts` | 複数コンポーネント結合シナリオ |
| クロスプラットフォーム | `*.crossplatform.test.ts` | OS 別パスでの動作検証 |
| フォールバック系 | `*.fallback.test.ts` | フォールバック分岐シナリオ |

ディレクトリ構造は `src/` をミラーします
(例: `src/sync/SyncManager.ts` → `src/test/sync/SyncManager.test.ts`)。

## テストインフラ

- **`generators.ts`** — fast-check 用のドメインジェネレータ
  (proxy URL バリエーション、ProxyState、ProxyMode など)。
- **`helpers.ts`** — 実行環境に応じてプロパティテストの試行回数と
  タイムアウトを返すヘルパー。
  - `getPropertyTestRuns()`: CI なら 100、開発時は 5、`OTAK_PROXY_TEST_FAST=1`
    なら 1、`OTAK_PROXY_PROPERTY_RUNS=<n>` で明示上書き。
  - `getPropertyTestTimeout(base)`: CI なら 10×、開発時は等倍、
    `OTAK_PROXY_TEST_TIMEOUT_MULTIPLIER=<x>` で明示上書き。
- **`crossPlatformMockers.ts`** — OS 別レジストリ/プラットフォーム呼び出しを
  差し替えるためのモック群。
- **`commandAvailability.ts`** — `git` / `npm` などの存在チェックヘルパー。

## 実行制御の環境変数

| 環境変数 | 効果 |
|---|---|
| `OTAK_PROXY_TEST_FAST=1` | プロパティテスト試行回数を最小化、タイムアウト等倍 |
| `OTAK_PROXY_PROPERTY_RUNS=<n>` | `getPropertyTestRuns()` の戻り値を上書き |
| `OTAK_PROXY_TEST_TIMEOUT_MULTIPLIER=<x>` | プロパティテストタイムアウトを倍率指定 |
| `OTAK_PROXY_LOG_SILENT=1` | `Logger.*` 出力を抑制(テスト時のデフォルト) |
| `OTAK_PROXY_VSCODE_TEST_ALL=1` | VS Code ホスト経由で全テストを走らせる |
| `MOCHA_GREP=<pattern>` | パターン一致するテストのみ実行 |
| `REAL_PROXY_URL=<url>` | `Real Proxy` 系テストに実プロキシを供給(未設定なら skip) |

## プロパティテストの書き方

```typescript
import * as fc from 'fast-check';
import { validProxyUrlGenerator } from './generators';
import { getPropertyTestRuns } from './helpers';

test('Property N: short description', () => {
    // Feature: <spec-name>, Property N: <name from design.md>
    // Validates: Requirements x.y
    fc.assert(
        fc.property(validProxyUrlGenerator(), (url) => {
            const result = validator.validate(url);
            return result.isValid;
        }),
        { numRuns: getPropertyTestRuns() }
    );
});
```

規約:
1. ジェネレータは有効入力ドメインに制約する。
2. テスト名と冒頭コメントに feature / property 番号 / 検証
   Requirement 番号を残す(対応する spec ドキュメントへの逆引きを
   可能にする)。
3. 試行回数は必ず `getPropertyTestRuns()` 経由で決定する
   (直値の `numRuns: 100` などはハードコード禁止)。

## 参考

- [ARCHITECTURE.md](../../ARCHITECTURE.md) — モジュール責務と相互関係
- [CLAUDE.md](../../CLAUDE.md) — テスト関連コマンド・isolation 詳細
- [fast-check 公式ドキュメント](https://fast-check.dev/)
