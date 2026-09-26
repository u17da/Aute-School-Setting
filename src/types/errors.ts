// 実行全体の最終終了ステータス
export type ExecutionStatus =
  // 正常完了系
  | 'SUCCESS'
  | 'SUCCESS_ALREADY_CONFIGURED'
  | 'SUCCESS_RECOVERED'
  | 'DRY_RUN_COMPLETED'
  // 初期化・CLI・設定系エラー
  | 'CLI_ARGUMENT_ERROR'
  | 'CONFIG_INVALID'
  | 'CREDENTIAL_NOT_FOUND'
  | 'CHECKPOINT_MISMATCH'
  | 'CHECKPOINT_IO_ERROR'
  | 'BATCH_LOCKED'
  | 'BATCH_INPUT_INVALID'
  // 認証・画面遷移系エラー
  | 'LOGIN_FAILED'
  | 'AUTH_INTERACTION_TIMEOUT'
  | 'AUTH_OUTCOME_UNKNOWN'
  | 'SCHOOL_MISMATCH'
  | 'SETTINGS_MENU_NOT_AVAILABLE'
  | 'SETTINGS_PAGE_NOT_FOUND'
  | 'UI_STRUCTURE_MISMATCH'
  // Plan・設定バリデーション系エラー
  | 'SETTING_NOT_AVAILABLE'
  | 'CONFIG_CONFLICT'
  | 'DEPENDENCY_UNSATISFIED'
  | 'UNSAFE_CONFIGURATION'
  // Execution Gate・適用系エラー
  | 'DESTRUCTIVE_CHANGE_BLOCKED'
  | 'POC_SCOPE_VIOLATION'
  | 'PRE_SAVE_VALIDATION_FAILED'
  | 'SAVE_FAILED'
  | 'RESTORE_FAILED'
  | 'VERIFY_MISMATCH'
  | 'UNEXPECTED_SIDE_EFFECT'
  | 'TIMEOUT'
  | 'CLEANUP_TIMEOUT'
  | 'APPROVAL_AUDIT_INVALID'
  | 'INTERRUPTED'
  | 'UNEXPECTED_ERROR';

// 実行中に検出される個別Issueのコード
export type ExecutionIssueCode =
  | 'CLI_ARGUMENT_ERROR'
  | 'CONFIG_INVALID'
  | 'CREDENTIAL_NOT_FOUND'
  | 'CHECKPOINT_MISMATCH'
  | 'CHECKPOINT_IO_ERROR'
  | 'BATCH_LOCKED'
  | 'BATCH_INPUT_INVALID'
  | 'LOGIN_FAILED'
  | 'AUTH_INTERACTION_TIMEOUT'
  | 'AUTH_OUTCOME_UNKNOWN'
  | 'SCHOOL_MISMATCH'
  | 'SETTINGS_MENU_NOT_AVAILABLE'
  | 'SETTINGS_PAGE_NOT_FOUND'
  | 'UI_STRUCTURE_MISMATCH'
  | 'SETTING_NOT_AVAILABLE'
  | 'CONFIG_CONFLICT'
  | 'DEPENDENCY_UNSATISFIED'
  | 'UNSAFE_CONFIGURATION'
  | 'DESTRUCTIVE_CHANGE_BLOCKED'
  | 'POC_SCOPE_VIOLATION'
  | 'PRE_SAVE_VALIDATION_FAILED'
  | 'SAVE_FAILED'
  | 'RESTORE_FAILED'
  | 'VERIFY_MISMATCH'
  | 'UNEXPECTED_SIDE_EFFECT'
  | 'TIMEOUT'
  | 'CLEANUP_TIMEOUT'
  | 'APPROVAL_AUDIT_INVALID'
  | 'INTERRUPTED'
  | 'UNEXPECTED_ERROR';

export class AutomationError extends Error {
  public readonly status: ExecutionStatus;
  public readonly issueCode: ExecutionIssueCode;
  public readonly details?: Record<string, unknown>;

  constructor(status: ExecutionStatus, message: string, details?: Record<string, unknown>) {
    super(`[${status}] ${message}`);
    this.name = 'AutomationError';
    this.status = status;
    this.issueCode = status as ExecutionIssueCode;
    this.details = details;
    Object.setPrototypeOf(this, AutomationError.prototype);
  }
}
