import * as React from 'react';
import './tour.css';

/**
 * まなびポケット Design System — Tour
 *
 * アプリ起動時にスライド式で特徴や使い方を段階的に伝えるコンポーネント。
 * 仕様の詳細は同ディレクトリの `tour.md` を参照。
 */

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

export type TourPlacement = 'center' | 'left' | 'right' | 'under' | 'top';

export interface TourStep {
  /** 対象要素のセレクタまたは ref。center 時は不要 */
  target?: string | React.RefObject<HTMLElement | null>;
  /** 吹き出しの配置方向 */
  placement: TourPlacement;
  /** ステップタイトル */
  title?: string;
  /** 説明テキスト */
  description: string;
  /** グラフィック枠を表示するか */
  showGraphic?: boolean;
  /** グラフィック枠内の画像URL */
  graphicSrc?: string;
}

export interface TourProps {
  /** ステップ定義の配列 */
  steps: TourStep[];
  /** ツアーの表示状態 */
  open: boolean;
  /** ツアー完了時のコールバック */
  onComplete: () => void;
  /** ツアースキップ時のコールバック（未指定時は onComplete と同じ） */
  onSkip?: () => void;
  /** ステッパーを表示するか。デフォルト true */
  showStepper?: boolean;
  /** スキップリンクを表示するか。デフォルト true */
  showSkipLink?: boolean;
  /** 初期ステップ index。デフォルト 0 */
  initialStep?: number;
}

/* ---------------------------------------------------------------------------
 * Stepper sub-component
 * --------------------------------------------------------------------------- */

export interface StepperProps {
  /** 総ステップ数 */
  total: number;
  /** 現在のアクティブ index (0-based) */
  current: number;
  /** ドットクリック時 */
  onDotClick?: (index: number) => void;
}

export const Stepper: React.FC<StepperProps> = ({ total, current, onDotClick }) => {
  const dots = Array.from({ length: total }, (_, i) => i);
  return (
    <div className="mp-tour-stepper" role="tablist" aria-label="ツアー進行状況">
      {dots.map((i) => (
        <button
          key={i}
          type="button"
          className={`mp-tour-stepper__dot${i === current ? ' mp-tour-stepper__dot--active' : ''}`}
          role="tab"
          aria-selected={i === current}
          aria-label={`ステップ ${i + 1} / ${total}`}
          onClick={() => onDotClick?.(i)}
        />
      ))}
    </div>
  );
};

/* ---------------------------------------------------------------------------
 * Positioning helper
 * --------------------------------------------------------------------------- */

function getTargetEl(target: TourStep['target']): HTMLElement | null {
  if (!target) return null;
  if (typeof target === 'string') return document.querySelector<HTMLElement>(target);
  return target.current;
}

function computePosition(
  targetEl: HTMLElement | null,
  placement: TourPlacement,
  panelWidth: number,
): React.CSSProperties {
  if (!targetEl || placement === 'center') {
    return {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
    };
  }

  const rect = targetEl.getBoundingClientRect();
  const gap = 24; // arrow height + margin

  switch (placement) {
    case 'right':
      return { position: 'fixed', top: rect.top + rect.height / 2, left: rect.left - panelWidth - gap, transform: 'translateY(-50%)' };
    case 'left':
      return { position: 'fixed', top: rect.top + rect.height / 2, left: rect.right + gap, transform: 'translateY(-50%)' };
    case 'under':
      return { position: 'fixed', top: rect.bottom + gap, left: rect.left + rect.width / 2, transform: 'translateX(-50%)' };
    case 'top':
      return { position: 'fixed', top: rect.top - gap, left: rect.left + rect.width / 2, transform: 'translate(-50%, -100%)' };
    default:
      return {};
  }
}

/* ---------------------------------------------------------------------------
 * Component
 * --------------------------------------------------------------------------- */

export const Tour: React.FC<TourProps> = ({
  steps,
  open,
  onComplete,
  onSkip,
  showStepper = true,
  showSkipLink = true,
  initialStep = 0,
}) => {
  const [current, setCurrent] = React.useState(initialStep);
  const [pos, setPos] = React.useState<React.CSSProperties>({});
  const panelRef = React.useRef<HTMLDivElement>(null);

  const step = steps[current];
  const isFirst = current === 0;
  const isLast = current === steps.length - 1;

  /* --- Dev-time warnings ---------------------------------------------- */
  if (process.env.NODE_ENV !== 'production') {
    if (steps.length === 0) {
      console.warn('[Tour] steps 配列が空です');
    }
    steps.forEach((s, i) => {
      if (s.placement !== 'center' && !s.target) {
        console.warn(`[Tour] step[${i}] placement="${s.placement}" ですが target が未指定です`);
      }
    });
  }

  /* --- Position calculation ------------------------------------------- */
  React.useEffect(() => {
    if (!open || !step) return;
    const targetEl = getTargetEl(step.target);
    const w = panelRef.current?.offsetWidth ?? 444;
    setPos(computePosition(targetEl, step.placement, w));
  }, [open, current, step]);

  /* --- Escape key ----------------------------------------------------- */
  React.useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (onSkip ?? onComplete)();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [open, onSkip, onComplete]);

  /* --- Reset on reopen ------------------------------------------------ */
  React.useEffect(() => {
    if (open) setCurrent(initialStep);
  }, [open, initialStep]);

  if (!open || !step) return null;

  const handleNext = () => {
    if (isLast) {
      onComplete();
    } else {
      setCurrent((c) => c + 1);
    }
  };
  const handlePrev = () => setCurrent((c) => Math.max(0, c - 1));

  const cls = [
    'mp-tour',
    `mp-tour--${step.placement}`,
  ].join(' ');

  return (
    <>
      {/* Spotlight overlay */}
      <div className="mp-tour-spotlight" aria-hidden="true" />

      {/* Tour panel */}
      <div
        ref={panelRef}
        className={cls}
        style={pos}
        role="dialog"
        aria-modal="false"
        aria-labelledby={step.title ? 'mp-tour-title' : undefined}
        aria-describedby="mp-tour-desc"
      >
        {/* Arrow */}
        {step.placement !== 'center' && <div className="mp-tour__arrow" />}

        {/* Title */}
        {step.title && (
          <h3 className="mp-tour__title" id="mp-tour-title">{step.title}</h3>
        )}

        {/* Graphic */}
        {step.showGraphic && (
          <div className="mp-tour__graphic">
            {step.graphicSrc && <img src={step.graphicSrc} alt="" />}
          </div>
        )}

        {/* Description */}
        <div className="mp-tour__body" id="mp-tour-desc">{step.description}</div>

        {/* Footer */}
        <div className="mp-tour__footer">
          {showStepper && (
            <Stepper total={steps.length} current={current} onDotClick={setCurrent} />
          )}
          <div className="mp-tour__buttons">
            {showSkipLink && !isLast && (
              <button
                type="button"
                className="mp-tour__skip"
                onClick={onSkip ?? onComplete}
              >
                全画面表示
              </button>
            )}
            {!isFirst && (
              <button type="button" className="mp-tour__btn mp-tour__btn--prev" onClick={handlePrev}>
                戻る
              </button>
            )}
            <button type="button" className="mp-tour__btn mp-tour__btn--next" onClick={handleNext}>
              {isLast ? '完了' : '次へ'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

Tour.displayName = 'Tour';
export default Tour;

/* ---------------------------------------------------------------------------
 * 使用例
 *
 * // 1. 基本
 * const steps = [
 *   { target: '#menu', placement: 'right' as const, title: 'メニュー', description: 'ここから各機能へ' },
 *   { target: '#cards', placement: 'under' as const, title: 'カード', description: '学習カードを管理', showGraphic: true },
 *   { placement: 'center' as const, title: '完了', description: 'ツアーは以上です' },
 * ];
 * <Tour steps={steps} open={showTour} onComplete={() => setShowTour(false)} />
 *
 * // 2. ステッパーのみ単体使用
 * <Stepper total={6} current={2} />
 *
 * // 3. スキップなし、ステッパーなし
 * <Tour steps={steps} open={true} onComplete={done} showStepper={false} showSkipLink={false} />
 * --------------------------------------------------------------------------- */
