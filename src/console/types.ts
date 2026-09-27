import { z } from 'zod';
import { RequestedSettings } from '../types/config';
import { BatchSchoolItem, SchoolCredential, CheckpointStatus, BatchSummaryReport } from '../types/batch';
import { SchoolSettingsObservation, SettingKey, SettingValue } from '../types/settings';
import { PlanAction } from '../types/plan';

export type ConsoleJobState =
  | 'IDLE'
  | 'VALIDATING'
  | 'READY'
  | 'RUNNING'
  | 'DISCOVERY_RUNNING'
  | 'FINAL_PREFLIGHT_RUNNING'
  | 'APPLY_RUNNING'
  | 'STOPPING'
  | 'INTERRUPTED'
  | 'COMPLETED'
  | 'FAILED';

export type InputDataSource = 'UPLOAD' | 'LOCAL_DEFAULT';

export interface ActiveUploadedBatch {
  uploadId: string;
  originalFileName: string;
  fileSize: number;
  schools: BatchSchoolItem[];
  credentials: Record<string, SchoolCredential>;
  createdAt: string;
}

// 1. TargetValidationSnapshot (Phase 6A: Profile未確定の対象検証結果)
export interface TargetValidationSnapshot {
  targetSnapshotId: string;
  schoolsHash: string;
  toolFingerprint: string;
  toolVersion: string;
  authMode: 'A' | 'B';
  expectedSchoolCount?: number;
  enabledSchoolCount: number;
  totalSchoolCount: number;
  resolvedCredentialsCount: number;
  source: InputDataSource;
  sourceName: string;
  createdAt: string;
}

// 2. SchoolObservationItem (Phase 6A: Discriminated Union & SSOT SchoolSettingsObservation)
export type SchoolObservationItem =
  | {
      schoolCode: string;
      schoolName: string;
      readStatus: 'SUCCESS';
      observation: SchoolSettingsObservation; // 既存SSOT: CONTRACT_NOT_AVAILABLE時はvalue=null
      discoveryStateHash: string; // Discovery用の状態識別Hash (baselineHashとは呼称・型を分離。Manifest流入禁止)
      observedAt: string;         // 学校ごとの観測完了時刻
    }
  | {
      schoolCode: string;
      schoolName: string;
      readStatus: 'FAILED';
      errorCode: string;
      errorMessage: string;
      observedAt: string;         // 観測試行時刻
    };

// 2B. ObservationSnapshot (Phase 6A: Discovery結果)
export interface ObservationSnapshot {
  observationSnapshotId: string;
  targetSnapshotId: string;
  parentObservationSnapshotId?: string; // Resume / Retry Failed 後の新Snapshot用
  schoolsHash: string;
  toolFingerprint: string;
  authMode: 'A' | 'B';
  startedAt: string;
  completedAt: string;
  totalSchools: number;
  readSuccessCount: number;
  readFailedCount: number;
  distribution: Record<SettingKey, Record<string, number>>;
  schools: SchoolObservationItem[];
}

// 3. DraftProfileState (Phase 6A: Revision & Hash 管理)
export interface DraftProfileState {
  targetSnapshotId: string;
  observationSnapshotId: string;
  draftRevision: number;
  draftHash: string;
  settings: RequestedSettings; // 既存Domain型
  updatedAt: string;
}

// 4. ProfileSnapshot (Phase 6A: Lineage バインド追加)
export interface ProfileSnapshot {
  snapshotId: string;
  targetSnapshotId?: string;
  observationSnapshotId?: string;
  sourceDraftRevision?: number;
  sourceDraftHash?: string;
  profileHash: string;
  requestedSettings: RequestedSettings;
  createdAt: string;
}

// 5. FinalValidationSnapshot (Phase 6A: Final Preflight直前のLineage再検証)
export interface FinalValidationSnapshot {
  finalValidationSnapshotId: string;
  targetSnapshotId: string;
  observationSnapshotId: string;
  profileSnapshotId: string;
  profileHash: string;
  schoolsHash: string;
  toolVersion: string;
  toolFingerprint: string;
  authMode: 'A' | 'B';
  enabledSchoolCount: number;
  totalSchoolCount: number;
  resolvedCredentialsCount: number;
  validatedAt: string;
}

// 6. PreviewExecutionPlan (Phase 6A: 既存 PlanAction 再利用)
export interface SchoolPreviewDiff {
  schoolCode: string;
  schoolName: string;
  hasChanges: boolean;
  isDestructive: boolean;
  planExecutable: boolean;
  actions: PlanAction[];
  warnings: string[];
}

export interface PreviewExecutionPlan {
  observationSnapshotId: string;
  draftRevision: number;
  draftHash: string;
  calculatedAt: string;
  totalSchools: number;
  targetCount: number;
  alreadyConfiguredCount: number;
  destructiveCount: number;
  uncontractedCount: number;
  blockedCount: number;
  observationFailedCount: number; // 独立表示 (FAILED校を変更あり/なしに混入させない)
  settingDiffDistribution: Record<string, Record<string, number>>;
  schoolDiffs: SchoolPreviewDiff[];
}

// 6B. ActivePreviewContext (Phase 6A Hardening: Server-side preview binding)
export interface ActivePreviewContext {
  observationSnapshotId: string;
  draftRevision: number;
  draftHash: string;
  calculatedAt: string;
  previewPlan?: PreviewExecutionPlan;
}

// 6C. ActiveFinalPreflightContext (Phase 6A Hardening: Exact Execution Binding SSOT)
export interface ActiveFinalPreflightContext {
  executionId: string;
  deploymentId: string;
  runId: string;
  targetSnapshotId: string;
  observationSnapshotId: string;
  profileSnapshotId: string;
  finalValidationSnapshotId: string;
  authMode: 'A' | 'B';
  schoolsHash: string;
  toolFingerprint: string;
  report: import('../types/batch').PreflightReport;
  summary: any;
  completedAt: string;
  validUntil: string;
}

// 6D. WorkflowCapabilities (Server-side SSOT Gate)
export interface WorkflowCapabilities {
  canEditDraft: boolean;
  canPreview: boolean;
  canConfirmProfile: boolean;
  canRunFinalPreflight: boolean;
  canPrepareApply: boolean;
}

// 6E. ExecutionResultViewModel & ActiveExecutionResultContext (Phase 6A: Production Result Contract)
export type ExecutionResultCategory =
  | 'APPLIED'
  | 'ALREADY_CONFIGURED'
  | 'SKIPPED'
  | 'BLOCKED'
  | 'FAILED_KNOWN'
  | 'OUTCOME_UNKNOWN'
  | 'INTERRUPTED'
  | 'NOT_PROCESSED'
  | 'RESULT_INCONSISTENT';

export interface ExecutionChangeDetail {
  settingKey: SettingKey;
  settingLabel: string;
  before: SettingValue | null;
  after: SettingValue | null;
  beforeLabel: string | null;
  afterLabel: string | null;
}

export interface ExecutionSchoolResultViewModel {
  schoolCode: string;
  schoolName: string;
  status: CheckpointStatus;
  category: ExecutionResultCategory;
  actionsCount: number;
  changes: ExecutionChangeDetail[];
  message: string;
  requiresHumanReview: boolean;
  errorMessage?: string;
}

export interface ExecutionResultViewModel {
  mode: 'PRODUCTION_WRITE';
  deploymentId: string;
  runId: string;
  completedAt: string;

  totalCount: number;
  processedCount: number;
  appliedSuccessCount: number;
  alreadyConfiguredCount: number;
  skippedDestructiveCount: number;
  blockedCount: number;
  failedKnownCount: number;
  outcomeUnknownCount: number;
  interruptedCount: number;
  notProcessedCount: number;
  inconsistentCount: number;
  attentionRequiredCount: number;

  schools: ExecutionSchoolResultViewModel[];
}

export interface ActiveExecutionResultContext {
  productionExecutionId?: string;
  deploymentId: string;
  runId: string;
  mode: 'PRODUCTION_WRITE';
  summary: BatchSummaryReport;
  viewModel: ExecutionResultViewModel;
  completedAt: string;
}

// 6F. Current Production Execution Ledger (Phase 6A: Runtime Lifecycle Hardening)
export type CurrentProductionExecutionState =
  | 'STARTING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'RESULT_INVALID'
  | 'INTERRUPTED'
  | 'OUTCOME_UNKNOWN';

export interface CurrentProductionExecutionLedger {
  schemaVersion: '1.0';
  executionId: string;
  state: CurrentProductionExecutionState;
  deploymentId: string;
  runId: string;
  profileSnapshotId: string;
  finalPreflightExecutionId?: string;
  finalValidationSnapshotId?: string;
  profileHash: string;
  schoolsHash: string;
  applyTargetHash: string;
  startedAt: string;
  finishedAt?: string;
  summaryPath: string;
  contextPath: string;
  errorMessage?: string;
}

// 既存後方互換用
export interface ValidationSnapshot {
  profileHash: string;
  profileSnapshotId?: string;
  schoolsHash: string;
  toolVersion: string;
  toolFingerprint: string;
  expectedSchoolCount?: number;
  enabledSchoolCount: number;
  totalSchoolCount: number;
  resolvedCredentialsCount: number;
  validatedAt: string;
  source?: InputDataSource;
  sourceName?: string;
  targetSnapshotId?: string;
}

export interface SanitizedProfileItem {
  key: string;
  label: string;
  status: 'MANAGED' | 'UNMANAGED';
  value: string | null;
}

export interface ConsoleStatusResponse {
  jobState: ConsoleJobState;
  csrfToken: string;
  targetSnapshot?: TargetValidationSnapshot | null;
  observationSnapshot?: ObservationSnapshot | null;
  draftProfile?: DraftProfileState | null;
  activeProfileSnapshot?: ProfileSnapshot | null;
  finalValidationSnapshot?: FinalValidationSnapshot | null;
  activeFinalPreflightReport?: import('../types/batch').PreflightReport | null; // 互換性
  activeFinalPreflightContext?: ActiveFinalPreflightContext | null; // Phase 6A Hardening
  applyReady: boolean; // Phase 6A Hardening: Server-side SSOT Apply Gate
  canPrepareApply?: boolean; // Phase 6A: Server-side capability SSOT
  serverInstanceId?: string;
  serverStartedAt?: string;
  serverBuildFingerprint?: string;
  workflowCapabilities?: WorkflowCapabilities;
  snapshot: ValidationSnapshot | null; // 互換性維持

  currentJob?: {
    runId: string;
    startedAt: string;
    mode: 'PREFLIGHT_DRY_RUN' | 'PRODUCTION_WRITE';
    progress?: {
      processed: number;
      total: number;
      percentage: number;
      success: number;
      failed: number;
      remaining: number;
      elapsedSeconds: number;
      estimatedRemainingSeconds: number | null;
      currentSchool?: {
        schoolCode: string;
        schoolName: string;
      };
    };
  };
  lastError?: {
    code: string;
    message: string;
    schoolCode?: string;
  };
}

// Request Schemas (Strict - reject unknown / write fields)
export const TargetValidateRequestSchema = z.object({
  schoolsFilePath: z.string().optional(),
  credentialsFilePath: z.string().optional(),
  expectedSchoolCount: z.number().int().positive().optional(),
  authMode: z.enum(['A', 'B']).optional()
}).strict();
export type TargetValidateRequest = z.infer<typeof TargetValidateRequestSchema>;

export const DraftProfileRequestSchema = z.object({
  targetSnapshotId: z.string().min(1),
  observationSnapshotId: z.string().min(1),
  draftRevision: z.number().int().nonnegative().optional(),
  expectedDraftRevision: z.number().int().nonnegative().optional(),
  settings: z.record(z.any())
}).strict().refine((data) => data.expectedDraftRevision !== undefined || data.draftRevision !== undefined, {
  message: 'expectedDraftRevision (または draftRevision) は必須です'
});
export type DraftProfileRequest = z.infer<typeof DraftProfileRequestSchema>;

export const ProfileConfirmRequestSchema = z.object({
  targetSnapshotId: z.string().min(1),
  observationSnapshotId: z.string().min(1),
  expectedDraftRevision: z.number().int().nonnegative(),
  expectedDraftHash: z.string().min(1)
}).strict();
export type ProfileConfirmRequest = z.infer<typeof ProfileConfirmRequestSchema>;

export const ValidateRequestSchema = z.object({
  schoolsFilePath: z.string().optional(),
  profileFilePath: z.string().optional(),
  credentialsFilePath: z.string().optional(),
  expectedSchoolCount: z.number().int().positive().optional(),
  profile: z.record(z.any()).optional(),
  profileSnapshotId: z.string().optional(),
  authMode: z.enum(['A', 'B']).optional()
}).strict();

export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;

export const ApplyStartRequestSchema = z.object({
  preflightId: z.string().min(1),
  profileSnapshotId: z.string().min(1),
  confirmationToken: z.string().min(1)
}).strict();

export type ApplyStartRequest = z.infer<typeof ApplyStartRequestSchema>;

export const EmptyActionRequestSchema = z.object({}).strict();
export type EmptyActionRequest = z.infer<typeof EmptyActionRequestSchema>;

// Write-related fields to explicitly check & reject (Defense in depth)
export const FORBIDDEN_WRITE_FIELDS = [
  'apply',
  'allowLiveWrite',
  'batchApply',
  'allowDestructive',
  'includeDestructiveSchools',
  'liveWrite',
  'write',
  'destructive'
] as const;

export type ConsoleErrorCode =
  | 'VALIDATION_REQUIRED'
  | 'VALIDATION_STALE'
  | 'JOB_CONFLICT'
  | 'JOB_NOT_RUNNING'
  | 'PROCESS_SPAWN_FAILED'
  | 'INVALID_REQUEST'
  | 'WRITE_FORBIDDEN'
  | 'SAMPLE_DATA_BLOCKED'
  | 'SNAPSHOT_NOT_FOUND'
  | 'APPLY_NOT_ELIGIBLE'
  | 'PREFLIGHT_STATE_CHANGED'
  | 'DESTRUCTIVE_CHANGE_BLOCKED'
  | 'LINEAGE_MISMATCH'
  | 'DRAFT_STALE'
  | 'PURPOSE_MISMATCH';

export class ConsoleError extends Error {
  readonly code: ConsoleErrorCode;
  readonly status: ConsoleErrorCode;
  readonly details?: any;

  constructor(code: ConsoleErrorCode, message: string, details?: any) {
    super(`[${code}] ${message}`);
    this.name = 'ConsoleError';
    this.code = code;
    this.status = code;
    this.details = details;
  }
}

