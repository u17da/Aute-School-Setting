# Label — まなびポケット Design System

> `button.md` と同じ思想で書かれた、エージェント参照用の仕様書です。

カテゴリやステータスを **表示するだけ** の受動的コンポーネント。クリックしてもアクションは起こらない。Chip との明確な使い分けは「操作可能性」。

---

## いつ使うか（意思決定フロー）

| やりたいこと | 使うコンポーネント |
|---|---|
| カテゴリ・タグを **表示するだけ**（操作不可） | **Label** ✅ |
| ステータスをドット付きで示す（対応中／対応終了など） | **Label**（Status バリアント） ✅ |
| クリックして絞り込み・削除 | Chip |
| 主要アクション | Button |
| 重要・要返信などの注意喚起 | **Label**（notification カラー）✅ |

**判定の核**: 「ユーザーが触れるか」。触らせない＝Label、触らせる＝Chip。

---

## Variants / Props

| Prop | 値 | デフォルト | 説明 |
|---|---|---|---|
| `size` | `'S' \| 'SS'` | `'S'` | サイズ（L/M はなし） |
| `color` | `LabelColor` | `'gray'` | カラー |
| `variant` | `'filled' \| 'outlined'` | `'filled'` | スタイル |
| `label` | `string` | — | テキスト |
| `status` | `'on' \| 'off'` | — | ステータスドット表示用 |
| `statusLabel` | `string` | — | ステータス時のテキスト（例: 「対応中」「対応終了」） |

### LabelColor

```ts
type LabelColor =
  | 'gray'         // 標準・ニュートラル
  | 'blue'         // 情報系
  | 'secondary'    // セカンダリ（teal #00729E）
  | 'green'        // 完了・正常
  | 'orange'       // 注意・警告（弱）
  | 'lightBlue'    // 単色運用したい時の推奨色
  | 'notification1'// 重要（赤・filled のみ）
  | 'notification2'// 要返信（薄ピンク）
```

---

## Sizes

| Size | 高さ | フォント | padding | 用途 |
|---|---|---|---|---|
| S  | 22px | 12px | 2px 6px | **標準** |
| SS | 16px | 10px | 2px 6px | 一覧・テーブル内・密度高めUI |

---

## Colors × Variants 対応表

| Color | Filled (bg / text) | Outlined (border / text) |
|---|---|---|
| gray | `#444749` / `#FFFFFF` | `#444749` / `#444749` |
| blue | `#0D47A1` / `#FFFFFF` | `#0D47A1` / `#0D47A1` |
| secondary | `#00729E` / `#FFFFFF` | `#00729E` / `#00729E` |
| green | `#2E7D32` / `#FFFFFF` | `#2E7D32` / `#219653` |
| orange | `#C45500` / `#FFFFFF` | `#C45500` / `#C45500` |
| lightBlue | `#EFFBFF` / `#283148` | — |
| notification1 | `#C53F3F` / `#FFFFFF` | — |
| notification2 | `#FCECEF` / `#D50000` | — |

---

## Status バリアント

「対応中／対応終了」のようなフロー状態を、テキスト＋色付きドットで表す。背景は `#EDF0F2` の薄グレーに固定。

| Status | ドット色 |
|---|---|
| on | `#00839A`（対応中・進行中など） |
| off | `#909398`（対応終了・休止など） |

```tsx
<Label status="on" statusLabel="対応中" />
<Label status="off" statusLabel="対応終了" size="SS" />
```

---

## Do / Don't

✅ Do
- 並列して複数表示する場合は **同じ size に統一**
- 1色だけで運用したい場合は **lightBlue** を使う
- 重要事項のみ notification1（赤・filled）を使う

❌ Don't
- ❌ クリック動作を期待させない（border/hover/cursor を変えない）
- ❌ notification（赤・ピンク）をカテゴリカラーの一つとして並列利用しない
- ❌ Button や Chip と並べて操作可能要素と紛らわしくしない
- ❌ S と SS を同じグループ内で混在させない

---

## アクセシビリティ

- 受動表示なので **focusable にしない**（`tabIndex` を付けない・`button` 要素にしない）
- 色のみで意味を伝えない。ステータスは必ずテキストを併記
- スクリーンリーダー向けに、文脈に応じて `aria-label` を補強できるよう Props で受ける

---

## 実装の入り口

```tsx
import { Label } from '@/components/Label/Label';

// 基本
<Label label="国語" />

// サイズ・カラー指定
<Label size="SS" color="blue" variant="outlined" label="未提出" />

// 重要表示
<Label color="notification1" label="重要" />

// ステータス表示
<Label status="on" statusLabel="対応中" />
```
