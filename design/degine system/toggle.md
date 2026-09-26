# Toggle — まなびポケット Design System

> `button.md` と同じ思想で書かれた、エージェント参照用の仕様書です。
> 実装時はまずこのファイルを読み、Toggle.tsx を呼び出すこと。

---

## いつ Toggle を使うか — 意思決定フロー

| やりたいこと | 使うコンポーネント |
|---|---|
| 設定の **オン/オフを即時反映** で切り替えたい（例: 通知ON/OFF、公開/非公開） | **Toggle** ✅ |
| 複数項目から選ばせたい（単一選択） | Radio |
| 複数項目から選ばせたい（複数選択） | Checkbox |
| 表示モード切替（リスト⇔グリッド、自分のクラス⇔全クラス） | **Tab または SegmentedControl**（Toggleではない）|
| 送信ボタンなど「保存して反映」が必要な操作 | Button |
| 反対概念の二択（男/女、ON/OFF以外の対立項目） | Radio または SegmentedControl |

### Toggle が適切な条件
1. **単一の設定** に対する **オン/オフ** の二値切替であること
2. **即時反映** されること（保存ボタン不要）
3. オン状態とオフ状態が **対立概念ではなく**「機能の有効化/無効化」であること

> ⚠️ Toggle は「2つの選択肢から1つ選ぶ」UIではない。それは Radio や SegmentedControl の役割。

---

## Variants / Props

### Check（必須・状態）
| 値 | 意味 | 視覚 |
|---|---|---|
| `on` | 有効化されている | スライダーが右、青系 (#16ABCE bg / #008299 knob) |
| `off` | 無効化されている | スライダーが左、グレー (#909398 bg / #FFFFFF knob) |

### State（任意・状態修飾）
| 値 | 意味 | 視覚 |
|---|---|---|
| `default` | 通常 | 上記の通常配色 |
| `disable` | 操作不可 | bg #EFEFEF / knob #D7D7D7、テキストもグレー化 |

### Label位置（任意）
- ラベルテキストを **左側** に表示するのが標準
- ラベル省略時はトグル単体で表示可

### サイズ
- 1サイズのみ（width 46px / height 28px / knob 20px）。サイズバリエーションは持たない。

---

## Do / Don't

### ✅ Do
- **設定画面・詳細パネル** での即時切替設定に使う
- ラベルは「通知を受け取る」「公開する」など、**オンにした状態が何を意味するか** が分かる名詞句または動詞句にする
- 操作後、即座にUIに反映する（保存待ちにしない）

### ❌ Don't
- **ボタンの代わり** として使わない（送信・実行などの瞬間動作には使わない）
- **対立する2項目** の選択に使わない（「全てのクラス」⇔「自分のクラス」のような切替は Tab/SegmentedControl）
- **異なる機能の切り替え** に使わない（リスト表示⇔グリッド表示など）
- ボタンと **同一カードの中で並列に置かない**（保存反映タイミングが混乱する）
- 入れ子構造にしない

---

## アクセシビリティ要件

- ネイティブ `<input type="checkbox" role="switch">` を内包し、`aria-checked` を保持
- ラベルは `<label>` で `htmlFor` 連結、もしくは `aria-labelledby`
- `disabled` 時は `aria-disabled="true"` も併記
- キーボード: Space / Enter で切替できること（input 要素なら自動）
- フォーカス時は `:focus-visible` で knob にリング表示
- 切替時はスクリーンリーダーが「on/off」を読み上げる（role="switch" で自動）

---

## 実装の入り口

```tsx
import { Toggle } from '@/design-system/components/toggle/Toggle';

// 基本
<Toggle checked={notif} onChange={(e) => setNotif(e.target.checked)}>
  通知を受け取る
</Toggle>

// 無効化
<Toggle checked={false} disabled>機能を有効にする</Toggle>

// ラベル無し（カードのアクション位置に置く時など）
<Toggle checked={visible} onChange={...} aria-label="公開状態" />
```
