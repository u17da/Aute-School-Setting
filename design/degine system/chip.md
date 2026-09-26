# Chip — まなびポケット Design System

> `button.md` と同じ思想で書かれた、エージェント参照用の仕様書です。

ステータス表示・フィルタリング・補助的アクションのトリガーに使う、コンパクトなラウンドピル型コンポーネント。学習プラットフォームでは「教科タグ」「絞り込みチップ」「出欠表示」などに使う。

---

## いつ使うか（意思決定フロー）

| やりたいこと | 使うコンポーネント |
|---|---|
| ステータスやカテゴリを **クリックして操作** させる | **Chip** ✅ |
| 絞り込み条件をその場で追加／削除する | **Chip** ✅（×アイコン付き） |
| 並列するクイックアクション（編集・展開など） | **Chip** ✅ |
| 単に **カテゴリ名を表示するだけ**（操作不可） | Label |
| 主要なアクション・遷移 | Button |
| 即時反映の On/Off | Toggle |

**判定の核**: 「クリック（操作）できるか」。できる＝Chip、できない＝Label。Button との差は「補助的か主要か」「並列して複数置くか単独で目立たせるか」。

---

## Variants / Props

| Prop | 値 | デフォルト | 説明 |
|---|---|---|---|
| `size` | `'L' \| 'M' \| 'S'` | `'L'` | サイズ |
| `color` | `'primary' \| 'white'` | `'primary'` | カラーテーマ |
| `variant` | `'filled' \| 'outlined'` | `'filled'` | スタイル |
| `state` | `'default' \| 'hover' \| 'active' \| 'disabled'` | `'default'` | 状態（通常はCSSで制御） |
| `disabled` | `boolean` | `false` | 非活性 |
| `label` | `string` | — | ラベルテキスト |
| `startIcon` | `ReactNode` | — | 先頭アイコン |
| `endIcon` | `ReactNode` | — | 末尾アイコン（×・▼・✏︎・›など） |
| `onClick` | `() => void` | — | クリックハンドラ |
| `onDelete` | `() => void` | — | 削除ハンドラ（指定時に末尾に×を表示） |

---

## Sizes

| Size | 高さ | 横padding | フォント | 主な用途 |
|---|---|---|---|---|
| L | 36px | 8px | 16px (bold) | **標準**。視認性優先 |
| M | 32px | 8px | 14px | スペース制約あり |
| S | 21px | 4px | 14px | コンパクト一覧・テーブル内 |

---

## Colors × Variants

| 組み合わせ | 用途 |
|---|---|
| Primary × Filled | **最も基本**。アクション可能なステータス・タグ |
| Primary × Outlined | 補助的に使う。背景色や並列要素との優先度調整 |
| White × Filled | 暗色系背景上で使用 |
| White × Outlined | 白背景上で枠線のみで存在感を抑える |

---

## States

| 状態 | 背景 | テキスト | 枠線 |
|---|---|---|---|
| Primary/Filled Default | `#F2FAFC` | `#283148` | — |
| Primary/Filled Hover | `#EFFBFF` | `#283148` | — |
| Primary/Filled Active | `#EFFBFF` | `#00606D` | — |
| Primary/Filled Disabled | `#EDF0F2` (38%) | `#909398` | — |
| Primary/Outlined Default | `#FFFFFF` | `#283148` | `#008299` |
| Primary/Outlined Hover | `#EFFBFF` | `#283148` | `#008299` |
| Primary/Outlined Active | `#EFFBFF` | `#00606D` | `#008299` |
| Primary/Outlined Disabled | `#FFFFFF` (38%) | `#909398` | `#CCCCCC` |
| White/Outlined Default | `#FFFFFF` | `#283148` | `#DDE0E2` |
| White/Outlined Hover | `#F5F7F8` | `#283148` | `#DDE0E2` |
| Focus-visible | + `outline: 2px solid #008299` | — | — |

---

## Chips/Attendance（拡張バリアント）

出欠状況の表示用ピル。極小サイズ（高さ15px）で、テーブルセルや時間割セルに配置する。

| Status | 枠線色 | テキスト色 |
|---|---|---|
| 出席 | `#008299` | `#008299` |
| 遅刻 | `#C97CCB` | `#C97CCB` |
| 早退 | `#A3CB7C` | `#A3CB7C` |
| 欠席 | `#C53F3F` | `#C53F3F` |
| その他 | `#909398` | `#909398` |

```tsx
<AttendanceChip status="出席" />
```

---

## Do / Don't

✅ Do
- フィルタリングUI で複数の Chip を横並び配置（折返し可）
- 削除可能な要素には `endIcon={<CancelIcon />}` または `onDelete` を使う
- 1画面に複数並べる場合はサイズを統一する

❌ Don't
- 主要アクション（フォーム送信・遷移など）には Chip を使わない → Button
- 単純なカテゴリ表示には Chip を使わない → Label
- Filled と Outlined を同じグループ内で混ぜない（情報階層が崩れる）

---

## アクセシビリティ

- クリック可能な Chip は `role="button"` を持ち、Enter/Space で発火
- 削除アイコンは独立した `<button aria-label="削除">` として配置
- `disabled` 時は `aria-disabled="true"` を付与し、フォーカス対象から外す
- フォーカス時は `outline` を必ず可視化（`focus-visible`）
- 色のみで状態を伝えない（出欠チップはテキスト併記が必須）

---

## 実装の入り口

```tsx
import { Chip } from '@/components/Chip/Chip';

// 基本
<Chip label="国語" />

// 削除可能なフィルタ
<Chip
  label="1年2組"
  onDelete={() => removeFilter('class-1-2')}
/>

// プルダウン的な使い方
<Chip
  label="並び替え"
  endIcon={<KeyboardArrowDownIcon />}
  onClick={openMenu}
/>

// アウトライン・小サイズ
<Chip size="S" variant="outlined" label="提出済み" />
```
