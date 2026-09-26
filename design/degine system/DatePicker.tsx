import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";

/* =============================================================
 * Types
 * ============================================================= */

export type DatePickerVariant = "day" | "week" | "month" | "range" | "time";
export type DatePickerSize = "m" | "s" | "ss";
export type DatePickerTriggerKind = "text" | "text-icon" | "icon";

export type DateRange = [Date | null, Date | null];
export type TimeValue = { hour: number; minute: number };

type BaseProps = {
  /** 表示サイズ。既定 'm' */
  size?: DatePickerSize;
  /** トリガー表示の種類。既定 'text-icon' */
  triggerKind?: DatePickerTriggerKind;
  /** 無効化 */
  disabled?: boolean;
  /** カスタムフォーマッタ。トリガーに表示する文字列を返す */
  formatter?: (value: unknown) => string;
  /** "今日" ボタンのラベル。既定 '今日' */
  todayLabel?: string;
  /** ポップオーバー上下左右の前/翌ジャンプ矢印を表示（week/range 推奨） */
  showJumpArrows?: boolean;
  /** ロケール。既定 'ja-JP' */
  locale?: string;
  /** 任意のクラス名 */
  className?: string;
  style?: CSSProperties;
  id?: string;
  "aria-label"?: string;
};

type DayProps = BaseProps & {
  variant: "day";
  value: Date | null;
  onChange: (next: Date) => void;
  /** 選択不可日の判定 */
  isDateDisabled?: (date: Date) => boolean;
  /** セル内に出すバッジ件数 */
  badgeCountFor?: (date: Date) => number | undefined;
};

type WeekProps = BaseProps & {
  variant: "week";
  /** 週の開始日（月曜日想定） */
  value: Date | null;
  onChange: (weekStartMonday: Date) => void;
};

type MonthProps = BaseProps & {
  variant: "month";
  value: { year: number; month: number } | null;
  onChange: (next: { year: number; month: number }) => void;
};

type RangeProps = BaseProps & {
  variant: "range";
  value: DateRange;
  onChange: (next: DateRange) => void;
  isDateDisabled?: (date: Date) => boolean;
};

type TimeProps = BaseProps & {
  variant: "time";
  value: TimeValue | null;
  onChange: (next: TimeValue) => void;
  /** 分の刻み幅。既定 1 */
  minuteStep?: number;
};

export type DatePickerProps =
  | DayProps
  | WeekProps
  | MonthProps
  | RangeProps
  | TimeProps;

/* =============================================================
 * Helpers
 * ============================================================= */

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfMonth(year: number, month: number): Date {
  return new Date(year, month, 1);
}
function daysInMonthGrid(year: number, month: number): Date[] {
  // 6週分（42セル）。前月末・翌月頭で埋める。日曜始まり。
  const first = startOfMonth(year, month);
  const startWeekday = first.getDay();
  const gridStart = addDays(first, -startWeekday);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

/* =============================================================
 * DatePicker
 * ============================================================= */

export const DatePicker = forwardRef<HTMLDivElement, DatePickerProps>(
  function DatePicker(props, ref) {
    const {
      variant,
      size = "m",
      triggerKind = "text-icon",
      disabled = false,
      todayLabel = "今日",
      showJumpArrows = false,
      locale = "ja-JP",
      className,
      style,
      id,
      formatter,
    } = props;

    const reactId = useId();
    const popoverId = id ?? `mp-dp-${reactId}`;

    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);

    /* ---- 開発時の不正組み合わせ警告 ---- */
    if (process.env.NODE_ENV !== "production") {
      if (size === "ss" && triggerKind === "icon") {
        // eslint-disable-next-line no-console
        console.warn(
          "[DatePicker] size='ss' + triggerKind='icon' はタップ領域が 32×32 を切るため非推奨です。triggerKind='text-icon' を推奨。"
        );
      }
      if (variant === "time" && (showJumpArrows || size === "ss")) {
        // eslint-disable-next-line no-console
        console.warn(
          "[DatePicker] variant='time' は size='m' / showJumpArrows=false を想定しています。"
        );
      }
      if (variant === "month" && showJumpArrows) {
        // eslint-disable-next-line no-console
        console.warn(
          "[DatePicker] variant='month' で showJumpArrows は冗長です。月グリッド自身が遷移を担います。"
        );
      }
    }

    /* ---- 外側クリック / Esc で閉じる ---- */
    useEffect(() => {
      if (!open) return;
      const onClick = (e: MouseEvent) => {
        if (
          popoverRef.current &&
          !popoverRef.current.contains(e.target as Node) &&
          !triggerRef.current?.contains(e.target as Node)
        ) {
          setOpen(false);
        }
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          setOpen(false);
          triggerRef.current?.focus();
        }
      };
      document.addEventListener("mousedown", onClick);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("mousedown", onClick);
        document.removeEventListener("keydown", onKey);
      };
    }, [open]);

    /* ---- Trigger 表示テキスト ---- */
    const triggerText = useMemo(
      () => formatTriggerLabel(props, locale, formatter),
      [props, locale, formatter]
    );

    const triggerClassName = [
      "mp-dp-trigger",
      size !== "m" && `mp-dp-trigger--${size}`,
      triggerKind === "icon" && "mp-dp-trigger--icon-only",
      open && "mp-dp-trigger--active",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    /* =========================================================
     * Render
     * ========================================================= */

    return (
      <div
        ref={ref}
        className="mp-dp-root"
        style={{ position: "relative", display: "inline-block", ...style }}
      >
        <button
          ref={triggerRef}
          type="button"
          className={triggerClassName}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={popoverId}
          aria-disabled={disabled || undefined}
          aria-label={props["aria-label"] ?? triggerText}
          disabled={disabled}
          onClick={() => !disabled && setOpen((v) => !v)}
        >
          {triggerKind !== "icon" && <span>{triggerText}</span>}
          {triggerKind !== "text" && (
            <span className="mp-dp-trigger__icon" aria-hidden="true">
              <CalendarIcon />
            </span>
          )}
        </button>

        {open && !disabled && (
          <div
            ref={popoverRef}
            id={popoverId}
            role="dialog"
            aria-modal="false"
            aria-label={`${variant} 選択`}
            style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 50 }}
          >
            <PopoverBody
              {...props}
              todayLabel={todayLabel}
              showJumpArrows={showJumpArrows}
              locale={locale}
              onClose={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            />
          </div>
        )}
      </div>
    );
  }
);

/* =============================================================
 * Popover body — variant ごとに分岐
 * ============================================================= */

function PopoverBody(
  props: DatePickerProps & { onClose: () => void }
) {
  switch (props.variant) {
    case "day":
      return <DayBody {...props} />;
    case "week":
      return <WeekBody {...props} />;
    case "month":
      return <MonthBody {...props} />;
    case "range":
      return <RangeBody {...props} />;
    case "time":
      return <TimeBody {...props} />;
  }
}

/* =============================================================
 * Day body
 * ============================================================= */

function DayBody(props: DayProps & { onClose: () => void; locale: string }) {
  const { value, onChange, isDateDisabled, badgeCountFor, locale, onClose } = props;
  const today = useMemo(() => startOfDay(new Date()), []);
  const initial = value ?? today;
  const [view, setView] = useState({
    year: initial.getFullYear(),
    month: initial.getMonth(),
  });

  const cells = useMemo(
    () => daysInMonthGrid(view.year, view.month),
    [view]
  );

  const title = `${view.year}年${view.month + 1}月`;
  const titleId = useId();

  return (
    <div className="mp-dp-popover" aria-labelledby={titleId}>
      <div className="mp-dp-popover__header">
        <button
          type="button"
          className="mp-dp-nav__today"
          onClick={() =>
            setView({ year: today.getFullYear(), month: today.getMonth() })
          }
        >
          今日
        </button>
        <div className="mp-dp-popover__title-group">
          <button
            type="button"
            className="mp-dp-nav__btn"
            aria-label="前月へ"
            onClick={() =>
              setView((v) =>
                v.month === 0
                  ? { year: v.year - 1, month: 11 }
                  : { year: v.year, month: v.month - 1 }
              )
            }
          >
            <ChevronIcon dir="left" />
          </button>
          <span id={titleId} className="mp-dp-popover__title">
            {title}
          </span>
          <button
            type="button"
            className="mp-dp-nav__btn"
            aria-label="翌月へ"
            onClick={() =>
              setView((v) =>
                v.month === 11
                  ? { year: v.year + 1, month: 0 }
                  : { year: v.year, month: v.month + 1 }
              )
            }
          >
            <ChevronIcon dir="right" />
          </button>
        </div>
      </div>

      <Weekdays />

      <div className="mp-dp-grid" role="grid" aria-labelledby={titleId}>
        {cells.map((d, i) => {
          const isMuted = d.getMonth() !== view.month;
          const isToday = isSameDay(d, today);
          const isSelected = value ? isSameDay(d, value) : false;
          const isDisabled = isDateDisabled?.(d) ?? false;
          const badge = badgeCountFor?.(d);

          return (
            <CalendarCell
              key={i}
              date={d}
              isToday={isToday}
              isSelected={isSelected}
              isMuted={isMuted}
              isDisabled={isDisabled}
              badgeCount={badge}
              locale={locale}
              onSelect={(picked) => {
                onChange(picked);
                onClose();
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/* =============================================================
 * Week body — 月〜金の5日を一塊として選択
 * ============================================================= */

function WeekBody(props: WeekProps & { onClose: () => void; locale: string }) {
  const { value, onChange, locale, onClose } = props;
  const today = useMemo(() => startOfDay(new Date()), []);
  const initial = value ?? today;
  const [view, setView] = useState({
    year: initial.getFullYear(),
    month: initial.getMonth(),
  });

  const cells = useMemo(
    () => daysInMonthGrid(view.year, view.month),
    [view]
  );

  const title = `${view.year}年${view.month + 1}月`;
  const titleId = useId();

  // 月曜始まりの週開始を返す
  function mondayOf(d: Date): Date {
    const day = d.getDay(); // 0=Sun..6=Sat
    const diff = day === 0 ? -6 : 1 - day;
    return addDays(d, diff);
  }
  const selectedMonday = value ? mondayOf(value) : null;

  return (
    <div className="mp-dp-popover" aria-labelledby={titleId}>
      <div className="mp-dp-popover__header">
        <div className="mp-dp-popover__title-group">
          <button
            type="button"
            className="mp-dp-nav__btn"
            aria-label="前月へ"
            onClick={() =>
              setView((v) =>
                v.month === 0
                  ? { year: v.year - 1, month: 11 }
                  : { year: v.year, month: v.month - 1 }
              )
            }
          >
            <ChevronIcon dir="left" />
          </button>
          <span id={titleId} className="mp-dp-popover__title">
            {title}
          </span>
          <button
            type="button"
            className="mp-dp-nav__btn"
            aria-label="翌月へ"
            onClick={() =>
              setView((v) =>
                v.month === 11
                  ? { year: v.year + 1, month: 0 }
                  : { year: v.year, month: v.month + 1 }
              )
            }
          >
            <ChevronIcon dir="right" />
          </button>
        </div>
      </div>

      <Weekdays />

      <div className="mp-dp-grid" role="grid" aria-labelledby={titleId}>
        {cells.map((d, i) => {
          const monday = mondayOf(d);
          const isInWeek = selectedMonday
            ? isSameDay(monday, selectedMonday)
            : false;
          const isMuted = d.getMonth() !== view.month;
          const isToday = isSameDay(d, today);

          return (
            <CalendarCell
              key={i}
              date={d}
              isToday={isToday}
              isSelected={isInWeek}
              isMuted={isMuted}
              locale={locale}
              onSelect={() => {
                onChange(monday);
                onClose();
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/* =============================================================
 * Month body — 3列×4行（YYYY年 + 1〜12月）
 * ============================================================= */

function MonthBody(props: MonthProps & { onClose: () => void }) {
  const { value, onChange, onClose } = props;
  const now = new Date();
  const [year, setYear] = useState(value?.year ?? now.getFullYear());
  const titleId = useId();

  return (
    <div className="mp-dp-popover" aria-labelledby={titleId}>
      <div className="mp-dp-popover__header">
        <div className="mp-dp-popover__title-group">
          <button
            type="button"
            className="mp-dp-nav__btn"
            aria-label="前年へ"
            onClick={() => setYear((y) => y - 1)}
          >
            <ChevronIcon dir="left" />
          </button>
          <span id={titleId} className="mp-dp-popover__title">
            {year}年
          </span>
          <button
            type="button"
            className="mp-dp-nav__btn"
            aria-label="翌年へ"
            onClick={() => setYear((y) => y + 1)}
          >
            <ChevronIcon dir="right" />
          </button>
        </div>
      </div>

      <div
        className="mp-dp-grid mp-dp-grid--month"
        role="grid"
        aria-labelledby={titleId}
      >
        {Array.from({ length: 12 }, (_, m) => {
          const isSelected = value?.year === year && value?.month === m;
          const isCurrent =
            now.getFullYear() === year && now.getMonth() === m;
          return (
            <div
              key={m}
              className={[
                "mp-dp-cell",
                "mp-dp-month-cell",
                isCurrent && "mp-dp-cell--today",
                isSelected && "mp-dp-cell--selected",
              ]
                .filter(Boolean)
                .join(" ")}
              role="gridcell"
              aria-selected={isSelected}
            >
              <button
                type="button"
                className="mp-dp-cell__inner"
                onClick={() => {
                  onChange({ year, month: m });
                  onClose();
                }}
              >
                {m + 1}月
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =============================================================
 * Range body
 * ============================================================= */

function RangeBody(props: RangeProps & { onClose: () => void; locale: string }) {
  const { value, onChange, isDateDisabled, locale, onClose } = props;
  const today = useMemo(() => startOfDay(new Date()), []);
  const anchor = value[0] ?? today;
  const [view, setView] = useState({
    year: anchor.getFullYear(),
    month: anchor.getMonth(),
  });
  const [hoverEnd, setHoverEnd] = useState<Date | null>(null);

  const cells = useMemo(
    () => daysInMonthGrid(view.year, view.month),
    [view]
  );

  const titleId = useId();

  const [start, end] = value;
  const previewEnd = end ?? hoverEnd;

  function inRange(d: Date): {
    isStart: boolean;
    isEnd: boolean;
    isMid: boolean;
    isPreview: boolean;
  } {
    if (!start) return { isStart: false, isEnd: false, isMid: false, isPreview: false };
    const a = start.getTime();
    const b = previewEnd?.getTime();
    const t = startOfDay(d).getTime();
    const isStart = t === a;
    const isEnd = b !== undefined && t === b;
    const isMid =
      b !== undefined &&
      ((a < b && t > a && t < b) || (a > b && t < a && t > b));
    const isPreview = !end && !!hoverEnd && (isMid || isEnd);
    return { isStart, isEnd, isMid, isPreview };
  }

  function handleSelect(d: Date) {
    if (!start || (start && end)) {
      onChange([d, null]);
      setHoverEnd(null);
      return;
    }
    // start のみ確定済み -> end を確定
    const [a, b] = d.getTime() < start.getTime() ? [d, start] : [start, d];
    onChange([a, b]);
    onClose();
  }

  return (
    <div className="mp-dp-popover" aria-labelledby={titleId}>
      <div className="mp-dp-popover__header">
        <div className="mp-dp-popover__title-group">
          <button
            type="button"
            className="mp-dp-nav__btn"
            aria-label="前月へ"
            onClick={() =>
              setView((v) =>
                v.month === 0
                  ? { year: v.year - 1, month: 11 }
                  : { year: v.year, month: v.month - 1 }
              )
            }
          >
            <ChevronIcon dir="left" />
          </button>
          <span id={titleId} className="mp-dp-popover__title">
            {view.year}年{view.month + 1}月
          </span>
          <button
            type="button"
            className="mp-dp-nav__btn"
            aria-label="翌月へ"
            onClick={() =>
              setView((v) =>
                v.month === 11
                  ? { year: v.year + 1, month: 0 }
                  : { year: v.year, month: v.month + 1 }
              )
            }
          >
            <ChevronIcon dir="right" />
          </button>
        </div>
      </div>

      <Weekdays />

      <div className="mp-dp-grid" role="grid" aria-labelledby={titleId}>
        {cells.map((d, i) => {
          const { isStart, isEnd, isMid, isPreview } = inRange(d);
          const isMuted = d.getMonth() !== view.month;
          const isToday = isSameDay(d, today);
          const isDisabled = isDateDisabled?.(d) ?? false;

          return (
            <div
              key={i}
              className={[
                "mp-dp-cell",
                isMid && "mp-dp-cell--in-range",
                isStart && "mp-dp-cell--range-start",
                isEnd && !isStart && "mp-dp-cell--range-end",
                isPreview && "mp-dp-cell--range-preview",
              ]
                .filter(Boolean)
                .join(" ")}
              role="gridcell"
              aria-selected={isStart || isEnd}
              onMouseEnter={() => start && !end && setHoverEnd(d)}
            >
              <button
                type="button"
                className={[
                  "mp-dp-cell__inner",
                  isToday && !isStart && !isEnd && "mp-dp-cell__inner--today",
                  (isStart || isEnd) && "mp-dp-cell--selected-inner",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-disabled={isDisabled || undefined}
                disabled={isDisabled || isMuted}
                style={
                  isStart || isEnd
                    ? {
                        background: "var(--mp-dp-cell-selected-bg)",
                        color: "var(--mp-dp-cell-selected-text)",
                      }
                    : isToday
                    ? {
                        background: "var(--mp-dp-cell-today-bg)",
                        color: "var(--mp-dp-cell-today-text)",
                        fontWeight: 600,
                      }
                    : isMuted
                    ? { color: "var(--mp-dp-cell-muted-text)" }
                    : undefined
                }
                onClick={() => !isDisabled && !isMuted && handleSelect(d)}
              >
                {d.getDate()}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =============================================================
 * Time body
 * ============================================================= */

function TimeBody(props: TimeProps & { onClose: () => void }) {
  const { value, onChange, minuteStep = 1, onClose } = props;
  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);
  const minutes = useMemo(
    () => Array.from({ length: Math.floor(60 / minuteStep) }, (_, i) => i * minuteStep),
    [minuteStep]
  );

  const [draft, setDraft] = useState<TimeValue>(
    value ?? { hour: 0, minute: 0 }
  );

  return (
    <div className="mp-dp-time" role="dialog" aria-label="時刻選択">
      <div className="mp-dp-time__column" aria-label="時">
        {hours.map((h) => {
          const sel = h === draft.hour;
          return (
            <button
              key={h}
              type="button"
              className={[
                "mp-dp-time__item",
                sel && "mp-dp-time__item--selected",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => {
                const next = { ...draft, hour: h };
                setDraft(next);
                onChange(next);
              }}
              aria-selected={sel}
            >
              {String(h).padStart(2, "0")}
            </button>
          );
        })}
      </div>
      <div className="mp-dp-time__column" aria-label="分">
        {minutes.map((m) => {
          const sel = m === draft.minute;
          return (
            <button
              key={m}
              type="button"
              className={[
                "mp-dp-time__item",
                sel && "mp-dp-time__item--selected",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => {
                const next = { ...draft, minute: m };
                setDraft(next);
                onChange(next);
                onClose();
              }}
              aria-selected={sel}
            >
              {String(m).padStart(2, "0")}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* =============================================================
 * Internal: CalendarCell（外部 export しない）
 * ============================================================= */

type CellProps = {
  date: Date;
  isToday?: boolean;
  isSelected?: boolean;
  isMuted?: boolean;
  isDisabled?: boolean;
  badgeCount?: number;
  locale: string;
  onSelect: (date: Date) => void;
} & Pick<ButtonHTMLAttributes<HTMLButtonElement>, "onMouseEnter">;

function CalendarCell({
  date,
  isToday,
  isSelected,
  isMuted,
  isDisabled,
  badgeCount,
  onSelect,
  onMouseEnter,
}: CellProps) {
  const cls = [
    "mp-dp-cell",
    isToday && "mp-dp-cell--today",
    isSelected && "mp-dp-cell--selected",
    isMuted && "mp-dp-cell--muted",
    isDisabled && "mp-dp-cell--disabled",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cls}
      role="gridcell"
      aria-selected={isSelected || undefined}
      aria-current={isToday ? "date" : undefined}
      aria-disabled={isDisabled || undefined}
    >
      <button
        type="button"
        className="mp-dp-cell__inner"
        onClick={() => !isDisabled && onSelect(date)}
        onMouseEnter={onMouseEnter}
        disabled={isDisabled}
        tabIndex={isDisabled ? -1 : 0}
      >
        {date.getDate()}
      </button>
      {badgeCount !== undefined && badgeCount > 0 && (
        <span className="mp-dp-cell__badge" aria-label={`${badgeCount}件`}>
          {badgeCount > 9 ? "9+" : badgeCount}
        </span>
      )}
    </div>
  );
}

/* =============================================================
 * Internal: Weekdays / Icons
 * ============================================================= */

function Weekdays() {
  return (
    <div className="mp-dp-weekdays" role="row">
      {WEEKDAY_LABELS.map((w, i) => (
        <div
          key={w}
          className={[
            "mp-dp-weekdays__cell",
            i === 0 && "mp-dp-weekdays__cell--sun",
          ]
            .filter(Boolean)
            .join(" ")}
          role="columnheader"
          aria-label={`${w}曜日`}
        >
          {w}
        </div>
      ))}
    </div>
  );
}

function CalendarIcon(): ReactNode {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M19 4h-1V2h-2v2H8V2H6v2H5C3.9 4 3 4.9 3 6v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z"
        fill="currentColor"
      />
    </svg>
  );
}

function ChevronIcon({ dir }: { dir: "left" | "right" }): ReactNode {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ transform: dir === "left" ? "rotate(180deg)" : undefined }}
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* =============================================================
 * Trigger label formatter
 * ============================================================= */

function formatTriggerLabel(
  props: DatePickerProps,
  locale: string,
  formatter?: (v: unknown) => string
): string {
  if (formatter) return formatter((props as { value: unknown }).value);

  const fmtDate = (d: Date) =>
    new Intl.DateTimeFormat(locale, {
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(d);

  switch (props.variant) {
    case "day":
      return props.value ? fmtDate(props.value) : "日付を選択";
    case "week": {
      if (!props.value) return "週を選択";
      const start = props.value;
      const end = addDays(start, 4);
      return `${fmtDate(start)} - ${fmtDate(end)}`;
    }
    case "month":
      return props.value
        ? `${props.value.year}年${props.value.month + 1}月`
        : "月を選択";
    case "range": {
      const [a, b] = props.value;
      if (!a) return "期間を選択";
      if (!b) return `${fmtDate(a)} -`;
      return `${fmtDate(a)} - ${fmtDate(b)}`;
    }
    case "time":
      return props.value
        ? `${String(props.value.hour).padStart(2, "0")}:${String(
            props.value.minute
          ).padStart(2, "0")}`
        : "時刻を選択";
  }
}

/* =============================================================
 * Usage examples
 * =============================================================
 *
 * // 単日（AAR ふりかえり個別画面）
 * const [date, setDate] = useState<Date | null>(new Date());
 * <DatePicker
 *   variant="day"
 *   size="m"
 *   value={date}
 *   onChange={setDate}
 *   badgeCountFor={(d) => unreadCountByDay[d.toDateString()]}
 * />
 *
 * // 週（AAR ポータル週単位ふりかえり）
 * const [weekStart, setWeekStart] = useState<Date | null>(null);
 * <DatePicker variant="week" value={weekStart} onChange={setWeekStart} />
 *
 * // 範囲（レポート出力期間）
 * const [range, setRange] = useState<DateRange>([null, null]);
 * <DatePicker variant="range" value={range} onChange={setRange} />
 *
 * // 月（年間サマリー）
 * const [ym, setYm] = useState<{year:number; month:number} | null>(null);
 * <DatePicker variant="month" value={ym} onChange={setYm} />
 *
 * // 時刻（授業開始時刻）
 * const [time, setTime] = useState<TimeValue | null>({ hour: 9, minute: 0 });
 * <DatePicker variant="time" value={time} onChange={setTime} minuteStep={5} />
 *
 * // 小サイズ・アイコン併用（サイドパネル）
 * <DatePicker variant="day" size="s" triggerKind="text-icon" value={date} onChange={setDate} />
 *
 * ============================================================= */
