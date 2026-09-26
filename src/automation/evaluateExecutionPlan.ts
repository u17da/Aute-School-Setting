import { ExecutionPlan, ExecutionPlanEvaluation, ExecutionIssue } from '../types/plan';
import { DEPENDENCY_RULES } from '../settings/dependencies';
import { SettingKey } from '../types/settings';

/**
 * ExecutionPlan そのものが論理的に成立しているかを判定する
 * ※破壊的変更があっても、Plan自体が論理的に正しければ isExecutable: true, requiresDestructiveConfirmation: true とする
 */
export function evaluateExecutionPlan(plan: ExecutionPlan): ExecutionPlanEvaluation {
  const blockReasons: ExecutionIssue[] = [];

  // 1. 契約外不在設定への明示要求チェック (mentalHealth 等)
  for (const [key, item] of Object.entries(plan.items) as [SettingKey, any][]) {
    if (item.current.availability === 'CONTRACT_NOT_AVAILABLE' && item.requested !== null) {
      blockReasons.push({
        code: 'SETTING_NOT_AVAILABLE',
        message: `契約上非表示の設定「${item.label}」に対して設定変更要求(${item.requested})が指定されています`,
        settingKey: key,
        details: { requested: item.requested }
      });
    }
  }

  // 2. Runtime 依存関係充足チェック
  for (const rule of DEPENDENCY_RULES) {
    const parentItem = plan.items[rule.parentKey];
    const childItem = plan.items[rule.childKey];

    // 親設定の最終期待値がOFFなのに、子が明示的にONを要求している場合 (子の現在availabilityがAVAILABLE/DISABLED_BY_DEPENDENCY問わずブロック)
    if (childItem.requested === 'ON' && parentItem.expected.value === 'OFF') {
      blockReasons.push({
        code: 'DEPENDENCY_UNSATISFIED',
        message: `依存関係未充足: 「${childItem.label}」をONにするには親設定「${parentItem.label}」がONである必要がありますが、親設定の最終状態はOFFです (parentRequested=${parentItem.requested ?? 'null'}, parentCurrent=${parentItem.current.value})`,
        settingKey: rule.childKey,
        details: {
          parentKey: rule.parentKey,
          parentCurrent: parentItem.current.value,
          parentRequested: parentItem.requested,
          childRequested: childItem.requested
        }
      });
    }
  }

  const isExecutable = blockReasons.length === 0;
  const requiresApply = plan.hasChanges;
  const requiresDestructiveConfirmation = plan.hasDestructiveChanges;

  return {
    isExecutable,
    blockReasons,
    warnings: [...plan.warnings],
    requiresApply,
    requiresDestructiveConfirmation
  };
}
