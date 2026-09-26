/* ==========================================================
   ProgressBar — まなびポケット Design System
   React component with forwardRef, full typing, a11y
   ========================================================== */

import React, { forwardRef } from 'react';
import './progressbar.css';

// ---------- Types ----------

export type ProgressBarVariant = 'determinate' | 'indeterminate';
export type ProgressBarSize = 'md' | 'sm';

export interface ProgressBarProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'role'> {
  /** 0–100. Ignored when variant is indeterminate. */
  value?: number;
  /** Display mode. @default 'determinate' */
  variant?: ProgressBarVariant;
  /** @default 'md' */
  size?: ProgressBarSize;
  /** Show percentage text label. @default true */
  showLabel?: boolean;
  /** Accessible name describing what this progress represents */
  'aria-label'?: string;
}

// ---------- Dev warnings ----------

function devWarn(condition: boolean, message: string) {
  if (
    condition &&
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV !== 'production'
  ) {
    console.warn(`[mp-progressbar] ${message}`);
  }
}

// ---------- Helpers ----------

function clampValue(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function formatLabel(value: number): string {
  return `${Math.round(value)}%`;
}

// ---------- Component ----------

export const ProgressBar = forwardRef<HTMLDivElement, ProgressBarProps>(
  function ProgressBar(
    {
      value = 0,
      variant = 'determinate',
      size = 'md',
      showLabel = true,
      className,
      'aria-label': ariaLabel,
      ...rest
    },
    ref,
  ) {
    const isDeterminate = variant === 'determinate';
    const clamped = clampValue(value);

    // Dev warnings
    devWarn(
      isDeterminate && (value < 0 || value > 100),
      `value=${value} is out of range. It will be clamped to 0–100.`,
    );
    devWarn(
      !isDeterminate && value !== 0 && value !== undefined,
      'value is ignored when variant is "indeterminate".',
    );
    devWarn(!ariaLabel, 'Provide aria-label to describe the progress context.');

    const classNames = [
      'mp-progressbar',
      `mp-progressbar--${size}`,
      !isDeterminate ? 'mp-progressbar--indeterminate' : '',
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ');

    // ARIA attributes
    const ariaProps: React.AriaAttributes & { role: string } = {
      role: 'progressbar',
      'aria-label': ariaLabel,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
    };

    if (isDeterminate) {
      ariaProps['aria-valuenow'] = clamped;
    } else {
      ariaProps['aria-busy'] = true;
    }

    return (
      <div ref={ref} className={classNames} {...ariaProps} {...rest}>
        <div className="mp-progressbar__track">
          <div
            className="mp-progressbar__fill"
            style={isDeterminate ? { width: `${clamped}%` } : undefined}
          />
        </div>
        {showLabel && isDeterminate && (
          <span className="mp-progressbar__label" aria-hidden="true">
            {formatLabel(clamped)}
          </span>
        )}
      </div>
    );
  },
);

/* ==========================================================
   Usage Example
   ==========================================================

   import { ProgressBar } from './ProgressBar';

   function LessonProgress() {
     const [progress, setProgress] = useState(0);

     useEffect(() => {
       const timer = setInterval(() => {
         setProgress((prev) => (prev >= 100 ? 100 : prev + 10));
       }, 1000);
       return () => clearInterval(timer);
     }, []);

     return (
       <div style={{ width: 400 }}>
         <ProgressBar
           value={progress}
           size="md"
           aria-label="授業の進捗"
         />

         <ProgressBar
           value={75}
           size="sm"
           aria-label="ドリル完了率"
         />

         <ProgressBar
           variant="indeterminate"
           aria-label="読み込み中"
         />
       </div>
     );
   }

   ========================================================== */
