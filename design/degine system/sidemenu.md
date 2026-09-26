# SideMenu — まなびポケット Design System

グローバルナビゲーションとは別に、画面内のサブナビゲーションとして使用するコンポーネント。
クリックで画面遷移を伴うアクションが発生する。

---

## 意思決定フロー

| やりたいこと | 使うもの | 備考 |
|---|---|---|
| サブナビゲーション（常時表示） | **SideMenu** | 選択肢が一覧で見える |
| サブナビゲーション（省スペース） | Pulldown/Btn | クリックしないと選択肢が見えない。ユーザビリティ低下の恐れ |
| アクションを伴わない一覧表示 | List | 遷移なし |
| 複数要素から選択のみ | TextField/Select | フォーム入力向け |
| セクション内の折りたたみ | SideMenu `accordion` variant | 子メニューの表示/非表示を切り替え |
| ユーザー名付きメニュー | SideMenu `name` variant | アバター + 名前を表示 |

---

## Variants

| variant | 説明 | 用途 |
|---|---|---|
| `section` | セクション見出し。クリック不可の区切りラベル | メニューグループのカテゴリ表示 |
| `title` | 太字タイトル行。右に chevron | 主要カテゴリへの遷移 |
| `accordion` | 左に開閉矢印 + タイトル + Badge | 子メニューを持つ折りたたみ |
| `default` | テキスト行 + 右 chevron | 標準メニュー項目 |
| `name` | アバター + ユーザー名 + 右 chevron | ユーザープロフィール、児童名リスト等 |
| `nav` | 下線付き行 + 右矢印 | ページ遷移リンク（Nav/SideMenu） |

---

## Sizes

| size | 高さ (variant による) | padding | フォント |
|---|---|---|---|
| `md` | section: 26px / default: 40px / title,accordion,name: 56px | 16px | title: 16px/600, default: 14px/300, section: 12px/300 |
| `sm` | section: 26px / default: 40px / title,accordion,name: 48px | 12px 16px | title: 14px/600, default: 14px/300, section: 12px/300 |

---

## States

| state | 背景 | テキスト色 | アイコン色 |
|---|---|---|---|
| `enabled` | `#FFFFFF` | `#283148` | `#61646C` |
| `hover` | `#F5F7F8` | `#283148` | `#61646C` |
| `active` | `#EFFBFF` | `#00606D` | `#008299` |

`section` variant は常に `bg: #F5F7F8`, `color: #283148` で、状態変化なし。

---

## Colors / Tokens

```
--mp-sidemenu-bg-enabled:    #FFFFFF
--mp-sidemenu-bg-hover:      #F5F7F8
--mp-sidemenu-bg-active:     #EFFBFF
--mp-sidemenu-bg-section:    #F5F7F8

--mp-sidemenu-text-primary:  #283148
--mp-sidemenu-text-secondary:#61646C
--mp-sidemenu-text-active:   #00606D
--mp-sidemenu-icon-default:  #61646C
--mp-sidemenu-icon-active:   #008299

--mp-sidemenu-badge-bg:      #D50000
--mp-sidemenu-badge-text:    #FFFFFF

--mp-sidemenu-nav-border:    #3D4965
```

---

## Badge

- 赤丸（`#D50000`）に白テキスト
- 10px / line-height 150% / border-radius 64px
- 未読数・通知数を表示
- `badgeCount` prop で制御。0 以下で非表示

---

## Accordion 開閉

- `open={false}`: 下向き矢印 `keyboard_arrow_down`
- `open={true}`: 矢印を 180° 回転（`transform: rotate(180deg)`）
- `onToggle` コールバックで親が状態管理

---

## Do / Don't

### Do
- 選択肢が 3〜15 件程度のサブナビゲーションに使う
- `section` でグループを区切り、視認性を高める
- Active 状態で現在地を明示する
- キーボード操作（↑↓ / Enter / Space）に対応する

### Don't
- 2 階層以上のネストは避ける（accordion の中に accordion は NG）
- `section` をクリッカブルにしない
- Badge を装飾目的で使わない（数値のないバッジは出さない）
- 選択肢が 2 件以下なら Tab や SegmentedControl を検討する

---

## アクセシビリティ

- `role="navigation"` を最外殻に、`aria-label` でナビゲーション名を付与
- 各アイテムは `role="menuitem"`（section は `role="separator"`）
- Active 項目に `aria-current="page"`
- Accordion は `aria-expanded` で開閉状態を伝達
- Badge は `aria-label="通知 {n} 件"` で読み上げ対応
- フォーカスリングは `2px solid #008299` offset `2px`
- Tab / Shift+Tab でメニュー間、↑↓ でアイテム間移動

---

## 実装スニペット

```tsx
import { SideMenu, SideMenuItem } from '@manabi-ds/sidemenu';

<SideMenu aria-label="設定メニュー" size="md">
  <SideMenuItem variant="section">基本設定</SideMenuItem>
  <SideMenuItem variant="title" active>プロフィール</SideMenuItem>
  <SideMenuItem variant="default" badgeCount={3}>通知設定</SideMenuItem>
  <SideMenuItem variant="accordion" open onToggle={toggle}>
    詳細設定
  </SideMenuItem>
  <SideMenuItem variant="name" avatarSrc="/img/user.jpg">
    山田太郎
  </SideMenuItem>
  <SideMenuItem variant="nav" href="/settings/advanced">
    高度な設定
  </SideMenuItem>
</SideMenu>
```
