# Tooltip — まなびポケット Design System

> エージェントへ：補足テキストを一時表示する場合、まず本ファイルを読み、`Tooltip.tsx`をimportして使うこと。

---

## 1. いつどれを使うか（意思決定フロー）

| ユーザーに伝えたいこと | 使う？ | 代替案 |
|---|---|---|
| UIスペースが限られている場合の**補足テキスト** | Tooltip を使う | — |
| 操作に必要な情報（入力要件・エラーメッセージ等） | **使わない** | 常に表示するインラインテキストに |
| アイコンのアクション説明 | Tooltip を使う | — |
| 省略されたテキストの全文 | Tooltip を使う | — |
| グラフのデータ詳細 | Tooltip を使う | — |
| フォーム入力に必要な情報（パスワード要件等） | **使わない** | ヘルパーテキストに |

### 厳守ルール

- **Tooltip 内の情報は隠れるため、操作に必要な情報の表示には使用しない。**
- ユーザーが把握しないと操作が進められない重要情報は、常に表示すること。
- 重要情報の具体例: パスワード入力要件、入力エラーメッセージ、操作補助情報（ショートカットなど）。
- Tooltip が表示されることを示唆するために、マウスオーバー可能な要素であることを想起させるテキスト・アイコン・色を組み合わせる。

---

## 2. Direction × Position マトリクス

| direction | position | 矢印の位置 |
|---|---|---|
| `up` | `center` / `left` / `right` | 矢印が下向き、ターゲットの上に表示 |
| `down` | `center` / `left` / `right` | 矢印が上向き、ターゲットの下に表示 |
| `left` | `center` | 矢印が右向き、ターゲットの左に表示 |
| `right` | `center` | 矢印が左向き、ターゲットの右に表示 |
| `none` | `none` | 矢印なし |

---

## 3. Anatomy（構造）

```
Direction=Up, Position=Center:
         ┌──────────┐
         │ テキスト  │  ← bg rgba(97,97,97,0.9), radius 4px
         └────▲─────┘
              │ ← Arrow 12×6px

Direction=Down:
              │ ← Arrow
         ┌────▼─────┐
         │ テキスト  │
         └──────────┘
```

- 背景: `rgba(97, 97, 97, 0.9)`
- border-radius: `4px`
- padding: `4px 8px`
- font: Hiragino Kaku Gothic Pro, 10px, weight 300, line-height 1.5
- text color: `#FFFFFF`
- Arrow: 12px × 6px、同背景色

---

## 4. 主な使用パターン

| パターン | 説明 | トリガー |
|---|---|---|
| テキスト + アイコン | 文章の補足。テキスト横に「?」アイコンを配置 | hover on ? icon |
| アイコン | アイコンのアクション説明 | hover on icon |
| 省略テキスト | 三点リーダ「…」で省略されたテキスト全文 | hover on truncated text |
| グラフの補足説明 | グラフデータの詳細・内訳。該当箇所をハイライト | hover on chart element |

---

## 5. Do / Don't

| Do | Don't |
|---|---|
| スペースが限られた場面で補足テキストを一時表示 | 操作に必要な情報をTooltipに隠す |
| hover可能であることを「?」アイコンや色で示唆 | 何も手がかりなくhoverしないと見えない情報にする |
| 短く簡潔なテキスト（1〜2行） | 長文や複雑な説明をTooltipに入れる |
| グラフでは該当箇所をハイライトする | Tooltipとグラフの対応関係が不明瞭なまま表示 |

---

## 6. アクセシビリティ

- Tooltip コンテンツに `role="tooltip"` を付与。
- トリガー要素に `aria-describedby={tooltipId}` を付与。
- `Escape` キーで閉じられるようにする。
- Tooltip 内のテキストはスクリーンリーダーからアクセス可能であること。
- ホバーだけでなく、`focus` でもTooltipが表示されること（キーボードユーザー対応）。
- Tooltip表示中にカーソルがTooltip上に移動しても消えないこと。

---

## 7. 実装の入り口

```tsx
import { Tooltip } from '@manabi-ds/Tooltip';

{/* テキスト補足 */}
<Tooltip content="ここに補足テキストが入ります" direction="up" position="center">
  <HelpIcon />
</Tooltip>

{/* アイコンの説明 */}
<Tooltip content="設定" direction="down">
  <SettingsIcon />
</Tooltip>

{/* 省略テキスト */}
<Tooltip content="非常に長いテキストの全文がここに表示されます">
  <span className="truncate">非常に長いテキスト…</span>
</Tooltip>

{/* 矢印なし */}
<Tooltip content="ヒント" direction="none">
  <InfoIcon />
</Tooltip>
```
