# DatePicker

まなびポケットで日付・期間・時刻を入力するための統合コンポーネント。AAR ポータル（ふりかえり / やること切替）での利用を主軸に設計している。

トリガー（呼び出し側のテキスト/ボタン）と、ポップオーバー本体（カレンダー/月選択/時刻選択）を1つのコンポーネントとして扱う。

---

## いつどれを使うか

| 状況 | variant | 補足 |
|------|---------|------|
| 1日だけ選ぶ（授業日、出席日、個別ふりかえり） | `day` | 既定。AAR ポータル「やること」「ふりかえり」両方の単日表示で使う |
| 平日5日間（月〜金）を1単位として動かす | `week` | 「週単位ふりかえり」用。前週/翌週の double-arrow を必ず添える |
| 月単位の集計・閲覧 | `month` | グリッド3×4。年間ふりかえり画面など |
| 開始日〜終了日の任意期間（出力期間、レポート対象期間） | `range` | 範囲ハイライトは `--mp-dp-cell-range-bg` |
| 時刻だけ選ぶ（授業開始時刻、面談時間） | `time` | Hour / Minute の縦スクロール2列 |

迷ったら `day`。期間が必要だと判明した時点で `range` に上げる。

### サイズの選び方

| size | 高さ | 用途 |
|------|------|------|
| `m` | 40px | 既定。ページ主役の日付ナビ |
| `s` | 24px | サブヘッダー、サイドパネル内、二次的な日付 |
| `ss` | 32px | リスト行内、コンパクトな並びの中。フォントは 14px に縮む |

### トリガー表示の選び方

| trigger | 見た目 | 用途 |
|---------|--------|------|
| `text` | テキストのみ | 既存の見出しに馴染ませたい時 |
| `text-icon` | テキスト + カレンダーアイコン | 既定。「クリックできる」を最も伝える |
| `icon` | アイコンのみ | スペースが極端に狭い時のみ |

---

## デザイントークン

### 色（カレンダー本体）

| token | 値 | 用途 |
|-------|-----|------|
| `--mp-dp-cell-today-bg` | #EFFBFF | 当日セル背景 |
| `--mp-dp-cell-today-text` | #008299 | 当日セル文字 |
| `--mp-dp-cell-selected-bg` | #00839A | 選択セル背景 |
| `--mp-dp-cell-selected-text` | #FFFFFF | 選択セル文字 |
| `--mp-dp-cell-range-bg` | #E1F7FD | 範囲内セル背景（range のみ） |
| `--mp-dp-cell-range-preview-border` | #CCCCCC | 範囲ホバー時の点線枠 |
| `--mp-dp-cell-hover-bg` | #D7D7D7 | 通常セル hover |
| `--mp-dp-cell-disabled-bg` | #F5F7F8 | 無効セル背景 |
| `--mp-dp-cell-disabled-text` | #BCBDBD | 無効セル文字 |
| `--mp-dp-cell-muted-text` | #909398 | 前月/翌月セル文字 |
| `--mp-dp-cell-default-text` | #283148 | 通常セル文字 |
| `--mp-dp-badge-bg` | #F44336 | 通知バッジ |
| `--mp-dp-weekday-bg` | #F5F7F8 | 曜日ヘッダー帯 |
| `--mp-dp-popover-bg` | #FFFFFF | ポップオーバー本体 |
| `--mp-dp-popover-shadow` | 0 2px 12px rgba(0,0,0,.10) | ポップオーバー影 |

### 色（トリガー）

Button と共通。`text-active` 状態でテキスト色が `#008299`、隣接アイコンの背景は `#EFFBFF`。

### サイズ

| token | 値 |
|-------|-----|
| `--mp-dp-cell-size` | 36px（クリック領域、通常）|
| `--mp-dp-cell-size-s` | 24px（小）|
| `--mp-dp-radius-cell` | 4px |
| `--mp-dp-radius-popover` | 4px |
| `--mp-dp-radius-trigger` | 8px |

フォントは Hiragino Kaku Gothic Pro / 600（数字以外）/ line-height 1.5 を踏襲。

---

## States

| state | 適用先 | 振る舞い |
|-------|--------|---------|
| `default` | セル | 文字 #283148、背景なし |
| `today` | セル | `--mp-dp-cell-today-bg` + `--mp-dp-cell-today-text`。常に bold |
| `selected` | セル | `--mp-dp-cell-selected-bg` + 白文字 |
| `in-range` | セル | range の開始〜終了の中間。背景のみ |
| `range-edge` | セル | range の両端。selected と同じ見た目 |
| `range-preview` | セル | range 選択中、マウスホバーで点線枠 |
| `prev-next` | セル | 前月/翌月。文字 #909398 |
| `disabled` | セル | クリック不可。`aria-disabled="true"` |
| `hover` | セル | 通常セルは #D7D7D7、today は枠線のみ追加 |
| `focus-visible` | セル | 2px solid #008299 のリングを outline で |
| `enabled / hover / active` | トリガー | テキスト色のみ変化、active は #008299 |

---

## アクセシビリティ要件

- ポップオーバーは `role="dialog"` + `aria-modal="false"` + `aria-labelledby`。
- 月グリッドは `role="grid"`、各セルは `role="gridcell"`。
- 当日セルは `aria-current="date"`。
- 選択中セルは `aria-selected="true"`。
- 無効セルは `aria-disabled="true"` かつ `tabindex="-1"`。
- キーボード:
  - `←/→` 前日/翌日、`↑/↓` 前週/翌週
  - `PageUp/PageDown` 前月/翌月、`Shift+PageUp/PageDown` 前年/翌年
  - `Home/End` 週の開始/終端
  - `Enter/Space` 選択確定、`Esc` ポップオーバーを閉じる
- ポップオーバー open 時、フォーカスは選択中セル（無ければ today）に移す。close 時、フォーカスはトリガーへ戻す。
- 矢印ボタン（前週/翌週）には `aria-label="前週へ"` 等を必ず付ける。double-arrow は `aria-label="前年へ"` または `"前4週へ"`（用途次第）。

---

## Do / Don't

### Do

- AAR ポータルでは ToggleBtn（やること/ふりかえり）→ DatePicker の順で並べる。Figma のレイアウトに従う。
- `range` 選択中は終端候補に point-cursor を見せる。Figma の Date_range の Cursor/Pointer の意図はこれ。
- `time` の Hour/Minute はそれぞれ独立にスクロールさせる。1列ずつ独立してスナップ。

### Don't

- セル内に2つ以上の情報（バッジ + ドット + 数字 + …）を同時に出さない。バッジ1つまで。
- `selected` と `today` を同時に強調しない。selected を優先し today の色は退場させる。
- ポップオーバーを画面外にはみ出させない。トリガーとの位置関係は flip 戦略で。
- size=`ss` で trigger=`icon` を使わない（タップ領域が 32×32 を切る）。

---

## 実装の入り口

```tsx
import { DatePicker } from "@/components/DatePicker";

// 単日
<DatePicker
  variant="day"
  size="m"
  value={date}
  onChange={setDate}
  todayLabel="今日"
/>

// 週（AAR ポータル）
<DatePicker
  variant="week"
  size="m"
  value={weekStart}
  onChange={setWeekStart}
  showJumpArrows
/>

// 範囲
<DatePicker
  variant="range"
  size="m"
  value={[start, end]}
  onChange={setRange}
/>

// 時刻
<DatePicker
  variant="time"
  value={time}
  onChange={setTime}
  minuteStep={5}
/>
```

セル単位で量産したい場合は内部の `<CalendarCell>` を直接使えるが、**外部に export しない**。常に DatePicker 経由で扱う。
