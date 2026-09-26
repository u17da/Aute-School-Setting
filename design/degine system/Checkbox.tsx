import {
  forwardRef,
  useId,
  useEffect,
  useRef,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import './checkbox.css';

export type CheckboxSize = 'L' | 'M' | 'S' | 'SS';

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type' | 'size'> {
  /** Checked state. */
  checked?: boolean;
  /** Mixed selection (parent of partially-checked group). */
  indeterminate?: boolean;
  /** Disabled. */
  disabled?: boolean;
  /** Size. Default 'M'. */
  size?: CheckboxSize;
  /** Main label. */
  label?: ReactNode;
  /** Secondary metadata text (right of label). */
  helperLabel?: ReactNode;
  /** Optional small icon next to the label (lock, help, etc.). */
  helperIcon?: ReactNode;
  /** Identifier value (useful for forms / lists). */
  value?: string;
  /** Change handler. */
  onChange?: (checked: boolean) => void;
  /** Optional id. */
  id?: string;
  /** Extra className for wrapper. */
  className?: string;
}

const cx = (...classes: Array<string | false | undefined | null>) =>
  classes.filter(Boolean).join(' ');

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    checked = false,
    indeterminate = false,
    disabled = false,
    size = 'M',
    label,
    helperLabel,
    helperIcon,
    value,
    onChange,
    id,
    className,
    'aria-label': ariaLabel,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? `mp-checkbox-${reactId}`;
  const innerRef = useRef<HTMLInputElement | null>(null);

  // Keep the DOM `indeterminate` property in sync (it cannot be set via JSX attr)
  useEffect(() => {
    if (innerRef.current) {
      innerRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  if (process.env.NODE_ENV !== 'production') {
    if (!label && !ariaLabel) {
      console.warn('[Checkbox] Provide either `label` or `aria-label`.');
    }
    if (indeterminate && checked) {
      console.warn(
        '[Checkbox] `indeterminate` and `checked` are both true — indeterminate visually wins, but consider clarifying state.',
      );
    }
  }

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange?.(e.target.checked);
  };

  const setRef = (node: HTMLInputElement | null) => {
    innerRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  const ariaChecked: boolean | 'mixed' = indeterminate ? 'mixed' : checked;

  const wrapperClass = cx(
    'mp-checkbox',
    `mp-checkbox--${size.toLowerCase()}`,
    checked && !indeterminate && 'mp-checkbox--checked',
    indeterminate && 'mp-checkbox--indeterminate',
    disabled && 'mp-checkbox--disabled',
    className,
  );

  return (
    <label className={wrapperClass} htmlFor={inputId}>
      <span className="mp-checkbox__square">
        <input
          {...rest}
          ref={setRef}
          id={inputId}
          className="mp-checkbox__input"
          type="checkbox"
          checked={checked}
          disabled={disabled}
          value={value}
          aria-checked={ariaChecked}
          aria-disabled={disabled || undefined}
          aria-label={ariaLabel}
          onChange={handleChange}
        />
        <span className="mp-checkbox__box" aria-hidden="true">
          <span className="mp-checkbox__tick" />
          <span className="mp-checkbox__dash" />
        </span>
      </span>
      {(label || helperIcon || helperLabel) && (
        <span className="mp-checkbox__label-block">
          {label && <span>{label}</span>}
          {helperIcon && (
            <span className="mp-checkbox__helper-icon" aria-hidden="true">
              {helperIcon}
            </span>
          )}
          {helperLabel && (
            <span className="mp-checkbox__helper-label">{helperLabel}</span>
          )}
        </span>
      )}
    </label>
  );
});

Checkbox.displayName = 'Checkbox';

/* ---------- Usage examples ----------

// Basic
<Checkbox label="エンターテイメント" checked={v} onChange={setV} />

// Multiple in a list (parent + children)
<Checkbox
  label="全て選択"
  indeterminate={selected.length > 0 && selected.length < total}
  checked={selected.length === total}
  onChange={toggleAll}
/>

// CheckList-style with helper meta
<Checkbox
  size="S"
  label="あかねこドリル 3〜5ページ"
  helperLabel="1年2組"
/>

// Disabled
<Checkbox label="削除済み" disabled checked />

// SS for dense table cells
<Checkbox size="SS" label="完了" />

----------------------------------- */
