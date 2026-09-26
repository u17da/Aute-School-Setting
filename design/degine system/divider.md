# Divider（ディバイダー）

まなびポケット Design System — レイアウトコンポーネント

## いつどれを使うか

| シナリオ | 使うもの | 理由 |
|---|---|---|
| セクション間の視覚的区切り | **Divider** | 読みやすさ向上 |
| コンテンツのグループ分け | **Divider + Accordion** | 折りたたみ付き区切り |
| タブやナビゲーションの切替 | Tab / Navigation | 区切りではなく切替 |

## Direction variants

| direction | 用途 | 説明 |
|---|---|---|
| `horizontal` | セクション間の横線 | 最も一般的 |
| `vertical` | 並列コンテンツ間の縦線 | 数値比較、サイドバイサイド表示 |

## Accordion variants

| accordion | open | 表示 |
|---|---|---|
| `false` | — | シンプルな線のみ |
| `true` | `false` | 線 + Chip(ラベル + ▼) + 線 |
| `true` | `true` | 線 + Chip(ラベル + ▲) + 線 |

## 構造

### シンプル（horizontal）
```
────────────────────────────────────
```

### シンプル（vertical）
```
│
│
│
```

### Accordion（closed）
```
──────  [ ラベル ▼ ]  ──────
```

### Accordion（open）
```
──────  [ ラベル ▲ ]  ──────
          コンテンツ
──────  [ ラベル ▲ ]  ──────
```

## スタイル詳細

| 要素 | 値 |
|---|---|
| 線色（デフォルト） | `#E9EBEC`（stroke/form_gray30） |
| 線の太さ | `1px solid` |
| Chip 背景 | `#FFFFFF` |
| Chip ボーダー | `1px solid #DDE0E2`（accordion=true, outline あり） |
| Chip テキスト | 14px / weight 300 / `#283148` |
| Chip radius | `100px`（pill） |
| Chip padding | `4px 8px` |
| ▼/▲ アイコン | 24×24、`#61646C`（closed）/ `#909398`（open） |

## カラーバリエーション

- デフォルト: `#E9EBEC`
- 場所によって見づらい場合はカラーパレットの stroke 色から変更可能
- `color` prop で上書き

## Do / Don't

| ✅ Do | ❌ Don't |
|---|---|
| 異なるセクション間に明確な区切りとして使う | 同じセクション内の各行に入れる（→ リスト罫線で十分） |
| vertical は並列数値比較などに使う | vertical を無理にナビゲーション代わりにする |
| Accordion で折りたたむ場合は中身のラベルを明記する | ラベルなしの Accordion を使う |
| 背景色との対比でカラーを調整する | デフォルト色で見づらいまま放置する |

## アクセシビリティ

- シンプル Divider: `role="separator"` + `aria-orientation="horizontal|vertical"`
- Accordion Divider: Chip 部分に `aria-expanded="true|false"` + `aria-controls`
- Accordion のキーボード操作: Enter / Space で開閉
- 視覚的な区切りのみで論理的な区切りがない場合は `role="presentation"` でもよい

## 実装スニペット

```tsx
import { Divider } from '@manabi-ds/divider';

// 1. 横線（シンプル）
<Divider />

// 2. 縦線
<Divider direction="vertical" />

// 3. Accordion 付き
<Divider accordion label="詳細を表示">
  <DetailContent />
</Divider>

// 4. カラー変更
<Divider color="#DDE0E2" />
```
