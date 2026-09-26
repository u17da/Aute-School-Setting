import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactNode,
} from 'react'
import './TextField.css'

/* -------------------------------------------------------------------------
 * Public types
 * ------------------------------------------------------------------------- */
export type TextFieldVariant = 'input' | 'textarea' | 'search'
export type TextFieldSize = 'L' | 'M' | 'S'

type CommonProps = {
  /** 入力形態。`input`(1行) / `textarea`(複数行) / `search`(検索) */
  variant?: TextFieldVariant
  /** サイズ。原則 `M`。目立たせたい場合のみ `L`、狭い場所のみ `S` */
  size?: TextFieldSize
  /** 上部に表示するラベル。`<label>` 相当で input と紐付く */
  label?: string
  /** 下部に表示する補足テキスト */
  helperText?: string
  /** エラーメッセージ。空文字以外を渡すと自動で error 状態になる */
  errorText?: string
  /** 左端アイコン(variant=search のときは虫眼鏡が自動で入るので不要) */
  startIcon?: ReactNode
  /** 右端アイコン(絵文字選択など) */
  endIcon?: ReactNode
  /** 横幅いっぱいに広げる */
  block?: boolean
  /** ラッパー要素に追加するクラス */
  wrapperClassName?: string
}

type InputModeProps = CommonProps &
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
    variant?: 'input' | 'search'
  }

type TextareaModeProps = CommonProps &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> & {
    variant: 'textarea'
  }

export type TextFieldProps = InputModeProps | TextareaModeProps

/* -------------------------------------------------------------------------
 * Default search icon (依存ゼロのインラインSVG)
 * ------------------------------------------------------------------------- */
const SearchIcon = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    width="24"
    height="24"
  >
    <path
      d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"
      fill="currentColor"
    />
  </svg>
)

/* -------------------------------------------------------------------------
 * Dev-time validation
 * ------------------------------------------------------------------------- */
function warnInvalidCombination(props: TextFieldProps) {
  if (process.env.NODE_ENV === 'production') return

  const { variant = 'input', errorText, disabled, startIcon } = props as InputModeProps

  if (errorText && disabled) {
    console.warn(
      '[TextField] `disabled` と `errorText` の併用は推奨されません。' +
        '操作不可の入力欄にエラーを出すとユーザーが混乱します。',
    )
  }

  if (variant === 'search' && startIcon) {
    console.warn(
      '[TextField] variant="search" のときは虫眼鏡アイコンが自動で入ります。' +
        '`startIcon` は無視されます。',
    )
  }

  if (variant === 'textarea' && (props as InputModeProps).type) {
    console.warn(
      '[TextField] variant="textarea" に `type` props は適用されません。',
    )
  }
}

/* -------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------- */
export const TextField = forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  TextFieldProps
>(function TextField(props, ref) {
  warnInvalidCombination(props)

  const {
    variant = 'input',
    size = 'M',
    label,
    helperText,
    errorText,
    startIcon,
    endIcon,
    block = false,
    wrapperClassName,
    disabled,
    id: idFromProps,
    ...rest
  } = props as InputModeProps & TextareaModeProps

  // 一意なIDを払い出してラベル/ヘルパー/エラーと関連付ける
  const generatedId = useId()
  const id = idFromProps ?? `mp-textfield-${generatedId}`
  const helperId = `${id}-helper`
  const errorId = `${id}-error`

  const hasError = Boolean(errorText)
  const isSearch = variant === 'search'
  const isTextarea = variant === 'textarea'

  const wrapperClass = [
    'mp-textfield',
    `mp-textfield--${variant}`,
    `mp-textfield--${size.toLowerCase()}`,
    hasError && 'mp-textfield--error',
    disabled && 'mp-textfield--disabled',
    block && 'mp-textfield--block',
    wrapperClassName,
  ]
    .filter(Boolean)
    .join(' ')

  // describedby: helperText と errorText の両方ある場合に連結
  const describedBy =
    [helperText && helperId, hasError && errorId].filter(Boolean).join(' ') ||
    undefined

  // 共通の aria 属性
  const sharedInputProps = {
    id,
    'aria-invalid': hasError || undefined,
    'aria-errormessage': hasError ? errorId : undefined,
    'aria-describedby': describedBy,
    'aria-disabled': disabled || undefined,
    disabled,
  }

  return (
    <div className={wrapperClass}>
      {label && (
        <label
          htmlFor={id}
          className={[
            'mp-textfield__helper',
            'mp-textfield__helper--top',
            disabled && 'mp-textfield__helper--disabled',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {label}
        </label>
      )}

      <div className="mp-textfield__container">
        {/* 左アイコン: search なら自動、それ以外は startIcon があれば */}
        {(isSearch || startIcon) && (
          <span className="mp-textfield__icon-start" aria-hidden="true">
            {isSearch ? <SearchIcon /> : startIcon}
          </span>
        )}

        {isTextarea ? (
          <textarea
            ref={ref as React.Ref<HTMLTextAreaElement>}
            className="mp-textfield__input"
            {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
            {...sharedInputProps}
          />
        ) : (
          <input
            ref={ref as React.Ref<HTMLInputElement>}
            className="mp-textfield__input"
            type={(rest as InputHTMLAttributes<HTMLInputElement>).type ?? 'text'}
            {...(rest as InputHTMLAttributes<HTMLInputElement>)}
            {...sharedInputProps}
          />
        )}

        {endIcon && !isSearch && (
          <span className="mp-textfield__icon-end" aria-hidden="true">
            {endIcon}
          </span>
        )}
      </div>

      {hasError ? (
        <span
          id={errorId}
          role="alert"
          className="mp-textfield__helper mp-textfield__helper--bottom mp-textfield__helper--error"
        >
          {errorText}
        </span>
      ) : (
        helperText && (
          <span
            id={helperId}
            className={[
              'mp-textfield__helper',
              'mp-textfield__helper--bottom',
              disabled && 'mp-textfield__helper--disabled',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {helperText}
          </span>
        )
      )}
    </div>
  )
})

/* -------------------------------------------------------------------------
 * 使用例
 * -------------------------------------------------------------------------
 *
 * // 1) 基本のフォーム項目
 * <TextField
 *   label="氏名"
 *   placeholder="例: 山田太郎"
 *   helperText="姓と名の間にスペースを入れてください"
 * />
 *
 * // 2) バリデーションエラー
 * <TextField
 *   label="メールアドレス"
 *   value={email}
 *   onChange={(e) => setEmail(e.target.value)}
 *   errorText={!isValid ? '正しい形式で入力してください' : ''}
 * />
 *
 * // 3) 複数行入力
 * <TextField
 *   variant="textarea"
 *   label="お問い合わせ内容"
 *   rows={5}
 *   size="L"
 *   block
 * />
 *
 * // 4) 検索バー
 * <TextField
 *   variant="search"
 *   placeholder="授業を検索"
 *   value={query}
 *   onChange={(e) => setQuery(e.target.value)}
 * />
 *
 * // 5) 無効化
 * <TextField label="登録番号" value="A-12345" disabled />
 *
 * // 6) 右側にカスタムアイコン
 * <TextField
 *   label="気分"
 *   endIcon={<EmojiIcon />}
 * />
 *
 * ------------------------------------------------------------------------- */
