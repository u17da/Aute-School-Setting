import { z } from 'zod';
import { RequestedSettings } from '../types/config';

export type ConsoleJobState =
  | 'IDLE'
  | 'VALIDATING'
  | 'READY'
  | 'RUNNING'
  | 'STOPPING'
  | 'INTERRUPTED'
  | 'COMPLETED'
  | 'FAILED';

import { BatchSchoolItem, SchoolCredential } from '../types/batch';

export type InputDataSource = 'UPLOAD' | 'LOCAL_DEFAULT';

export interface ActiveUploadedBatch {
  uploadId: string;
  originalFileName: string;
  fileSize: number;
  schools: BatchSchoolItem[];
  credentials: Record<string, SchoolCredential>;
  createdAt: string;
}

export interface ProfileSnapshot {
  snapshotId: string;
  profileHash: string;
  requestedSettings: RequestedSettings;
  createdAt: string;
}

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
  snapshot: ValidationSnapshot | null;
  activeProfileSnapshot?: ProfileSnapshot | null;
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
export const ValidateRequestSchema = z.object({
  schoolsFilePath: z.string().optional(),
  profileFilePath: z.string().optional(),
  credentialsFilePath: z.string().optional(),
  expectedSchoolCount: z.number().int().positive().optional(),
  profile: z.record(z.any()).optional(),
  profileSnapshotId: z.string().optional()
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
  | 'DESTRUCTIVE_CHANGE_BLOCKED';

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

