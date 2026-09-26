import { ExecutionPlan, ExecutionPlanEvaluation } from '../types/plan';
import { EffectiveExecutionOptions } from '../types/config';
import { AutomationError } from '../types/errors';

/**
 * 今回の実行コンテキスト（CLIオプション等）に基づき、実際にUI書き込みを行ってよいかを判定する
 */
export function checkExecutionGate(
  plan: ExecutionPlan,
  evaluation: ExecutionPlanEvaluation,
  options: EffectiveExecutionOptions
): boolean {
  // 1. Plan 自体が論理的に実行可能か
  if (!evaluation.isExecutable) {
    const firstIssue = evaluation.blockReasons[0];
    throw new AutomationError(firstIssue.code, firstIssue.message, firstIssue.details);
  }

  // 2. 破壊的変更（予約投稿削除リスク）の明示的許可があるか
  if (evaluation.requiresDestructiveConfirmation && !options.allowDestructive) {
    const warningsText = evaluation.warnings.join(' / ');
    throw new AutomationError(
      'DESTRUCTIVE_CHANGE_BLOCKED',
      `破壊的変更が検出されましたが、--allow-destructive が指定されていないため実行をブロックしました: ${warningsText}`,
      {
        warnings: evaluation.warnings,
        allowDestructive: false
      }
    );
  }

  // 3. 書き込みゲート (--apply)
  if (!options.apply) {
    // Dry Run モードのため書き込みは行わない
    return false;
  }

  return true;
}
