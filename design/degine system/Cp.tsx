import * as React from 'react';
import './cp.css';

/**
 * まなびポケット Design System — CP (Content Provider)
 *
 * コンテンツプロバイダのアイコン・カード・選択肢コンポーネント。
 * 仕様の詳細は同ディレクトリの `cp.md` を参照。
 */

/* ---------------------------------------------------------------------------
 * Shared icons
 * --------------------------------------------------------------------------- */

const closeIconSvg = (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M18.3 5.71a1 1 0 00-1.41 0L12 10.59 7.11 5.7A1 1 0 105.7 7.11L10.59 12 5.7 16.89a1 1 0 101.41 1.41L12 13.41l4.89 4.89a1 1 0 001.41-1.41L13.41 12l4.89-4.89a1 1 0 000-1.4z" fill="currentColor" />
  </svg>
);

const checkCircleSvg = (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="currentColor" />
  </svg>
);

/* ===========================================================================
 * CpIcon — Size S / M
 * =========================================================================== */

export type CpIconSize = 's' | 'm';

export interface CpIconProps extends React.HTMLAttributes<HTMLDivElement> {
  /** CP ロゴ画像の URL */
  src: string;
  /** CP 名称（alt に使用） */
  name: string;
  /** サイズ。デフォルトは 's' */
  size?: CpIconSize;
  /** 削除コールバック（M サイズで close badge 表示） */
  onRemove?: () => void;
}

export const CpIcon = React.forwardRef<HTMLDivElement, CpIconProps>(
  function CpIcon({ src, name, size = 's', onRemove, className, ...rest }, ref) {
    /* Dev warnings */
    if (process.env.NODE_ENV !== 'production') {
      if (size === 's' && onRemove) {
        console.warn('[CpIcon] size="s" では onRemove（close badge）は表示されません。size="m" を使ってください');
      }
    }

    const cls = ['mp-cp-icon', `mp-cp-icon--${size}`, className].filter(Boolean).join(' ');

    return (
      <div ref={ref} className={cls} {...rest}>
        <img className="mp-cp-icon__img" src={src} alt={name} />
        {size === 'm' && onRemove && (
          <button
            type="button"
            className="mp-cp-close"
            aria-label={`${name}を削除`}
            onClick={onRemove}
          >
            {closeIconSvg}
          </button>
        )}
      </div>
    );
  },
);

CpIcon.displayName = 'CpIcon';

/* ===========================================================================
 * CpCard — Size L (icon + label + description + close)
 * =========================================================================== */

export interface CpCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** CP ロゴ画像の URL */
  src: string;
  /** CP 名称 */
  name: string;
  /** 上段ラベル（会社名等） */
  label?: string;
  /** 説明テキスト */
  description?: string;
  /** 削除コールバック */
  onRemove?: () => void;
}

export const CpCard = React.forwardRef<HTMLDivElement, CpCardProps>(
  function CpCard({ src, name, label, description, onRemove, className, ...rest }, ref) {
    const cls = ['mp-cp-card', className].filter(Boolean).join(' ');

    return (
      <div ref={ref} className={cls} {...rest}>
        <div className="mp-cp-card__icon">
          <img src={src} alt={name} />
        </div>
        <div className="mp-cp-card__info">
          {label && <span className="mp-cp-card__label">{label}</span>}
          {description && <span className="mp-cp-card__desc">{description}</span>}
        </div>
        {onRemove && (
          <button
            type="button"
            className="mp-cp-close"
            aria-label={`${name}を削除`}
            onClick={onRemove}
          >
            {closeIconSvg}
          </button>
        )}
      </div>
    );
  },
);

CpCard.displayName = 'CpCard';

/* ===========================================================================
 * CpSuggest — Dropdown option (default / selected)
 * =========================================================================== */

export interface CpSuggestProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onClick'> {
  /** CP ロゴ画像の URL */
  src: string;
  /** 上段ラベル（会社名等） */
  label: string;
  /** 説明テキスト */
  description?: string;
  /** ステータステキスト（例: "選択中"） */
  status?: string;
  /** 選択済みか */
  selected?: boolean;
  /** クリック時コールバック */
  onClick?: (e: React.MouseEvent) => void;
}

export const CpSuggest = React.forwardRef<HTMLDivElement, CpSuggestProps>(
  function CpSuggest(
    { src, label, description, status, selected = false, onClick, className, ...rest },
    ref,
  ) {
    const cls = [
      'mp-cp-suggest',
      selected && 'mp-cp-suggest--selected',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        ref={ref}
        className={cls}
        role="option"
        aria-selected={selected}
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick?.(e as unknown as React.MouseEvent);
          }
        }}
        {...rest}
      >
        <div className="mp-cp-suggest__icon">
          <img src={src} alt={label} />
        </div>
        <div className="mp-cp-suggest__info">
          <span className="mp-cp-suggest__label">{label}</span>
          {description && <span className="mp-cp-suggest__desc">{description}</span>}
          {status && (
            <span className="mp-cp-suggest__status">
              {selected && (
                <span className="mp-cp-suggest__check">{checkCircleSvg}</span>
              )}
              {status}
            </span>
          )}
        </div>
      </div>
    );
  },
);

CpSuggest.displayName = 'CpSuggest';

export default { CpIcon, CpCard, CpSuggest };

/* ---------------------------------------------------------------------------
 * 使用例
 *
 * // 1. インラインアイコン（小）
 * <CpIcon src="/logos/schooltakt.png" name="スクールタクト" size="s" />
 *
 * // 2. 削除可能なアイコン（中）
 * <CpIcon src="/logos/schooltakt.png" name="スクールタクト" size="m"
 *   onRemove={() => removeCp('schooltakt')} />
 *
 * // 3. カード表示
 * <CpCard
 *   src="/logos/schooltakt.png"
 *   name="スクールタクト"
 *   label="株式会社コードタクト"
 *   description="協働学習支援ツール"
 *   onRemove={() => removeCp('schooltakt')}
 * />
 *
 * // 4. ドロップダウン選択肢
 * <div role="listbox" aria-label="コンテンツプロバイダを選択">
 *   <CpSuggest
 *     src="/logos/schooltakt.png"
 *     label="株式会社コードタクト"
 *     description="スクールタクト"
 *     status="選択中"
 *     selected={true}
 *     onClick={() => select('schooltakt')}
 *   />
 *   <CpSuggest
 *     src="/logos/mirai.png"
 *     label="ベネッセコーポレーション"
 *     description="ミライシード"
 *     selected={false}
 *     onClick={() => select('mirai')}
 *   />
 * </div>
 * --------------------------------------------------------------------------- */
