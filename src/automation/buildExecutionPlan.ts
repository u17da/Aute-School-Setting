import { SettingKey, SettingValue, SettingObservation, SettingExpectation, SettingAvailability } from '../types/settings';
import { RequestedSettings } from '../types/config';
import { ExecutionPlan, SettingPlanItem, PlanAction, DependencyEffect, ChangeReason } from '../types/plan';
import { SETTING_DEFINITIONS, ALL_SETTING_KEYS } from '../settings/definitions';
import { DEPENDENCY_RULES, getParentDependencyRule } from '../settings/dependencies';

export interface BuildPlanParams {
  schoolCode: string;
  schoolName: string;
  currentObservation: Record<SettingKey, SettingObservation>;
  requestedSettings: RequestedSettings;
}

/**
 * ExecutionPlan を生成する純粋関数（副作用なし・実行可否判断なし）
 */
export function buildExecutionPlan(params: BuildPlanParams): ExecutionPlan {
  const { schoolCode, schoolName, currentObservation, requestedSettings } = params;

  const items: Partial<Record<SettingKey, SettingPlanItem>> = {};
  const warnings: string[] = [];
  const dependencyEffects: DependencyEffect[] = [];

  // 親設定から順序よく期待値を導出
  const orderedKeys: SettingKey[] = [
    'timelineChannel',
    'allChannel',
    'parentChannel',
    'directMessage',
    'parentDirectMessage',
    'storage',
    'attendance',
    'contactBook',
    'mentalHealth',
    'otherSchoolLog',
    'studentPasswordChange'
  ];

  for (const key of orderedKeys) {
    const def = SETTING_DEFINITIONS[key];
    const current = currentObservation?.[key] || { value: null, availability: 'AVAILABLE' };
    const requested = (requestedSettings[key] !== undefined ? requestedSettings[key] : null) as SettingValue | null;

    // 画面に存在しない契約外設定 (例: mentalHealth が CONTRACT_NOT_AVAILABLE)
    if (current.availability === 'CONTRACT_NOT_AVAILABLE') {
      items[key] = {
        settingKey: key,
        label: def.label,
        current,
        requested,
        expected: {
          value: null,
          availability: 'CONTRACT_NOT_AVAILABLE'
        },
        reason: 'UNCHANGED',
        isDestructive: false
      };
      continue;
    }

    let expectedValue: SettingValue | null = current.value;
    let expectedAvailability: SettingAvailability | undefined = current.availability;
    let reason: ChangeReason = 'UNCHANGED';

    if (requested !== null) {
      expectedValue = requested;
      reason = 'EXPLICIT';
    } else {
      // requested が null の場合、親設定の期待値による依存伝播を確認
      const parentRule = getParentDependencyRule(key);
      if (parentRule) {
        const parentItem = items[parentRule.parentKey];
        if (parentItem && parentItem.expected.value !== null && parentRule.isParentOff(parentItem.expected.value)) {
          expectedValue = parentRule.forcedChildValueWhenParentOff;
          expectedAvailability = parentRule.forcedChildAvailabilityWhenParentOff ?? current.availability;
          if (current.value !== expectedValue || current.availability !== expectedAvailability) {
            reason = 'DEPENDENCY';
            dependencyEffects.push({
              sourceSettingKey: parentRule.parentKey,
              targetSettingKey: key,
              targetLabel: def.label,
              effectType: parentRule.effectType,
              beforeValue: current.value,
              expectedValue,
              expectedAvailability,
              rule: parentRule.effectType === 'AVAILABILITY_CHANGE'
                ? `親設定「${parentItem.label}」がOFFになるため利用不能(${expectedAvailability})`
                : `親設定「${parentItem.label}」がOFFになるため連動OFF`
            });
          }
        }
      }
    }

    // 破壊的変更（予約投稿削除リスク）の判定: current=ON かつ expected=OFF
    let isDestructive = false;
    let destructiveWarning: string | undefined;

    if (def.destructiveWhenOff && current.value === 'ON' && expectedValue === 'OFF') {
      isDestructive = true;
      destructiveWarning = `「${def.label}」をONからOFFにするため、未投稿の予約投稿が削除される可能性があります`;
      warnings.push(destructiveWarning);
    }

    items[key] = {
      settingKey: key,
      label: def.label,
      current,
      requested,
      expected: {
        value: expectedValue,
        availability: expectedAvailability
      },
      reason,
      isDestructive,
      destructiveWarning
    };
  }

  // 操作列（actions）の生成: Playwright が直接クリックする操作のみ（連動で変化する項目は除外）
  const actions: PlanAction[] = [];
  let actionOrder = 1;

  // 1. timelineChannel の操作
  const timelineItem = items.timelineChannel!;
  if (timelineItem.current.value !== timelineItem.expected.value && timelineItem.requested !== null) {
    actions.push({
      order: actionOrder++,
      settingKey: 'timelineChannel',
      label: timelineItem.label,
      from: timelineItem.current.value,
      to: timelineItem.expected.value as SettingValue,
      requiresUiSync: true // 連動する allChannel / parentChannel の状態確認のため
    });
  }

  // 2. 子設定 (allChannel, parentChannel) の明示的クリック操作
  // ※親がOFFになる場合は自動連動でOFFになるため、子が requested !== null かつ親がOFFにならない場合のみ操作
  for (const childKey of ['allChannel', 'parentChannel'] as SettingKey[]) {
    const childItem = items[childKey]!;
    if (
      childItem.current.value !== childItem.expected.value &&
      childItem.requested !== null &&
      childItem.reason === 'EXPLICIT'
    ) {
      actions.push({
        order: actionOrder++,
        settingKey: childKey,
        label: childItem.label,
        from: childItem.current.value,
        to: childItem.expected.value as SettingValue,
        requiresUiSync: false
      });
    }
  }

  // 3. directMessage の操作
  const dmItem = items.directMessage!;
  if (dmItem.current.value !== dmItem.expected.value && dmItem.requested !== null) {
    actions.push({
      order: actionOrder++,
      settingKey: 'directMessage',
      label: dmItem.label,
      from: dmItem.current.value,
      to: dmItem.expected.value as SettingValue,
      requiresUiSync: true
    });
  }

  // 4. parentDirectMessage の明示的クリック操作
  const parentDmItem = items.parentDirectMessage!;
  if (
    parentDmItem.current.value !== parentDmItem.expected.value &&
    parentDmItem.requested !== null &&
    parentDmItem.reason === 'EXPLICIT'
  ) {
    actions.push({
      order: actionOrder++,
      settingKey: 'parentDirectMessage',
      label: parentDmItem.label,
      from: parentDmItem.current.value,
      to: parentDmItem.expected.value as SettingValue,
      requiresUiSync: false
    });
  }

  // 5. その他の独立設定項目
  const remainingKeys: SettingKey[] = [
    'storage',
    'attendance',
    'contactBook',
    'mentalHealth',
    'otherSchoolLog',
    'studentPasswordChange'
  ];

  for (const key of remainingKeys) {
    const item = items[key]!;
    if (
      item.current.availability === 'AVAILABLE' &&
      item.current.value !== item.expected.value &&
      item.requested !== null
    ) {
      actions.push({
        order: actionOrder++,
        settingKey: key,
        label: item.label,
        from: item.current.value,
        to: item.expected.value as SettingValue,
        requiresUiSync: false
      });
    }
  }

  // Pre-Save / Post-Save 期待値マップの構築 (Phase 4C実仕様反映)
  const preSaveExpectations: Partial<Record<SettingKey, SettingExpectation>> = {};
  const postSaveExpectations: Partial<Record<SettingKey, SettingExpectation>> = {};

  const actionMap = new Map<SettingKey, PlanAction>();
  for (const act of actions) {
    actionMap.set(act.settingKey, act);
  }

  for (const key of ALL_SETTING_KEYS) {
    const item = items[key]!;
    // Post-Save は items[key].expected そのもの (サーバー永続化後の期待状態)
    postSaveExpectations[key] = {
      value: item.expected.value,
      availability: item.expected.availability
    };

    // Pre-Save はクライアントDOM上での操作直後:
    // actions に含まれる項目は action.to (AVAILABLE)、それ以外は current (Baseline) のまま
    const action = actionMap.get(key);
    if (action) {
      preSaveExpectations[key] = {
        value: action.to,
        availability: 'AVAILABLE'
      };
    } else {
      preSaveExpectations[key] = {
        value: item.current.value,
        availability: item.current.availability
      };
    }
  }

  const hasChanges = Object.values(items).some(
    (item) => item?.current.value !== item?.expected.value || item?.current.availability !== item?.expected.availability
  );
  const hasDestructiveChanges = Object.values(items).some((item) => item?.isDestructive);

  return {
    schoolCode,
    schoolName,
    items: items as Record<SettingKey, SettingPlanItem>,
    actions,
    dependencyEffects,
    hasChanges,
    hasDestructiveChanges,
    warnings,
    preSaveExpectations: preSaveExpectations as Record<SettingKey, SettingExpectation>,
    postSaveExpectations: postSaveExpectations as Record<SettingKey, SettingExpectation>
  };
}
