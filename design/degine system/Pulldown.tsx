import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

/* ============================================================
   Types
   ============================================================ */

export type PulldownBtnStyle = 'text' | 'icon';
export type PulldownBtnSize = 'L' | 'M' | 'S' | 'SS';
export type PulldownMenuSize = 'M' | 'S' | 'SS';
export type PulldownMenuTone = 'normal' | 'danger';

export interface PulldownItem {
  /** 識別値（onSelect で受け取る値） */
  value: string;
  /** 表示テキスト（動詞なし・体言止め推奨） */
  label: string;
  /** 危険操作（削除など）は 'danger' で赤テキスト */
  tone?: PulldownMenuTone;
  /** 個別に非活性化 */
  disabled?: boolean;
  /** 任意のサブテキスト（"1年2組" など、グレー小文字） */
  sub?: string;
  /** 任意のリーディングアイコン */
  icon?: ReactNode;
}

/* ============================================================
   default icons (inline SVG, currentColor)
   ============================================================ */

const CaretDownIcon = () => (
  <svg
    aria-hidden="true"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z"
      fill="currentColor"
    />
  </svg>
);

const CaretUpIcon = () => (
  <svg
    aria-hidden="true"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M12 8 6 14l1.41 1.41L12 10.83l4.59 4.58L18 14z"
      fill="currentColor"
    />
  </svg>
);

const MoreVertIcon = () => (
  <svg
    aria-hidden="true"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"
      fill="currentColor"
    />
  </svg>
);

/* ============================================================
   PulldownBtn — trigger button (low-level, controlled)
   ============================================================ */

export interface PulldownBtnProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** 'text' = ラベル＋▼ / 'icon' = ︙ アイコンのみ */
  buttonStyle?: PulldownBtnStyle;
  size?: PulldownBtnSize;
  /** 表示テキスト（style='text'時に必須） */
  label?: string;
  /** 開いている状態（caret方向と aria-expanded を反映） */
  open?: boolean;
  /** style='icon' 時の aria-label（必須） */
  iconLabel?: string;
}

export const PulldownBtn = forwardRef<HTMLButtonElement, PulldownBtnProps>(
  (
    {
      buttonStyle = 'text',
      size = 'M',
      label,
      open = false,
      iconLabel,
      disabled,
      className,
      children,
      ...rest
    },
    ref
  ) => {
    if (process.env.NODE_ENV !== 'production') {
      if (buttonStyle === 'text' && !label && !children) {
        console.warn(
          '[PulldownBtn] style="text" requires `label` or children for accessibility.'
        );
      }
      if (buttonStyle === 'icon' && !iconLabel) {
        console.warn(
          '[PulldownBtn] style="icon" requires `iconLabel` (aria-label) for accessibility.'
        );
      }
    }

    const sizeClass = `mp-pulldown-btn--${size.toLowerCase()}`;
    const styleClass =
      buttonStyle === 'icon' ? 'mp-pulldown-btn--icon' : 'mp-pulldown-btn--text';

    const classes = ['mp-pulldown-btn', sizeClass, styleClass, className]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        ref={ref}
        type="button"
        className={classes}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        aria-label={buttonStyle === 'icon' ? iconLabel : undefined}
        disabled={disabled}
        {...rest}
      >
        {buttonStyle === 'icon' ? (
          <span className="mp-pulldown-btn__icon">
            <MoreVertIcon />
          </span>
        ) : (
          <>
            <span className="mp-pulldown-btn__label">{label ?? children}</span>
            <span className="mp-pulldown-btn__caret">
              {open ? <CaretUpIcon /> : <CaretDownIcon />}
            </span>
          </>
        )}
      </button>
    );
  }
);

PulldownBtn.displayName = 'PulldownBtn';

/* ============================================================
   PulldownMenu — single menu item (low-level)
   ============================================================ */

export interface PulldownMenuProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  size?: PulldownMenuSize;
  tone?: PulldownMenuTone;
  label: string;
  /** 補助テキスト（"1年2組" など） */
  sub?: string;
  /** リーディングアイコン */
  icon?: ReactNode;
  /** 選択状態（aria-selected） */
  selected?: boolean;
}

export const PulldownMenu = forwardRef<HTMLButtonElement, PulldownMenuProps>(
  (
    {
      size = 'M',
      tone = 'normal',
      label,
      sub,
      icon,
      selected = false,
      disabled,
      className,
      ...rest
    },
    ref
  ) => {
    const sizeClass = `mp-pulldown-menu--${size.toLowerCase()}`;
    const toneClass = tone === 'danger' ? 'mp-pulldown-menu--danger' : '';

    const classes = ['mp-pulldown-menu', sizeClass, toneClass, className]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        ref={ref}
        type="button"
        role="option"
        aria-selected={selected}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        className={classes}
        {...rest}
      >
        {icon && <span className="mp-pulldown-menu__icon">{icon}</span>}
        <span className="mp-pulldown-menu__label">{label}</span>
        {sub && <span className="mp-pulldown-menu__sub">{sub}</span>}
      </button>
    );
  }
);

PulldownMenu.displayName = 'PulldownMenu';

/* ============================================================
   Pulldown — composite (Btn + Set + Menu items)
   open/close state, outside-click, keyboard nav
   ============================================================ */

export interface PulldownProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  /** メニュー項目 */
  items: PulldownItem[];
  /** style: text or icon (more_vert) */
  buttonStyle?: PulldownBtnStyle;
  size?: PulldownBtnSize;
  /** Btn ラベル（style='text'時） */
  label?: string;
  /** style='icon'時の aria-label */
  iconLabel?: string;
  /** 全体非活性 */
  disabled?: boolean;
  /** 項目選択時のコールバック（選択即時にメニューが閉じる） */
  onSelect?: (value: string) => void;
  /** ポップアップの揃え方向 */
  align?: 'left' | 'right';
  /** 6項目以上のときスクロール（明示制御したい場合に） */
  scrollable?: boolean;
}

export const Pulldown = forwardRef<HTMLDivElement, PulldownProps>(
  (
    {
      items,
      buttonStyle = 'text',
      size = 'M',
      label,
      iconLabel,
      disabled = false,
      onSelect,
      align = 'left',
      scrollable,
      className,
      ...rest
    },
    ref
  ) => {
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState<number>(-1);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const btnRef = useRef<HTMLButtonElement | null>(null);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const listboxId = useId();

    // Btn と Menu のサイズ整合（L→M に縮退）
    const menuSize: PulldownMenuSize = size === 'L' ? 'M' : (size as PulldownMenuSize);

    // 6項目以上で自動スクロール
    const isScrollable = scrollable ?? items.length > 5;

    const close = useCallback(() => {
      setOpen(false);
      setActiveIndex(-1);
      // フォーカスをトリガーに戻す
      btnRef.current?.focus();
    }, []);

    const toggle = useCallback(() => {
      if (disabled) return;
      setOpen((prev) => {
        const next = !prev;
        if (next) {
          setActiveIndex(0);
        } else {
          setActiveIndex(-1);
        }
        return next;
      });
    }, [disabled]);

    const handleSelect = useCallback(
      (item: PulldownItem) => {
        if (item.disabled) return;
        onSelect?.(item.value);
        close();
      },
      [onSelect, close]
    );

    // Outside click → close
    useEffect(() => {
      if (!open) return;

      const handleClickOutside = (e: MouseEvent) => {
        if (
          wrapperRef.current &&
          !wrapperRef.current.contains(e.target as Node)
        ) {
          setOpen(false);
          setActiveIndex(-1);
        }
      };

      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [open]);

    // 項目フォーカス制御
    useEffect(() => {
      if (open && activeIndex >= 0) {
        itemRefs.current[activeIndex]?.focus();
      }
    }, [open, activeIndex]);

    // Btn 上のキー操作
    const handleBtnKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;

      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIndex(0);
        } else {
          setActiveIndex((prev) => (prev + 1) % items.length);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIndex(items.length - 1);
        }
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        close();
      }
    };

    // メニュー項目上のキー操作
    const handleMenuKeyDown = (
      e: ReactKeyboardEvent<HTMLButtonElement>,
      idx: number
    ) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((idx + 1) % items.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((idx - 1 + items.length) % items.length);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSelect(items[idx]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Tab') {
        // Tab で閉じる（フォーカスは外に出す）
        setOpen(false);
        setActiveIndex(-1);
      }
    };

    // ref を wrapper と forwardRef にマージ
    const setWrapperRef = (el: HTMLDivElement | null) => {
      wrapperRef.current = el;
      if (typeof ref === 'function') {
        ref(el);
      } else if (ref) {
        ref.current = el;
      }
    };

    const wrapperClasses = ['mp-pulldown', className].filter(Boolean).join(' ');
    const popupClasses = [
      'mp-pulldown__popup',
      align === 'right' ? 'mp-pulldown__popup--right' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const setClasses = [
      'mp-pulldown-set',
      isScrollable ? 'mp-pulldown-set--scrollable' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div ref={setWrapperRef} className={wrapperClasses} {...rest}>
        <PulldownBtn
          ref={btnRef}
          buttonStyle={buttonStyle}
          size={size}
          label={label}
          iconLabel={iconLabel}
          open={open}
          disabled={disabled}
          onClick={toggle}
          onKeyDown={handleBtnKeyDown}
          aria-controls={listboxId}
        />
        {open && (
          <div className={popupClasses}>
            <ul
              id={listboxId}
              role="listbox"
              className={setClasses}
              aria-label={label ?? iconLabel ?? 'options'}
            >
              {items.map((item, idx) => (
                <li key={item.value} role="presentation">
                  <PulldownMenu
                    ref={(el) => {
                      itemRefs.current[idx] = el;
                    }}
                    size={menuSize}
                    tone={item.tone}
                    label={item.label}
                    sub={item.sub}
                    icon={item.icon}
                    disabled={item.disabled}
                    selected={activeIndex === idx}
                    onClick={() => handleSelect(item)}
                    onKeyDown={(e) => handleMenuKeyDown(e, idx)}
                    tabIndex={activeIndex === idx ? 0 : -1}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
);

Pulldown.displayName = 'Pulldown';

/* ============================================================
   Usage examples

   // 基本（即時アクション、テキストスタイル）
   <Pulldown
     label="並び替え"
     items={[
       { value: 'asc',  label: '昇順' },
       { value: 'desc', label: '降順' },
       { value: 'name', label: '名前順' },
     ]}
     onSelect={(v) => applySort(v)}
   />

   // テーブル行内のサブアクション（Iconスタイル + more_vert）
   <Pulldown
     buttonStyle="icon"
     iconLabel="行アクション"
     size="M"
     items={[
       { value: 'edit',   label: '編集' },
       { value: 'copy',   label: '複製' },
       { value: 'delete', label: '削除', tone: 'danger' },
     ]}
     onSelect={(v) => handleRowAction(v)}
   />

   // 6項目以上 → 自動でスクロール表示
   <Pulldown
     label="科目"
     items={subjects.map((s) => ({ value: s.id, label: s.name }))}
     onSelect={(id) => filterBySubject(id)}
   />

   // 低レベルAPI（Btn と Menu を別々に組みたい場合）
   <PulldownBtn label="表示" size="S" open={isOpen} onClick={toggle} />
   <ul role="listbox" className="mp-pulldown-set">
     <li><PulldownMenu size="S" label="一覧" onClick={...} /></li>
     <li><PulldownMenu size="S" label="グリッド" onClick={...} /></li>
   </ul>
   ============================================================ */
