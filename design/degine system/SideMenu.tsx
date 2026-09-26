/* ==========================================================
   SideMenu — まなびポケット Design System
   React component with forwardRef, full typing, a11y
   ========================================================== */

import React, { forwardRef, useCallback } from 'react';
import './sidemenu.css';

// ---------- Types ----------

export type SideMenuSize = 'md' | 'sm';

export type SideMenuItemVariant =
  | 'section'
  | 'title'
  | 'accordion'
  | 'default'
  | 'name'
  | 'nav';

export interface SideMenuProps extends React.HTMLAttributes<HTMLElement> {
  /** Menu size applied to all children */
  size?: SideMenuSize;
  children: React.ReactNode;
}

export interface SideMenuItemProps
  extends Omit<React.HTMLAttributes<HTMLElement>, 'onClick'> {
  variant?: SideMenuItemVariant;
  size?: SideMenuSize;
  /** Mark as current page / active item */
  active?: boolean;
  /** Badge count. Hidden when <= 0 */
  badgeCount?: number;
  /** Accordion open state */
  open?: boolean;
  /** Accordion toggle callback */
  onToggle?: (open: boolean) => void;
  /** Click handler (ignored for section) */
  onClick?: React.MouseEventHandler<HTMLElement>;
  /** href for nav variant — renders <a> instead of <button> */
  href?: string;
  /** Avatar image src (name variant) */
  avatarSrc?: string;
  /** Avatar alt text */
  avatarAlt?: string;
  /** Sub-label text (e.g. "1時間目") */
  subLabel?: string;
  children: React.ReactNode;
}

// ---------- Dev warnings ----------

function devWarn(condition: boolean, message: string) {
  if (
    condition &&
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV !== 'production'
  ) {
    console.warn(`[mp-sidemenu] ${message}`);
  }
}

// ---------- Icons (inline SVG) ----------

const ChevronRight: React.FC<{ className?: string }> = ({ className }) => (
  <span
    className={`mp-sidemenu-item__icon mp-sidemenu-item__chevron ${className ?? ''}`}
    aria-hidden="true"
  >
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path
        d="M9.29 6.71a1 1 0 000 1.41L13.17 12l-3.88 3.88a1 1 0 101.42 1.41l4.59-4.59a1 1 0 000-1.41L10.71 6.7a1 1 0 00-1.42.01z"
        fill="currentColor"
      />
    </svg>
  </span>
);

const ArrowForward: React.FC<{ className?: string }> = ({ className }) => (
  <span
    className={`mp-sidemenu-item__icon ${className ?? ''}`}
    aria-hidden="true"
  >
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z"
        fill="currentColor"
      />
    </svg>
  </span>
);

const KeyboardArrowDown: React.FC<{ open?: boolean }> = ({ open }) => (
  <span
    className={`mp-sidemenu-item__icon mp-sidemenu-item__arrow ${open ? 'mp-sidemenu-item__arrow--open' : ''}`}
    aria-hidden="true"
  >
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path
        d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"
        fill="currentColor"
      />
    </svg>
  </span>
);

// ---------- SideMenu (container) ----------

export const SideMenu = forwardRef<HTMLElement, SideMenuProps>(
  function SideMenu({ size = 'md', children, className, ...rest }, ref) {
    return (
      <nav
        ref={ref}
        role="navigation"
        className={`mp-sidemenu ${className ?? ''}`}
        {...rest}
      >
        <ul role="menu" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {React.Children.map(children, (child) => {
            if (!React.isValidElement<SideMenuItemProps>(child)) return child;
            // Inherit size from parent unless child overrides
            return React.cloneElement(child, {
              size: child.props.size ?? size,
            });
          })}
        </ul>
      </nav>
    );
  },
);

// ---------- SideMenuItem ----------

export const SideMenuItem = forwardRef<HTMLElement, SideMenuItemProps>(
  function SideMenuItem(
    {
      variant = 'default',
      size = 'md',
      active = false,
      badgeCount,
      open,
      onToggle,
      onClick,
      href,
      avatarSrc,
      avatarAlt = '',
      subLabel,
      children,
      className,
      ...rest
    },
    ref,
  ) {
    // Dev warnings
    devWarn(
      variant === 'section' && (active || !!onClick),
      'section variant should not be clickable or active.',
    );
    devWarn(
      variant === 'accordion' && typeof open === 'undefined',
      'accordion variant requires `open` prop for controlled state.',
    );
    devWarn(
      variant === 'name' && !avatarSrc,
      'name variant should include `avatarSrc` for the avatar image.',
    );
    devWarn(
      variant !== 'nav' && !!href,
      '`href` is only used with the nav variant. Did you mean variant="nav"?',
    );

    const isSection = variant === 'section';

    const classNames = [
      'mp-sidemenu-item',
      `mp-sidemenu-item--${size}`,
      `mp-sidemenu-item--${variant}`,
      active && !isSection ? 'mp-sidemenu-item--active' : '',
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ');

    // Role
    const role = isSection ? 'separator' : 'menuitem';
    const ariaCurrent = active && !isSection ? ('page' as const) : undefined;

    // Badge
    const badge =
      badgeCount != null && badgeCount > 0 ? (
        <span
          className="mp-sidemenu-item__badge"
          aria-label={`通知 ${badgeCount} 件`}
        >
          {badgeCount}
        </span>
      ) : null;

    // Handle accordion toggle
    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLElement>) => {
        if (variant === 'accordion' && onToggle) {
          onToggle(!open);
        }
        onClick?.(e);
      },
      [variant, onToggle, open, onClick],
    );

    // Content based on variant
    const renderContent = () => {
      switch (variant) {
        case 'section':
          return <span className="mp-sidemenu-item__label">{children}</span>;

        case 'title':
          return (
            <>
              <span className="mp-sidemenu-item__label">{children}</span>
              <ChevronRight />
            </>
          );

        case 'accordion':
          return (
            <>
              <KeyboardArrowDown open={open} />
              <span className="mp-sidemenu-item__label">{children}</span>
              {badge}
            </>
          );

        case 'name':
          return (
            <>
              {avatarSrc && (
                <img
                  className="mp-sidemenu-item__avatar"
                  src={avatarSrc}
                  alt={avatarAlt}
                />
              )}
              <span className="mp-sidemenu-item__label">{children}</span>
              {badge}
              <ChevronRight />
            </>
          );

        case 'nav':
          return (
            <>
              <span className="mp-sidemenu-item__label">{children}</span>
              <ArrowForward />
            </>
          );

        case 'default':
        default:
          return (
            <>
              <span className="mp-sidemenu-item__label">{children}</span>
              {subLabel && (
                <span className="mp-sidemenu-item__sublabel">{subLabel}</span>
              )}
              {badge}
              <ChevronRight />
            </>
          );
      }
    };

    // Wrapper element
    const wrapperProps = {
      className: classNames,
      role,
      'aria-current': ariaCurrent,
      tabIndex: isSection ? -1 : 0,
      ...rest,
    };

    // Section = non-interactive <li><div>
    if (isSection) {
      return (
        <li role="none">
          <div ref={ref as React.Ref<HTMLDivElement>} {...wrapperProps}>
            {renderContent()}
          </div>
        </li>
      );
    }

    // Nav with href = <li><a>
    if (variant === 'nav' && href) {
      return (
        <li role="none">
          <a
            ref={ref as React.Ref<HTMLAnchorElement>}
            href={href}
            onClick={handleClick}
            {...wrapperProps}
          >
            {renderContent()}
          </a>
        </li>
      );
    }

    // Accordion
    if (variant === 'accordion') {
      return (
        <li role="none">
          <button
            ref={ref as React.Ref<HTMLButtonElement>}
            type="button"
            aria-expanded={open}
            onClick={handleClick}
            {...wrapperProps}
          >
            {renderContent()}
          </button>
        </li>
      );
    }

    // All other interactive items
    return (
      <li role="none">
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          onClick={handleClick}
          {...wrapperProps}
        >
          {renderContent()}
        </button>
      </li>
    );
  },
);

/* ==========================================================
   Usage Example
   ==========================================================

   import { SideMenu, SideMenuItem } from './SideMenu';

   function SettingsNav() {
     const [accordionOpen, setAccordionOpen] = useState(false);

     return (
       <SideMenu aria-label="設定メニュー" size="md">
         <SideMenuItem variant="section">基本設定</SideMenuItem>
         <SideMenuItem variant="title" active>
           プロフィール
         </SideMenuItem>
         <SideMenuItem variant="default" badgeCount={3}>
           通知設定
         </SideMenuItem>
         <SideMenuItem
           variant="accordion"
           open={accordionOpen}
           onToggle={setAccordionOpen}
           badgeCount={1}
         >
           詳細設定
         </SideMenuItem>
         {accordionOpen && (
           <>
             <SideMenuItem variant="default" size="sm">
               表示設定
             </SideMenuItem>
             <SideMenuItem variant="default" size="sm">
               セキュリティ
             </SideMenuItem>
           </>
         )}
         <SideMenuItem
           variant="name"
           avatarSrc="/img/yamada.jpg"
           avatarAlt="山田太郎"
         >
           山田太郎
         </SideMenuItem>
         <SideMenuItem variant="nav" href="/settings/advanced">
           高度な設定
         </SideMenuItem>
       </SideMenu>
     );
   }

   ========================================================== */
