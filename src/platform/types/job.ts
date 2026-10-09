import { TargetSet } from './target';
import { ExecutionPlan } from './plan';
import { ApprovalPolicy } from './policy';
import { CostEstimate, TimeEstimate } from './estimator';

import { z } from 'zod';

export const JobExecutionModeSchema = z.enum([
  'LOGICAL_DRY_RUN',
  'CANARY_VALIDATION',
  'FULL_PRODUCTION'
]);

export type JobExecutionMode = z.infer<typeof JobExecutionModeSchema>;

export type JobStatus =
  | 'DRAFT'
  | 'TARGETS_CONFIGURED'
  | 'PLAN_GENERATED'
  | 'DRY_RUN_COMPLETED'
  | 'CANARY_COMPLETED'
  | 'CANARY_FAILED'
  | 'CREDENTIAL_REQUIRED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'HALTED_BY_CIRCUIT_BREAKER'
  | 'STOPPED'
  | 'FAILED';

export interface RunEvidenceFingerprint {
  planHash: string;
  targetSetHash: string;
  mode: JobExecutionMode;
  actualSchoolCodes: string[];
  capabilityVersions: Record<string, string>;
}

export interface RunEvidence {
  evidenceId: string;
  runId: string;
  mode: JobExecutionMode;
  fingerprint: RunEvidenceFingerprint;
  status: 'SUCCESS' | 'FAILED';
  totalSchools: number;
  successCount: number;
  failedCount: number;
  blockedCount: number;
  allVerified: boolean;
  completedAt: string;
}

export interface SchoolRunResult {
  schoolCode: string;
  schoolName: string;
  status: 'SUCCESS' | 'ALREADY_CONFIGURED' | 'BLOCKED' | 'FAILED' | 'SKIPPED';
  before?: Record<string, any>;
  planned?: Record<string, any>;
  after?: Record<string, any>;
  verificationPassed: boolean;
  error?: string;
  retries: number;
  durationMs: number;
  executionId: string;
  timestamp: string;
}

export interface JobRunSummary {
  runId: string;
  mode: JobExecutionMode;
  startTime: string;
  endTime?: string;
  elapsedSeconds: number;
  totalSchools: number;
  processedCount: number;
  successCount: number;
  alreadyConfiguredCount: number;
  blockedCount: number;
  failedCount: number;
  skippedCount: number;
  currentSchool?: string;
  currentOperation?: string;
  etaSeconds?: number;
  accumulatedAiCostJpy: number;
  circuitBreakerState: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
  runtimeHealth: 'HEALTHY' | 'DEGRADED' | 'HALTED';
}

export interface PlatformJob {
  jobId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  targetSet?: TargetSet;
  userInstruction?: string;
  sourceFiles?: string[];
  executionPlan?: ExecutionPlan;
  policy: ApprovalPolicy;
  timeEstimate?: TimeEstimate;
  costEstimate?: CostEstimate;
  runs: Record<string, {
    summary: JobRunSummary;
    results: SchoolRunResult[];
  }>;
  activeRunId?: string;
  evidences?: RunEvidence[];
}
