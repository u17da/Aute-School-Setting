import { SettingKey, SettingValue, SettingAvailability } from '../types/settings';
import { DependencyEffectType } from '../types/plan';

export interface DependencyRule {
  parentKey: SettingKey;
  childKey: SettingKey;
  isParentOff: (parentValue: SettingValue | 'NOT_AVAILABLE') => boolean;
  forcedChildValueWhenParentOff: SettingValue | null;
  forcedChildAvailabilityWhenParentOff?: SettingAvailability;
  effectType: DependencyEffectType;
  destructiveIfChildChangedToOff: boolean;
}

// 依存ルール定義
export const DEPENDENCY_RULES: DependencyRule[] = [
  {
    parentKey: 'timelineChannel',
    childKey: 'allChannel',
    isParentOff: (v) => v === 'OFF',
    forcedChildValueWhenParentOff: 'OFF',
    effectType: 'VALUE_CHANGE',
    destructiveIfChildChangedToOff: true // 予約投稿削除の副作用あり
  },
  {
    parentKey: 'timelineChannel',
    childKey: 'parentChannel',
    isParentOff: (v) => v === 'OFF',
    forcedChildValueWhenParentOff: 'OFF',
    effectType: 'VALUE_CHANGE',
    destructiveIfChildChangedToOff: true // 予約投稿削除の副作用あり
  },
  {
    parentKey: 'directMessage',
    childKey: 'parentDirectMessage',
    isParentOff: (v) => v === 'OFF',
    forcedChildValueWhenParentOff: null,
    forcedChildAvailabilityWhenParentOff: 'DISABLED_BY_DEPENDENCY',
    effectType: 'AVAILABILITY_CHANGE',
    destructiveIfChildChangedToOff: false
  }
];

export interface DependencyGraphNode {
  parentKey: SettingKey;
  children: SettingKey[];
}

export const DEPENDENCY_GRAPH: Record<string, DependencyGraphNode> = {
  timelineChannel: {
    parentKey: 'timelineChannel',
    children: ['allChannel', 'parentChannel']
  },
  directMessage: {
    parentKey: 'directMessage',
    children: ['parentDirectMessage']
  }
};

/**
 * ある設定キーが親設定の制約を受けているかを調べる
 */
export function getParentDependencyRule(childKey: SettingKey): DependencyRule | undefined {
  return DEPENDENCY_RULES.find((rule) => rule.childKey === childKey);
}

/**
 * ある設定キーを親として依存している子ルール一覧を取得する
 */
export function getChildDependencyRules(parentKey: SettingKey): DependencyRule[] {
  return DEPENDENCY_RULES.filter((rule) => rule.parentKey === parentKey);
}
