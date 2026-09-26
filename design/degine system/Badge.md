# Badge — まなびポケット Design System

> エージェントへ：通知バッジを実装する時、まず本ファイルを読み、`Badge.tsx`をimportして使うこと。

---

## 1. いつどれを使うか（意思決定フロー）

| ユーザーに伝えたいこと | `type` | `color` | 例 |
|---|---|---|---|
| 未読の存在を知らせたい（数不要） | `dot` | `primary` | サイドメニューアイコン右上 |
| 未読の**件数**を知らせたい | `count` | `primary` | メニュー項目「お知らせ (3)」 |
| 補助的な件数情報（アラート感不要） | `count` | `secondary` | フォルダ内のファイル数 |

### 厳守ルール

- 数字のみ表記する。テキストは入れない。
- **100件を超える場合は「99+」** で表記する。
- 1桁は正円、桁数が増えると横に拡張する。
- アイコンに使用する場合は**基本的に右上に配置**する。

---

## 2. Types

| type | 説明 | 形状 |
|---|---|---|
| `dot` | 件数不要の存在通知 | 8px 正円 |
| `count` | 件数あり通知 | 正円〜横長ピル |

---

## 3. Sizes

| size | dot 直径 | count 高さ | count min-width | font-size | 用途 |
|---|---|---|---|---|---|
| `small` | 8px | 14px | 14px | 8px | アイコン右上に配置 |
| `medium` | — | 19px | 19px(1桁) / auto(2桁+) | 10px | リスト・メニュー横に配置 |

---

## 4. Colors

| color | 背景 | テキスト | ボーダー | 用途 |
|---|---|---|---|---|
| `primary` | `#D50000` | `#FFFFFF` | なし | 緊急・未読通知 |
| `secondary` | `#FFFFFF` | `#61646C` | 1px solid `#CCCCCC` | 補助情報 |

---

## 5. States

Badge はインタラクティブな要素ではないため、hover / focus 等の状態はない。  
表示/非表示の切り替えのみ。

- `count === 0` または `visible === false` → 非表示。
- アニメーション: 出現時にscale(0→1)のpulseを推奨（任意）。

---

## 6. Anatomy（構造）

```
Dot:
  ● ← 8px circle, bg #D50000

Count / Small:
  ┌───┐
  │ 2 │ ← 14px circle, font 8px
  └───┘

Count / Medium:
  ┌─────┐
  │ 99+ │ ← 19px height, pill shape
  └─────┘
```

---

## 7. Do / Don't

| Do | Don't |
|---|---|
| 数字のみ表示する | テキスト（「新着」等）を入れる |
| 100件超は「99+」で表記 | 「123」のような3桁数字をそのまま表示 |
| アイコンの右上に配置 | アイコンの左下に配置 |
| Primary で緊急通知、Secondary で補助情報 | 全部 Primary にする |
| 未読が0件なら非表示にする | 「0」を表示し続ける |

---

## 8. アクセシビリティ

- Badge 自体にインタラクションはない。`aria-hidden="true"` を付与。
- 親要素に `aria-label` で件数情報を付与する（例: `aria-label="お知らせ 3件未読"`）。
- スクリーンリーダー用に `<span className="sr-only">3件の未読</span>` を別途追加することを推奨。

---

## 9. 実装の入り口

```tsx
import { Badge } from '@manabi-ds/Badge';

{/* アイコンの右上に dot */}
<div style={{ position: 'relative', display: 'inline-flex' }}>
  <BellIcon />
  <Badge type="dot" />
</div>

{/* 件数表示 */}
<div style={{ position: 'relative', display: 'inline-flex' }}>
  <FolderIcon />
  <Badge type="count" count={3} size="small" />
</div>

{/* 99+ 表示 */}
<Badge type="count" count={150} size="medium" color="primary" />

{/* 補助情報 */}
<Badge type="count" count={5} size="medium" color="secondary" />
```
