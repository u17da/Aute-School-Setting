# Message（トースト通知）

まなびポケット Design System — フィードバックコンポーネント

## いつどれを使うか

| シナリオ | コンポーネント | 理由 |
|---|---|---|
| ユーザー操作の成否を即座に伝える | **Message** | 一時的表示・自動消失 |
| サイト全体に関わる重要告知 | MessageBar | 画面最上部に常設 |
| 情報を常設バナーで提示 | InfoBanner | 画面下部に配置 |
| ユーザーの入力・選択を求める | Modal | 操作を中断させる |

## Variants（type プロパティ）

| type | アイコン色 | 用途 | 自動消失 |
|---|---|---|---|
| `info` | `#0083B1` | 情報提示（Primary色相） | 5秒 |
| `success` | `#388E3C` | 操作完了 | 3秒 |
| `error` | `#C53F3F` | 操作失敗 | 5秒 |
| `warning` | `#EF6C00` | 注意喚起 | 5秒 |

## Sizes

| size | 用途 | padding | font-size | icon |
|---|---|---|---|---|
| `pc` | デスクトップ | `16px 24px` | 16px / weight 600 | 24×24 |
| `sp` | モバイル | `8px` | 14px / weight 300 | 24×24 |

## States

- **visible** — フェードイン、画面上部中央にオーバーレイ表示
- **dismissing** — フェードアウト（ユーザーが×を押す or タイマー）
- **hidden** — DOM から除去 or display:none

## 構造

```
┌─────────────────────────────────────┐
│ [icon]  メッセージテキスト     [×]  │
└─────────────────────────────────────┘
```

- 白背景 `#FFFFFF` + `box-shadow: 0px 2px 12px rgba(0,0,0,0.1)` + `border-radius: 8px`
- アイコン（info / check_circle / cancel / warning）各 24×24
- 閉じるボタン（×）: `#61646C`、32×32 タップ領域

## 表示ルール

- コンテンツエリア上部中央に配置、z-index はモーダル未満
- success は 3秒で自動消失、それ以外は 5秒
- 統一不可の場合は全タイプ 5秒
- 複数同時表示時はスタッキング（上から順に積む）

## Do / Don't

| ✅ Do | ❌ Don't |
|---|---|
| 操作の直接的な結果を通知する | 長文の説明を入れる |
| 1行で完結するメッセージにする | 複数アクションをトースト内に配置する |
| type を情報属性に合わせて選択する | 全て info で統一する |
| SP では padding を詰める | PC 用サイズをモバイルにそのまま使う |

## アクセシビリティ

- `role="status"` + `aria-live="polite"`（success/info）
- `role="alert"` + `aria-live="assertive"`（error/warning）
- 閉じるボタンに `aria-label="閉じる"`
- フォーカストラップは不要（非モーダル）
- タイマー中にホバー/フォーカスされたら消失を一時停止

## 実装スニペット

```tsx
import { Message } from '@manabi-ds/message';

<Message type="success">保存しました</Message>
<Message type="error" duration={8000}>通信エラーが発生しました</Message>
<Message type="info" size="sp">お知らせがあります</Message>
```
