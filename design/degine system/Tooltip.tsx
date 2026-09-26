import React, { forwardRef, useState, useId, useRef, useCallback, type ReactNode } from 'react';
import './Tooltip.css';

/* =========================================================================
   Tooltip — まなびポケット Design System
   ========================================================================= */

export type TooltipDirection = 'up' | 'down' | 'left' | 'right' | 'none';
export type TooltipPosition = 'center' | 'left' | 'right';

export interface TooltipProps {
  /** Tooltip のテキスト内容 */
  content: string;
  /** 表示方向 */
  direction?: TooltipDirection;
  /** 矢印の位置（up/down のみ有効） */
  position?: TooltipPosition;
  /** トリガーとなる子要素 */
  children: ReactNode;
  /** 表示ディレイ (ms) */
  enterDelay?: number;
  /** 非表示ディレイ (ms) */
  leaveDelay?: number;
  className?: string;
}

export const Tooltip = forwardRef<HTMLDivElement, TooltipProps>(function Tooltip(
  {
    content,
    direction = 'up',
    position = 'center',
    children,
    enterDelay = 200,
    leaveDelay = 100,
    className = '',
  },
  ref
) {
  const [visible, setVisible] = useState(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout>>();
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const id = useId();
  const tooltipId = `mp-tooltip-${id}`;

  const show = useCallback(() => {
    clearTimeout(leaveTimer.current);
    enterTimer.current = setTimeout(() => setVisible(true), enterDelay);
  }, [enterDelay]);

  const hide = useCallback(() => {
    clearTimeout(enterTimer.current);
    leaveTimer.current = setTimeout(() => setVisible(false), leaveDelay);
  }, [leaveDelay]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setVisible(false);
  }, []);

  // Direction class mapping
  const directionCls =
    direction === 'right' ? 'mp-tooltip--right-dir' :
    direction === 'left' ? 'mp-tooltip--left-dir' :
    `mp-tooltip--${direction}`;

  const positionCls = (direction === 'up' || direction === 'down') ? `mp-tooltip--${position}` : '';
  const visibilityCls = visible ? 'mp-tooltip--visible' : 'mp-tooltip--hidden';

  const tooltipCls = [
    'mp-tooltip',
    directionCls,
    positionCls,
    visibilityCls,
    className,
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={ref}
      className="mp-tooltip-wrapper"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={handleKeyDown}
    >
      {React.Children.map(children, (child) => {
        if (React.isValidElement(child)) {
          return React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
            'aria-describedby': tooltipId,
          });
        }
        return child;
      })}
      <div id={tooltipId} role="tooltip" className={tooltipCls}>
        {direction !== 'none' && <span className="mp-tooltip__arrow" />}
        <span className="mp-tooltip__content">{content}</span>
      </div>
    </div>
  );
});

if (process.env.NODE_ENV !== 'production') {
  Tooltip.displayName = 'Tooltip';
}

/* -------------------------------------------------------------------------
 * 使用例:
 *
 * import { Tooltip } from '@manabi-ds/Tooltip';
 *
 * // 1) ヘルプアイコンの補足
 * <Tooltip content="パスワードは8文字以上です" direction="up">
 *   <HelpIcon />
 * </Tooltip>
 *
 * // 2) アイコンの説明
 * <Tooltip content="設定" direction="down" position="center">
 *   <SettingsIcon />
 * </Tooltip>
 *
 * // 3) 左向き
 * <Tooltip content="閉じる" direction="left">
 *   <CloseIcon />
 * </Tooltip>
 *
 * // 4) 矢印なし
 * <Tooltip content="ヒント" direction="none">
 *   <InfoIcon />
 * </Tooltip>
 * ------------------------------------------------------------------------- */
