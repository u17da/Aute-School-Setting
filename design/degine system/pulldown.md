# Pulldown — まなびポケット Design System

> `button.md` と同じ思想で書かれた、エージェント参照用の仕様書です。

複数のアクション・選択肢を格納するドロップダウンメニュー。**選択直後に即アクションが実行される** のが TextField/Select との最大の違い。

> Pulldown は `Pulldown/Btn`（トリガー）と `Pulldown/Menu`（個別の項目）の 2 サブコンポーネントから構成される。

---

## いつ使うか（意思決定フロー）

| やりたいこと | 使うコンポーネント |
|---|---|
| 選択即時にアクション実行（並び替え・絞り込み・モード切替） | **Pulldown** ✅ |
| その場で実行されるサブアクション群（編集・削除・複製） | **Pulldown**（Iconスタイル＋more_vert）✅ |
| フォームの値を選択（送信時に確定） | **TextField/Select** |
| 単一トリガーの主要アクション | Button |
| クリックして発火する補助アクション（単発） | Chip |

**判定の核**: 「選んだ瞬間に何かが起こるか」。即時=Pulldown、保存ボタンで反映=Select。

---

## サブコンポーネント

### 1. `Pulldown/Btn` — トリガー本体

| Prop | 値 | デフォルト | 説明 |
|---|---|---|---|
| `style` | `'text' \| 'icon'` | `'text'` | テキスト＋▼ or アイコンのみ（more_vert）|
| `size` | `'L' \| 'M' \| 'S' \| 'SS'` | `'M'` | サイズ |
| `state` | `'default' \| 'hover' \| 'focus' \| 'disabled'` | — | 通常はCSSで制御 |
| `label` | `string` | — | 表示テキスト |
| `disabled` | `boolean` | `false` | 非活性 |
| `open` | `boolean` | `false` | メニュー開閉状態 |
| `placeholder` | `string` | — | 未選択時の文言（動詞なし・体言止め） |

### 2. `Pulldown/Menu` — メニュー項目

| Prop | 値 | デフォルト | 説明 |
|---|---|---|---|
| `size` | `'M' \| 'S' \| 'SS'` | `'M'` | 項目サイズ（Btn のサイズと一致させる） |
| `state` | `'default' \| 'hover' \| 'active'` | `'default'` | 状態 |
| `label` | `string` | — | 項目テキスト |
| `value` | `string` | — | 識別値 |
| `onSelect` | `(value: string) => void` | — | 選択ハンドラ |
| `tone` | `'normal' \| 'danger'` | `'normal'` | 危険操作（削除など）は赤テキスト |

---

## Sizes

### Pulldown/Btn

| Size | 高さ | フォント | 主な用途 |
|---|---|---|---|
| L  | 48px | 16px | 大きいフォーム・タッチ主体 |
| M  | 40px | 16px | **標準** |
| S  | 32px | 14px | 一覧上のクイック操作 |
| SS | 32px | 12px | テーブル内・コンパクトUI |

### Pulldown/Menu

| Size | 高さ | フォント |
|---|---|---|
| M  | 40px | 16px |
| S  | 32px | 14px |
| SS | 30px | 12px |

---

## States

### Pulldown/Btn

| 状態 | 背景 | 枠線 | テキスト |
|---|---|---|---|
| Default | `#FFFFFF` | `#E9EBEC` | `#283148` |
| Hover | `#F5F7F8` | `#E9EBEC` | `#283148` |
| Focus / Open | `#FFFFFF` | `#008299` (2px) | `#283148` |
| Disabled | `#FFFFFF` | `#E9EBEC` | `#909398` |
| Disabled Hover | （上と同じ） | — | カーソル `not-allowed` |

### Pulldown/Menu

| 状態 | 背景 |
|---|---|
| Default | `#FFFFFF` |
| Hover | `#F5F7F8` |
| Active | `#F5F7F8` |

---

## スクロール表示

選択肢の数で出し分ける。

- **5項目以下**: スクロールバー非表示（メニュー高さ可変）
- **6項目以上**: メニュー高さを固定し、`Scrollbar` を表示

幅 15px、つまみ色 `#BCBDBD`、トラック色 `#EFEFEF`。

---

## プルダウン文言ルール

トリガー（Btn）に表示するラベルは **動詞なし・体言止め** で統一する。

✅ 良い: 「並び替え」「学年」「教科」
❌ 悪い: 「並び替える」「学年を選択してください」

---

## TextField/Select との違い

| 観点 | Pulldown/Btn | TextField/Select |
|---|---|---|
| **主用途** | 選択肢・アクションを選ぶ | フォームで値を選択する |
| **選択後の挙動** | 即座にアクション実行 | フォーム送信時に値が反映される |
| **使用例** | サブメニュー・絞り込み | フォーム項目選択（送信ボタンで反映） |

---

## Icon スタイル（`style="icon"`）

`more_vert`（︙）アイコンのみのトリガー。一覧の各行にサブアクション（編集・削除・複製）をまとめる用途。

```tsx
<Pulldown
  style="icon"
  size="M"
  items={[
    { value: 'edit', label: '編集' },
    { value: 'duplicate', label: '複製' },
    { value: 'delete', label: '削除', tone: 'danger' },
  ]}
/>
```

---

## Do / Don't

✅ Do
- Btn と Menu の size を一致させる
- 危険操作（削除など）は `tone="danger"` で赤テキスト
- 選択肢が6つ以上の場合は必ずスクロールバー表示

❌ Don't
- ❌ フォーム値の選択用途で使わない（→ TextField/Select）
- ❌ Btn のラベルに動詞を使わない
- ❌ 非活性時にもクリック可能なように見せない（`cursor: not-allowed` を出す）

---

## アクセシビリティ

- Btn は `<button aria-haspopup="listbox" aria-expanded={open}>`
- Menu は `<ul role="listbox">`、項目は `<li role="option" aria-selected={selected}>`
- キーボード操作: `↑↓` で項目移動、`Enter`/`Space` で選択、`Esc` でクローズ
- 開閉時は `aria-expanded` を切り替える
- 選択肢のフォーカスは `focus-visible` で必ず可視化

---

## 実装の入り口

```tsx
import { Pulldown } from '@/components/Pulldown/Pulldown';

const items = [
  { value: 'asc', label: '昇順' },
  { value: 'desc', label: '降順' },
];

// 標準（テキスト + 矢印）
<Pulldown
  label="並び替え"
  size="M"
  items={items}
  onSelect={(v) => sort(v)}
/>

// アイコンのみ（more_vert）
<Pulldown
  style="icon"
  items={[
    { value: 'edit', label: '編集' },
    { value: 'delete', label: '削除', tone: 'danger' },
  ]}
/>
```
