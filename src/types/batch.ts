import { ExecutionStatus } from './errors';
import { RequestedSettings } from './config';
import { SchoolSettingsObservation } from './settings';

export interface BatchSchoolItem {
  schoolCode: string;
  schoolName: string;
  credentialRef: string;
  enabled: boolean;
}

export interface SchoolCredential {
  userId: string;
  password: string;
}

export interface CredentialProvider {
  getCredential(ref: string): Promise<SchoolCredential>;
  hasCredential(ref: string): boolean;
}

export type CheckpointStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'SUCCESS_ALREADY_CONFIGURED'
  | 'FAILED'
  | 'INTERRUPTED';

export interface SchoolCheckpointEntry {
  schoolCode: string;
  schoolName: string;
  credentialRef: string;
  status: CheckpointStatus;
  startedAt?: string;
  finishedAt?: string;
  executionStatus?: ExecutionStatus;
  actionsCount?: number;
  hasDestructiveChanges?: boolean;
  error?: string;
  resultLogPath?: string;
}

// 指示4, 6: deploymentId と runId の分離、実行条件 Hash の保存
export interface BatchCheckpoint {
  deploymentId: string;
  runId: string;
  profileHash: string;
  schoolsHash: string;
  toolVersion: string;
  toolFingerprint?: string;
  authMode: 'A' | 'B';
  createdAt: string;
  updatedAt: string;
  isCompleted: boolean;
  entries: Record<string, SchoolCheckpointEntry>; // schoolCode -> Entry
}

export interface ActionsDistribution {
  zero: number;
  one: number;
  two: number;
  threePlus: number;
}

// 指示9: Circuit Breaker 重大度別分類
export type ErrorSeverity = 'CRITICAL' | 'SYSTEMIC' | 'SCHOOL_SPECIFIC';

export interface CircuitBreakerTripInfo {
  category: ErrorSeverity;
  errorCode: ExecutionStatus;
  consecutiveCount: number;
  tripReason: string;
  trippedAt: string;
}

export interface DestructiveChangeDetail {
  schoolCode: string;
  schoolName: string;
  settingKey: string;
  current: string | null;
  expected: string | null;
  risk: string;
}

export interface BatchSummaryReport {
  deploymentId: string;
  runId: string;
  mode: 'PREFLIGHT_DRY_RUN' | 'PRODUCTION_WRITE';
  profileHash: string;
  schoolsHash: string;
  toolVersion: string;
  toolFingerprint?: string;
  startedAt: string;
  finishedAt: string;
  totalSchools: number;
  processedSchools: number;
  skippedSchools: number;
  // 指示14: 概念分離
  readSuccess: number;
  readFailed: number;
  loginSuccess: number;
  loginFailed: number;
  schoolMismatch: number;
  uiStructureMismatch: number;
  planExecutable: number;
  planBlocked: number;
  alreadyConfigured: number;
  requiresChange: number;
  destructiveChangeSchools: number;
  destructiveChangeActions: number;
  writeEligibleNonDestructive: number;
  writeBlockedDestructive: number;
  configConflict: number;
  dependencyUnsatisfied: number;
  otherErrors: number;
  circuitBreakerTrip?: CircuitBreakerTripInfo;
  actionsDistribution: ActionsDistribution;
  // 指示11, 12, 13: 詳細分布と破壊的変更詳細
  destructiveChangeDetails: DestructiveChangeDetail[];
  currentStateDistribution: Record<string, Record<string, number>>;
  plannedChangeDistribution: Record<string, Record<string, number>>;
  schoolResults: Array<{
    schoolCode: string;
    schoolName: string;
    status: CheckpointStatus;
    executionStatus?: ExecutionStatus;
    actionsCount?: number;
    hasDestructiveChanges?: boolean;
    before?: Partial<Record<string, string | null>>;
    requested?: Partial<Record<string, string | null>>;
    after?: Partial<Record<string, string | null>>;
    error?: string;
  }>;
}

export type PreflightStatus =
  | 'COMPLETE'
  | 'INCOMPLETE'
  | 'PAUSED'
  | 'INTERRUPTED';

export interface PreflightSchoolResult {
  schoolCode: string;
  schoolName: string;
  readStatus: 'SUCCESS' | 'FAILED' | 'NOT_PROCESSED' | 'INTERRUPTED';
  planExecutable: boolean;
  hasDestructiveChanges: boolean;
  writeEligible: boolean;
  actionsCount: number;
}

export interface PreflightReport {
  deploymentId: string;
  status: PreflightStatus;
  writeGateEligible: boolean;
  allReadSucceeded: boolean;
  allPlansExecutable: boolean;
  profileHash: string;
  schoolsHash: string;
  toolVersion: string;
  toolFingerprint?: string;
  completedAt: string;
  validUntil: string;
  total: number;
  processed: number;
  readSuccess: number;
  readFailed: number;
  planBlocked: number;
  notProcessed: number;
  alreadyConfigured: number;
  requiresChange: number;
  destructiveChangeSchools: number;
  summaryPath: string;
  schools: PreflightSchoolResult[];
}

export interface BatchLockInfo {
  pid: number;
  startedAt: string;
  runId: string;
  deploymentId: string;
}

export interface CircuitBreakerConfig {
  consecutiveFailureThreshold: number; // SYSTEMIC カテゴリの連続失敗閾値（デフォルト: 3）
  canaryMode?: boolean;               // Canary段階では SAVE_FAILED 1件で即PAUSE
}
