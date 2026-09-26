# Checkbox — まなびポケット Design System

> `button.md` と同じ思想で書かれた、エージェント参照用の仕様書です。

複数項目から **複数** を選択する／単一項目の On/Off を切り替えるコンポーネント。学習プラットフォームでは「ドリル選択」「学年フィルタ」「教員側のクラス絞り込み」などで多用される。

---

## いつ使うか（意思決定フロー）

| やりたいこと | 使うコンポーネント |
|---|---|
| 複数の選択肢から **複数** 選ばせる | **Checkbox** ✅ |
| 単一項目のチェック（同意するなど） | **Checkbox** ✅ |
| 複数の選択肢から **1つだけ** | Radio |
| 即時反映の On/Off スイッチ | Toggle |
| 選択肢が多い／領域が狭い | Pulldown |

**判定の核**: 「複数選択を許すか」「保存ボタン等で明示反映するか」。両方Yes → Checkbox。即時反映なら Toggle。

---

## Variants / Props

| Prop | 値 | デフォルト | 説明 |
|---|---|---|---|
| `checked` | `boolean` | `false` | チェック状態 |
| `indeterminate` | `boolean` | `false` | 中間状態（親チェックボックスが「一部選択」を示すとき） |
| `disabled` | `boolean` | `false` | 非活性 |
| `size` | `'L' \| 'M' \| 'S' \| 'SS'` | `'M'` | サイズ。CheckList 用に SS あり |
| `label` | `string` | — | ラベルテキスト |
| `helperLabel` | `string` | — | 補足メタ情報（例: 「1年2組」） |
| `helperIcon` | `ReactNode` | — | 補足アイコン（鍵マーク・ヘルプ等） |
| `value` | `string` | — | 識別値 |
| `onChange` | `(checked: boolean) => void` | — | 変更ハンドラ |

---

## Sizes

| Size | ヒット領域 | アイコン | フォント | 主な用途 |
|---|---|---|---|---|
| L  | 46×46 | 28×28 | 16px | タッチ主体・大きいフォーム |
| M  | 42×42 | 24×24 | 16px | **標準** |
| S  | 38×38 | 20×20 | 14px | CheckList・密度高めUI |
| SS | 38×38 | 20×20 | 12px | 表セル内・コンパクト一覧 |

---

## States

| 状態 | 枠／塗り | チェック色 | ラベル色 |
|---|---|---|---|
| Unchecked / Default | border `#CCCCCC` | — | `#283148` |
| Unchecked / Hover | border `#CCCCCC` + bg `#EFEFEF`（円周） | — | `#283148` |
| Unchecked / Focus | border `#CCCCCC` + bg `#D7D7D7` | — | `#283148` |
| Unchecked / Disabled | border `#DFE6EB` | — | `#909398` |
| Checked / Default | fill `#008299` | white | `#283148` |
| Checked / Hover | fill `#008299` + bg `#F2FAFC` | white | `#283148` |
| Checked / Focus | fill `#008299` + bg `#EFFBFF` | white | `#283148` |
| Checked / Disabled | fill `#DFE6EB` | white | `#909398` |
| Indeterminate / Default | fill `#008299` | white「ー」 | `#283148` |
| Indeterminate / Disabled | fill `#DFE6EB` | white「ー」 | `#909398` |
| Focus-visible | + `outline: 2px solid #008299` | — | — |

---

## CheckList（拡張バリアント）

学習プラットフォーム特有の「課題の進捗をリスト表示しつつチェックできる」用途。`label` に加えて `helperLabel`（例:「1年2組」）と `helperIcon`（鍵マークなど）をサポート。

```tsx
<Checkbox
  size="S"
  label="あかねこドリル 3〜5ページ"
  helperLabel="1年2組"
/>
```

---

## Do / Don't

### ✅ Do
- 複数選択が必要なフィルタ・絞り込みに使う
- 親チェックボックスの「一部選択」状態は `indeterminate` で表現する
- 単一項目（利用規約への同意など）にも使ってよい
- ラベルは名詞句または体言止めで簡潔に

### ❌ Don't
- 即時反映スイッチには使わない（→ Toggle）
- 単一選択（排他）の場面では使わない（→ Radio）
- 選択肢が極端に多い（10件以上）場合は Pulldown 検討
- ラベルなしで使わない（aria-label が必要）

---

## アクセシビリティ要件

- **ネイティブ `<input type="checkbox">` を使用**
- **`indeterminate` は DOM プロパティ経由で設定**（属性では不可、`useEffect` で代入）
- **キーボード操作**: `Space` でトグル、`Tab` でフォーカス
- **`aria-checked`**: `'mixed'`（indeterminate）/ `true` / `false`
- **`aria-disabled`**: `disabled=true` のとき
- **`<label htmlFor>`** で関連付け、クリック領域を広げる
- **focus-visible** でキーボードフォーカスを可視化

---

## 実装の入り口

```tsx
import { Checkbox } from '@/components/Checkbox';

// 基本
<Checkbox label="エンターテイメント" checked={v} onChange={setV} />

// 親（一部選択）
<Checkbox label="全て" indeterminate={partial} onChange={toggleAll} />

// CheckList 用途
<Checkbox size="S" label="あかねこドリル 3〜5ページ" helperLabel="1年2組" />

// 非活性
<Checkbox label="削除済み項目" disabled checked />
```
