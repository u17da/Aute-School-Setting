/**
 * Target Normalization Models for AI-Governed Browser Automation Platform
 */

export type TargetValidationStatus = 'READY' | 'MISSING' | 'AMBIGUOUS';

export interface TargetSchool {
  schoolCode: string;
  schoolName: string;
  userId?: string;
  schoolType?: 'ELEMENTARY' | 'JUNIOR_HIGH' | 'HIGH' | 'COMBINED';
  credentialRef: string; // Secret handle / reference. Never store plaintext password here.
  enabled: boolean;
  metadata?: Record<string, any>;
  sourceReference?: string;
  validationStatus: TargetValidationStatus;
  missingFields?: string[];
  ambiguityReason?: string;
}

export interface TargetSet {
  targetSetId: string;
  jobId?: string;
  name: string;
  createdAt: string;
  sourceFiles: string[];
  rawTextProvided?: boolean;
  sanitizedRawTextMeta?: { charCount: number; lineCount: number };
  schools: TargetSchool[];
  summary: {
    total: number;
    ready: number;
    missing: number;
    ambiguous: number;
  };
}
