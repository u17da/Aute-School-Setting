import React, { forwardRef, useState, useId, useRef, useEffect, useCallback, type ReactNode } from 'react';
import './Accordion.css';

/* =========================================================================
   Accordion — まなびポケット Design System
   ========================================================================= */

export type AccordionDirection = 'down' | 'right' | 'up' | 'left';

export interface AccordionProps {
  /** 展開方向 */
  direction?: AccordionDirection;
  children: ReactNode;
  className?: string;
}

export interface AccordionItemProps {
  /** 見出しテキスト */
  title: string;
  /** 初期状態で開いておく */
  defaultOpen?: boolean;
  children: ReactNode;
  /** @internal Accordion から注入 */
  _direction?: AccordionDirection;
  className?: string;
}

// ---------- Chevron SVG ----------
function ChevronIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M7.41 8.59L12 13.17L16.59 8.59L18 10L12 16L6 10L7.41 8.59Z" fill="currentColor" />
    </svg>
  );
}

// ---------- AccordionItem ----------
export const AccordionItem = forwardRef<HTMLDivElement, AccordionItemProps>(function AccordionItem(
  { title, defaultOpen = false, children, _direction = 'down', className = '' },
  ref
) {
  const [open, setOpen] = useState(defaultOpen);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const triggerId = `mp-accordion-trigger-${id}`;
  const panelId = `mp-accordion-panel-${id}`;

  // Measure panel height for animation
  const [panelHeight, setPanelHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (panelRef.current) {
      setPanelHeight(panelRef.current.scrollHeight);
    }
  }, [children, open]);

  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  return (
    <div ref={ref} className={`mp-accordion-item ${className}`}>
      <button
        id={triggerId}
        type="button"
        className={`mp-accordion-trigger mp-accordion-trigger--wide mp-accordion-trigger--${_direction}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        <span className="mp-accordion-trigger__label">{title}</span>
        <span className="mp-accordion-trigger__icon">
          <ChevronIcon />
        </span>
      </button>
      <div
        id={panelId}
        ref={panelRef}
        role="region"
        aria-labelledby={triggerId}
        className={`mp-accordion-panel ${open ? 'mp-accordion-panel--open' : 'mp-accordion-panel--closed'}`}
        style={{ maxHeight: open ? (panelHeight ?? 'none') : 0 }}
      >
        {children}
      </div>
    </div>
  );
});

// ---------- Accordion (container) ----------
export const Accordion = forwardRef<HTMLDivElement, AccordionProps>(function Accordion(
  { direction = 'down', children, className = '' },
  ref
) {
  if (process.env.NODE_ENV !== 'production') {
    if (direction === 'left' || direction === 'right') {
      // サイドパネル用途では flex-direction を変える必要あり
    }
  }

  const isHorizontal = direction === 'left' || direction === 'right';

  return (
    <div
      ref={ref}
      className={`mp-accordion ${className}`}
      style={isHorizontal ? { flexDirection: 'row' } : undefined}
    >
      {React.Children.map(children, (child) => {
        if (!React.isValidElement<AccordionItemProps>(child)) return child;
        return React.cloneElement(child, { _direction: direction });
      })}
    </div>
  );
});

// ---------- Dev ----------
if (process.env.NODE_ENV !== 'production') {
  AccordionItem.displayName = 'AccordionItem';
  Accordion.displayName = 'Accordion';
}

/* -------------------------------------------------------------------------
 * 使用例:
 *
 * import { Accordion, AccordionItem } from '@manabi-ds/Accordion';
 *
 * // 1) 基本的なFAQ
 * <Accordion>
 *   <AccordionItem title="基本設定" defaultOpen>
 *     <p>基本設定の内容...</p>
 *   </AccordionItem>
 *   <AccordionItem title="高度な設定">
 *     <p>高度な設定の内容...</p>
 *   </AccordionItem>
 * </Accordion>
 *
 * // 2) サイドメニュー
 * <Accordion direction="right">
 *   <AccordionItem title="フィルタ">
 *     <FilterPanel />
 *   </AccordionItem>
 * </Accordion>
 * ------------------------------------------------------------------------- */
