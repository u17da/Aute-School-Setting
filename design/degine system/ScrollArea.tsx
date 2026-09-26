import * as React from 'react';
import './scrollbar.css';

/**
 * まなびポケット Design System — ScrollArea
 *
 * コンテンツが枠を超える場合に使うスクロール領域ラッパー。
 * ネイティブスクロールに CSS カスタムスクロールバーを適用する。
 * 仕様の詳細は同ディレクトリの `scrollbar.md` を参照。
 */

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

export type ScrollDirection = 'vertical' | 'horizontal';

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  /** スクロール方向。デフォルトは 'vertical' */
  direction?: ScrollDirection;
  /** 最大高さ（vertical 時）。CSS 値で指定 */
  maxHeight?: number | string;
  /** 最大幅（horizontal 時）。CSS 値で指定 */
  maxWidth?: number | string;
  /** スクロール領域の aria-label */
  label?: string;
  children: React.ReactNode;
}

/* ---------------------------------------------------------------------------
 * Component
 * --------------------------------------------------------------------------- */

export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  function ScrollArea(
    {
      direction = 'vertical',
      maxHeight,
      maxWidth,
      label,
      children,
      className,
      style,
      ...rest
    },
    ref,
  ) {
    /* --- Dev-time warnings ---------------------------------------------- */
    if (process.env.NODE_ENV !== 'production') {
      if (direction === 'horizontal' && !maxWidth) {
        console.warn('[ScrollArea] direction="horizontal" ですが maxWidth が未指定です');
      }
      if (direction === 'vertical' && !maxHeight) {
        console.warn('[ScrollArea] direction="vertical" ですが maxHeight が未指定です。高さ制約がないとスクロールバーが表示されません');
      }
      if (direction === 'horizontal') {
        console.warn('[ScrollArea] 水平スクロールはできるだけ避けてください（scrollbar.md 仕様ルール④）');
      }
    }

    const cls = [
      'mp-scroll',
      `mp-scroll--${direction}`,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const mergedStyle: React.CSSProperties = {
      ...style,
      ...(direction === 'vertical' && maxHeight ? { maxHeight } : {}),
      ...(direction === 'horizontal' && maxWidth ? { maxWidth } : {}),
    };

    return (
      <div
        ref={ref}
        className={cls}
        style={mergedStyle}
        role="region"
        aria-label={label}
        tabIndex={0}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

ScrollArea.displayName = 'ScrollArea';
export default ScrollArea;

/* ---------------------------------------------------------------------------
 * 使用例
 *
 * // 1. 縦スクロール（リスト）
 * <ScrollArea direction="vertical" maxHeight={400} label="生徒一覧">
 *   <StudentList />
 * </ScrollArea>
 *
 * // 2. 横スクロール（テーブル）
 * <ScrollArea direction="horizontal" maxWidth="100%" label="成績表">
 *   <WideGradeTable />
 * </ScrollArea>
 *
 * // 3. CSS ユーティリティクラスで直接適用（コンポーネント不使用）
 * <div className="mp-scrollable-y" style={{ maxHeight: 300 }}>
 *   <LongContent />
 * </div>
 *
 * // 4. モーダル内でのスクロール
 * <Modal style="default" size="lg" title="クラス一覧" open={open} onClose={close} showClose>
 *   <ScrollArea maxHeight={400} label="クラス別利用回数">
 *     <BarChart data={data} />
 *   </ScrollArea>
 * </Modal>
 * --------------------------------------------------------------------------- */
