import * as React from 'react';
import './message.css';

/**
 * まなびポケット Design System — Message (Toast)
 *
 * ユーザー操作の結果を一時的に通知するトーストコンポーネント。
 * 仕様の詳細は同ディレクトリの `message.md` を参照。
 */

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

export type MessageType = 'info' | 'success' | 'error' | 'warning';
export type MessageSize = 'pc' | 'sp';

export interface MessageProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 通知の種別。デフォルトは 'info' */
  type?: MessageType;
  /** サイズ。デフォルトは 'pc' */
  size?: MessageSize;
  /** 自動消失までのミリ秒。0 で無効。未指定時は type で決定 */
  duration?: number;
  /** 閉じるボタンを表示するか。デフォルトは true */
  dismissible?: boolean;
  /** 閉じた時のコールバック */
  onDismiss?: () => void;
  /** メッセージテキスト（children） */
  children: React.ReactNode;
}

/* ---------------------------------------------------------------------------
 * Icon SVGs
 * --------------------------------------------------------------------------- */

const icons: Record<MessageType, React.ReactNode> = {
  info: (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"
        fill="currentColor"
      />
    </svg>
  ),
  success: (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
        fill="currentColor"
      />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"
        fill="currentColor"
      />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"
        fill="currentColor"
      />
    </svg>
  ),
};

const closeIcon = (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M18.3 5.71a1 1 0 00-1.41 0L12 10.59 7.11 5.7A1 1 0 105.7 7.11L10.59 12 5.7 16.89a1 1 0 101.41 1.41L12 13.41l4.89 4.89a1 1 0 001.41-1.41L13.41 12l4.89-4.89a1 1 0 000-1.4z"
      fill="currentColor"
    />
  </svg>
);

/* ---------------------------------------------------------------------------
 * Default durations
 * --------------------------------------------------------------------------- */

const DEFAULT_DURATION: Record<MessageType, number> = {
  info: 5000,
  success: 3000,
  error: 5000,
  warning: 5000,
};

/* ---------------------------------------------------------------------------
 * Component
 * --------------------------------------------------------------------------- */

export const Message = React.forwardRef<HTMLDivElement, MessageProps>(
  function Message(
    {
      type = 'info',
      size = 'pc',
      duration,
      dismissible = true,
      onDismiss,
      children,
      className,
      ...rest
    },
    ref,
  ) {
    const [exiting, setExiting] = React.useState(false);
    const [paused, setPaused] = React.useState(false);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const effectiveDuration = duration ?? DEFAULT_DURATION[type];

    /* --- Dev-time warnings ---------------------------------------------- */
    if (process.env.NODE_ENV !== 'production') {
      if (!children) {
        console.warn('[Message] children (メッセージテキスト) が空です');
      }
    }

    /* --- Auto-dismiss timer --------------------------------------------- */
    const startDismiss = React.useCallback(() => {
      setExiting(true);
      const animDuration = 150; // matches --mp-msg-duration-out
      setTimeout(() => onDismiss?.(), animDuration);
    }, [onDismiss]);

    React.useEffect(() => {
      if (effectiveDuration <= 0 || paused) return;

      timerRef.current = setTimeout(startDismiss, effectiveDuration);
      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }, [effectiveDuration, paused, startDismiss]);

    /* --- Pause on hover / focus ----------------------------------------- */
    const handleMouseEnter = () => setPaused(true);
    const handleMouseLeave = () => setPaused(false);
    const handleFocus = () => setPaused(true);
    const handleBlur = () => setPaused(false);

    /* --- aria role ------------------------------------------------------- */
    const isUrgent = type === 'error' || type === 'warning';

    /* --- class name ------------------------------------------------------ */
    const cls = [
      'mp-msg',
      `mp-msg--${type}`,
      size === 'sp' && 'mp-msg--sp',
      exiting && 'mp-msg--exiting',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        ref={ref}
        className={cls}
        role={isUrgent ? 'alert' : 'status'}
        aria-live={isUrgent ? 'assertive' : 'polite'}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
        {...rest}
      >
        <div className="mp-msg__body">
          <span className="mp-msg__icon">{icons[type]}</span>
          <span className="mp-msg__text">{children}</span>
        </div>

        {dismissible && (
          <button
            type="button"
            className="mp-msg__close"
            aria-label="閉じる"
            onClick={startDismiss}
          >
            {closeIcon}
          </button>
        )}
      </div>
    );
  },
);

Message.displayName = 'Message';
export default Message;

/* ---------------------------------------------------------------------------
 * 使用例
 *
 * // 1. 基本（info、5秒で自動消失）
 * <Message type="info">設定を変更しました</Message>
 *
 * // 2. 成功（3秒で自動消失）
 * <Message type="success">保存しました</Message>
 *
 * // 3. エラー（5秒、閉じるボタン付き）
 * <Message type="error" onDismiss={() => console.log('closed')}>
 *   通信エラーが発生しました
 * </Message>
 *
 * // 4. 警告
 * <Message type="warning">変更は保存されていません</Message>
 *
 * // 5. モバイルサイズ
 * <Message type="info" size="sp">通知メッセージ</Message>
 *
 * // 6. 自動消失なし
 * <Message type="error" duration={0}>手動で閉じてください</Message>
 *
 * // 7. スタッキング表示（コンテナ使用）
 * <div className="mp-msg-container">
 *   <Message type="success">カードを配布しました</Message>
 *   <Message type="info">新しいお知らせがあります</Message>
 * </div>
 * --------------------------------------------------------------------------- */
