# Tab — まなびポケット Design System

> エージェントへ：タブUIを実装する時、まず本ファイルを読み、`Tab.tsx`をimportして使うこと。
> `tab.css`の変数・クラスは外部から触らない。

---

## 1. いつどれを使うか（意思決定フロー）

| ユーザーの意図 | `variant` | 例 |
|---|---|---|
| ページ内のメインビューを切り替える | `primary` | 「出席簿」「成績」「健康観察」 |
| Primary Tab の中でさらにサブビューを切り替える | `secondary` | 「月別」「学期別」「年間」 |

### 厳守ルール

- **Primary → Secondary の順**に重要度を下げる。逆は禁止。
- Primary Tab のコンテンツ内にタブが必要な場合、Secondary Tab を使う。
- Tab の影響範囲を明確にする。**原則として下線で影響ビューの範囲を示す**。下線なしで影響範囲が自明な場合は省略可。
- アイコンは任意。コンポーネントプロパティから表示/非表示を切り替えられる。
- アイコンを変更する場合は、Icon Value プロパティから icon ページ上のインスタンスを選択する。

---

## 2. Variants

| variant | 見た目 | 高さ |
|---|---|---|
| `primary` | 角丸上部(16px 16px 0 0)、背景色あり、下部2pxボーダー | 40px |
| `secondary` | pill形状(40px radius)、背景色塗り、ボーダーなし | 32px |

---

## 3. States

| state | primary の見た目 | secondary の見た目 |
|---|---|---|
| `default` | bg `#DFE6EB` / text `#283148` / 下線 2px solid `#283148` | bg `#FFFFFF` / text `#283148` |
| `disabled` | bg `#EDF0F2` / text `#FFFFFF` | bg `#EDF0F2` / text `#FFFFFF` |
| `active` | bg `#283148` / text `#FFFFFF` | bg `#283148` / text `#FFFFFF` |

---

## 4. Anatomy（構造）

```
Primary Tab:
┌─────────────────────────────────┐
│  [Container]                     │  ← border-radius: 16px 16px 0 0
│    [icon?] [label]               │  ← padding: 8px 16px, gap: 8px
│  ─────────────────────────────── │  ← Line: 2px solid #283148 (default)
└─────────────────────────────────┘

Secondary Tab:
┌─────────────────────┐
│  [icon?] [label]     │  ← border-radius: 40px, padding: 4px 12px, gap: 4px
└─────────────────────┘
```

---

## 5. Do / Don't

| Do | Don't |
|---|---|
| Primary Tab でメインのビュー切替に使う | Secondary Tab だけでページ直下のビュー切替にしない |
| 影響範囲を下線で明示する | Tab の影響範囲が不明瞭なまま配置する |
| 2〜5個程度のタブ数にする | 10個以上のタブを並べる（→ ドロップダウンを検討） |
| Active 状態で今いる場所を示す | 全タブが default のまま放置 |
| アイコンはラベルの補助として使う | アイコンのみでラベルなしのタブにする |

---

## 6. アクセシビリティ

- `role="tablist"` をタブの外側コンテナに付与。
- 各タブに `role="tab"` + `aria-selected="true|false"` を付与。
- Active タブのコンテンツに `role="tabpanel"` + `aria-labelledby={tabId}` を付与。
- キーボード操作: `ArrowLeft` / `ArrowRight` でフォーカス移動、`Enter` / `Space` でアクティベート。
- `aria-disabled="true"` を disabled タブに付与（`disabled` 属性ではなく aria で制御）。

---

## 7. 実装の入り口

```tsx
import { Tabs, Tab } from '@manabi-ds/Tab';

<Tabs value={activeTab} onChange={setActiveTab}>
  <Tab value="attendance" icon={<CheckIcon />}>出席簿</Tab>
  <Tab value="grades">成績</Tab>
  <Tab value="health" disabled>健康観察</Tab>
</Tabs>

{/* Secondary（Primary内で使う場合） */}
<Tabs value={subTab} onChange={setSubTab} variant="secondary">
  <Tab value="monthly">月別</Tab>
  <Tab value="semester">学期別</Tab>
</Tabs>
```
