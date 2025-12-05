# Test Infrastructure

このディレクトリには、otak-proxy拡張機能のテストインフラが含まれています。

## テストフレームワーク

- **Mocha**: ユニットテストフレームワーク
- **Sinon**: モックとスタブ用ライブラリ
- **fast-check**: プロパティベーステスト用ライブラリ

## ファイル構成

### `generators.ts`
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

### `helpers.ts`
テスト用のヘルパー関数を提供します。

利用可能な関数：
- `containsShellMetacharacters(str)` - シェルメタキャラクタの存在を確認
- `extractPassword(url)` - URLからパスワードを抽出
- `isMasked(str)` - 文字列がマスクされているか確認
- `isValidPort(port)` - ポート番号の有効性を確認
- `hasValidHostnameCharacters(hostname)` - ホスト名の文字が有効か確認
- `hasValidCredentialCharacters(credential)` - 認証情報の文字が有効か確認
- `hasValidProtocol(url)` - URLが有効なプロトコルを持つか確認
- その他のユーティリティ関数

### `property-test-example.test.ts`
プロパティベーステストインフラの動作確認用サンプルテスト。

## プロパティベーステストの設定

各プロパティベーステストは最低100回の反復実行を行うように設定されています：

```typescript
fc.assert(
    fc.property(generator(), (value) => {
        // テストロジック
        return true; // または false
    }),
    { numRuns: 100 } // 最低100回実行
);
```

## テストの実行

```bash
# 全てのテストを実行
npm test

# コンパイルのみ
npm run compile

# リントチェック
npm run lint
```

## プロパティベーステストの書き方

1. `generators.ts`から適切なジェネレータをインポート
2. `fc.assert`と`fc.property`を使用してテストを記述
3. `numRuns: 100`を設定して最低100回の反復を保証
4. テストにコメントで対応する設計ドキュメントのプロパティ番号を記載

例：
```typescript
import * as fc from 'fast-check';
import { validProxyUrlGenerator } from './generators';

test('Property 1: Shell metacharacter rejection', () => {
    // **Feature: security-and-error-handling, Property 1: Shell metacharacter rejection**
    fc.assert(
        fc.property(urlWithShellMetacharactersGenerator(), (url) => {
            const result = validator.validate(url);
            return !result.isValid;
        }),
        { numRuns: 100 }
    );
});
```

## 注意事項

- プロパティベーステストは、特定の例ではなく、普遍的なプロパティをテストします
- ジェネレータは有効な入力ドメインのみを生成するように制約する必要があります
- テストが失敗した場合、fast-checkは最小の反例を提供します
