# Tour（ツアー / オンボーディング）

まなびポケット Design System — ガイダンスコンポーネント

## いつどれを使うか

| シナリオ | コンポーネント | 理由 |
|---|---|---|
| 機能やUIを段階的に説明したい | **Tour** | 吹き出し式でフォーカス解説 |
| 一時的な操作結果を伝えたい | Message | トースト通知 |
| 確認や入力を求めたい | Modal | ダイアログ |

## Placement variants

| placement | 吹き出しの三角の向き | 用途 |
|---|---|---|
| `center` | 三角なし（中央配置） | 最初のステップ、全体説明 |
| `left` | 右辺に三角（→ 対象は左側） | 左側の要素を指す |
| `right` | 左辺に三角（← 対象は右側） | 右側の要素を指す |
| `under` | 上辺に三角（↑ 対象は上側） | 上側の要素を指す |
| `top` | 下辺に三角（↓ 対象は下側） | 下側の要素を指す |

## 表示オプション（プロパティ）

| プロパティ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `showTitle` | boolean | true | タイトル行の表示 |
| `showGraphic` | boolean | false | 画像/イラスト枠（240px高） |
| `showStepper` | boolean | true | ドットインジケーター |
| `showSkip` | boolean | true | 「全画面表示」テキストリンク |

## 構造

```
┌──────────────────────────────────────┐
│ タイトル（16px bold）                │
│ [グラフィック枠 396×240 #F5F5F5]    │  ← showGraphic 時
│ 説明テキスト（14px / 3行まで）       │
│                                      │
│ ● ○ ○ ○ ○ ○   [スキップ] [戻る] [次へ] │
└──────────────────────────────────────┘
     ▲ ← placement に応じた三角
```

- 白背景 `#FFFFFF` + `box-shadow: 0px 2px 12px rgba(0,0,0,0.1)` + `border-radius: 8px`
- 幅: 444px、padding: `24px`（center）/ `16px`（それ以外）
- 三角（矢印）: 24×16px 白色、CSS triangle で実装
- Stepper ドット: 8×8px、アクティブ `#008299`、非アクティブ `#EDF0F2`、gap 4px

## ボタン構成

| 要素 | スタイル | 色 |
|---|---|---|
| スキップ（テキストリンク） | text variant | `#008299` |
| 戻る | solid | `#878F96`（Negative） |
| 次へ / 完了 | solid | `#008299`（Primary） |

- ボタンサイズ: 80×40px、radius 8px
- 最終ステップでは「次へ」→「完了」にラベル変更

## Stepper 単体

| ステップ数 | 固定6ドット | アクティブ位置 |
|---|---|---|
| step 1 | ● ○ ○ ○ ○ ○ | index 0 |
| step 2 | ○ ● ○ ○ ○ ○ | index 1 |
| ... | ... | ... |
| step 6 | ○ ○ ○ ○ ○ ● | index 5 |

## Do / Don't

| ✅ Do | ❌ Don't |
|---|---|
| 重要な機能やアイコンの説明に使う | 自明な操作にツアーを付ける |
| 1ステップ3行以内の説明にする | 長文の詳細説明をツアーで行う |
| placement を対象要素の位置に合わせる | 全ステップ center で済ませる |
| 初回起動時のみ表示する | 毎回表示する |

## アクセシビリティ

- `role="dialog"` + `aria-modal="false"`（背景操作はブロックしない）
- `aria-labelledby` でタイトルを参照
- `aria-describedby` で説明文を参照
- ステッパーに `role="tablist"` + 各ドットに `role="tab"` + `aria-selected`
- キーボード: Tab で「スキップ→戻る→次へ」を巡回、Escape でツアー終了
- 対象要素にフォーカスリングを当てる（`box-shadow` or `outline`）

## 実装スニペット

```tsx
import { Tour, TourStep } from '@manabi-ds/tour';

const steps: TourStep[] = [
  { target: '#sidebar', placement: 'right', title: 'メニュー', description: 'ここから各機能に移動できます' },
  { target: '#dashboard', placement: 'under', title: 'ダッシュボード', description: '利用状況を確認できます', showGraphic: true },
  { target: '#settings', placement: 'left', title: '設定', description: '学校の設定を変更できます' },
];

<Tour steps={steps} open={isFirstVisit} onComplete={markTourDone} />
```
