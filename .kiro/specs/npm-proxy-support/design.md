# 設計書

## 概要

本設計は、既存のVSCodeとGitのproxy設定管理機能にnpm対応を追加するものです。NpmConfigManagerクラスを新規作成し、既存のGitConfigManagerとVscodeConfigManagerと同じパターンで実装します。npmの`http-proxy`と`https-proxy`設定を管理し、既存のセキュリティ基準（ProxyUrlValidator、InputSanitizer、execFile使用）を踏襲します。

## アーキテクチャ

### 既存のアーキテクチャ

現在のシステムは以下のレイヤーで構成されています：

1. **拡張機能レイヤー** (`extension.ts`)
   - コマンド登録とユーザーインタラクション
   - 状態管理（ProxyState）
   - 設定適用のオーケストレーション

2. **設定管理レイヤー** (`src/config/`)
   - `GitConfigManager`: Git proxy設定
   - `VscodeConfigManager`: VSCode proxy設定
   - `SystemProxyDetector`: システムproxy検出

3. **検証・サニタイズレイヤー** (`src/validation/`)
   - `ProxyUrlValidator`: URL検証
   - `InputSanitizer`: クレデンシャル保護

4. **エラーハンドリングレイヤー** (`src/errors/`)
   - `ErrorAggregator`: エラー集約
   - `UserNotifier`: ユーザー通知

### npm対応の追加

`NpmConfigManager`を`src/config/`に追加し、既存の設定管理クラスと同じインターフェースを実装します。

```
src/config/
├── GitConfigManager.ts      (既存)
├── VscodeConfigManager.ts   (既存)
├── SystemProxyDetector.ts   (既存)
└── NpmConfigManager.ts      (新規)
```

## コンポーネントとインターフェース

### NpmConfigManager

npmの設定を管理する新しいクラス。GitConfigManagerと同じパターンで実装します。

```typescript
export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'CONFIG_ERROR' | 'UNKNOWN';
}

export class NpmConfigManager {
    private readonly timeout: number = 5000; // 5秒タイムアウト

    /**
     * npmのproxy設定を適用（http-proxyとhttps-proxy）
     * @param url - 検証済みのproxy URL
     * @returns 成功状態とエラー詳細を含む結果
     */
    async setProxy(url: string): Promise<OperationResult>;

    /**
     * npmのproxy設定を削除
     * @returns 成功状態とエラー詳細を含む結果
     */
    async unsetProxy(): Promise<OperationResult>;

    /**
     * 現在のnpm proxy設定を取得
     * @returns 現在のproxy URLまたはnull
     */
    async getProxy(): Promise<string | null>;

    /**
     * npm設定キーが存在するか確認
     * @param key - 確認する設定キー
     * @returns キーが存在する場合true
     */
    private async hasConfig(key: string): Promise<boolean>;

    /**
     * npmコマンド実行エラーを処理し、エラータイプを判定
     * @param error - execFileからのエラー
     * @returns エラー詳細を含むOperationResult
     */
    private handleError(error: any): OperationResult;
}
```

### extension.tsの変更

既存の`applyProxySettings`と`disableProxySettings`関数にnpm設定を追加します。

```typescript
// 新しいインスタンスを追加
const npmConfigManager = new NpmConfigManager();

async function applyProxySettings(proxyUrl: string, enabled: boolean, context?: vscode.ExtensionContext): Promise<boolean> {
    // ... 既存の検証ロジック ...
    
    let gitSuccess = false;
    let vscodeSuccess = false;
    let npmSuccess = false; // 新規追加

    // VSCode設定
    try {
        await updateVSCodeProxy(enabled, proxyUrl);
        vscodeSuccess = true;
    } catch (error) {
        errorAggregator.addError('VSCode configuration', errorMsg);
    }

    // Git設定
    try {
        await updateGitProxy(enabled, proxyUrl);
        gitSuccess = true;
    } catch (error) {
        errorAggregator.addError('Git configuration', errorMsg);
    }

    // npm設定（新規追加）
    try {
        await updateNpmProxy(enabled, proxyUrl);
        npmSuccess = true;
    } catch (error) {
        errorAggregator.addError('npm configuration', errorMsg);
    }

    // 状態追跡の更新
    if (context) {
        const state = await getProxyState(context);
        state.gitConfigured = gitSuccess;
        state.vscodeConfigured = vscodeSuccess;
        state.npmConfigured = npmSuccess; // 新規追加
        // ...
    }

    // すべての設定が成功した場合のみtrueを返す
    const success = gitSuccess && vscodeSuccess && npmSuccess;
    // ...
}

async function updateNpmProxy(enabled: boolean, proxyUrl: string): Promise<void> {
    try {
        let result;
        
        if (enabled) {
            result = await npmConfigManager.setProxy(proxyUrl);
        } else {
            result = await npmConfigManager.unsetProxy();
        }

        if (!result.success) {
            Logger.error('npm proxy configuration failed:', result.error, result.errorType);
            throw new Error(result.error || 'Failed to update npm proxy settings');
        }

        return;
    } catch (error) {
        Logger.error('npm proxy setting error:', error);
        throw error;
    }
}
```

### ProxyStateインターフェースの拡張

```typescript
interface ProxyState {
    mode: ProxyMode;
    manualProxyUrl?: string;
    autoProxyUrl?: string;
    lastSystemProxyCheck?: number;
    gitConfigured?: boolean;
    vscodeConfigured?: boolean;
    npmConfigured?: boolean; // 新規追加
    systemProxyDetected?: boolean;
    lastError?: string;
}
```

## データモデル

### OperationResult

既存のGitConfigManagerとVscodeConfigManagerで使用されているインターフェースと同じ構造を使用します。

```typescript
export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'CONFIG_ERROR' | 'UNKNOWN';
}
```

### エラータイプ

- `NOT_INSTALLED`: npmがインストールされていない、またはPATHに存在しない
- `NO_PERMISSION`: npm設定ファイルへのアクセス権限がない
- `TIMEOUT`: npmコマンドが5秒以内に完了しなかった
- `CONFIG_ERROR`: npm設定の読み書きに失敗
- `UNKNOWN`: その他のエラー

## 正確性プロパティ

*プロパティとは、システムのすべての有効な実行において真であるべき特性や動作のことです。これは、人間が読める仕様と機械で検証可能な正確性保証の橋渡しとなります。*


### プロパティ反映

事前分析を確認した結果、以下の冗長性を特定しました：

- プロパティ1.3と5.3は同じエラー分離を検証（npm失敗時に他の設定が継続）→ 1つに統合
- プロパティ1.4と3.3は同じエラーケース（npmが未インストール）→ 1つの例として扱う
- プロパティ2.2と5.1は同じエラー集約を検証（エラーがErrorAggregatorに追加）→ 1つに統合

### 正確性プロパティ

プロパティ1: npm proxy設定の適用
*任意の*有効なproxy URLに対して、setProxy()を呼び出した後、npm configのhttp-proxyとhttps-proxyの両方が同じURLに設定されているべき
**検証対象: 要件 1.1**

プロパティ2: 設定の一貫性
*任意の*有効なproxy URLに対して、applyProxySettings()を呼び出した後、npm、Git、VSCodeの設定がすべて同じURLを持つべき
**検証対象: 要件 1.2**

プロパティ3: エラー分離
*任意の*proxy URLに対して、npmConfigManager.setProxy()が失敗しても、gitConfigManager.setProxy()とvscodeConfigManager.setProxy()は成功し、ErrorAggregatorにnpmのエラーが記録されるべき
**検証対象: 要件 1.3, 5.1, 5.3**

プロパティ4: proxy設定の削除
*任意の*設定済みproxy URLに対して、unsetProxy()を呼び出した後、npm configのhttp-proxyとhttps-proxyが存在しないべき
**検証対象: 要件 2.1**

プロパティ5: 削除エラーのハンドリング
*任意の*エラー状態において、unsetProxy()が失敗した場合、ErrorAggregatorにエラーが追加され、UserNotifierで通知されるべき
**検証対象: 要件 2.2**

プロパティ6: 削除操作の一貫性
*任意の*proxy状態において、disableProxySettings()を呼び出した場合、npm、Git、VSCodeのすべてのunsetProxy()が呼び出されるべき
**検証対象: 要件 2.3**

プロパティ7: 設定取得のラウンドトリップ
*任意の*有効なproxy URLに対して、setProxy()してからgetProxy()を呼び出すと、同じURLが返されるべき
**検証対象: 要件 3.1**

プロパティ8: 無効URL拒否
*任意の*無効なproxy URL（シェルメタキャラクタ、無効なプロトコル、無効なポート等）に対して、applyProxySettings()は検証エラーを返し、npm設定を適用しないべき
**検証対象: 要件 4.1**

プロパティ9: クレデンシャルマスキング
*任意の*クレデンシャル付きproxy URLに対して、ログ出力とユーザー通知にパスワードが平文で含まれないべき
**検証対象: 要件 4.2**

プロパティ10: エラー集約と通知
*任意の*複数のエラー状態において、すべてのエラーがErrorAggregatorに集約され、UserNotifierで一度に表示されるべき
**検証対象: 要件 5.2**

プロパティ11: エラーメッセージの提案
*任意の*npm設定エラーに対して、UserNotifierで表示されるエラーメッセージにトラブルシューティングの提案が含まれるべき
**検証対象: 要件 5.4**

## エラーハンドリング

### エラータイプと対応

NpmConfigManagerは以下のエラータイプを識別し、適切なエラーメッセージとトラブルシューティング提案を提供します：

1. **NOT_INSTALLED**
   - 検出条件: `ENOENT`エラー、"not found"メッセージ
   - エラーメッセージ: "npm is not installed or not in PATH"
   - 提案:
     - "Install Node.js and npm from https://nodejs.org/"
     - "Verify npm is in your system PATH"
     - "Restart VSCode after installing npm"

2. **NO_PERMISSION**
   - 検出条件: `EACCES`エラー、"Permission denied"メッセージ
   - エラーメッセージ: "Permission denied when accessing npm configuration"
   - 提案:
     - "Check file permissions for npm config files"
     - "Try running VSCode with appropriate permissions"
     - "Verify you have write access to npm's global config"

3. **TIMEOUT**
   - 検出条件: タイムアウト、`SIGTERM`シグナル
   - エラーメッセージ: "npm command timed out after 5 seconds"
   - 提案:
     - "Check if npm is responding correctly"
     - "Try running 'npm config list' manually to verify npm works"
     - "Restart VSCode and try again"

4. **CONFIG_ERROR**
   - 検出条件: npm config操作の失敗
   - エラーメッセージ: "Failed to read/write npm configuration"
   - 提案:
     - "Verify npm configuration is not corrupted"
     - "Try running 'npm config list' to check npm config"
     - "Consider resetting npm config with 'npm config edit'"

5. **UNKNOWN**
   - 検出条件: その他のエラー
   - エラーメッセージ: エラーの詳細メッセージ
   - 提案:
     - "Check npm installation and configuration"
     - "Try running npm commands manually to diagnose the issue"
     - "Restart VSCode and try again"

### エラー集約戦略

既存のErrorAggregatorパターンを使用し、npm設定エラーを他の設定エラー（Git、VSCode）と一緒に集約します：

```typescript
// applyProxySettings内
const errorAggregator = new ErrorAggregator();

// npm設定試行
try {
    await updateNpmProxy(enabled, proxyUrl);
    npmSuccess = true;
} catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    errorAggregator.addError('npm configuration', errorMsg);
}

// すべての設定試行後
if (errorAggregator.hasErrors()) {
    const formattedErrors = errorAggregator.formatErrors();
    userNotifier.showError(errorMessage, suggestions);
}
```

### グレースフルデグラデーション

npm設定が失敗しても、拡張機能は動作を継続します：

1. npm設定エラーは記録されるが、Git/VSCode設定は継続
2. ProxyStateにnpmConfigured状態を追跡
3. ユーザーには部分的な成功を通知
4. npmが利用できない環境でも拡張機能は使用可能

## テスト戦略

### ユニットテスト

NpmConfigManagerの基本機能をテストします：

1. **正常系テスト**
   - setProxy()が正しくhttp-proxyとhttps-proxyを設定
   - unsetProxy()が設定を削除
   - getProxy()が現在の設定を返す

2. **エッジケーステスト**
   - npmが未インストール（例: NOT_INSTALLEDエラー）
   - 権限エラー（例: NO_PERMISSIONエラー）
   - タイムアウト（例: TIMEOUTエラー）
   - 設定が存在しない場合のgetProxy()

3. **統合テスト**
   - applyProxySettings()がnpm設定を含む
   - disableProxySettings()がnpm設定を削除
   - エラー集約が正しく動作

### プロパティベーステスト

fast-checkライブラリを使用して、以下のプロパティを検証します：

- **最小イテレーション数**: 各プロパティテストは最低100回実行
- **ジェネレーター**: 既存の`src/test/generators.ts`を拡張してnpm設定用のジェネレーターを追加
- **タグ付け**: 各プロパティテストに設計書のプロパティ番号を明記

```typescript
// 例: プロパティ1のテスト
/**
 * Feature: npm-proxy-support, Property 1: npm proxy設定の適用
 * 任意の有効なproxy URLに対して、setProxy()を呼び出した後、
 * npm configのhttp-proxyとhttps-proxyの両方が同じURLに設定されているべき
 */
test('Property 1: npm proxy configuration applies to both http and https', async () => {
    await fc.assert(
        fc.asyncProperty(validProxyUrlGenerator(), async (proxyUrl) => {
            const manager = new NpmConfigManager();
            const result = await manager.setProxy(proxyUrl);
            
            expect(result.success).toBe(true);
            
            const httpProxy = await getConfigValue('http-proxy');
            const httpsProxy = await getConfigValue('https-proxy');
            
            expect(httpProxy).toBe(proxyUrl);
            expect(httpsProxy).toBe(proxyUrl);
        }),
        { numRuns: 100 }
    );
});
```

### テストの実行順序

1. NpmConfigManagerのユニットテスト
2. NpmConfigManagerのプロパティテスト
3. extension.ts統合テスト（npm設定を含む）
4. エラーハンドリングのプロパティテスト

### モックとスタブ

- `execFile`をモックしてnpmコマンドの動作をシミュレート
- エラー状態（未インストール、権限エラー、タイムアウト）をモック
- 既存のテストヘルパー（`src/test/helpers.ts`）を活用

## 実装の詳細

### npmコマンドの使用

NpmConfigManagerは以下のnpmコマンドを使用します：

```bash
# proxy設定
npm config set http-proxy <url>
npm config set https-proxy <url>

# proxy削除
npm config delete http-proxy
npm config delete https-proxy

# proxy取得
npm config get http-proxy
```

### execFile()の使用

セキュリティのため、`exec()`ではなく`execFile()`を使用します：

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// 安全なコマンド実行
await execFileAsync('npm', ['config', 'set', 'http-proxy', url], {
    timeout: this.timeout,
    encoding: 'utf8'
});
```

### タイムアウト設定

GitConfigManagerと同じ5秒のタイムアウトを使用します：

```typescript
private readonly timeout: number = 5000; // 5秒
```

### 設定の確認

設定を削除する前に存在を確認し、不要なエラーを防ぎます：

```typescript
private async hasConfig(key: string): Promise<boolean> {
    try {
        await execFileAsync('npm', ['config', 'get', key], {
            timeout: this.timeout,
            encoding: 'utf8'
        });
        return true;
    } catch {
        return false;
    }
}
```

## セキュリティ考慮事項

### 入力検証

- applyProxySettings()内でProxyUrlValidatorを使用
- 無効なURLはnpm設定前に拒否
- シェルメタキャラクタを含むURLを拒否

### クレデンシャル保護

- すべてのログ出力でInputSanitizerを使用
- ユーザー通知でパスワードをマスク
- エラーメッセージにクレデンシャルを含めない

### コマンドインジェクション防止

- `exec()`ではなく`execFile()`を使用
- npmコマンドの引数を配列で渡す
- シェル解釈を回避

### タイムアウト保護

- すべてのnpmコマンドに5秒のタイムアウト
- ハングアップを防止
- タイムアウトエラーを適切に処理

## パフォーマンス考慮事項

### 並列実行

npm、Git、VSCodeの設定は独立しているため、エラーハンドリングを適切に行えば並列実行も可能です。ただし、現在の実装は順次実行を採用しており、npm対応でもこのパターンを踏襲します。

### キャッシング

getProxy()の結果をキャッシュする必要はありません。設定の取得は高速で、頻繁に呼ばれることもないためです。

### エラーリカバリー

npm設定の失敗は他の設定に影響しないため、パフォーマンスへの影響は最小限です。

## 互換性

### Node.jsバージョン

- Node.js 12.x以降をサポート（VSCode 1.9.0の要件に準拠）
- npmはNode.jsに同梱されているため、追加のインストールは不要

### npm設定の場所

npmの設定は以下の場所に保存されます：

- **Windows**: `%USERPROFILE%\.npmrc`
- **macOS/Linux**: `~/.npmrc`

NpmConfigManagerはnpm CLIを使用するため、プラットフォーム固有のパス処理は不要です。

### 既存の設定との共存

- 既存のnpm proxy設定を上書き
- 手動で設定したnpm proxyも管理対象
- 拡張機能の無効化時は設定を保持（ユーザーが明示的に削除するまで）

## 今後の拡張性

### yarn対応

将来的にyarnのproxy設定にも対応可能です。YarnConfigManagerを追加し、同じパターンで実装できます。

### pnpm対応

pnpmのproxy設定も同様のパターンで追加可能です。

### 設定のインポート/エクスポート

すべての設定（VSCode、Git、npm）をまとめてインポート/エクスポートする機能を追加できます。
