import React, { forwardRef, useId, useCallback, useRef, type ReactNode, type KeyboardEvent } from 'react';
import './Tab.css';

/* =========================================================================
   Tab — まなびポケット Design System
   ========================================================================= */

// ---------- Types ----------
export type TabVariant = 'primary' | 'secondary';

export interface TabProps {
  /** タブの値（Tabs の value と一致させる） */
  value: string;
  /** ラベルテキスト */
  children: ReactNode;
  /** 左アイコン（任意） */
  icon?: ReactNode;
  /** 無効化 */
  disabled?: boolean;
  /** @internal Tabs から注入 */
  _selected?: boolean;
  /** @internal Tabs から注入 */
  _onSelect?: (value: string) => void;
  /** @internal Tabs から注入 */
  _variant?: TabVariant;
  className?: string;
}

export interface TabsProps {
  /** 現在選択中のタブ値 */
  value: string;
  /** タブ変更ハンドラ */
  onChange: (value: string) => void;
  /** primary(デフォルト) or secondary */
  variant?: TabVariant;
  children: ReactNode;
  className?: string;
  /** aria-label for tablist */
  label?: string;
}

// ---------- Tab (個別タブ) ----------
export const Tab = forwardRef<HTMLButtonElement, TabProps>(function Tab(
  { value, children, icon, disabled = false, _selected = false, _onSelect, _variant = 'primary', className = '' },
  ref
) {
  const id = useId();
  const tabId = `mp-tab-${id}`;
  const panelId = `mp-tabpanel-${id}`;

  const state = disabled ? 'disabled' : _selected ? 'active' : 'default';
  const cls = [
    'mp-tab',
    `mp-tab--${_variant}`,
    `mp-tab--${state}`,
    className,
  ].filter(Boolean).join(' ');

  const handleClick = () => {
    if (!disabled && _onSelect) _onSelect(value);
  };

  return (
    <button
      ref={ref}
      id={tabId}
      role="tab"
      type="button"
      className={cls}
      aria-selected={_selected}
      aria-disabled={disabled || undefined}
      aria-controls={panelId}
      tabIndex={_selected ? 0 : -1}
      onClick={handleClick}
    >
      {icon && <span className="mp-tab__icon">{icon}</span>}
      <span className="mp-tab__label">{children}</span>
    </button>
  );
});

// ---------- Tabs (コンテナ) ----------
export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  { value, onChange, variant = 'primary', children, className = '', label },
  ref
) {
  const tabsRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const container = tabsRef.current;
    if (!container) return;
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([aria-disabled="true"])'));
    const currentIndex = tabs.findIndex((t) => t === document.activeElement);
    if (currentIndex === -1) return;

    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') nextIndex = 0;
    if (e.key === 'End') nextIndex = tabs.length - 1;

    if (nextIndex !== null) {
      e.preventDefault();
      tabs[nextIndex].focus();
    }
  }, []);

  const mergedRef = (node: HTMLDivElement | null) => {
    (tabsRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
  };

  return (
    <div
      ref={mergedRef}
      role="tablist"
      className={`mp-tablist ${className}`}
      aria-label={label}
      onKeyDown={handleKeyDown}
    >
      {React.Children.map(children, (child) => {
        if (!React.isValidElement<TabProps>(child)) return child;
        return React.cloneElement(child, {
          _selected: child.props.value === value,
          _onSelect: onChange,
          _variant: variant,
        });
      })}
    </div>
  );
});

// ---------- TabPanel ----------
export interface TabPanelProps {
  /** 対応する Tab の value */
  value: string;
  /** 現在選択中のタブ値 */
  activeValue: string;
  children: ReactNode;
  className?: string;
}

export function TabPanel({ value, activeValue, children, className = '' }: TabPanelProps) {
  if (value !== activeValue) return null;
  return (
    <div role="tabpanel" className={className} tabIndex={0}>
      {children}
    </div>
  );
}

// ---------- Dev warnings ----------
if (process.env.NODE_ENV !== 'production') {
  Tab.displayName = 'Tab';
  Tabs.displayName = 'Tabs';
}

/* -------------------------------------------------------------------------
 * 使用例:
 *
 * import { Tabs, Tab, TabPanel } from '@manabi-ds/Tab';
 *
 * function MyPage() {
 *   const [tab, setTab] = useState('attendance');
 *   return (
 *     <>
 *       <Tabs value={tab} onChange={setTab} label="メインナビゲーション">
 *         <Tab value="attendance" icon={<CheckIcon />}>出席簿</Tab>
 *         <Tab value="grades">成績</Tab>
 *         <Tab value="health" disabled>健康観察</Tab>
 *       </Tabs>
 *       <TabPanel value="attendance" activeValue={tab}>
 *         <AttendanceView />
 *       </TabPanel>
 *       <TabPanel value="grades" activeValue={tab}>
 *         <GradesView />
 *       </TabPanel>
 *     </>
 *   );
 * }
 *
 * // Secondary（Primary Tab 内のサブタブ）
 * <Tabs value={subTab} onChange={setSubTab} variant="secondary">
 *   <Tab value="monthly">月別</Tab>
 *   <Tab value="semester">学期別</Tab>
 * </Tabs>
 * ------------------------------------------------------------------------- */
