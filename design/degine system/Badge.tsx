import React, { forwardRef, type ReactNode } from 'react';
import './Badge.css';

/* =========================================================================
   Badge — まなびポケット Design System
   ========================================================================= */

export type BadgeType = 'dot' | 'count';
export type BadgeColor = 'primary' | 'secondary';
export type BadgeSize = 'small' | 'medium';

export interface BadgeProps {
  /** dot = 件数なし通知点、count = 件数表示 */
  type?: BadgeType;
  /** 件数（type="count" 時のみ有効）。100以上は自動で "99+" 表示 */
  count?: number;
  /** primary(赤) or secondary(グレーボーダー) */
  color?: BadgeColor;
  /** small or medium（type="count" 時のみ有効） */
  size?: BadgeSize;
  /** false にすると非表示（アニメーション付き） */
  visible?: boolean;
  /** 親要素に対して右上に絶対配置する */
  positioned?: boolean;
  /** スクリーンリーダー向けラベル（例: "3件の未読"） */
  srLabel?: string;
  className?: string;
}

const MAX_COUNT = 99;

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  {
    type = 'dot',
    count = 0,
    color = 'primary',
    size = 'small',
    visible = true,
    positioned = true,
    srLabel,
    className = '',
  },
  ref
) {
  // Dev warnings
  if (process.env.NODE_ENV !== 'production') {
    if (type === 'dot' && count > 0) {
      console.warn('[Badge] type="dot" には count は不要です。件数を表示するなら type="count" を使ってください。');
    }
    if (type === 'dot' && color === 'secondary') {
      console.warn('[Badge] type="dot" に color="secondary" は未定義の組み合わせです。dot は常に primary です。');
    }
  }

  const isDot = type === 'dot';
  const isHidden = !visible || (!isDot && count === 0);

  const displayText = isDot ? '' : count > MAX_COUNT ? '99+' : String(count);

  const cls = [
    'mp-badge',
    `mp-badge--${type}`,
    `mp-badge--${color}`,
    !isDot && `mp-badge--${size}`,
    positioned && 'mp-badge--positioned',
    isHidden && 'mp-badge--hidden',
    className,
  ].filter(Boolean).join(' ');

  return (
    <>
      <span ref={ref} className={cls} aria-hidden="true">
        {!isDot && displayText}
      </span>
      {srLabel && <span className="mp-badge-sr-only">{srLabel}</span>}
    </>
  );
});

// ---------- Dev ----------
if (process.env.NODE_ENV !== 'production') {
  Badge.displayName = 'Badge';
}

/* -------------------------------------------------------------------------
 * 使用例:
 *
 * import { Badge } from '@manabi-ds/Badge';
 *
 * // 1) アイコン右上にドット
 * <div style={{ position: 'relative', display: 'inline-flex' }}>
 *   <BellIcon />
 *   <Badge type="dot" srLabel="未読あり" />
 * </div>
 *
 * // 2) 件数バッジ (small)
 * <div style={{ position: 'relative', display: 'inline-flex' }}>
 *   <FolderIcon />
 *   <Badge type="count" count={3} size="small" srLabel="3件" />
 * </div>
 *
 * // 3) 件数バッジ (medium, secondary)
 * <Badge type="count" count={5} size="medium" color="secondary" positioned={false} />
 *
 * // 4) 99+ 表示
 * <Badge type="count" count={150} size="medium" srLabel="99件以上" />
 *
 * // 5) 非表示 (アニメーション付きで消える)
 * <Badge type="count" count={0} visible={false} />
 * ------------------------------------------------------------------------- */
