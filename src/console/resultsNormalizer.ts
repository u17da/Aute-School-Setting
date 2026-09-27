import { BatchSummaryReport, CheckpointStatus } from '../types/batch';
import { SettingKey, SettingValue } from '../types/settings';
import { ALL_SETTING_KEYS, SETTING_DEFINITIONS, valueToLabel } from '../settings/definitions';
import {
  ExecutionResultCategory,
  ExecutionChangeDetail,
  ExecutionSchoolResultViewModel,
  ExecutionResultViewModel,
  ConsoleError
} from './types';

/**
 * CheckpointStatus から UI集計・表示用 ExecutionResultCategory への決定論的マッピング (SSOT)
 */
export function categorizeCheckpointStatus(status: CheckpointStatus): ExecutionResultCategory {
  switch (status) {
    case 'SUCCESS':
    case 'SUCCESS_RECOVERED':
      return 'APPLIED';
    case 'SUCCESS_ALREADY_CONFIGURED':
      return 'ALREADY_CONFIGURED';
    case 'SKIPPED_DESTRUCTIVE':
      return 'SKIPPED';
    case 'PREFLIGHT_STATE_CHANGED':
    case 'PLAN_BLOCKED':
      return 'BLOCKED';
    case 'SAVE_FAILED_KNOWN':
    case 'FAILED':
      return 'FAILED_KNOWN';
    case 'SAVE_OUTCOME_UNKNOWN':
      return 'OUTCOME_UNKNOWN';
    case 'INTERRUPTED':
      return 'INTERRUPTED';
    case 'PENDING':
      return 'NOT_PROCESSED';
    case 'RUNNING':
      return 'RESULT_INCONSISTENT';
    default:
      return 'RESULT_INCONSISTENT';
  }
}

/**
 * before / after のレコードから実際の差分リスト (ExecutionChangeDetail[]) を抽出する純粋関数
 */
export function extractExecutionChangeDetails(
  before: Partial<Record<string, string | null>> | undefined,
  after: Partial<Record<string, string | null>> | undefined
): ExecutionChangeDetail[] {
  if (!before || !after) {
    return [];
  }

  const changes: ExecutionChangeDetail[] = [];

  for (const key of ALL_SETTING_KEYS) {
    const beforeVal = before[key] ?? null;
    const afterVal = after[key] ?? null;

    if (beforeVal !== afterVal) {
      const def = SETTING_DEFINITIONS[key];
      const settingLabel = def ? def.label : key;

      const beforeLabel = beforeVal !== null ? valueToLabel(key, beforeVal as SettingValue) : '未設定';
      const afterLabel = afterVal !== null ? valueToLabel(key, afterVal as SettingValue) : '未設定';

      changes.push({
        settingKey: key,
        settingLabel,
        before: beforeVal as SettingValue | null,
        after: afterVal as SettingValue | null,
        beforeLabel,
        afterLabel
      });
    }
  }

  return changes;
}

export interface NormalizeOptions {
  allSchools?: Array<{ schoolCode: string; schoolName?: string; enabled?: boolean }>;
  executionScopeCodes?: string[] | Set<string>;
}

/**
 * BatchSummaryReport から ExecutionResultViewModel を構築する純粋関数 (Normalizer)
 * Filesystem / HTTP / DOM に一切依存しない決定論的変換を行う。
 */
export function normalizeExecutionResult(
  summary: BatchSummaryReport,
  options?: NormalizeOptions
): ExecutionResultViewModel {
  // 1. Contract Validation
  if (!summary || typeof summary !== 'object') {
    throw new ConsoleError('INVALID_REQUEST', '[RESULT_CONTRACT_INVALID] サマリデータが存在しないか不正です');
  }

  if (summary.mode !== 'PRODUCTION_WRITE') {
    throw new ConsoleError('PURPOSE_MISMATCH', `[RESULT_CONTRACT_INVALID] 本番書き込みモードのサマリではありません (mode=${summary.mode})`);
  }

  if (!Array.isArray(summary.schoolResults)) {
    throw new ConsoleError('INVALID_REQUEST', '[RESULT_CONTRACT_INVALID] schoolResults 配列が存在しません');
  }

  // 2. Execution Scope (母集団) の決定
  // 優先順位: options.executionScopeCodes > summary.executionScopeCodes > options.allSchools(enabled !== false)
  let scopeSet: Set<string> | null = null;
  if (options?.executionScopeCodes) {
    scopeSet = options.executionScopeCodes instanceof Set
      ? options.executionScopeCodes
      : new Set(options.executionScopeCodes);
  } else if (summary.executionScopeCodes && Array.isArray(summary.executionScopeCodes)) {
    scopeSet = new Set(summary.executionScopeCodes);
  } else if (options?.allSchools && options.allSchools.length > 0) {
    const hasEnabledFlag = options.allSchools.some((s) => typeof s.enabled === 'boolean');
    if (hasEnabledFlag) {
      scopeSet = new Set(options.allSchools.filter((s) => s.enabled !== false).map((s) => s.schoolCode));
    }
  }

  let rawSchoolResults: Array<typeof summary.schoolResults[number]> = [];

  if (scopeSet) {
    // Execution Scope が定義されている場合:
    // Scope 内の学校のみを結果母集団とし、Scope 外の学校 (disabled, targetFilter外, Canary limit外) は除外する
    const existingMap = new Map(summary.schoolResults.map((r) => [r.schoolCode, r]));
    const schoolNameMap = new Map((options?.allSchools || []).map((s) => [s.schoolCode, s.schoolName || s.schoolCode]));

    for (const code of scopeSet) {
      const existing = existingMap.get(code);
      if (existing) {
        rawSchoolResults.push(existing);
      } else {
        // Scope 内に入っていたが、先行校の安全停止等により処理されなかった学校は PENDING として安全補完
        rawSchoolResults.push({
          schoolCode: code,
          schoolName: schoolNameMap.get(code) || code,
          status: 'PENDING',
          actionsCount: 0
        });
      }
    }
  } else {
    // 明示的な Execution Scope がない場合 (従来の動作との互換維持):
    rawSchoolResults = [...summary.schoolResults];
    const totalSchools = summary.totalSchools ?? rawSchoolResults.length;
    if (rawSchoolResults.length < totalSchools) {
      const existingCodes = new Set(rawSchoolResults.map((r) => r.schoolCode));
      if (options?.allSchools && options.allSchools.length > 0) {
        for (const s of options.allSchools) {
          if (!existingCodes.has(s.schoolCode)) {
            rawSchoolResults.push({
              schoolCode: s.schoolCode,
              schoolName: s.schoolName || s.schoolCode,
              status: 'PENDING',
              actionsCount: 0
            });
            existingCodes.add(s.schoolCode);
          }
        }
      } else {
        const missingCount = totalSchools - rawSchoolResults.length;
        for (let i = 1; i <= missingCount; i++) {
          const dummyCode = `PENDING_${i}`;
          rawSchoolResults.push({
            schoolCode: dummyCode,
            schoolName: `未処理校 (${dummyCode})`,
            status: 'PENDING',
            actionsCount: 0
          });
        }
      }
    }
  }

  const schools: ExecutionSchoolResultViewModel[] = [];

  let appliedSuccessCount = 0;
  let alreadyConfiguredCount = 0;
  let skippedDestructiveCount = 0;
  let blockedCount = 0;
  let failedKnownCount = 0;
  let outcomeUnknownCount = 0;
  let interruptedCount = 0;
  let notProcessedCount = 0;
  let inconsistentCount = 0;

  for (const sr of rawSchoolResults) {
    if (!sr.schoolCode || !sr.status) {
      throw new ConsoleError('INVALID_REQUEST', `[RESULT_CONTRACT_INVALID] 学校結果レコードに必須項目 (schoolCode / status) が不足しています: ${JSON.stringify(sr)}`);
    }

    let category = categorizeCheckpointStatus(sr.status);
    const changes = extractExecutionChangeDetails(sr.before, sr.after);
    const actionsCount = sr.actionsCount ?? changes.length;

    let requiresHumanReview = false;
    let message = '';

    // 不整合検出 (要件 6, 7)
    // A. SUCCESS だが actionsCount > 0 かつ changes.length === 0
    if ((sr.status === 'SUCCESS' || sr.status === 'SUCCESS_RECOVERED') && actionsCount > 0 && changes.length === 0) {
      category = 'RESULT_INCONSISTENT';
      requiresHumanReview = true;
      message = '実行結果データに不整合があります（アクション数と実差分が一致しません：差分(changes)が0件）。手動確認が必要です。';
    }
    // B. SUCCESS だが actionsCount === 0 かつ changes.length > 0
    else if ((sr.status === 'SUCCESS' || sr.status === 'SUCCESS_RECOVERED') && actionsCount === 0 && changes.length > 0) {
      category = 'RESULT_INCONSISTENT';
      requiresHumanReview = true;
      message = '実行結果データに不整合があります（アクション数0件ですが実差分が存在します）。手動確認が必要です。';
    }
    // C. SUCCESS_ALREADY_CONFIGURED だが changes.length > 0
    else if (sr.status === 'SUCCESS_ALREADY_CONFIGURED' && changes.length > 0) {
      category = 'RESULT_INCONSISTENT';
      requiresHumanReview = true;
      message = '実行結果データに不整合があります（設定済判定ですが実差分が存在します）。手動確認が必要です。';
    }
    // D. SKIPPED_DESTRUCTIVE だが changes.length > 0
    else if (sr.status === 'SKIPPED_DESTRUCTIVE' && changes.length > 0) {
      category = 'RESULT_INCONSISTENT';
      requiresHumanReview = true;
      message = '実行結果データに不整合があります（破壊的変更スキップですが実差分が存在します）。手動確認が必要です。';
    }
    // E. RUNNING が完了サマリに残存している場合
    else if (sr.status === 'RUNNING') {
      category = 'RESULT_INCONSISTENT';
      requiresHumanReview = true;
      message = '実行結果データに不整合があります（完了サマリにRUNNING状態が残存しています）。手動確認が必要です。';
    }

    switch (category) {
      case 'APPLIED': {
        appliedSuccessCount++;
        if (changes.length > 0) {
          const changeSummary = changes.map((c) => `${c.settingLabel}: ${c.beforeLabel} → ${c.afterLabel}`).join(', ');
          if (sr.status === 'SUCCESS_RECOVERED') {
            message = `${changes.length}項目変更完了 (リカバリ成功: ${changeSummary})`;
          } else {
            message = `${changes.length}項目変更完了 (${changeSummary})`;
          }
        } else {
          message = sr.status === 'SUCCESS_RECOVERED' ? 'リカバリ成功により設定変更完了' : '設定変更完了';
        }
        break;
      }

      case 'ALREADY_CONFIGURED': {
        alreadyConfiguredCount++;
        message = '設定変更不要（既に設定済）';
        break;
      }

      case 'SKIPPED': {
        skippedDestructiveCount++;
        message = '破壊的変更を伴うため安全のため自動除外';
        break;
      }

      case 'BLOCKED': {
        blockedCount++;
        message = sr.error || (sr.status === 'PREFLIGHT_STATE_CHANGED'
          ? '事前確認時と画面設定が異なっていたため安全のためスキップしました'
          : '依存関係等の制約により変更がブロックされました');
        break;
      }

      case 'FAILED_KNOWN': {
        failedKnownCount++;
        message = sr.error || (sr.status === 'SAVE_FAILED_KNOWN'
          ? '保存処理後に設定値が反映されなかったことが確定しました'
          : '設定の適用に失敗しました');
        break;
      }

      case 'OUTCOME_UNKNOWN': {
        outcomeUnknownCount++;
        requiresHumanReview = true;
        message = '保存結果を確定できません。手動確認が必要です。';
        break;
      }

      case 'INTERRUPTED': {
        interruptedCount++;
        requiresHumanReview = true;
        message = '処理が中断されました。未完了の可能性があります。';
        break;
      }

      case 'NOT_PROCESSED': {
        notProcessedCount++;
        message = '安全停止または中断により未処理';
        requiresHumanReview = false;
        break;
      }

      case 'RESULT_INCONSISTENT': {
        inconsistentCount++;
        requiresHumanReview = true;
        if (!message) {
          message = '実行結果データに不整合があります。手動確認が必要です。';
        }
        break;
      }
    }

    schools.push({
      schoolCode: sr.schoolCode,
      schoolName: sr.schoolName || sr.schoolCode,
      status: sr.status,
      category,
      actionsCount,
      changes,
      message,
      requiresHumanReview,
      errorMessage: sr.error
    });
  }

  // 母集団 (totalCount) は今回の Production Execution Scope の学校総数 (schools.length)
  const totalCount = schools.length;
  // processedCount は「今回の Execution Scope のうち、実際に試行・確定（成功、設定済、スキップ、ブロック、失敗、結果不明、中断等）された学校数」
  // notProcessedCount は「今回の Execution Scope 内にあったが、先行校の安全停止（SAVE_OUTCOME_UNKNOWN / Circuit Breaker / Operator Stop等）により未処理となった学校数」
  const processedCount = totalCount - notProcessedCount;

  // attentionRequiredCount SSOT (要件 8: requiresHumanReview === true の学校数)
  const attentionRequiredCount = schools.filter((s) => s.requiresHumanReview).length;

  // Invariant チェック (要件 2 & 7: 全カテゴリの合計が対象総数と厳密に一致すること)
  const sumCategories =
    appliedSuccessCount +
    alreadyConfiguredCount +
    skippedDestructiveCount +
    blockedCount +
    failedKnownCount +
    outcomeUnknownCount +
    interruptedCount +
    notProcessedCount +
    inconsistentCount;

  if (sumCategories !== totalCount || schools.length !== totalCount) {
    throw new ConsoleError(
      'INVALID_REQUEST',
      `[RESULT_INCONSISTENT] カテゴリ集計の合計 (${sumCategories}) または学校結果数 (${schools.length}) が対象総数 (${totalCount}) と一致しません`
    );
  }

  return {
    mode: 'PRODUCTION_WRITE',
    deploymentId: summary.deploymentId,
    runId: summary.runId,
    completedAt: summary.finishedAt || new Date().toISOString(),
    totalCount,
    processedCount,
    appliedSuccessCount,
    alreadyConfiguredCount,
    skippedDestructiveCount,
    blockedCount,
    failedKnownCount,
    outcomeUnknownCount,
    interruptedCount,
    notProcessedCount,
    inconsistentCount,
    attentionRequiredCount,
    schools
  };
}
