# Accordion — まなびポケット Design System

> エージェントへ：折りたたみUIを実装する時、まず本ファイルを読み、`Accordion.tsx`をimportして使うこと。

---

## 1. いつどれを使うか（意思決定フロー）

| ユーザーの意図 | direction | 例 |
|---|---|---|
| 見出し下のコンテンツを展開/折りたたみ | `down` | FAQ・設定セクション |
| サイドパネルを開閉したい | `right` / `left` | サイドメニュー・フィルタパネル |
| 上方向にコンテンツを展開したい | `up` | フッター付近のパネル |

### 厳守ルール

- **多用を禁止する。** スペースを省略できるが、多用するとユーザーの使いづらさに繋がる。情報の粒度・構造が適切かを精査すること。
- **デフォルトの開閉状態は慎重に決める。** 重要性の高い情報を隠さないように注意。
  - デフォルトで閉じるケース: 一部ユーザーしか使わない高度な設定、見出しを並べて全体構造を把握させたい場合。
  - デフォルトで開くケース: ユーザーの操作・閲覧が必ず必要な重要情報。
- **複数パネルを同時に開くことが可能な設定にする。** 1つ開くと他が閉じる挙動はユーザーの予測に反するため非推奨。

---

## 2. Direction（展開方向）

| direction | トリガーアイコン | 展開方向 |
|---|---|---|
| `down` | `expand_more` (▼) | 下方向にコンテンツが出る |
| `right` | `chevron_right` (▶) | 右方向にパネルが出る |
| `up` | `expand_more` 反転 (▲) | 上方向にコンテンツが出る |
| `left` | `chevron_left` (◀) | 左方向にパネルが出る |

---

## 3. States

| state | 背景 | ボーダー |
|---|---|---|
| `default` | `#FFFFFF` | 1px solid `#E9EBEC` |
| `hover` | `#F5F7F8` | 1px solid `#E9EBEC` |

---

## 4. Anatomy（構造）

```
Trigger (button):
┌───────────────────────────────────────┐
│  [icon ▼/▶/▲/◀]                       │  ← 40px × 46px, radius 6px
└───────────────────────────────────────┘

Panel (content):
┌───────────────────────────────────────┐
│  (children — 任意のコンテンツ)         │  ← サイズは変更可能
└───────────────────────────────────────┘
```

- トリガーボタン: 40px × 46px、border-radius 6px、padding 16px
- アイコン: 24px × 24px、color `#283148`
- フレームサイズは変更可能。横方向のサイドメニューにも使用可能。

---

## 5. Do / Don't

| Do | Don't |
|---|---|
| 補足的な情報を折りたたんで画面をシンプルに保つ | すべての情報をアコーディオンに隠す |
| 複数パネルを同時に開ける設定にする | 1つ開くと他が自動で閉じる設定にする |
| 重要な情報はデフォルトで開いておく | ユーザーが必ず見るべき情報を閉じた状態にする |
| 画面内の情報量が適切か精査してから使う | 情報整理を怠ってアコーディオンで隠す |

---

## 6. アクセシビリティ

- トリガーは `<button>` で実装し、`aria-expanded="true|false"` を付与。
- パネルに `role="region"` + `aria-labelledby={triggerId}` を付与。
- `Enter` / `Space` キーで開閉トグル。
- パネルが閉じている場合、パネル内の要素はフォーカストラップに含めない。

---

## 7. 実装の入り口

```tsx
import { Accordion, AccordionItem } from '@manabi-ds/Accordion';

<Accordion>
  <AccordionItem title="基本設定" defaultOpen>
    <p>基本設定の内容...</p>
  </AccordionItem>
  <AccordionItem title="高度な設定">
    <p>高度な設定の内容...</p>
  </AccordionItem>
</Accordion>

{/* サイドパネル用途 */}
<Accordion direction="right">
  <AccordionItem title="フィルタ">
    <FilterPanel />
  </AccordionItem>
</Accordion>
```
