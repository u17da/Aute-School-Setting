# Radio — まなびポケット Design System

> `button.md` と同じ思想で書かれた、エージェント参照用の仕様書です。
> 実装時はまずこのファイルを読み、Radio.tsx を呼び出すこと。

---

## いつ Radio を使うか — 意思決定フロー

| やりたいこと | 使うコンポーネント |
|---|---|
| 複数の選択肢から **1つだけ** 選ばせたい | **Radio** ✅ |
| 複数の選択肢から **複数** 選ばせたい | Checkbox |
| 単一の設定の オン/オフ を即時切替 | Toggle |
| 選択肢が多い・表示領域が狭い | Pulldown |

### Radio が適切な条件
1. 選択肢が **2〜5つ程度** で、**全選択肢を一覧表示** したい
2. ユーザーが **1つだけ** 選ぶ
3. 選択肢のラベルが短く、**横並び** または **縦並び** で見比べたい

> ⚠️ 選択肢が6つ以上、またはラベルが長い場合は **Pulldown** を検討する。

---

## Variants / Props

### Size
| 値 | input サイズ | text サイズ | 用途 |
|---|---|---|---|
| `m` | 24px | Body/Large 16px | **デフォルト**。フォーム本体・設定画面 |
| `l` | 28px | Body/Large 16px | タッチ操作中心の画面、視認性を上げたい時 |
| `s` | 20px | Body/Medium 14px | 密なテーブル内、サイドパネル |

### LabelPlacement（ラベル位置）
| 値 | 配置 | 用途 |
|---|---|---|
| `end` | ラベルが右 | **デフォルト**。一般的なフォームレイアウト |
| `start` | ラベルが左 | 表組みなどラベル列とコントロール列を分ける時 |
| `top` | ラベルが上 | カードグリッド、選択肢にイメージや説明を併記する時 |
| `bottom` | ラベルが下 | 上記の縦配置パターン |

### State
| 値 | 視覚 |
|---|---|
| `default` | 通常 |
| `hover` | 背景に薄いグレー (#EFEFEF) または primary 系 (#F2FAFC) |
| `focus` | 背景に focus 用色 (#D7D7D7 / #EFFBFF) |
| `disabled` | アイコン色を #DFE6EB に、ラベルを #909398 に |

### Checked（必須・状態）
| 値 | 視覚 |
|---|---|
| `false` | 円のみ（border #CCCCCC） |
| `true` | 円 + 中央に塗りつぶしの ✓ ドット（#008299） |

---

## Do / Don't

### ✅ Do
- 横幅に余裕がある場合は **横並び** を原則とする
- 選択肢のテキストが長くなる場合に **縦並び** を検討する
- グループには `<fieldset>` + `<legend>` でグループタイトルを付ける
- **デフォルトで1つを選択済み** にしておく（最も一般的な選択肢）

### ❌ Don't
- **ラジオボタンを入れ子構造で使わない**（階層的選択は別UIで）
- 横幅に余裕があるのに縦並びを乱用しない（視認性が落ちる）
- 選択肢が動的に増える可能性がある場合に Radio を使わない（→ Pulldown）
- 単独の Radio ボタンを置かない（必ず2つ以上のグループで使う）

---

## アクセシビリティ要件

- ネイティブ `<input type="radio">` を使い、**同じ name** でグループ化する
- グループは `<fieldset>` + `<legend>` で囲み、グループの目的を伝える
- 各 input には `<label htmlFor>` で連結
- `aria-disabled` は不要（disabled 属性で十分）
- キーボード: 矢印キーでグループ内移動、Tab はグループ単位で移動
- フォーカス時は input 自体に focus ring が出るようにする

---

## 実装の入り口

```tsx
import { RadioGroup, Radio } from '@/design-system/components/radio/Radio';

// 標準的な使い方（fieldset/legend 自動）
<RadioGroup
  name="grade"
  label="学年を選択してください"
  value={grade}
  onChange={(v) => setGrade(v)}
>
  <Radio value="1">1年生</Radio>
  <Radio value="2">2年生</Radio>
  <Radio value="3">3年生</Radio>
</RadioGroup>

// サイズ・配置を変更
<RadioGroup name="layout" size="l" labelPlacement="bottom">
  <Radio value="list">リスト表示</Radio>
  <Radio value="grid">グリッド表示</Radio>
</RadioGroup>
```
