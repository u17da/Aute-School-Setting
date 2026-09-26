# ProgressBar — まなびポケット Design System

待機時間や操作の継続時間、進捗率を視覚的に表示するコンポーネント。

---

## 意思決定フロー

| やりたいこと | 使うもの | 備考 |
|---|---|---|
| 処理の進捗率を表示（0〜100%） | **ProgressBar** | 値が明確な determinate 表示 |
| 処理中であることだけ伝える | **ProgressBar** `indeterminate` | 完了時刻が不明な場合 |
| ファイルアップロード等のインライン進捗 | **ProgressBar** size `sm` | 省スペース |
| 円形の進捗表示 | CircularProgress（別コンポーネント） | ProgressBar では対応しない |
| ステップ式の進捗 | Stepper（別コンポーネント） | 離散的な段階表示 |

---

## Variants

| variant | 説明 | 用途 |
|---|---|---|
| `determinate` | 0〜100% の値を表示（デフォルト） | ファイルアップロード、学習進捗、設定完了率 |
| `indeterminate` | 左右にアニメーションするループ | 読み込み中・処理待ち |

---

## Sizes

| size | トラック高さ | テキストサイズ | テキスト幅 | 全体の想定最小幅 |
|---|---|---|---|---|
| `md` | 8px | 18px/600 | 56px | 制約なし（親幅に追従） |
| `sm` | 4px | 14px/600 | 40px | 制約なし |

---

## Colors / Tokens

```
--mp-progressbar-track-bg:      #EFEFEF
--mp-progressbar-fill:          #008299
--mp-progressbar-text:          #008299

--mp-progressbar-track-radius:  100px
--mp-progressbar-fill-radius:   100px
```

Figma 上では fill 色は `#008299`（Primary）のみ。カラーバリエーションが必要になった場合は `color` prop で拡張可能な設計にしておく。

---

## States

| state | 挙動 |
|---|---|
| **determinate** | `value` に応じて fill 幅が 0〜100% に変化 |
| **indeterminate** | fill が左右にスライドするアニメーション（CSS keyframes） |
| **complete** | value=100 時、fill がトラック全幅を占める |

ProgressBar 自体に hover / active / disabled 等のインタラクティブ状態はない（表示専用）。

---

## Anatomy（構造）

```
┌─ .mp-progressbar ──────────────────────────────┐
│ ┌─ track ───────────────────────┐  ┌─ text ─┐ │
│ │ ┌─ fill ──────┐               │  │  30%   │ │
│ │ └─────────────┘               │  └────────┘ │
│ └───────────────────────────────┘              │
└────────────────────────────────────────────────┘
```

- **track**: 背景レール。角丸 100px。
- **fill**: 進捗を示すバー。左端からスタートし `width: {value}%` で伸びる。
- **text**: パーセンテージ数値。右寄せ。`showLabel={false}` で非表示可。

---

## Do / Don't

### Do
- `aria-valuenow` / `aria-valuemin` / `aria-valuemax` を必ず設定する
- 親コンテナの幅に追従させる（`width: 100%`）
- 値の変化時にスムーズな transition をかける
- 100% 到達時に完了メッセージや次のアクションを提示する

### Don't
- 値が不明なのに determinate を使わない → `indeterminate` を使う
- テキストラベルを省略して進捗率が全く読み取れない状態にしない
- fill 色を独自に変更して Primary カラーとの一貫性を崩さない
- 極端に狭い幅（100px 未満）で使わない — テキストが潰れる

---

## アクセシビリティ

- `role="progressbar"` を付与
- `aria-valuenow={value}` / `aria-valuemin={0}` / `aria-valuemax={100}`
- indeterminate 時は `aria-valuenow` を省略し `aria-busy="true"` を付与
- `aria-label` でコンテキストを伝達（例: `"学習進捗"` `"アップロード進捗"`）
- テキストラベルは `aria-hidden="true"`（`aria-valuenow` と二重読み上げを防ぐ）
- 色だけに頼らず数値テキストで進捗を伝える（色覚多様性対応）

---

## 実装スニペット

```tsx
import { ProgressBar } from '@manabi-ds/progressbar';

{/* 基本 */}
<ProgressBar value={30} aria-label="学習進捗" />

{/* ラベル非表示 */}
<ProgressBar value={75} showLabel={false} aria-label="アップロード" />

{/* 小サイズ */}
<ProgressBar value={50} size="sm" aria-label="読み込み" />

{/* 不定 */}
<ProgressBar variant="indeterminate" aria-label="処理中" />

{/* 完了 */}
<ProgressBar value={100} aria-label="完了" />
```
