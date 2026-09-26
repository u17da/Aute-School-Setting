# Modal（モーダルダイアログ）

まなびポケット Design System — フィードバックコンポーネント

## いつどれを使うか

| シナリオ | コンポーネント | 理由 |
|---|---|---|
| ユーザー操作の成否を即座に伝える | Message | 一時的・自動消失 |
| サイト全体の重要告知 | MessageBar | 画面最上部、高優先度 |
| **入力・選択・確認を求める** | **Modal** | 操作を中断、集中させる |
| **情報を詳細に提示する** | **Modal** | コンテンツスロット活用 |

## Style variants

| style | 用途 | ヘッダー構成 |
|---|---|---|
| `default` | 汎用。コンテンツスロットあり | タイトル + (×) |
| `info` | 情報提示。info アイコン付き | info アイコン + タイトル |
| `success` | 完了通知。check_circle 付き | check アイコン + タイトル |
| `error` | エラー通知。cancel アイコン付き | cancel アイコン + タイトル |
| `warning` | 警告。warning アイコン付き | warning アイコン + タイトル |
| `dialog` | 確認ダイアログ。シンプル | タイトル + × ボタン |
| `share` | 共有設定。ラジオボタン等 | タイトルのみ |

## Sizes（width）

| size | 幅 | 用途 |
|---|---|---|
| `sm` | 444px | 確認ダイアログ、短いメッセージ |
| `md` | 600px | フォーム、中量コンテンツ |
| `lg` | 800px | 詳細表示、大量コンテンツ |

- 高さはコンテンツに応じて可変。最小 200px
- 最大幅は画面幅の 90%
- 縦方向の最大は画面高さの 80%（超過時はモーダル内スクロール）

## 構造

```
┌─────────────────────────────────────────┐
│ Header: タイトル            [×(任意)]   │
├─────────────────────────────────────────┤
│ Body: メッセージ or コンテンツスロット   │
├─────────────────────────────────────────┤
│ Footer: [テキストリンク] [戻る] [実行]  │
└─────────────────────────────────────────┘
```

### Header
- タイトル: 16px / weight 600 / `#283148`
- info/success/error/warning: 左にアイコン（24×24）
- × ボタン: 24×24、`#61646C`。dialog style 時は表示

### Body
- メッセージ: 14px / weight 300 / line-height 1.5 / `#283148`
- コンテンツスロット: 自由配置可能領域（default/md/lg で活用）
- 背景: `#EDF0F2` のスロット枠あり（default size md/lg）

### Footer
- ボタンは右寄せ
- Primary ボタン: `#008299` / 8px radius
- Negative ボタン: `#878F96` / 8px radius
- dialog: 「いいえ」「はい」の 80px 幅ボタン
- 左端にテキストリンク（任意）

## Overlay

- 背景色: `rgba(0, 0, 0, 0.5)` = `BG/Modal` トークン
- クリックでモーダルを閉じる（dialog 以外）

## 共通スタイル

- 背景: `#FFFFFF`
- `box-shadow: 0px 2px 12px rgba(0,0,0,0.1)`
- `border-radius: 8px`
- padding: `24px`（全サイズ共通）
- gap: style が default なら `24px`、それ以外は `16px`

## 注意事項（Figma 仕様書記載）

1. **同じ役割のボタンを共存させない** — × ボタンと「キャンセル」ボタンは同時に表示しない
2. **常に元の画面に戻る導線を用意する** — ボタン設置不可 or 縦スクロール発生時は × ボタンを必ず表示
3. **拡大する場合のルール**:
   - padding 24px を維持
   - 横幅 800px・縦幅 600px を最大値とする
   - 縦スクロール発生時は × ボタン必須

## States

- **closed** — 非表示
- **opening** — フェードイン（overlay + scale）
- **open** — 表示中、フォーカストラップ有効
- **closing** — フェードアウト

## Do / Don't

| ✅ Do | ❌ Don't |
|---|---|
| 確認や入力など、ユーザーの注意が必要な場面で使う | 単なるお知らせに使う（→ Message） |
| タイトルは体言止めにする | 「〜しますか？」等の疑問文をタイトルにする |
| × ボタンと「キャンセル」を共存させない | 同じ役割のボタンを 2 つ置く |
| 縦スクロール時は × ボタンを必ず出す | スクロール下部にしか閉じる手段がない |
| コンテンツスロットは MD→LG で検討する | いきなり 800px を使う |

## アクセシビリティ

- `role="dialog"` + `aria-modal="true"`
- `aria-labelledby` でタイトル要素を参照
- `aria-describedby` でメッセージ本文を参照（任意）
- 開いた時にモーダル内の最初のフォーカス可能要素にフォーカス
- Tab キーでモーダル内にフォーカストラップ
- Escape キーで閉じる
- overlay クリックで閉じる（dialog 除く）
- 閉じた後、トリガー要素にフォーカスを返す

## 実装スニペット

```tsx
import { Modal } from '@manabi-ds/modal';

// 1. 基本確認ダイアログ
<Modal
  style="dialog"
  size="sm"
  title="削除の確認"
  open={isOpen}
  onClose={handleClose}
  footer={
    <>
      <Button color="negative" onClick={handleClose}>いいえ</Button>
      <Button color="primary" onClick={handleDelete}>はい</Button>
    </>
  }
>
  この操作は取り消せません。本当に削除しますか？
</Modal>

// 2. コンテンツスロット付き
<Modal style="default" size="md" title="生徒アプリ利用回数" open={isOpen}>
  <BarChart data={usageData} />
</Modal>

// 3. 警告モーダル
<Modal style="warning" size="sm" title="注意" open={isOpen}>
  入力内容が保存されていません。
</Modal>
```
