# Test Infrastructure

このディレクトリには、otak-proxy拡張機能のテストインフラが含まれています。

## テスト概要

- **テスト総数**: 389個（すべて合格）
- **ユニットテスト**: 200+
- **プロパティベーステスト**: 15+
- **統合テスト**: 複数のエンドツーエンドシナリオ

## テストフレームワーク

- **Mocha**: ユニットテストフレームワーク
- **Sinon**: モックとスタブ用ライブラリ
- **fast-check**: プロパティベーステスト用ライブラリ

## テスト戦略

拡張機能はデュアルテストアプローチを採用しています：

### 1. ユニットテスト

**目的**: 特定の例とエッジケースを検証

**特徴**:
- 個別関数とクラスメソッドをテスト
- 外部依存関係をモック（Git、npmコマンド）
- 高速実行でフィードバックが早い
- 具体的な入力と期待される出力を検証

**例**:
```typescript
it('should toggle from off to manual', async () => {
    const state = { mode: ProxyMode.Off };
    const nextMode = stateManager.getNextMode(state.mode);
    expect(nextMode).toBe(ProxyMode.Manual);
});
```

### 2. プロパティベーステスト

**目的**: 普遍的なプロパティを検証

**特徴**:
- ランダムな入力を生成してエッジケースを発見
- 設計ドキュメントの正しさプロパティを検証
- すべての有効な入力に対して成り立つべき性質をテスト
- fast-checkが自動的に反例を最小化

**検証されるプロパティ**:
- Property 1: コマンドエラーハンドリングの一貫性
- Property 2: コマンドの独立性
- Property 3: 状態永続化のフォールバック
- Property 4: レガシー状態の移行
- Property 5: プロキシ有効化シーケンス
- Property 6: プロキシ無効化の完全性
- Property 7: エラー集約
- Property 8: ステータスバーの状態反映
- Property 9: コマンドリンクの検証
- Property 10: ステータスバーの国際化

**例**:
```typescript
it('Property 3: State persistence fallback', () => {
    fc.assert(
        fc.asyncProperty(
            arbitraryProxyState,
            async (state) => {
                // globalState.updateが失敗してもin-memoryフォールバックが機能することを検証
                mockGlobalState.update.mockRejectedValue(new Error('Storage failed'));
                await stateManager.saveState(state);
                const retrieved = await stateManager.getState();
                expect(retrieved).toEqual(state);
            }
        ),
        { numRuns: 100 }
    );
});
```

### 3. 統合テスト

**目的**: エンドツーエンドのワークフローを検証

**特徴**:
- コンポーネント間の連携をテスト
- 必要に応じて実際のGit/npmコマンドを使用
- 実際のユーザーシナリオを再現

## ファイル構成

### テストファイル命名規則

- `*.test.ts` - ユニットテスト
- `*.property.test.ts` - プロパティベーステスト
- `integration.test.ts` - 統合テスト

### モジュール別テストファイル

#### Core Module Tests
- `core/types.test.ts` - 型定義のテスト
- `ProxyStateManager.test.ts` - 状態管理のユニットテスト
- `ProxyStateManager.property.test.ts` - 状態管理のプロパティテスト
- `ProxyApplier.test.ts` - プロキシ適用のユニットテスト
- `ProxyApplier.property.test.ts` - プロキシ適用のプロパティテスト

#### Command Tests
- `statusbar-commands.test.ts` - コマンド実行のユニットテスト
- `statusbar-commands.property.test.ts` - コマンドのプロパティテスト

#### Configuration Tests
- `GitConfigManager.test.ts` - Git設定のテスト
- `VscodeConfigManager.test.ts` - VSCode設定のテスト
- `NpmConfigManager.test.ts` - npm設定のユニットテスト
- `NpmConfigManager.property.test.ts` - npm設定のプロパティテスト
- `SystemProxyDetector.test.ts` - システムプロキシ検出のユニットテスト
- `SystemProxyDetector.property.test.ts` - システムプロキシ検出のプロパティテスト

#### Monitoring Tests
- `ProxyMonitor.test.ts` - プロキシ監視のユニットテスト
- `ProxyMonitor.property.test.ts` - プロキシ監視のプロパティテスト
- `ProxyMonitorState.test.ts` - モニター状態のテスト
- `ProxyChangeLogger.test.ts` - 変更ログのテスト

#### Validation Tests
- `ProxyUrlValidator.test.ts` - URL検証のテスト
- `InputSanitizer.test.ts` - 入力サニタイズのテスト
- `security.test.ts` - セキュリティ関連のテスト

#### Error Handling Tests
- `ErrorAggregator.test.ts` - エラー集約のテスト
- `errors/UserNotifier.test.ts` - ユーザー通知のテスト

#### i18n Tests
- `i18n/I18nManager.property.test.ts` - 国際化のプロパティテスト
- `i18n-integration.test.ts` - i18n統合テスト
- `statusbar-i18n.test.ts` - ステータスバーi18nテスト

#### Utility Tests
- `utils/ProxyUtils.test.ts` - ユーティリティ関数のテスト

#### Integration Tests
- `integration.test.ts` - エンドツーエンド統合テスト
- `extension.test.ts` - 拡張機能全体のテスト
- `extension.property.test.ts` - 拡張機能のプロパティテスト

### テストインフラファイル

#### `generators.ts`
プロパティベーステスト用のランダムデータジェネレータを提供します。

利用可能なジェネレータ：
- `validProxyUrlGenerator()` - 有効なプロキシURLを生成
- `urlWithShellMetacharactersGenerator()` - シェルメタキャラクタを含むURLを生成
- `urlWithoutProtocolGenerator()` - プロトコルなしのURLを生成
- `urlWithInvalidPortGenerator()` - 無効なポート番号を含むURLを生成
- `urlWithInvalidHostnameGenerator()` - 無効なホスト名文字を含むURLを生成
- `urlWithCredentialsGenerator()` - 認証情報を含むURLを生成
- `emptyOrWhitespaceGenerator()` - 空文字列または空白文字のみの文字列を生成
- `urlWithMultipleAtSymbolsGenerator()` - 複数の@記号を含むURLを生成
- `arbitraryProxyState()` - ランダムなProxyStateを生成
- `arbitraryProxyMode()` - ランダムなProxyModeを生成

#### `helpers.ts`
テスト用のヘルパー関数を提供します。

利用可能な関数：
- `getTestIterations()` - 環境に応じたテスト実行回数を取得（CI: 100回、開発: 10回）
- `containsShellMetacharacters(str)` - シェルメタキャラクタの存在を確認
- `extractPassword(url)` - URLからパスワードを抽出
- `isMasked(str)` - 文字列がマスクされているか確認
- `isValidPort(port)` - ポート番号の有効性を確認
- `hasValidHostnameCharacters(hostname)` - ホスト名の文字が有効か確認
- `hasValidCredentialCharacters(credential)` - 認証情報の文字が有効か確認
- `hasValidProtocol(url)` - URLが有効なプロトコルを持つか確認
- その他のユーティリティ関数

#### `property-test-example.test.ts`
プロパティベーステストインフラの動作確認用サンプルテスト。

## テストパフォーマンス最適化

### 環境変数による実行回数制御

プロパティベーステストの実行回数は環境に応じて自動調整されます：

```typescript
import { getTestIterations } from './helpers';

fc.assert(
    fc.property(generator(), (value) => {
        // テストロジック
        return true;
    }),
    { numRuns: getTestIterations() } // CI: 100回、開発: 10回
);
```

- **開発モード**: 10回（高速フィードバック）
- **CIモード**: 100回（包括的検証）

### 並列実行

`.vscode-test.mjs`で並列実行が有効化されています：

```javascript
{
    parallel: true,
    workers: 4
}
```

### モックの活用

- 外部コマンド（git、npm）はデフォルトでモック
- 統合テストのみ実際のコマンドを使用
- テスト実行時間を大幅に短縮

### パフォーマンス結果

- **開発モード**: ~30秒
- **CIモード**: ~2分
- **テスト数**: 389個すべて合格

## テストの実行

```bash
# 全てのテストを実行
npm test

# 開発モード（高速）
npm test

# CIモード（包括的）
CI=true npm test

# コンパイルのみ
npm run compile

# リントチェック
npm run lint

# 特定のテストファイルを実行
npm test -- --grep "ProxyStateManager"
```

## プロパティベーステストの書き方

### 基本パターン

1. `generators.ts`から適切なジェネレータをインポート
2. `fc.assert`と`fc.property`を使用してテストを記述
3. `getTestIterations()`を使用して環境に応じた実行回数を設定
4. テストにコメントで対応する設計ドキュメントのプロパティ番号を記載

### 例1: 同期プロパティテスト

```typescript
import * as fc from 'fast-check';
import { urlWithShellMetacharactersGenerator } from './generators';
import { getTestIterations } from './helpers';

test('Property 1: Shell metacharacter rejection', () => {
    // **Feature: security-and-error-handling, Property 1: Shell metacharacter rejection**
    // **Validates: Requirements 6.1**
    fc.assert(
        fc.property(urlWithShellMetacharactersGenerator(), (url) => {
            const result = validator.validate(url);
            return !result.isValid;
        }),
        { numRuns: getTestIterations() }
    );
});
```

### 例2: 非同期プロパティテスト

```typescript
import * as fc from 'fast-check';
import { arbitraryProxyState } from './generators';
import { getTestIterations } from './helpers';

test('Property 3: State persistence fallback', async () => {
    // **Feature: extension-refactoring, Property 3: State persistence fallback**
    // **Validates: Requirements 3.2**
    await fc.assert(
        fc.asyncProperty(
            arbitraryProxyState(),
            async (state) => {
                // globalState.updateが失敗してもin-memoryフォールバックが機能することを検証
                mockGlobalState.update.mockRejectedValue(new Error('Storage failed'));
                await stateManager.saveState(state);
                const retrieved = await stateManager.getState();
                return JSON.stringify(retrieved) === JSON.stringify(state);
            }
        ),
        { numRuns: getTestIterations() }
    );
});
```

### 例3: 複数の入力を持つプロパティテスト

```typescript
import * as fc from 'fast-check';
import { arbitraryProxyMode, validProxyUrlGenerator } from './generators';
import { getTestIterations } from './helpers';

test('Property 5: Proxy enablement sequence', async () => {
    // **Feature: extension-refactoring, Property 5: Proxy enablement sequence**
    // **Validates: Requirements 4.2**
    await fc.assert(
        fc.asyncProperty(
            validProxyUrlGenerator(),
            fc.boolean(),
            async (proxyUrl, enabled) => {
                const result = await proxyApplier.applyProxy(proxyUrl, enabled);
                // バリデーション→適用→エラー集約の順序を検証
                return result === true;
            }
        ),
        { numRuns: getTestIterations() }
    );
});
```

## ベストプラクティス

### 1. ジェネレータの制約

ジェネレータは有効な入力ドメインのみを生成するように制約します：

```typescript
// 良い例: 有効なポート範囲のみを生成
const validPortGenerator = fc.integer({ min: 1, max: 65535 });

// 悪い例: 無効な値も生成してしまう
const badPortGenerator = fc.integer(); // 負の値や大きすぎる値も生成
```

### 2. プロパティの明確化

テストするプロパティを明確にコメントで記載します：

```typescript
test('Property 8: Status bar state reflection', () => {
    // **Feature: extension-refactoring, Property 8: Status bar state reflection**
    // **Validates: Requirements 5.2**
    // *For any* ProxyState, updating the status bar should generate text and tooltip
    // that accurately reflect the current mode and URLs
    fc.assert(/* ... */);
});
```

### 3. エラーメッセージの改善

fast-checkが反例を見つけやすいように、明確な失敗条件を設定します：

```typescript
fc.assert(
    fc.property(generator(), (value) => {
        const result = functionUnderTest(value);
        // 明確な条件
        return result.isValid === true && result.errors.length === 0;
    }),
    { numRuns: getTestIterations() }
);
```

### 4. テストの独立性

各プロパティテストは独立して実行できるようにします：

```typescript
beforeEach(() => {
    // 各テスト前にモックをリセット
    sinon.restore();
});
```

## トラブルシューティング

### fast-checkが反例を見つけた場合

1. **反例を確認**: fast-checkが出力する最小の反例を確認
2. **ジェネレータを確認**: ジェネレータが無効な入力を生成していないか確認
3. **プロパティを確認**: テストしているプロパティが正しいか確認
4. **コードを修正**: バグが見つかった場合はコードを修正

### テストが遅い場合

1. **実行回数を減らす**: 開発モードでは`getTestIterations()`が自動的に10回に設定
2. **モックを使用**: 外部依存関係をモックして高速化
3. **並列実行**: `.vscode-test.mjs`で並列実行を有効化

## 参考資料

- [fast-check Documentation](https://fast-check.dev/)
- [Property-Based Testing Guide](https://hypothesis.works/articles/what-is-property-based-testing/)
- [設計ドキュメント](.kiro/specs/extension-refactoring/design.md)
- [アーキテクチャドキュメント](../../ARCHITECTURE.md)

## 注意事項

- プロパティベーステストは、特定の例ではなく、普遍的なプロパティをテストします
- ジェネレータは有効な入力ドメインのみを生成するように制約する必要があります
- テストが失敗した場合、fast-checkは最小の反例を提供します
- すべてのプロパティテストは設計ドキュメントの正しさプロパティに対応している必要があります
