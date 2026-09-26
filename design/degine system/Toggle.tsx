import * as React from 'react';
import './toggle.css';

/**
 * まなびポケット Design System — Toggle
 *
 * 設定の即時オン/オフ切替に使用する。
 * 仕様の詳細は同ディレクトリの `toggle.md` を参照。
 *
 * ❌ 使ってはいけない場面:
 *   - 送信ボタンなど瞬間的なアクション
 *   - 「全クラス⇔自分のクラス」のような対立項目の切替（→ Tab/SegmentedControl）
 *   - リスト/グリッドの表示切替などの異なる機能切替
 */

export interface ToggleProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** ラベルテキスト（左側に表示）。省略時は aria-label を必ず指定すること */
  children?: React.ReactNode;
  /** 無効化 */
  disabled?: boolean;
}

export const Toggle = React.forwardRef<HTMLInputElement, ToggleProps>(
  function Toggle(
    {
      children,
      disabled = false,
      className,
      id,
      checked,
      defaultChecked,
      'aria-label': ariaLabel,
      ...rest
    },
    ref
  ) {
    const reactId = React.useId();
    const inputId = id ?? `mp-toggle-${reactId}`;

    if (process.env.NODE_ENV !== 'production') {
      if (!children && !ariaLabel) {
        // eslint-disable-next-line no-console
        console.warn(
          '[mp-toggle] children も aria-label もありません。スクリーンリーダー向けのラベルを必ず指定してください。'
        );
      }
    }

    const wrapperClass = [
      'mp-toggle',
      disabled && 'mp-toggle--disabled',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <label className={wrapperClass} htmlFor={inputId}>
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          role="switch"
          className="mp-toggle__input"
          disabled={disabled}
          checked={checked}
          defaultChecked={defaultChecked}
          aria-label={ariaLabel}
          {...rest}
        />
        <span className="mp-toggle__switch" aria-hidden="true">
          <span className="mp-toggle__track" />
          <span className="mp-toggle__knob" />
        </span>
        {children && <span className="mp-toggle__label">{children}</span>}
      </label>
    );
  }
);

Toggle.displayName = 'Toggle';

/* -----------------------------------------------------------------------------
 * 使用例:
 *
 * // 通知設定
 * const [notif, setNotif] = useState(true);
 * <Toggle checked={notif} onChange={(e) => setNotif(e.target.checked)}>
 *   通知を受け取る
 * </Toggle>
 *
 * // 無効化
 * <Toggle disabled>機能は管理者のみ変更可能</Toggle>
 *
 * // ラベルなし（カードのアクション位置に置く時など）
 * <Toggle aria-label="公開状態" checked={visible} onChange={...} />
 * --------------------------------------------------------------------------- */
