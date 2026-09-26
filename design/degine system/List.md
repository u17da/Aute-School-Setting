# List — まなびポケット Design System

> エージェントへ：一覧やメニューを実装する時、まず本ファイルを読み、`List.tsx`をimportして使うこと。

---

## 1. いつどれを使うか（意思決定フロー）

| ユーザーの意図 | `type` | `size` | 例 |
|---|---|---|---|
| 画面の主要な一覧コンテンツ | Cell | `large` | 児童名簿一覧 |
| スペースに余裕がない一覧 | Cell | `medium` | モーダル内の選択リスト |
| テーブル内のコンパクト表示 | Cell | `small` | 詳細設定テーブル |
| 一覧のヘッダー行（ソート付き） | Header | `large` / `medium` / `small` | カラムヘッダー |

### サイズの選び方

- 画面内の主要コンテンツとして使用する場合 → 原則 **Large**
- スペースや他コンテンツとの優先順位を考慮 → **Medium**
- それでも収まらない → **Small**

---

## 2. Types

### Header

| 要素 | 説明 |
|---|---|
| Checkbox | 全選択チェックボックス（表示/非表示可） |
| Label + SortIcon | カラム名 + ソートアイコン（swap_vert） |
| SearchIcon | カラム内検索（表示/非表示可） |
| ToggleSwitch | ON/OFFトグル（表示/非表示可） |

### Cell

| 要素 | 説明 |
|---|---|
| Checkbox | 行選択チェックボックス（表示/非表示可） |
| Icon | アバターやアイコン（表示/非表示可） |
| DataInside | メインデータ（名前等） |
| AttentionText | 警告ラベル（エラー時に表示） |
| Indent | インデントスペーサー（ツリー構造用） |

---

## 3. Sizes

| size | Header 高さ | Cell 高さ | font-size |
|---|---|---|---|
| `large` | 56px | 56px | 16px |
| `medium` | 48px | 48px | 16px |
| `small` | 40px | 40px | 12px (Cell) / 14px (Header) |

---

## 4. States (Cell のみ)

| state | 背景 | テキスト色 | Checkbox |
|---|---|---|---|
| `enabled` | `#FFFFFF` | `#283148` | unchecked |
| `hovered` | `#F5F7F8` | `#283148` | unchecked |
| `focused` | `#F5F7F8` | `#283148` | unchecked |
| `disabled` | `#FFFFFF` | `#909398` | disabled appearance (#EDF0F2) |

---

## 5. Header — Check variants

| check | 見た目 |
|---|---|
| `off` | 空チェックボックス (#CCCCCC) |
| `on` | チェック済み (#008299) |

---

## 6. AAR ポータル専用 List

Figma上の `List/AAR` は AAR ポータルを中心に使用するもの。原則としてサイズ・色等の改変は行わない。

| 要素 | 説明 |
|---|---|
| Check=off, Disable=off | 通常セル |
| Check=on, Disable=off | 選択済みセル |
| Check=on, Disable=on | 選択済み＋無効（注意ラベル付き） |

---

## 7. Template/List（時間割テンプレート）

`Type=適用中` / `Type=未適用` の2パターン。

| type | 状態インジケータ | 削除ボタン色 |
|---|---|---|
| 適用中 | 水色ドット (#0997B3) + 「適用中」テキスト | DFE6EB（グレー＝削除不可） |
| 未適用 | グレードット (#D7D7D7) + 「未適用」テキスト | #008299（ティール＝削除可） |

---

## 8. コンポーネントプロパティ（表示切替可能な要素）

Header で表示/非表示を切り替え可能:
- **Search**: 検索アイコン
- **Switch**: トグルスイッチ

Cell で表示/非表示を切り替え可能:
- **Check**: チェックボックス
- **Icon**: アバター/アイコン
- **AttentionText**: 警告テキスト
- **Indent**: インデント

---

## 9. Do / Don't

| Do | Don't |
|---|---|
| 主要コンテンツには Large を使う | 全箇所 Small で統一する |
| Header にソートアイコンを付ける | ソートできるのに視覚的手がかりがない |
| Disabled 行はテキスト色で無効を示す | Disabled 行を見た目で区別できない |
| AAR List は改変せず使う | AAR List の色・サイズを独自に変更する |

---

## 10. アクセシビリティ

- リスト全体に `role="list"` または テーブルの場合 `role="grid"` を付与。
- Header のソートボタンに `aria-sort="ascending|descending|none"` を付与。
- Checkbox には `aria-checked` を付与。
- Disabled 行には `aria-disabled="true"` を付与。
- キーボード操作: `ArrowUp` / `ArrowDown` でフォーカス移動。
- 検索フィールドには `aria-label="カラム名で検索"` を付与。

---

## 11. 実装の入り口

```tsx
import { List, ListHeader, ListCell } from '@manabi-ds/List';

<List size="large">
  <ListHeader
    columns={[
      { key: 'name', label: '名前', sortable: true },
      { key: 'class', label: 'クラス', sortable: true },
    ]}
    checkable
    onCheckAll={handleCheckAll}
  />
  <ListCell
    checkable
    checked={false}
    data={{ name: 'あらい はなこ', class: '3年1組' }}
  />
  <ListCell
    checkable
    checked
    data={{ name: 'たなか たろう', class: '3年2組' }}
  />
  <ListCell
    disabled
    attentionText="転出済み"
    data={{ name: 'やまだ じろう', class: '3年1組' }}
  />
</List>
```
