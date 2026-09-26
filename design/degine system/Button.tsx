import * as React from 'react';
import './button.css';

/**
 * まなびポケット Design System — Button
 *
 * 仕様の詳細は同ディレクトリの `button.md` を参照。
 * 新しい variant / size / color を増やす時は md を先に更新すること。
 */

export type ButtonVariant = 'solid' | 'outline' | 'text';
export type ButtonSize = 'l' | 'm' | 's' | 'ss';
export type ButtonColor = 'primary' | 'negative' | 'alert' | 'tertiary';

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  /** 見た目のタイプ。デフォルトは 'solid' */
  variant?: ButtonVariant;
  /** サイズ。デフォルトは 'm' */
  size?: ButtonSize;
  /** 色。デフォルトは 'primary' */
  color?: ButtonColor;
  /** ラベル前のアイコン（ReactNode） */
  iconLeft?: React.ReactNode;
  /** ラベル後のアイコン（ReactNode） */
  iconRight?: React.ReactNode;
  /** ローディング中。trueの間はクリック不可 */
  loading?: boolean;
  /** ボタン全幅にしたい時 */
  fullWidth?: boolean;
}

function classNames(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(' ');
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    const {
      variant = 'solid',
      size = 'm',
      color = 'primary',
      iconLeft,
      iconRight,
      loading = false,
      fullWidth = false,
      disabled,
      type = 'button',
      className,
      style,
      children,
      ...rest
    } = props;

    // 開発時のガード：text variant に negative は仕様上未定義
    if (
      process.env.NODE_ENV !== 'production' &&
      variant === 'text' &&
      color === 'negative'
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        '[Button] variant="text" × color="negative" は DS で未定義です。' +
          'tertiary か primary を検討してください。',
      );
    }

    const cls = classNames(
      'mp-btn',
      `mp-btn--${variant}`,
      `mp-btn--${size}`,
      `mp-btn--${color}`,
      className,
    );

    const mergedStyle: React.CSSProperties | undefined = fullWidth
      ? { ...style, width: '100%' }
      : style;

    return (
      <button
        ref={ref}
        type={type}
        className={cls}
        style={mergedStyle}
        disabled={disabled || loading}
        aria-disabled={disabled || loading || undefined}
        data-loading={loading || undefined}
        {...rest}
      >
        {iconLeft && <span className="mp-btn__icon" aria-hidden>{iconLeft}</span>}
        {children}
        {iconRight && <span className="mp-btn__icon" aria-hidden>{iconRight}</span>}
      </button>
    );
  },
);

/* -----------------------------------------------------------------------------
 * 使用例（コメントとして残す。バイブコーディング時の参考になる）
 * ---------------------------------------------------------------------------
 *
 * // 1. 主要アクション
 * <Button onClick={handleSave}>保存する</Button>
 *
 * // 2. モーダルのフッター（左にネガティブ、右にプライマリ）
 * <div style={{ display: 'flex', gap: 16, justifyContent: 'flex-end' }}>
 *   <Button color="negative" onClick={onClose}>キャンセル</Button>
 *   <Button color="primary" onClick={onSubmit}>送信する</Button>
 * </div>
 *
 * // 3. 危険操作
 * <Button color="alert" onClick={onDelete}>削除する</Button>
 *
 * // 4. 補助操作（並列の選択肢）
 * <Button variant="outline" color="primary">プレビュー</Button>
 *
 * // 5. テキストボタン
 * <Button variant="text" iconRight={<ChevronRightIcon />}>
 *   全画面表示
 * </Button>
 *
 * // 6. ローディング
 * <Button loading={isSaving}>保存する</Button>
 *
 * // 7. 全幅
 * <Button size="l" fullWidth>新規登録する</Button>
 * --------------------------------------------------------------------------- */
