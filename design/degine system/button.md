# Button — まなびポケット Design System

> エージェントへ：UIにボタンを実装する時、まず本ファイルを読み、`Button.tsx`をimportして使うこと。`button.css`の変数・クラスは外部から触らない。新規スタイルを足したくなったら、まずこのファイルに該当variantが無いか確認する。

---

## 1. いつどれを使うか（意思決定フロー）

ユーザーの操作意図 → 選ぶべき variant:

| 操作の意図 | variant | color | 例 |
|---|---|---|---|
| 主要アクション（フローを進める） | `solid` | `primary` | 保存する / 送信する / 次へ |
| 補助アクション（並列の選択肢） | `outline` | `primary` | プレビュー / 一時保存 |
| 戻る・閉じる・キャンセル | `solid` | `negative` | 戻る / キャンセル |
| 削除・破棄・取消（リスク操作） | `solid` | `alert` | 削除する / 破棄する |
| 弱いインライン的アクション | `text` | `primary` | 全画面表示 / 詳細を見る |
| 画像/動画オーバーレイ上のボタン | `solid` | `tertiary` | 画像上の閉じる |

### 厳守ルール

- **Solid × Primary は 1画面に 1つまで**。最重要なアクションを際立たせる。
- 複数ボタンが並列する場合、**Primaryは右側に配置**する（左：戻る、右：保存する）。
- 種類の基本構成は `Solid (Primary)` と `Outline (Secondary扱い)` の2系統。`Negative` `Alert` は限定使用。
- 色のバリエーションは「プライマリーカラー（通常操作）」と「アラートカラー（危険操作）」の2系統で考える。

---

## 2. Variants 一覧

### 2.1 style（見た目のタイプ）

- `solid` — 塗りつぶし。最も視覚的に強い。
- `outline` — 枠線のみ。Solidの次点。
- `text` — 枠も背景もなし。リンクに近い軽い強調。
- `icon` — アイコン単体（ラベルなし）。後述する `IconButton` を別途用意。

### 2.2 size（4段階）

| size | 高さ | padding | font | radius | 用途 |
|---|---|---|---|---|---|
| `l` | 48px | 12px 16px | 16px / 600 | 8px | 主CTA・強調 |
| `m` | 40px | 8px 16px | 16px / 600 | 8px | **デフォルト**（迷ったらこれ） |
| `s` | 32px | 4px 12px | 14px / 600 | 8px | 一覧内・密度高いUI |
| `ss` | 26px | 4px 12px | 12px / 600 | **6px** | テーブルセル等狭所 |

注：`ss` のみ radius が 6px。

### 2.3 color

| color | 用途 | Default | Hover | Active | Disable |
|---|---|---|---|---|---|
| `primary` | 通常操作 | `#008299` | `#00606D` | `#00606D` | `#DFE6EB` |
| `negative` | 戻る・キャンセル | `#878F96` | `#717C86` | `#717C86` | `#DFE6EB` |
| `alert` | 削除・破棄 | `#C53F3F` | `#A7322F` | `#A7322F` | `#DFE6EB` |
| `tertiary` | 画像上の操作 | `rgba(0,0,0,0.5)` | (透過変化) | (透過変化) | `#D7D7D7` |

Outline スタイルの hover 時は薄い背景色が入る：
- primary hover: `#E1F7FD` + border `#00606D`
- negative hover: `#EFEFEF` + border `#717C86`
- alert hover: `#FCECEF` + border `#A7322F`

### 2.4 state

`default` / `hover` / `active` / `disable` / `loading`

- `disable` 時のラベル文字色は white（solid）または `#D7D7D7`（outline / text）。
- `disable` のホバー時は `cursor: not-allowed`（🚫 のようなカーソル）を出す。

---

## 3. ラベル（文言）の書き方

- **語尾に動詞をつける**：「保存する」「送信する」「削除する」（×「保存」「送信」）。
- ネガティブボタンの文言は文脈で使い分ける：
  - `閉じる` … 新規追加モーダル等、入力途中で離脱する場面
  - `戻る` … 編集中の画面から前の画面に戻る場面
  - `キャンセル` … モーダル内で操作を取りやめる場面
- 1ラベルは原則 6文字以内（最大10文字）。長くなる場合は文言を見直す。

---

## 4. レイアウト規則

- ボタンの**高さは固定**。サイズを変えたい時は size プロパティで切り替える。
- ボタンの**幅は可変**。文字長やコンテンツ幅に応じて伸ばしてよい。最小幅は size ごとに守る（M/L: 80px、S: 64px、SS: 64px、L フル幅時: 160px）。
- 並列配置時は `gap: 16px` を基本とする。
- アイコンとラベルの間は `gap: 4px`。アイコンは原則ラベルの**前**に置く。

---

## 5. アイコン

- アイコンは Material Symbols 互換のものを使う前提。`<Button>` の `iconLeft` / `iconRight` props で指定。
- `size: l, m` のアイコンは 24×24、`size: s, ss` のアイコンは 20×20。
- アイコン単体ボタン（`IconButton`）は別コンポーネントとして用意（本ファイルのスコープ外）。

---

## 6. Do / Don't

### ❌ Don't

```
[保存する(Primary)] [プレビュー(Primary)] [削除する(Primary)]
```
→ Primary が複数あり、最重要が不明瞭。

```
[キャンセル(Primary)] [削除する(Primary)]  ← モーダルのフッター
```
→ 危険操作と離脱操作が同じ重みで並んでいる。

### ✅ Do

```
[戻る(Negative)] [プレビュー(Outline)] [保存する(Primary)]
```
→ 重要度が一目でわかり、Primary は右端。

```
[キャンセル(Negative)]                    [削除する(Alert)]
```
→ 危険操作だけが Alert 色になっている。

---

## 7. アクセシビリティ

- 全ボタンに `type` を明示（`button` / `submit` / `reset`）。
- アイコン単体ボタンには `aria-label` 必須。
- `disable` 状態は `aria-disabled="true"` ＋ `disabled` 属性両方を付与。
- フォーカスリングは OS 標準（`outline`）を消さない。デザイン上必要なら `:focus-visible` で `outline: 2px solid #008299; outline-offset: 2px` を当てる。

---

## 8. 実装の入り口

```tsx
import { Button } from '@/components/manabi-ds/Button';

// 主要アクション
<Button variant="solid" color="primary" size="m" onClick={handleSave}>
  保存する
</Button>

// 並列レイアウト（左にネガティブ、右にプライマリ）
<div style={{ display: 'flex', gap: 16, justifyContent: 'flex-end' }}>
  <Button variant="solid" color="negative" size="m" onClick={handleCancel}>
    キャンセル
  </Button>
  <Button variant="solid" color="primary" size="m" onClick={handleSubmit}>
    送信する
  </Button>
</div>

// 危険操作
<Button variant="solid" color="alert" size="m" onClick={handleDelete}>
  削除する
</Button>

// テキストボタン
<Button variant="text" color="primary" size="m" iconRight="keyboard_arrow_right">
  全画面表示
</Button>
```

`color` 省略時は `primary`、`size` 省略時は `m`、`variant` 省略時は `solid`。

---

## 9. 改修・拡張する時のルール

- 新しい color/size/variant を増やす時は、**まず本ファイルに節を追加**してから実装する。
- Figma の更新があった場合、`button.css` の CSS 変数値を更新するのが基本（クラス名・props は変えない）。
- 既存 variant の数値（高さ・padding・色）を変える時は、影響範囲を全画面でチェック。
