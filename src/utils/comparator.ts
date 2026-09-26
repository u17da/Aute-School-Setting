import { SettingKey, SettingObservation, SettingExpectation, SchoolSettingsObservation } from '../types/settings';
import { ExecutionPlan, ChangeReason } from '../types/plan';

export interface SettingComparisonResult {
  matches: boolean;
  valueMatches: boolean;
  availabilityMatches: boolean;
  actual: SettingObservation;
  expected: SettingExpectation;
}

/**
 * 実画面から観測した状態 (Observation) と 期待状態 (Expectation) を比較する単一の真実（SSOT）関数
 *
 * ルール:
 * 1. value: expected.value と actual.value は常に一致必須
 * 2. availability: expected.availability が undefined の場合は検証対象外（true扱い）
 *    指定されている場合は actual.availability === expected.availability を必須とする
 */
export function compareObservationToExpectation(
  actual: SettingObservation,
  expected: SettingExpectation
): SettingComparisonResult {
  const valueMatches = actual.value === expected.value;
  const availabilityMatches =
    expected.availability === undefined
      ? true
      : actual.availability === expected.availability;

  return {
    matches: valueMatches && availabilityMatches,
    valueMatches,
    availabilityMatches,
    actual,
    expected
  };
}

/**
 * 全11項目について実際のObservationと期待状態を一括比較するSSOT関数
 */
export function compareAllSettingsObservations(
  actual: SchoolSettingsObservation,
  expected: Record<SettingKey, SettingExpectation>
): { isMatched: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const keys = Object.keys(actual) as SettingKey[];

  for (const key of keys) {
    const act = actual[key];
    const exp = expected[key];
    if (!exp) continue;
    const res = compareObservationToExpectation(act, exp);
    if (!res.matches) {
      mismatches.push(
        `[${key}] 期待値(val=${exp.value}, avail=${exp.availability ?? 'any'}) != 実測値(val=${act.value}, avail=${act.availability})`
      );
    }
  }

  return {
    isMatched: mismatches.length === 0,
    mismatches
  };
}

export interface PlanValidationResult {
  isValid: boolean;
  mismatches: Array<{
    key: SettingKey;
    reason: ChangeReason;
    actual: SettingObservation;
    expected: SettingExpectation;
    message: string;
  }>;
  hasUnexpectedSideEffect: boolean;
}

/**
 * 指示1, 2, Phase 4C: Pre-SaveおよびPost-Saveの全11項目を分離された期待値マップで比較検証する
 */
export function validateObservationMatchesPlan(
  actual: SchoolSettingsObservation,
  plan: ExecutionPlan,
  stage: 'PRE_SAVE' | 'POST_SAVE' = 'POST_SAVE'
): PlanValidationResult {
  const mismatches: PlanValidationResult['mismatches'] = [];
  let hasUnexpectedSideEffect = false;

  const expectations =
    stage === 'PRE_SAVE' && plan.preSaveExpectations
      ? plan.preSaveExpectations
      : stage === 'POST_SAVE' && plan.postSaveExpectations
      ? plan.postSaveExpectations
      : null;

  for (const [keyStr, planItem] of Object.entries(plan.items)) {
    const key = keyStr as SettingKey;
    const act = actual[key];
    if (!act) {
      mismatches.push({
        key,
        reason: planItem.reason,
        actual: { value: null, availability: 'CONTRACT_NOT_AVAILABLE' },
        expected: planItem.expected,
        message: `[${key}] 観測値が存在しません`
      });
      continue;
    }

    const exp = expectations ? expectations[key] : planItem.expected;
    const res = compareObservationToExpectation(act, exp);

    if (!res.matches) {
      if (stage === 'PRE_SAVE') {
        const isActionTarget = plan.actions.some((a) => a.settingKey === key);
        if (!isActionTarget) {
          hasUnexpectedSideEffect = true;
        }
      } else {
        if (planItem.reason === 'UNCHANGED') {
          hasUnexpectedSideEffect = true;
        }
      }
      mismatches.push({
        key,
        reason: planItem.reason,
        actual: act,
        expected: exp,
        message: `[${key}] ステージ=${stage}, 理由=${planItem.reason}: 期待値(val=${exp.value}, avail=${exp.availability ?? 'any'}) != 実測値(val=${act.value}, avail=${act.availability})`
      });
    }
  }

  return {
    isValid: mismatches.length === 0,
    mismatches,
    hasUnexpectedSideEffect
  };
}
