import * as React from 'react';
import './avatar.css';

/**
 * まなびポケット Design System — Avatar
 *
 * プロフィール写真でユーザーを識別するコンポーネント。
 * 仕様の詳細は同ディレクトリの `avatar.md` を参照。
 */

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

export type AvatarSize = 's' | 'm' | 'l';

export interface AvatarProps extends Omit<React.HTMLAttributes<HTMLElement>, 'onClick'> {
  /** ユーザー名（フォールバック頭文字 / alt / aria-label に使用） */
  name: string;
  /** 画像 URL。未指定 or エラー時は頭文字フォールバック */
  src?: string;
  /** サイズ。デフォルトは 'm' */
  size?: AvatarSize;
  /** 名前テキストを隣に表示するか。デフォルト false */
  showName?: boolean;
  /** クリック可能にするか */
  onClick?: (e: React.MouseEvent) => void;
}

/* ---------------------------------------------------------------------------
 * Helper: 先頭1文字取得
 * --------------------------------------------------------------------------- */

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

/* ---------------------------------------------------------------------------
 * Component
 * --------------------------------------------------------------------------- */

export const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  function Avatar(
    {
      name,
      src,
      size = 'm',
      showName = false,
      onClick,
      className,
      ...rest
    },
    ref,
  ) {
    const [imgError, setImgError] = React.useState(false);
    const useFallback = !src || imgError;
    const clickable = !!onClick;

    /* --- Dev-time warnings ---------------------------------------------- */
    if (process.env.NODE_ENV !== 'production') {
      if (!name) {
        console.warn('[Avatar] name は必須です（アクセシビリティ要件）');
      }
    }

    /* --- Reset error on src change -------------------------------------- */
    React.useEffect(() => {
      setImgError(false);
    }, [src]);

    /* --- Icon element --------------------------------------------------- */
    const iconCls = [
      'mp-avatar',
      `mp-avatar--${size}`,
      useFallback && 'mp-avatar--fallback',
      clickable && 'mp-avatar--clickable',
    ]
      .filter(Boolean)
      .join(' ');

    const iconEl = (
      <span
        className={iconCls}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={showName ? undefined : name}
        onClick={onClick}
        onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick?.(e as unknown as React.MouseEvent); } : undefined}
      >
        {useFallback ? (
          getInitial(name)
        ) : (
          <img
            className="mp-avatar__img"
            src={src}
            alt={showName ? '' : name}
            onError={() => setImgError(true)}
          />
        )}
      </span>
    );

    /* --- Icon only ------------------------------------------------------ */
    if (!showName) {
      return (
        <div ref={ref} className={className} style={{ display: 'inline-flex' }} {...rest}>
          {iconEl}
        </div>
      );
    }

    /* --- Named (icon + name) -------------------------------------------- */
    const namedCls = [
      'mp-avatar-named',
      `mp-avatar-named--${size}`,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div ref={ref} className={namedCls} {...rest}>
        {iconEl}
        <span className="mp-avatar__name">{name}</span>
      </div>
    );
  },
);

Avatar.displayName = 'Avatar';
export default Avatar;

/* ---------------------------------------------------------------------------
 * 使用例
 *
 * // 1. 写真あり（アイコンのみ）
 * <Avatar src="/photos/yamada.jpg" name="山田太郎" size="m" />
 *
 * // 2. 写真なし → 頭文字「上」が #008299 背景で表示
 * <Avatar name="上田一郎" size="m" />
 *
 * // 3. アイコン＋名前
 * <Avatar src="/photos/yamada.jpg" name="山田太郎" size="m" showName />
 *
 * // 4. サイズバリエーション
 * <Avatar name="佐藤宏" size="s" showName />
 * <Avatar name="佐藤宏" size="m" showName />
 * <Avatar name="佐藤宏" size="l" showName />
 *
 * // 5. クリック可能（プロフィール遷移等）
 * <Avatar name="新井花子" src="/photos/arai.jpg" size="l" onClick={goToProfile} />
 *
 * // 6. コメント欄での使用
 * <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
 *   <Avatar src="/photos/teacher.jpg" name="田中先生" size="s" />
 *   <div>
 *     <strong>田中先生</strong>
 *     <p>よくできました！</p>
 *   </div>
 * </div>
 * --------------------------------------------------------------------------- */
