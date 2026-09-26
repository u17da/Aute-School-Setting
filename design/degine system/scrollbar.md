# Scrollbar（スクロールバー）

まなびポケット Design System — ナビゲーションコンポーネント

## いつどれを使うか

| シナリオ | 使うもの | 理由 |
|---|---|---|
| コンテンツが枠の高さを超える | **Scrollbar (Vertical)** | 縦スクロール |
| コンテンツが枠の幅を超える | **Scrollbar (Horizontal)** | 横スクロール（極力避ける） |
| ページ全体のスクロール | ブラウザデフォルト | カスタム不要 |

## Direction variants

| direction | 用途 | 推奨度 |
|---|---|---|
| `vertical` | 縦スクロール。リスト、テーブル、モーダル内等 | ◎ 推奨 |
| `horizontal` | 横スクロール。横長テーブル等 | △ できるだけ避ける |

## 構造（Vertical 例）

```
     ┌───┐
     │ ▓ │ ← thumb (7px幅, 44px最小高さ)
     │   │
     │   │ ← track (#EFEFEF, 15px幅)
     │   │
     └───┘
```

- Track: `#EFEFEF`、幅/高さ 15px
- Thumb: `#BCBDBD`、幅/高さ 7px、`border-radius: 4px`
- Thumb 最小長: 44px
- Track 内 padding: 4px

## 仕様ルール

1. スクロールが必要なコンテンツ量がある場合は **必ず** スクロールバーを設置する
2. 全コンテンツがスクロールなしで表示できる場合は **スクロールバーを隠す**
3. **重要な情報** はスクロールしなくても見える位置（ファーストビュー）に配置する
4. **水平スクロールはできるだけ避けて** コンテンツを作成する

## States

| state | Thumb 色 | 説明 |
|---|---|---|
| default | `#BCBDBD` | 通常表示 |
| hover | `#909398` | マウスオーバー時 |
| dragging | `#909398` | ドラッグ中 |
| hidden | — | コンテンツが枠内に収まる場合 |

## Do / Don't

| ✅ Do | ❌ Don't |
|---|---|
| コンテンツが溢れる場所に必ず設置する | スクロールバーなしで溢れを隠す |
| 重要情報をファーストビューに配置する | 重要情報をスクロール下部にのみ置く |
| 縦スクロールを優先する | 横スクロールを安易に使う |
| CSS の `overflow: auto` で自動表示する | 常に表示しておく |

## アクセシビリティ

- ネイティブスクロールを使用し、カスタムスクロールバーは視覚的装飾のみ
- `tabindex` は付けない（ネイティブスクロールがキーボード操作を担う）
- スクロール可能であることを `role="region"` + `aria-label` で示す
- コンテンツの上下端で慣性スクロールを自然に止める（`overscroll-behavior: contain`）

## 実装スニペット

```tsx
import { ScrollArea } from '@manabi-ds/scrollbar';

// 縦スクロール
<ScrollArea direction="vertical" maxHeight={400}>
  <LongContent />
</ScrollArea>

// 横スクロール（非推奨だが必要な場合）
<ScrollArea direction="horizontal" maxWidth={600}>
  <WideTable />
</ScrollArea>
```

## CSS-only 適用パターン

カスタムスクロールバーをネイティブ要素に適用する場合:

```css
.my-scrollable {
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* Webkit (Chrome, Safari, Edge) */
.my-scrollable::-webkit-scrollbar { width: 15px; background: #EFEFEF; }
.my-scrollable::-webkit-scrollbar-thumb { background: #BCBDBD; border-radius: 4px; border: 4px solid #EFEFEF; }
.my-scrollable::-webkit-scrollbar-thumb:hover { background: #909398; }
```
