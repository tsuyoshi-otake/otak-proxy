# 技術スタック

## アーキテクチャ

VSCode Extension API を使用したデスクトップ拡張機能。
モジュラー設計で、各機能を独立したマネージャークラスに分離。
依存性注入パターンで疎結合を実現。

## コア技術

- **言語**: TypeScript 5.x
- **フレームワーク**: VSCode Extension API
- **ランタイム**: Node.js (VSCode 組み込み)
- **対象環境**: VSCode 1.9.0+

## 主要ライブラリ

開発依存のみ(本番依存なし):
- **テスト**: Mocha, @vscode/test-electron, Sinon
- **プロパティベーステスト**: fast-check
- **静的解析**: ESLint, typescript-eslint

## 開発標準

### 型安全性

```typescript
// tsconfig.json: strict: true
// 明示的な型定義を使用
interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'UNKNOWN';
}
```

### コード品質

- ESLint による静的解析
- TypeScript strict モード有効
- `any` 型の使用を最小限に

### テスト

- 単体テスト: 各モジュールに対応するテストファイル
- プロパティベーステスト: `.property.test.ts` サフィックス
- 統合テスト: `.integration.test.ts` サフィックス
- クロスプラットフォームテスト: `.crossplatform.test.ts` サフィックス

## 開発環境

### 必須ツール

- Node.js 20.x
- npm
- Git
- VSCode (デバッグ用)

### 共通コマンド

```bash
# 開発
npm run watch

# ビルド
npm run compile

# テスト
npm run test

# Lint
npm run lint

# 実プロキシテスト
npm run test:real-proxy
```

## 主要技術決定

### セキュアなコマンド実行

シェルインジェクション防止のため、`exec()` ではなく `execFile()` を使用:

```typescript
// Good: execFile は引数を個別に渡すため安全
await execFileAsync('git', ['config', '--global', 'http.proxy', url]);

// Bad: exec はシェル解釈されるため危険
// await exec(`git config --global http.proxy ${url}`);
```

### シングルトンパターン

I18nManager はシングルトンとして実装し、アプリケーション全体で一貫したロケールを保持:

```typescript
const i18n = I18nManager.getInstance();
```

### 状態管理

VSCode の globalState API を使用して拡張機能の状態を永続化:

```typescript
await context.globalState.update('proxyState', state);
```

---
_標準とパターンを文書化。依存関係の網羅的リストは避ける_
