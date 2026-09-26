import * as React from 'react';
import './modal.css';

/**
 * まなびポケット Design System — Modal
 *
 * ユーザーに入力・選択・確認を求めるダイアログコンポーネント。
 * 仕様の詳細は同ディレクトリの `modal.md` を参照。
 */

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

export type ModalStyle =
  | 'default'
  | 'info'
  | 'success'
  | 'error'
  | 'warning'
  | 'dialog'
  | 'share';

export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalProps extends React.HTMLAttributes<HTMLDivElement> {
  /** スタイルバリアント。デフォルトは 'default' */
  modalStyle?: ModalStyle;
  /** サイズ（横幅）。デフォルトは 'sm' */
  size?: ModalSize;
  /** タイトルテキスト */
  title: string;
  /** モーダルの開閉。true で表示 */
  open: boolean;
  /** 閉じる時のコールバック */
  onClose: () => void;
  /** × ボタンを表示するか。デフォルトは style に依存 */
  showClose?: boolean;
  /** overlay クリックで閉じるか。デフォルトは dialog 以外 true */
  closeOnOverlay?: boolean;
  /** フッター領域（ボタン群）。ReactNode を渡す */
  footer?: React.ReactNode;
  /** フッター左側（テキストリンク等） */
  footerLeft?: React.ReactNode;
  /** 本文テキスト or コンテンツ */
  children?: React.ReactNode;
}

/* ---------------------------------------------------------------------------
 * Icon SVGs
 * --------------------------------------------------------------------------- */

const styleIcons: Partial<Record<ModalStyle, React.ReactNode>> = {
  info: (
    <svg viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" fill="currentColor"/></svg>
  ),
  success: (
    <svg viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="currentColor"/></svg>
  ),
  error: (
    <svg viewBox="0 0 24 24" fill="none"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z" fill="currentColor"/></svg>
  ),
  warning: (
    <svg viewBox="0 0 24 24" fill="none"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" fill="currentColor"/></svg>
  ),
};

const closeIconSvg = (
  <svg viewBox="0 0 24 24" fill="none"><path d="M18.3 5.71a1 1 0 00-1.41 0L12 10.59 7.11 5.7A1 1 0 105.7 7.11L10.59 12 5.7 16.89a1 1 0 101.41 1.41L12 13.41l4.89 4.89a1 1 0 001.41-1.41L13.41 12l4.89-4.89a1 1 0 000-1.4z" fill="currentColor"/></svg>
);

/* ---------------------------------------------------------------------------
 * showClose defaults per style
 * --------------------------------------------------------------------------- */

const SHOW_CLOSE_DEFAULTS: Record<ModalStyle, boolean> = {
  default: false,
  info: false,
  success: false,
  error: false,
  warning: false,
  dialog: true,
  share: false,
};

/* ---------------------------------------------------------------------------
 * Focus trap utility
 * --------------------------------------------------------------------------- */

function useFocusTrap(ref: React.RefObject<HTMLDivElement | null>, active: boolean) {
  React.useEffect(() => {
    if (!active || !ref.current) return;

    const el = ref.current;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    first?.focus();

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };

    el.addEventListener('keydown', handleTab);
    return () => el.removeEventListener('keydown', handleTab);
  }, [ref, active]);
}

/* ---------------------------------------------------------------------------
 * Component
 * --------------------------------------------------------------------------- */

export const Modal = React.forwardRef<HTMLDivElement, ModalProps>(
  function Modal(
    {
      modalStyle = 'default',
      size = 'sm',
      title,
      open,
      onClose,
      showClose,
      closeOnOverlay,
      footer,
      footerLeft,
      children,
      className,
      ...rest
    },
    ref,
  ) {
    const panelRef = React.useRef<HTMLDivElement>(null);
    const triggerRef = React.useRef<HTMLElement | null>(null);
    const titleId = React.useId();
    const bodyId = React.useId();

    const effectiveShowClose = showClose ?? SHOW_CLOSE_DEFAULTS[modalStyle];
    const effectiveCloseOnOverlay = closeOnOverlay ?? (modalStyle !== 'dialog');

    /* --- Dev-time warnings ---------------------------------------------- */
    if (process.env.NODE_ENV !== 'production') {
      if (!title) {
        console.warn('[Modal] title は必須です（アクセシビリティ要件）');
      }
      if (effectiveShowClose && footer) {
        const footerStr = String(footer);
        if (
          footerStr.includes('キャンセル') ||
          footerStr.includes('閉じる') ||
          footerStr.includes('cancel')
        ) {
          console.warn(
            '[Modal] × ボタンと同じ役割のフッターボタンが共存しています。' +
            'どちらか一方にしてください（modal.md 注意事項①）',
          );
        }
      }
    }

    /* --- Focus management ----------------------------------------------- */
    useFocusTrap(panelRef, open);

    React.useEffect(() => {
      if (open) {
        triggerRef.current = document.activeElement as HTMLElement;
      } else {
        triggerRef.current?.focus();
      }
    }, [open]);

    /* --- Escape key ----------------------------------------------------- */
    React.useEffect(() => {
      if (!open) return;
      const handleEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
      };
      document.addEventListener('keydown', handleEsc);
      return () => document.removeEventListener('keydown', handleEsc);
    }, [open, onClose]);

    /* --- Body scroll lock ----------------------------------------------- */
    React.useEffect(() => {
      if (!open) return;
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }, [open]);

    if (!open) return null;

    /* --- Icon ----------------------------------------------------------- */
    const icon = styleIcons[modalStyle];
    const hasIcon = !!icon;

    /* --- Class names ---------------------------------------------------- */
    const panelCls = [
      'mp-modal',
      `mp-modal--${size}`,
      `mp-modal--${modalStyle}`,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        className="mp-modal-overlay"
        onClick={effectiveCloseOnOverlay ? onClose : undefined}
        aria-hidden="true"
      >
        <div
          ref={(node) => {
            (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          className={panelCls}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={children ? bodyId : undefined}
          onClick={(e) => e.stopPropagation()}
          {...rest}
        >
          {/* Header */}
          <div className="mp-modal__header">
            <div className="mp-modal__header-content">
              {hasIcon && <span className="mp-modal__icon">{icon}</span>}
              <h2 className="mp-modal__title" id={titleId}>
                {title}
              </h2>
            </div>
            {effectiveShowClose && (
              <button
                type="button"
                className="mp-modal__close"
                aria-label="閉じる"
                onClick={onClose}
              >
                {closeIconSvg}
              </button>
            )}
          </div>

          {/* Body */}
          {children && (
            <div className="mp-modal__body" id={bodyId}>
              {children}
            </div>
          )}

          {/* Footer */}
          {(footer || footerLeft) && (
            <div className="mp-modal__footer">
              {footerLeft && (
                <div className="mp-modal__footer-left">{footerLeft}</div>
              )}
              {footer && (
                <div className="mp-modal__footer-buttons">{footer}</div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  },
);

Modal.displayName = 'Modal';
export default Modal;

/* ---------------------------------------------------------------------------
 * 使用例
 *
 * // 1. 確認ダイアログ（dialog スタイル = ×ボタンあり、小さいボタン）
 * <Modal
 *   modalStyle="dialog"
 *   size="sm"
 *   title="削除の確認"
 *   open={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   footer={
 *     <>
 *       <Button color="negative" size="m" onClick={() => setIsOpen(false)}>いいえ</Button>
 *       <Button color="primary" size="m" onClick={handleDelete}>はい</Button>
 *     </>
 *   }
 * >
 *   この操作は取り消せません。本当に削除しますか？
 * </Modal>
 *
 * // 2. default + コンテンツスロット（中サイズ）
 * <Modal
 *   modalStyle="default"
 *   size="md"
 *   title="カード配布設定"
 *   open={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   footer={
 *     <>
 *       <Button color="negative" onClick={() => setIsOpen(false)}>戻る</Button>
 *       <Button color="primary" onClick={handleSubmit}>配布する</Button>
 *     </>
 *   }
 * >
 *   <div className="mp-modal__slot">
 *     {/* 自由なコンテンツ *\/}
 *   </div>
 * </Modal>
 *
 * // 3. info モーダル
 * <Modal modalStyle="info" title="お知らせ" open={isOpen} onClose={close}
 *   footer={
 *     <>
 *       <Button color="negative" onClick={close}>戻る</Button>
 *       <Button color="primary" onClick={handleOk}>確認</Button>
 *     </>
 *   }
 * >
 *   新しいダッシュボード機能が追加されました。
 * </Modal>
 *
 * // 4. error モーダル
 * <Modal modalStyle="error" title="エラー" open={isOpen} onClose={close}>
 *   データの保存に失敗しました。再度お試しください。
 * </Modal>
 *
 * // 5. 大サイズ（グラフ表示等）— ×ボタン手動指定
 * <Modal
 *   modalStyle="default"
 *   size="lg"
 *   title="生徒アプリ利用回数（クラス別）"
 *   open={isOpen}
 *   onClose={close}
 *   showClose={true}
 * >
 *   <BarChart data={classUsageData} />
 * </Modal>
 *
 * // 6. share モーダル（ラジオボタン内蔵）
 * <Modal modalStyle="share" size="sm" title="共有設定" open={isOpen} onClose={close}
 *   footer={
 *     <>
 *       <Button color="negative" onClick={close}>戻る</Button>
 *       <Button color="primary" onClick={handleShare}>共有する</Button>
 *     </>
 *   }
 * >
 *   <RadioGroup value={shareTarget} onChange={setShareTarget}>
 *     <Radio value="class">クラス</Radio>
 *     <Radio value="school">学校全体</Radio>
 *     <Radio value="district">自治体全体</Radio>
 *   </RadioGroup>
 * </Modal>
 * --------------------------------------------------------------------------- */
