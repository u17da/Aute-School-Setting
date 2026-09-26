import { SettingKey, SettingValue, SettingObservation, SettingExpectation, SchoolSettingsObservation } from './settings';
import { ExecutionStatus, ExecutionIssueCode } from './errors';
import { EffectiveExecutionOptions } from './config';

export type ChangeReason = 'EXPLICIT' | 'DEPENDENCY' | 'UNCHANGED';

export interface PlanAction {
  order: number;
  settingKey: SettingKey;
  label: string;
  from: SettingValue | null;
  to: SettingValue;
  requiresUiSync: boolean;
}

export type DependencyEffectType = 'VALUE_CHANGE' | 'AVAILABILITY_CHANGE';

export interface DependencyEffect {
  sourceSettingKey: SettingKey;
  targetSettingKey: SettingKey;
  targetLabel: string;
  effectType: DependencyEffectType;
  beforeValue: SettingValue | null;
  expectedValue: SettingValue | null;
  expectedAvailability?: import('./settings').SettingAvailability;
  rule: string;
}

export interface SettingPlanItem {
  settingKey: SettingKey;
  label: string;
  current: SettingObservation;
  requested: SettingValue | null;
  expected: SettingExpectation;
  reason: ChangeReason;
  isDestructive: boolean;
  destructiveWarning?: string;
}

export interface ExecutionPlan {
  schoolCode: string;
  schoolName: string;
  items: Record<SettingKey, SettingPlanItem>;
  actions: PlanAction[];
  dependencyEffects: DependencyEffect[];
  hasChanges: boolean;
  hasDestructiveChanges: boolean;
  warnings: string[];
  preSaveExpectations?: Record<SettingKey, SettingExpectation>;
  postSaveExpectations?: Record<SettingKey, SettingExpectation>;
}

export interface ExecutionIssue {
  code: ExecutionIssueCode;
  message: string;
  settingKey?: SettingKey;
  details?: Record<string, unknown>;
}

export interface ExecutionPlanEvaluation {
  isExecutable: boolean;
  blockReasons: ExecutionIssue[];
  warnings: string[];
  requiresApply: boolean;
  requiresDestructiveConfirmation: boolean;
}

export interface ExecutionResult {
  runId: string;
  toolVersion: string;
  startedAt: string;
  finishedAt: string;
  schoolCode: string | null;
  schoolName: string | null;
  status: ExecutionStatus;
  authObservation?: import('./auth').AuthObservation;
  settingsHash: string | null;
  runConfigHash: string | null;
  executionOptions: EffectiveExecutionOptions | null;
  executionPlan: ExecutionPlan | null;
  evaluation: ExecutionPlanEvaluation | null;
  beforeObservation: SchoolSettingsObservation | null;
  afterObservation: SchoolSettingsObservation | null;
  issues: ExecutionIssue[];
  screenshotPaths: Record<string, string>;
}
