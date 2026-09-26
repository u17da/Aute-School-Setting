# TextField

まなびポケット Design System のテキスト入力コンポーネント。
1行入力(Input)・複数行入力(TextArea)・検索(SearchBar)を `variant` で切り替える統合コンポーネント。

---

## いつどれを使うか(意思決定フロー)

| ユーザーの意図 | `variant` | 補足 |
|---|---|---|
| 氏名・メールアドレスなど **1行のテキスト** を入力させたい | `input` | デフォルト。フォーム項目の標準形 |
| 自由記述・問い合わせなど **複数行のテキスト** を入力させたい | `textarea` | 3〜10行を目安に `rows` を指定 |
| 一覧画面で **キーワード検索** をさせたい | `search` | 左に虫眼鏡アイコンが入る |

> **判断に迷ったら:** 入力内容が「単語〜短文」なら `input`、「文章」なら `textarea`、「絞り込み目的」なら `search`。

### `variant="textarea"` の行数目安

| ユースケース | 推奨 `rows` |
|---|---|
| チャット入力・短いコメント | 3〜5 |
| 問い合わせフォーム・要望欄 | 5〜7 |
| 自由記述・詳細説明 | 7〜10 |
| ブログ・論述などがっつり書く欄 | 10〜15(または高さ固定で `auto-resize`) |

---

## Sizes

`Button` と異なり、TextField は **3サイズ(L / M / S)** を提供。

| size | 高さ | font-size | 主な用途 |
|---|---|---|---|
| `L` | 48px | 16px | フォーム単体ページ・モーダル内のメインフィールド |
| `M` | 40px | 16px | **デフォルト**。一覧画面のフィルタやインライン編集 |
| `S` | 33px | 14px | スペース制約のあるツールバー・テーブル内編集 |

> **原則:** Mを使う。項目を目立たせたい場合だけL、スペースに収まらない場合だけS。
> **高さは絶対に変えない。** 複数行が必要なら必ず `variant="textarea"` を使うこと。
> **幅は可変OK。** 入力する文字数やコンテンツ幅に応じて `width` を調整する。

---

## States

| state | 見た目 | 発生条件 |
|---|---|---|
| `default` | 1px solid #E9EBEC / 背景 #FFFFFF | 通常 |
| `hover` | 背景が #F5F7F8 に変化 | マウスオーバー |
| `focus` | 2px solid #008299 / 背景 #FFFFFF | フォーカス中 |
| `completed` | default と同じ枠線 / 文字色 #283148 | 値が入っていてフォーカス外 |
| `error` | 2px solid #C53F3F / `errorText` を下に表示 | バリデーションNG |
| `disabled` | 背景 #DFE6EB / 文字色 #61646C(値あり) または #909398(プレースホルダ) | `disabled` propが true |

---

## Anatomy(構造)

```
┌─────────────────────────────────────┐
│ HelperText (ラベル/補足) ※任意       │ ← 上部
├─────────────────────────────────────┤
│ [icon] ラベル/値        [icon]      │ ← Input本体
├─────────────────────────────────────┤
│ HelperText / ErrorText ※任意        │ ← 下部
└─────────────────────────────────────┘
```

- **上部 HelperText**: 入力欄の名前(フィールド名)を表示するときに使う。任意。
- **下部 HelperText**: 通常時の補足説明。任意。
- **下部 ErrorText**: `state="error"` のとき自動で赤字に切り替わる。

---

## Do / Don't

### ✅ Do

- 1画面内のフォームでは **size を統一** する(基本M)。
- ラベルは `helperText` props で表示し、`<label>` と紐付ける(自動で `htmlFor` が設定される)。
- エラー時は `errorText` を必ず指定する(空文字だとUIが崩れる)。
- 検索欄は `variant="search"` を使い、自前で虫眼鏡アイコンを足さない。
- 複数行入力が必要になったら、widthを広げるのではなく **`variant="textarea"` に切り替える**。

### ❌ Don't

- ❌ `variant="input"` の `height` を CSS で上書きして複数行化する → `textarea` を使う。
- ❌ `disabled` 状態で `errorText` を出す → ユーザーが操作できないのにエラーは混乱を招く。
- ❌ `size="S"` をフォーム本体で使う → S は補助的な用途専用。
- ❌ アイコン枠(`startIcon` / `endIcon`)に画像やテキストを詰め込む → アイコン1つだけに留める。
- ❌ `placeholder` をラベル代わりに使う → 入力中に消えてしまう。必ず `helperText` を併用する。

---

## Accessibility 要件

- `<input>` / `<textarea>` 要素を直接ラップしているため、ネイティブのキーボード操作が利く。
- `helperText` を指定すると自動で一意な `id` が振られ、`aria-describedby` で関連付く。
- `errorText` があるときは `aria-invalid="true"` と `aria-errormessage` が自動付与される。
- `disabled` のときは `aria-disabled="true"` を付与(ネイティブ `disabled` と併用)。
- フォーカスリングは `:focus-visible` で 2px の Primary 色枠を表示。マウスクリックでは出ない。
- アイコンには `aria-hidden="true"` を付与し、スクリーンリーダーに読まれないようにする。

---

## 実装の入り口(コードスニペット)

```tsx
import { TextField } from '@/components/manabi-ds/TextField'

// 1行入力(デフォルト)
<TextField
  label="氏名"
  placeholder="例: 山田太郎"
  helperText="姓と名の間にスペースを入れてください"
  size="M"
/>

// 複数行入力
<TextField
  variant="textarea"
  label="お問い合わせ内容"
  rows={5}
  size="L"
/>

// 検索
<TextField
  variant="search"
  placeholder="キーワードで絞り込む"
  size="M"
/>

// エラー状態
<TextField
  label="メールアドレス"
  value={email}
  onChange={e => setEmail(e.target.value)}
  errorText={emailError}  // 空文字以外で error 状態に自動遷移
/>

// アイコン付き(右側のみ・絵文字や顔アイコンなど)
<TextField
  label="気分"
  endIcon={<EmojiIcon />}
/>
```

---

## デザイントークン参照

| トークン | 値 | 用途 |
|---|---|---|
| `--mp-textfield-color-text` | #283148 | 入力済みテキスト |
| `--mp-textfield-color-placeholder` | #909398 | プレースホルダ |
| `--mp-textfield-color-helper` | #61646C | ヘルパーテキスト |
| `--mp-textfield-color-border` | #E9EBEC | 通常時の枠線 |
| `--mp-textfield-color-border-focus` | #008299 | フォーカス時 |
| `--mp-textfield-color-border-error` | #C53F3F | エラー時 |
| `--mp-textfield-color-bg` | #FFFFFF | 通常背景 |
| `--mp-textfield-color-bg-hover` | #F5F7F8 | ホバー背景 |
| `--mp-textfield-color-bg-disabled` | #DFE6EB | 無効化背景 |
| `--mp-textfield-radius` | 8px | 角丸 |
| `--mp-textfield-font` | 'Hiragino Kaku Gothic Pro' | フォント |

> Button と共通のトークン(`--mp-color-primary` 等)を参照しているため、テーマ変更時は両方が同期して切り替わる。
