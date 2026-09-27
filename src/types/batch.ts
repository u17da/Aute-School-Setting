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

export type WritePhase =
  | 'BEFORE_SAVE'
  | 'SAVE_REQUEST_STARTED'
  | 'OUTCOME_RESOLUTION'
  | 'OUTCOME_CONFIRMED';

export type CheckpointStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'SUCCESS_RECOVERED'
  | 'SUCCESS_ALREADY_CONFIGURED'
  | 'SKIPPED_DESTRUCTIVE'
  | 'PREFLIGHT_STATE_CHANGED'
  | 'PLAN_BLOCKED'
  | 'SAVE_FAILED_KNOWN'
  | 'SAVE_OUTCOME_UNKNOWN'
  | 'FAILED'
  | 'INTERRUPTED';

export interface ApplyTargetItem {
  schoolCode: string;
  baselineHash: string;
  plannedActions: Array<{
    settingKey: string;
    from: string | null;
    to: string;
  }>;
  expectedFinalState: Record<string, string | null>;
}

export interface ApplyTargetManifest {
  finalValidationSnapshotId?: string; // Phase 6A: Lineage Binding
  finalPreflightExecutionId?: string; // Phase 6A: Execution Binding
  profileSnapshotId: string;
  preflightId: string;
  profileHash: string;
  schoolsHash: string;
  applyTargetHash: string;
  authMode?: 'A' | 'B';
  createdAt: string;
  totalSchools: number;
  applyTargets: ApplyTargetItem[];
  skippedDestructiveCount: number;
  alreadyConfiguredCount: number;
  blockedCount: number;
}

export interface ConfirmationTokenData {
  token: string;
  profileSnapshotId: string;
  preflightId: string;
  finalPreflightExecutionId?: string; // Phase 6A: Execution Binding
  finalValidationSnapshotId?: string; // Phase 6A: Lineage Binding
  profileHash: string;
  schoolsHash: string;
  applyTargetHash: string;
  targetCount: number;
  skippedDestructiveCount: number;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export const CHECKPOINT_SCHEMA_VERSION = '1.1';

export interface SchoolCheckpointEntry {
  schoolCode: string;
  schoolName: string;
  credentialRef?: string;
  status: CheckpointStatus;
  startedAt?: string;
  finishedAt?: string;
  updatedAt?: string;
  executionStatus?: ExecutionStatus;
  actionsCount?: number;
  hasDestructiveChanges?: boolean;
  planExecutable?: boolean;
  before?: Partial<Record<string, string | null>>;
  requested?: Partial<Record<string, string | null>>;
  after?: Partial<Record<string, string | null>>;
  error?: string;
  resultLogPath?: string;
}

// 指示4, 6: deploymentId と runId の分離、実行条件 Hash の保存、Schema Version 管理
export interface BatchCheckpoint {
  checkpointSchemaVersion: string;
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
  executionId?: string;
  productionExecutionId?: string;
  discoveryExecutionId?: string;
  finalValidationSnapshotId?: string;
  targetSnapshotId?: string;
  profileSnapshotId?: string;
  applyTargetHash?: string;
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
  currentStateCoverage?: DistributionCoverage;
  plannedChangeCoverage?: DistributionCoverage;
  executionScopeCodes?: string[]; // Phase 6A: Execution Scope
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
  baselineHash?: string;
  hasChanges?: boolean;
}

export interface DistributionCoverage {
  collected: number;
  total: number;
}

export interface PreflightReport {
  purpose?: 'DISCOVERY' | 'FINAL_PREFLIGHT';
  executionId?: string; // Phase 6A: Child Execution Binding
  deploymentId: string;
  runId: string;
  status: PreflightStatus;
  writeGateEligible: boolean;
  allReadSucceeded: boolean;
  allPlansExecutable: boolean;
  profileHash: string;
  profileSnapshotId?: string;
  finalValidationSnapshotId?: string;
  schoolsHash: string;
  toolVersion: string;
  toolFingerprint?: string;
  authMode?: 'A' | 'B';
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
  currentStateCoverage?: DistributionCoverage;
  plannedChangeCoverage?: DistributionCoverage;
  summaryPath: string;
  schools: PreflightSchoolResult[];
}

export interface NormalizedSchoolResult {
  schoolCode: string;
  schoolName: string;
  readStatus: 'SUCCESS' | 'FAILED' | 'NOT_PROCESSED' | 'INTERRUPTED';
  executionStatus?: ExecutionStatus;
  errorMessage?: string;
  planExecutable: boolean;
  hasDestructiveChanges: boolean;
  writeEligible: boolean;
  actionsCount: number;
}

export interface NormalizedResultsViewModel {
  status: PreflightStatus;
  deploymentId: string;
  runId: string;
  totalSchools: number;
  processedSchools: number;
  readSuccess: number;
  readFailed: number;
  alreadyConfigured: number;
  requiresChange: number;
  planBlocked: number;
  destructiveChangeSchools: number;
  writeEligible: number;
  writeGateEligible: boolean;
  allReadSucceeded: boolean;
  allPlansExecutable: boolean;
  actionsDistribution: ActionsDistribution;
  currentStateDistribution: Record<string, Record<string, number>>;
  plannedChangeDistribution: Record<string, Record<string, number>>;
  currentStateCoverage: DistributionCoverage;
  plannedChangeCoverage: DistributionCoverage;
  destructiveChangeDetails: DestructiveChangeDetail[];
  schools: NormalizedSchoolResult[];
  inconsistent?: boolean;
  inconsistentReason?: string;
  isStale?: boolean;
  staleReason?: string;
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
