import * as React from 'react';
import './divider.css';

/**
 * まなびポケット Design System — Divider
 *
 * セクション間の視覚的区切り。Accordion モードでは折りたたみ機能付き。
 * 仕様の詳細は同ディレクトリの `divider.md` を参照。
 */

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

export type DividerDirection = 'horizontal' | 'vertical';

export interface DividerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 方向。デフォルトは 'horizontal' */
  direction?: DividerDirection;
  /** 線の色。CSS カラー値。デフォルトは #E9EBEC */
  color?: string;
  /** Accordion モードを有効にする */
  accordion?: boolean;
  /** Accordion ラベルテキスト */
  label?: string;
  /** Accordion のアウトラインあり/なし。デフォルト true */
  outline?: boolean;
  /** Accordion の初期状態。デフォルト false（閉じた状態） */
  defaultOpen?: boolean;
  /** 制御モード: 外部から開閉を制御する場合 */
  open?: boolean;
  /** 開閉変更時のコールバック */
  onOpenChange?: (open: boolean) => void;
  /** Accordion の中身 */
  children?: React.ReactNode;
}

/* ---------------------------------------------------------------------------
 * Chevron icon
 * --------------------------------------------------------------------------- */

const chevronDown = (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" fill="currentColor" />
  </svg>
);

/* ---------------------------------------------------------------------------
 * Component
 * --------------------------------------------------------------------------- */

export const Divider = React.forwardRef<HTMLDivElement, DividerProps>(
  function Divider(
    {
      direction = 'horizontal',
      color,
      accordion = false,
      label,
      outline = true,
      defaultOpen = false,
      open: controlledOpen,
      onOpenChange,
      children,
      className,
      style,
      ...rest
    },
    ref,
  ) {
    const isControlled = controlledOpen !== undefined;
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
    const isOpen = isControlled ? controlledOpen : internalOpen;
    const contentId = React.useId();

    /* --- Dev-time warnings ---------------------------------------------- */
    if (process.env.NODE_ENV !== 'production') {
      if (accordion && !label) {
        console.warn('[Divider] accordion=true ですが label が未指定です。ラベルを付けてください');
      }
      if (accordion && !children) {
        console.warn('[Divider] accordion=true ですが children（折りたたみ内容）がありません');
      }
      if (accordion && direction === 'vertical') {
        console.warn('[Divider] accordion + vertical の組み合わせはサポートされていません');
      }
    }

    const toggle = () => {
      const next = !isOpen;
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    };

    /* --- Style override ------------------------------------------------- */
    const mergedStyle: React.CSSProperties = {
      ...style,
      ...(color ? { '--mp-divider-color': color } as React.CSSProperties : {}),
    };

    /* --- Simple divider (no accordion) ---------------------------------- */
    if (!accordion) {
      const cls = [
        'mp-divider',
        `mp-divider--${direction}`,
        className,
      ]
        .filter(Boolean)
        .join(' ');

      return (
        <div
          ref={ref}
          className={cls}
          style={mergedStyle}
          role="separator"
          aria-orientation={direction}
          {...rest}
        >
          <div className="mp-divider__line" />
        </div>
      );
    }

    /* --- Accordion divider ---------------------------------------------- */
    const cls = [
      'mp-divider',
      'mp-divider--horizontal',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const chipCls = [
      'mp-divider__chip',
      !outline && 'mp-divider__chip--plain',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div ref={ref} className={cls} style={mergedStyle} {...rest}>
        <div className="mp-divider__line" />

        <button
          type="button"
          className={chipCls}
          aria-expanded={isOpen}
          aria-controls={contentId}
          onClick={toggle}
        >
          <span className="mp-divider__chip-label">{label}</span>
          <span className="mp-divider__chevron">{chevronDown}</span>
        </button>

        <div className="mp-divider__line" />

        {/* Collapsible content */}
        <div
          id={contentId}
          className="mp-divider__content"
          data-state={isOpen ? 'open' : 'closed'}
          role="region"
          aria-labelledby={undefined}
        >
          {children}
        </div>
      </div>
    );
  },
);

Divider.displayName = 'Divider';
export default Divider;

/* ---------------------------------------------------------------------------
 * 使用例
 *
 * // 1. シンプル横線
 * <Divider />
 *
 * // 2. 縦線（並列レイアウト内）
 * <div style={{ display: 'flex', gap: 32 }}>
 *   <ScoreA />
 *   <Divider direction="vertical" />
 *   <ScoreB />
 * </div>
 *
 * // 3. Accordion
 * <Divider accordion label="詳細を表示" defaultOpen={false}>
 *   <DetailSection />
 * </Divider>
 *
 * // 4. Accordion（アウトラインなし）
 * <Divider accordion label="もっと見る" outline={false}>
 *   <MoreContent />
 * </Divider>
 *
 * // 5. カラー変更
 * <Divider color="#DDE0E2" />
 *
 * // 6. 制御モード
 * <Divider accordion label="設定" open={isExpanded} onOpenChange={setIsExpanded}>
 *   <SettingsForm />
 * </Divider>
 * --------------------------------------------------------------------------- */
