import * as React from 'react';
import './radio.css';

/**
 * まなびポケット Design System — Radio
 *
 * 複数の選択肢から1つだけ選ばせる場面で使用する。
 * 仕様の詳細は同ディレクトリの `radio.md` を参照。
 *
 * 使い方:
 *   - 必ず <RadioGroup> でラップする（name 共有とアクセシビリティのため）
 *   - グループには label を必ず付ける
 */

export type RadioSize = 'l' | 'm' | 's';
export type RadioLabelPlacement = 'end' | 'start' | 'top' | 'bottom';

/* =============================================================================
 * RadioGroup Context
 * ============================================================================= */

interface RadioGroupContextValue {
  name: string;
  value?: string;
  onChange?: (value: string) => void;
  size: RadioSize;
  labelPlacement: RadioLabelPlacement;
  disabled?: boolean;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null);

/* =============================================================================
 * RadioGroup
 * ============================================================================= */

export interface RadioGroupProps {
  /** input の name 属性（必須） */
  name: string;
  /** グループのラベル。省略時は aria-label を必須で指定 */
  label?: React.ReactNode;
  /** 制御モード: 選択中の value */
  value?: string;
  /** 選択値が変わった時 */
  onChange?: (value: string) => void;
  /** デフォルト値（非制御モード） */
  defaultValue?: string;
  /** サイズ */
  size?: RadioSize;
  /** ラベル位置 */
  labelPlacement?: RadioLabelPlacement;
  /** 横並び/縦並び */
  orientation?: 'horizontal' | 'vertical';
  /** 全体無効化 */
  disabled?: boolean;
  /** ラベル省略時のアクセシブル名 */
  'aria-label'?: string;
  className?: string;
  children: React.ReactNode;
}

export const RadioGroup: React.FC<RadioGroupProps> = ({
  name,
  label,
  value,
  onChange,
  defaultValue,
  size = 'm',
  labelPlacement = 'end',
  orientation = 'horizontal',
  disabled,
  'aria-label': ariaLabel,
  className,
  children,
}) => {
  const [internalValue, setInternalValue] = React.useState<string | undefined>(defaultValue);
  const isControlled = value !== undefined;
  const currentValue = isControlled ? value : internalValue;

  const handleChange = React.useCallback(
    (next: string) => {
      if (!isControlled) setInternalValue(next);
      onChange?.(next);
    },
    [isControlled, onChange]
  );

  if (process.env.NODE_ENV !== 'production') {
    if (!label && !ariaLabel) {
      // eslint-disable-next-line no-console
      console.warn('[mp-radio-group] label も aria-label も無し。グループの目的を伝えるラベルを必ず指定してください。');
    }
  }

  const groupClass = [
    'mp-radio-group',
    orientation === 'vertical' && 'mp-radio-group--vertical',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <RadioGroupContext.Provider
      value={{ name, value: currentValue, onChange: handleChange, size, labelPlacement, disabled }}
    >
      <fieldset className={groupClass} aria-label={ariaLabel}>
        {label && <legend className="mp-radio-group__legend">{label}</legend>}
        {children}
      </fieldset>
    </RadioGroupContext.Provider>
  );
};

/* =============================================================================
 * Radio
 * ============================================================================= */

export interface RadioProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'onChange'> {
  /** この選択肢の値 */
  value: string;
  /** ラベル */
  children: React.ReactNode;
  /** サイズ（GroupContextで設定されている場合は不要） */
  size?: RadioSize;
  /** ラベル位置（GroupContextで設定されている場合は不要） */
  labelPlacement?: RadioLabelPlacement;
}

export const Radio = React.forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { value, children, size: sizeProp, labelPlacement: placementProp, disabled: disabledProp, className, id, ...rest },
  ref
) {
  const ctx = React.useContext(RadioGroupContext);
  const reactId = React.useId();
  const inputId = id ?? `mp-radio-${reactId}`;

  if (process.env.NODE_ENV !== 'production' && !ctx) {
    // eslint-disable-next-line no-console
    console.warn('[mp-radio] <Radio> は <RadioGroup> でラップしてください。単独使用は推奨されません。');
  }

  const size = sizeProp ?? ctx?.size ?? 'm';
  const labelPlacement = placementProp ?? ctx?.labelPlacement ?? 'end';
  const disabled = disabledProp ?? ctx?.disabled ?? false;
  const checked = ctx ? ctx.value === value : undefined;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) ctx?.onChange?.(value);
  };

  const wrapperClass = [
    'mp-radio',
    `mp-radio--${size}`,
    labelPlacement !== 'end' && `mp-radio--placement-${labelPlacement}`,
    disabled && 'mp-radio--disabled',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <label className={wrapperClass} htmlFor={inputId}>
      <span className="mp-radio__visual">
        <input
          ref={ref}
          id={inputId}
          type="radio"
          className="mp-radio__input"
          name={ctx?.name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={handleChange}
          {...rest}
        />
        <span className="mp-radio__circle" aria-hidden="true" />
      </span>
      <span className="mp-radio__label">{children}</span>
    </label>
  );
});

Radio.displayName = 'Radio';

/* -----------------------------------------------------------------------------
 * 使用例:
 *
 * const [grade, setGrade] = useState('1');
 *
 * <RadioGroup name="grade" label="学年" value={grade} onChange={setGrade}>
 *   <Radio value="1">1年生</Radio>
 *   <Radio value="2">2年生</Radio>
 *   <Radio value="3">3年生</Radio>
 * </RadioGroup>
 *
 * // 縦並び・大サイズ
 * <RadioGroup name="layout" orientation="vertical" size="l">
 *   <Radio value="list">リスト表示</Radio>
 *   <Radio value="grid">グリッド表示</Radio>
 * </RadioGroup>
 * --------------------------------------------------------------------------- */
