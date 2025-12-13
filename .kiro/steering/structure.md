# プロジェクト構造

## 組織哲学

**レイヤー/ドメイン分離型**: 機能の責務に基づいてディレクトリを分割。
各ディレクトリは単一の責務を持ち、明確なインターフェースで連携。

## ディレクトリパターン

### コア (`/src/core/`)
**目的**: 拡張機能の中核ロジック
**内容**: 型定義、状態管理、初期化、プロキシ適用
**例**: `types.ts`, `ProxyStateManager.ts`, `ExtensionInitializer.ts`

### 設定管理 (`/src/config/`)
**目的**: 各ツールへのプロキシ設定
**内容**: Git/VSCode/npm/Terminal の ConfigManager
**パターン**: `{Tool}ConfigManager.ts` - 各ツール固有の設定操作をカプセル化

### コマンド (`/src/commands/`)
**目的**: VSCode コマンドの実装
**内容**: 各コマンドのハンドラ、レジストリ
**パターン**: `{Action}Command.ts` - 単一コマンドを単一クラスで実装

### バリデーション (`/src/validation/`)
**目的**: 入力検証とサニタイズ
**内容**: URL検証、入力サニタイザー
**例**: `ProxyUrlValidator.ts`, `InputSanitizer.ts`

### モニタリング (`/src/monitoring/`)
**目的**: プロキシ状態の監視と検証
**内容**: 接続テスト、スケジューラー、フォールバック管理
**例**: `ProxyMonitor.ts`, `ProxyConnectionTester.ts`

### エラー処理 (`/src/errors/`)
**目的**: エラーハンドリングと通知
**内容**: 通知管理、デバウンス、フォーマット
**例**: `UserNotifier.ts`, `NotificationThrottler.ts`

### UI (`/src/ui/`)
**目的**: ユーザーインターフェース
**内容**: ステータスバー管理
**例**: `StatusBarManager.ts`

### 国際化 (`/src/i18n/`)
**目的**: 多言語対応
**内容**: ロケールファイル、I18n マネージャー
**構成**: `locales/en.json`, `locales/ja.json`, `I18nManager.ts`

### ユーティリティ (`/src/utils/`)
**目的**: 共通ユーティリティ
**例**: `Logger.ts`, `ProxyUtils.ts`

### モデル (`/src/models/`)
**目的**: データモデル/値オブジェクト
**例**: `ProxyUrl.ts`

### テスト (`/src/test/`)
**目的**: テストコード
**パターン**: ソースと同じ構造をミラーリング

## 命名規則

- **ファイル**: PascalCase (例: `GitConfigManager.ts`)
- **クラス**: PascalCase (例: `class GitConfigManager`)
- **インターフェース**: PascalCase, `I` プレフィックス任意 (例: `interface ProxyState`, `interface IProxyApplier`)
- **列挙型**: PascalCase (例: `enum ProxyMode`)
- **テスト**: `{SourceName}.test.ts`, `{SourceName}.property.test.ts`

## インポート構成

```typescript
// 1. 外部モジュール (vscode, node built-ins)
import * as vscode from 'vscode';
import { execFile } from 'child_process';

// 2. 相対インポート (同一プロジェクト内)
import { ProxyMode } from './core/types';
import { Logger } from '../utils/Logger';
```

**パスエイリアス**: 未使用 (相対パスで統一)

## コード構成原則

### 単一責務

各クラスは単一の責務を持つ:
- `GitConfigManager`: Git プロキシ設定のみ
- `ProxyUrlValidator`: URL 検証のみ
- `StatusBarManager`: ステータスバー表示のみ

### 依存性注入

コンストラクタで依存を注入し、テスタビリティを確保:

```typescript
export class ProxyApplier {
    constructor(
        private gitConfigManager: GitConfigManager,
        private vscodeConfigManager: VscodeConfigManager,
        private npmConfigManager: NpmConfigManager,
        private validator: ProxyUrlValidator,
        // ...
    ) {}
}
```

### インターフェース分離

外部依存はインターフェースで抽象化:

```typescript
export interface IProxyStateManager {
    getState(): Promise<ProxyState>;
    saveState(state: ProxyState): Promise<void>;
    // ...
}
```

---
_パターンを文書化。ファイルツリーは避ける。パターンに従う新規ファイルは更新不要_
