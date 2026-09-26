import * as React from 'react';
import './message-bar.css';

/**
 * まなびポケット Design System — MessageBar
 *
 * サイト全体に関わる重要告知を画面最上部に表示する全幅バー。
 * 仕様の詳細は同ディレクトリの `message-bar.md` を参照。
 */

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

export type MessageBarColor = 'alert' | 'black';

export interface MessageBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 色バリアント。デフォルトは 'black' */
  color?: MessageBarColor;
  /** 閉じるボタンを表示するか。デフォルトは true */
  dismissible?: boolean;
  /** 閉じた時のコールバック */
  onDismiss?: () => void;
  /** sticky 配置にするか。デフォルトは false */
  sticky?: boolean;
  /** メッセージテキスト */
  children: React.ReactNode;
}

/* ---------------------------------------------------------------------------
 * Close icon
 * --------------------------------------------------------------------------- */

const closeIcon = (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M18.3 5.71a1 1 0 00-1.41 0L12 10.59 7.11 5.7A1 1 0 105.7 7.11L10.59 12 5.7 16.89a1 1 0 101.41 1.41L12 13.41l4.89 4.89a1 1 0 001.41-1.41L13.41 12l4.89-4.89a1 1 0 000-1.4z"
      fill="currentColor"
    />
  </svg>
);

/* ---------------------------------------------------------------------------
 * Component
 * --------------------------------------------------------------------------- */

export const MessageBar = React.forwardRef<HTMLDivElement, MessageBarProps>(
  function MessageBar(
    {
      color = 'black',
      dismissible = true,
      onDismiss,
      sticky = false,
      children,
      className,
      ...rest
    },
    ref,
  ) {
    const [visible, setVisible] = React.useState(true);

    /* --- Dev-time warnings ---------------------------------------------- */
    if (process.env.NODE_ENV !== 'production') {
      if (!children) {
        console.warn('[MessageBar] children (メッセージテキスト) が空です');
      }
    }

    if (!visible) return null;

    const handleDismiss = () => {
      setVisible(false);
      onDismiss?.();
    };

    const cls = [
      'mp-mbar',
      `mp-mbar--${color}`,
      sticky && 'mp-mbar--sticky',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        ref={ref}
        className={cls}
        role="banner"
        aria-live="polite"
        {...rest}
      >
        <span className="mp-mbar__text">{children}</span>

        {dismissible && (
          <button
            type="button"
            className="mp-mbar__close"
            aria-label="閉じる"
            onClick={handleDismiss}
          >
            {closeIcon}
          </button>
        )}
      </div>
    );
  },
);

MessageBar.displayName = 'MessageBar';
export default MessageBar;

/* ---------------------------------------------------------------------------
 * 使用例
 *
 * // 1. 緊急告知（赤背景）
 * <MessageBar color="alert" onDismiss={() => setDismissed(true)}>
 *   メンテナンスのため、本日22時〜翌6時までサービスを停止します。
 * </MessageBar>
 *
 * // 2. 通常の重要告知（黒背景）
 * <MessageBar color="black">
 *   新学期の設定を忘れずに行ってください。
 * </MessageBar>
 *
 * // 3. sticky 配置
 * <MessageBar color="alert" sticky>
 *   システム障害が発生しています。復旧まで一部機能が制限されます。
 * </MessageBar>
 *
 * // 4. 閉じるボタンなし
 * <MessageBar color="black" dismissible={false}>
 *   お知らせ: 本日は保護者面談日です。
 * </MessageBar>
 * --------------------------------------------------------------------------- */
