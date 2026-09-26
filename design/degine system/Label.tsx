import * as React from 'react';

/* ============================================================================
   Label — まなびポケット Design System
   カテゴリ・ステータスを表示するだけの受動的コンポーネント
   ============================================================================ */

export type LabelSize = 'S' | 'SS';
export type LabelVariant = 'filled' | 'outlined';
export type LabelColor =
  | 'gray'
  | 'blue'
  | 'secondary'
  | 'green'
  | 'orange'
  | 'lightBlue'
  | 'notification1'
  | 'notification2';

export type LabelStatus = 'on' | 'off';

export interface LabelProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 表示テキスト */
  label?: React.ReactNode;
  /** サイズ。デフォルト S */
  size?: LabelSize;
  /** カラー。デフォルト gray */
  color?: LabelColor;
  /** スタイル。デフォルト filled */
  variant?: LabelVariant;
  /** ステータス指定時はドット付きピルになる */
  status?: LabelStatus;
  /** ステータス時のテキスト（例: "対応中"） */
  statusLabel?: React.ReactNode;
}

const SIZE_CLASS: Record<LabelSize, string> = {
  S: 'mp-label--size-s',
  SS: 'mp-label--size-ss',
};

const STATUS_SIZE_CLASS: Record<LabelSize, string> = {
  S: 'mp-label-status--size-s',
  SS: 'mp-label-status--size-ss',
};

/** ColorをCSSクラス側のkebab系に変換 */
const colorToClass = (c: LabelColor): string => {
  switch (c) {
    case 'lightBlue':
      return 'mp-label--lightblue';
    default:
      return `mp-label--${c}`;
  }
};

/** 不正な組み合わせを開発時のみ警告 */
function warnInvalidCombination(
  color: LabelColor,
  variant: LabelVariant,
): void {
  if (process.env.NODE_ENV === 'production') return;

  // notification 系と lightBlue は filled のみ
  const filledOnly: LabelColor[] = [
    'lightBlue',
    'notification1',
    'notification2',
  ];
  if (filledOnly.includes(color) && variant === 'outlined') {
    // eslint-disable-next-line no-console
    console.warn(
      `[Label] color="${color}" は filled のみサポートしています。outlined は無効です。`,
    );
  }
}

export const Label = React.forwardRef<HTMLSpanElement, LabelProps>(function Label(
  {
    label,
    children,
    size = 'S',
    color = 'gray',
    variant = 'filled',
    status,
    statusLabel,
    className = '',
    ...rest
  },
  ref,
) {
  // Status バリアント
  if (status) {
    if (process.env.NODE_ENV !== 'production' && !statusLabel && !label && !children) {
      // eslint-disable-next-line no-console
      console.warn('[Label] status 指定時は statusLabel を指定してください。');
    }
    const classes = [
      'mp-label-status',
      STATUS_SIZE_CLASS[size],
      `mp-label-status--${status}`,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <span ref={ref} className={classes} {...rest}>
        <span className="mp-label-status__dot" aria-hidden="true" />
        <span>{statusLabel ?? label ?? children}</span>
      </span>
    );
  }

  // 通常の Label
  warnInvalidCombination(color, variant);

  if (process.env.NODE_ENV !== 'production' && !label && !children) {
    // eslint-disable-next-line no-console
    console.warn('[Label] label または children を指定してください。');
  }

  const classes = [
    'mp-label',
    SIZE_CLASS[size],
    colorToClass(color),
    `mp-label--${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span ref={ref} className={classes} {...rest}>
      {label ?? children}
    </span>
  );
});

Label.displayName = 'Label';

/* ----------------------------------------------------------------------------
   使用例

   // 基本（デフォルト: S / gray / filled）
   <Label label="国語" />

   // SSサイズ・blue・outlined
   <Label size="SS" color="blue" variant="outlined" label="未提出" />

   // 1色のみで運用したい場合は lightBlue 推奨
   <Label color="lightBlue" label="お知らせ" />

   // 重要表示（赤・filled 固定）
   <Label color="notification1" label="重要" />

   // 要返信（薄ピンク・filled 固定）
   <Label color="notification2" label="要返信" />

   // ステータス（ドット付き）
   <Label status="on" statusLabel="対応中" />
   <Label status="off" statusLabel="対応終了" size="SS" />
   ---------------------------------------------------------------------------- */
