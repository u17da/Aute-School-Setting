# CP（コンテンツプロバイダ）

まなびポケット Design System — コンテンツ識別コンポーネント

## いつどれを使うか

| シナリオ | variant | 理由 |
|---|---|---|
| コンテンツ提供元のアイコンのみ表示 | `icon` (Size=S/M) | 一覧、コンパクト表示 |
| アイコン＋名称＋説明をカード表示 | `card` (Size=L) | 設定画面、選択UI |
| ドロップダウン内の選択肢 | `suggest` | CP 選択フォーム |
| 選択済みの CP 表示 | `suggest` (selected) | 選択確認 |

## Sizes

| size | 用途 | アイコン寸法 | border-radius |
|---|---|---|---|
| `s` | インラインアイコン | 28×28px (内 padding 2.3px) | 4.7px |
| `m` | 一覧表示、削除可能 | 48×48px (内 padding 4px) | 8px |
| `l` | カード形式（名称＋説明付き） | 28×28px（カード内） | 8px |

## Variants

### Icon (S)
```
┌─────┐
│ [📷] │  28×28, 白背景, 1px border #CCCCCC, radius 4.7px
└─────┘
```

### Icon (M) — 削除ボタン付き
```
┌──────┐
│ [📷]  │  48×48, 白背景, 1px border #CCCCCC, radius 8px
│    ✕  │  ← 右上に16px close badge (#61646C 背景, 白×)
└──────┘
```

### Card (L) — 名称＋説明付き、削除ボタン付き
```
┌──────────────────────────────┐
│ [📷] CP名称                  │  44px高, 白背景, 1px border #E9EBEC
│      説明テキスト         ✕  │  radius 8px, padding 8px
└──────────────────────────────┘
```

### Suggest — ドロップダウン選択肢

#### Default（未選択）
```
┌──────────────────────────────────┐
│ [📷] ラベル（小）                │  44px高, 白背景
│      説明テキスト                │  1px border #CCCCCC, radius 8px
│      ステータス（グレー小文字）  │  padding 8px 12px
└──────────────────────────────────┘
```

#### Selected（選択済み）
```
┌──────────────────────────────────┐
│ [📷] ラベル（小）                │  44px高, #F2FAFC 背景
│      説明テキスト                │  2px border #008299, radius 8px
│      ✓ 選択中（teal 小文字）     │
└──────────────────────────────────┘
```

## スタイル詳細

| 要素 | 値 |
|---|---|
| アイコン画像 | `mix-blend-mode: multiply`（白背景を透過） |
| アイコン背景 | `#FFFFFF` |
| アイコン border | `1px solid #CCCCCC`（S/M）/ `#E9EBEC`（L） |
| Close badge (M/L) | 16×16px、`#61646C` 背景、白 × アイコン、`border-radius: 8px` |
| Close badge 位置 | 右上 `-8px` オフセット |
| ラベル小文字 | 8px / weight 600 / `#283148` |
| 説明テキスト | 12px / weight 300 / `#283148` |
| ステータス（default） | 8px / weight 600 / `#61646C` |
| ステータス（selected） | 8px / weight 600 / `#00838F` |
| Selected 背景 | `#F2FAFC` |
| Selected border | `2px solid #008299` |
| Selected check icon | 12×12px `#00838F` |

## Do / Don't

| ✅ Do | ❌ Don't |
|---|---|
| CP アイコンには `mix-blend-mode: multiply` を適用する | 白背景のロゴをそのまま使う（白四角に見える） |
| Size=M/L の削除可能な場面では close badge を出す | クリック全体を削除にする |
| Suggest の selected 状態を明確に色分けする | 選択済みかどうかわからない見た目にする |
| ラベルと説明は簡潔にする | 長い説明文を Suggest 内に入れる |

## アクセシビリティ

- アイコン `<img>` に `alt="{CP名称}"` を設定
- Close badge に `aria-label="{CP名称}を削除"` を設定
- Suggest 選択肢: `role="option"` + `aria-selected`
- Suggest リスト全体: `role="listbox"`
- キーボード: Tab / Arrow で選択肢移動、Enter / Space で選択

## 実装スニペット

```tsx
import { CpIcon, CpCard, CpSuggest } from '@manabi-ds/cp';

// 1. インラインアイコン（小）
<CpIcon src="/logos/schooltakt.png" name="スクールタクト" size="s" />

// 2. 削除可能なアイコン（中）
<CpIcon src="/logos/schooltakt.png" name="スクールタクト" size="m" onRemove={handleRemove} />

// 3. カード表示（大）
<CpCard
  src="/logos/schooltakt.png"
  name="スクールタクト"
  label="株式会社コードタクト"
  description="協働学習支援ツール"
  onRemove={handleRemove}
/>

// 4. ドロップダウン選択肢
<CpSuggest
  src="/logos/schooltakt.png"
  label="株式会社コードタクト"
  description="スクールタクト"
  status="選択中"
  selected={true}
  onClick={handleSelect}
/>
```
