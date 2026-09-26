import * as React from 'react';

/* ============================================================================
   Chip — まなびポケット Design System
   ステータス表示 / フィルタ / 補助アクションのトリガー用ピル
   ============================================================================ */

export type ChipSize = 'L' | 'M' | 'S';
export type ChipColor = 'primary' | 'white';
export type ChipVariant = 'filled' | 'outlined';

export interface ChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  /** ラベルテキスト（children を使う場合は省略可） */
  label?: React.ReactNode;
  /** サイズ。デフォルト L */
  size?: ChipSize;
  /** カラーテーマ */
  color?: ChipColor;
  /** スタイル */
  variant?: ChipVariant;
  /** 先頭アイコン */
  startIcon?: React.ReactNode;
  /** 末尾アイコン（×・▼・✏︎・›など） */
  endIcon?: React.ReactNode;
  /** 削除ハンドラ。指定すると末尾に独立した × ボタンが表示される */
  onDelete?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** 削除ボタンの aria-label */
  deleteAriaLabel?: string;
  /** active 状態を強制適用したい場合 */
  active?: boolean;
}

const SIZE_CLASS: Record<ChipSize, string> = {
  L: 'mp-chip--size-l',
  M: 'mp-chip--size-m',
  S: 'mp-chip--size-s',
};

const DEFAULT_DELETE_ICON = (
  <svg
    aria-hidden="true"
    width="100%"
    height="100%"
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" />
  </svg>
);

export const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  {
    label,
    children,
    size = 'L',
    color = 'primary',
    variant = 'filled',
    startIcon,
    endIcon,
    onDelete,
    deleteAriaLabel = '削除',
    active,
    disabled,
    className = '',
    onClick,
    ...rest
  },
  ref,
) {
  if (process.env.NODE_ENV !== 'production') {
    if (!label && !children) {
      // eslint-disable-next-line no-console
      console.warn('[Chip] label または children を指定してください。');
    }
    if (onDelete && endIcon) {
      // eslint-disable-next-line no-console
      console.warn(
        '[Chip] onDelete と endIcon を同時に指定すると、削除ボタンが優先されます。',
      );
    }
  }

  const classes = [
    'mp-chip',
    SIZE_CLASS[size],
    `mp-chip--${color}`,
    `mp-chip--${variant}`,
    active ? 'is-active' : '',
    disabled ? 'is-disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const handleDelete = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onDelete?.(e);
  };

  return (
    <button
      ref={ref}
      type="button"
      className={classes}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      {...rest}
    >
      {startIcon && <span className="mp-chip__icon">{startIcon}</span>}
      <span className="mp-chip__label">{label ?? children}</span>
      {onDelete ? (
        <button
          type="button"
          className="mp-chip__delete"
          aria-label={deleteAriaLabel}
          onClick={handleDelete}
          disabled={disabled}
          tabIndex={disabled ? -1 : 0}
        >
          {DEFAULT_DELETE_ICON}
        </button>
      ) : (
        endIcon && <span className="mp-chip__icon">{endIcon}</span>
      )}
    </button>
  );
});

Chip.displayName = 'Chip';

/* ----------------------------------------------------------------------------
   Chips/Attendance — 出欠表示用の別コンポーネント
   ---------------------------------------------------------------------------- */

export type AttendanceStatus = '出席' | '遅刻' | '早退' | '欠席' | 'その他';

export interface AttendanceChipProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  status: AttendanceStatus;
}

const ATTENDANCE_CLASS: Record<AttendanceStatus, string> = {
  出席: 'mp-chip-attendance--present',
  遅刻: 'mp-chip-attendance--late',
  早退: 'mp-chip-attendance--early',
  欠席: 'mp-chip-attendance--absent',
  その他: 'mp-chip-attendance--other',
};

export const AttendanceChip = React.forwardRef<
  HTMLSpanElement,
  AttendanceChipProps
>(function AttendanceChip({ status, className = '', ...rest }, ref) {
  return (
    <span
      ref={ref}
      className={`mp-chip-attendance ${ATTENDANCE_CLASS[status]} ${className}`}
      {...rest}
    >
      {status}
    </span>
  );
});

AttendanceChip.displayName = 'AttendanceChip';

/* ----------------------------------------------------------------------------
   使用例

   // 基本
   <Chip label="国語" />

   // 小サイズ・アウトライン
   <Chip size="S" variant="outlined" label="提出済み" />

   // 削除可能なフィルタチップ
   <Chip
     label="1年2組"
     onDelete={() => removeFilter('class-1-2')}
   />

   // プルダウン的に開く
   <Chip
     label="並び替え"
     endIcon={<KeyboardArrowDownIcon />}
     onClick={openMenu}
   />

   // 出欠表示
   <AttendanceChip status="出席" />
   <AttendanceChip status="遅刻" />
   ---------------------------------------------------------------------------- */
