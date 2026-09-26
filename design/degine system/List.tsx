import React, { forwardRef, useId, useCallback, type ReactNode } from 'react';
import './List.css';

/* =========================================================================
   List — まなびポケット Design System
   ========================================================================= */

export type ListSize = 'large' | 'medium' | 'small';
export type ListCellState = 'enabled' | 'hovered' | 'focused' | 'disabled';
export type SortDirection = 'ascending' | 'descending' | 'none';

// ---------- List container ----------
export interface ListProps {
  size?: ListSize;
  children: ReactNode;
  className?: string;
  /** aria-label for the list */
  label?: string;
}

export const List = forwardRef<HTMLDivElement, ListProps>(function List(
  { size = 'large', children, className = '', label },
  ref
) {
  return (
    <div ref={ref} role="list" aria-label={label} className={`mp-list ${className}`}>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        return React.cloneElement(child as React.ReactElement<{ _size?: ListSize }>, { _size: size });
      })}
    </div>
  );
});

// ---------- ListHeader ----------
export interface ListHeaderColumn {
  key: string;
  label: string;
  sortable?: boolean;
  sort?: SortDirection;
}

export interface ListHeaderProps {
  columns: ListHeaderColumn[];
  /** 全選択チェックボックスを表示 */
  checkable?: boolean;
  /** 全選択の状態 */
  allChecked?: boolean;
  onCheckAll?: (checked: boolean) => void;
  /** ソート変更ハンドラ */
  onSort?: (key: string) => void;
  /** 検索ボタン表示 */
  showSearch?: boolean;
  onSearch?: () => void;
  /** トグルスイッチ表示 */
  showToggle?: boolean;
  toggleLabel?: string;
  toggleChecked?: boolean;
  onToggle?: (checked: boolean) => void;
  /** @internal List から注入 */
  _size?: ListSize;
  className?: string;
}

// Sort icon SVG
function SortIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3L5 6.99h3V14h2V6.99h3L9 3z" />
    </svg>
  );
}

// Search icon SVG
function SearchIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
    </svg>
  );
}

export const ListHeader = forwardRef<HTMLDivElement, ListHeaderProps>(function ListHeader(
  {
    columns,
    checkable = false,
    allChecked = false,
    onCheckAll,
    onSort,
    showSearch = false,
    onSearch,
    showToggle = false,
    toggleLabel = '',
    toggleChecked = false,
    onToggle,
    _size = 'large',
    className = '',
  },
  ref
) {
  const cls = [
    'mp-list-row',
    'mp-list-header',
    `mp-list-row--${_size}`,
    _size === 'small' && 'mp-list-header--small',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div ref={ref} role="row" className={cls}>
      {checkable && (
        <div className="mp-list-header__checkbox">
          <input
            type="checkbox"
            checked={allChecked}
            onChange={(e) => onCheckAll?.(e.target.checked)}
            aria-label="全選択"
          />
        </div>
      )}
      {columns.map((col) => (
        <div key={col.key} className="mp-list-header__label">
          <span>{col.label}</span>
          {col.sortable && (
            <button
              type="button"
              className="mp-list-header__sort-icon"
              onClick={() => onSort?.(col.key)}
              aria-sort={col.sort || 'none'}
              aria-label={`${col.label}でソート`}
            >
              <SortIcon />
            </button>
          )}
        </div>
      ))}
      {showSearch && (
        <button type="button" className="mp-list-header__search" onClick={onSearch} aria-label="検索">
          <SearchIcon />
        </button>
      )}
      {showToggle && (
        <div className="mp-list-header__toggle">
          <span className="mp-list-header__toggle-label">{toggleLabel}</span>
          <input
            type="checkbox"
            role="switch"
            checked={toggleChecked}
            onChange={(e) => onToggle?.(e.target.checked)}
            aria-label={toggleLabel}
          />
        </div>
      )}
    </div>
  );
});

// ---------- ListCell ----------
export interface ListCellProps {
  /** メインデータ */
  children: ReactNode;
  /** チェックボックス表示 */
  checkable?: boolean;
  checked?: boolean;
  onCheck?: (checked: boolean) => void;
  /** 無効化 */
  disabled?: boolean;
  /** 左アイコン */
  icon?: ReactNode;
  /** インデント */
  indent?: boolean;
  /** 警告テキスト */
  attentionText?: string;
  /** @internal List から注入 */
  _size?: ListSize;
  className?: string;
  onClick?: () => void;
}

// Error outline icon
function ErrorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="mp-list-cell__attention-icon">
      <path d="M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z" />
    </svg>
  );
}

export const ListCell = forwardRef<HTMLDivElement, ListCellProps>(function ListCell(
  {
    children,
    checkable = false,
    checked = false,
    onCheck,
    disabled = false,
    icon,
    indent = false,
    attentionText,
    _size = 'large',
    className = '',
    onClick,
  },
  ref
) {
  // Dev warnings
  if (process.env.NODE_ENV !== 'production') {
    if (disabled && attentionText && checkable && checked) {
      // Valid combination: disabled + checked + attention = "転出済み" pattern
    }
  }

  const cls = [
    'mp-list-row',
    'mp-list-cell',
    `mp-list-row--${_size}`,
    _size === 'small' && 'mp-list-cell--small',
    disabled && 'mp-list-cell--disabled',
    className,
  ].filter(Boolean).join(' ');

  const indentWidth = _size === 'large' ? 42 : _size === 'medium' ? 38 : 38;

  return (
    <div
      ref={ref}
      role="listitem"
      className={cls}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onClick}
    >
      {indent && <div className="mp-list-cell__indent" style={{ width: indentWidth }} />}
      {checkable && (
        <div className="mp-list-cell__checkbox">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onCheck?.(e.target.checked)}
            aria-label="行を選択"
          />
        </div>
      )}
      {icon && <div className="mp-list-cell__icon">{icon}</div>}
      <div className="mp-list-cell__data">{children}</div>
      {attentionText && (
        <div className="mp-list-cell__attention">
          <ErrorIcon />
          <span className="mp-list-cell__attention-text">{attentionText}</span>
        </div>
      )}
    </div>
  );
});

// ---------- Dev ----------
if (process.env.NODE_ENV !== 'production') {
  List.displayName = 'List';
  ListHeader.displayName = 'ListHeader';
  ListCell.displayName = 'ListCell';
}

/* -------------------------------------------------------------------------
 * 使用例:
 *
 * import { List, ListHeader, ListCell } from '@manabi-ds/List';
 *
 * // 1) 基本的な一覧
 * <List size="large" label="児童名簿">
 *   <ListHeader
 *     columns={[
 *       { key: 'name', label: '名前', sortable: true },
 *       { key: 'class', label: 'クラス', sortable: true },
 *     ]}
 *     checkable
 *   />
 *   <ListCell checkable>あらい はなこ</ListCell>
 *   <ListCell checkable checked>たなか たろう</ListCell>
 *   <ListCell disabled attentionText="転出済み">やまだ じろう</ListCell>
 * </List>
 *
 * // 2) コンパクト (medium)
 * <List size="medium">
 *   <ListHeader columns={[{ key: 'name', label: '教材名' }]} />
 *   <ListCell>算数ドリル</ListCell>
 *   <ListCell>国語プリント</ListCell>
 * </List>
 *
 * // 3) 検索 + トグル付きヘッダー
 * <List size="large">
 *   <ListHeader
 *     columns={[{ key: 'name', label: '名前', sortable: true }]}
 *     showSearch
 *     showToggle
 *     toggleLabel="編集"
 *   />
 *   <ListCell>...</ListCell>
 * </List>
 * ------------------------------------------------------------------------- */
