import { z } from 'zod';
import { RiskClass } from './plan';

export const GateIdSchema = z.enum([
  'GATE_1_PLAN',
  'GATE_2_DRY_RUN',
  'GATE_3_CANARY',
  'GATE_4_FULL_PRODUCTION'
]);

export type GateId = z.infer<typeof GateIdSchema>;

export const PolicyApproveRequestSchema = z.object({
  jobId: z.string().min(1, 'jobId is required'),
  gateId: GateIdSchema,
  approvedBy: z.string().min(1, 'approvedBy must be a non-empty string'),
  notes: z.string().optional(),
  autoProceedToFull: z.boolean().optional()
});

export type PolicyApproveRequest = z.infer<typeof PolicyApproveRequestSchema>;

export interface GateStatus {
  gateId: GateId;
  name: string;
  required: boolean;
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
  notes?: string;
}

export interface ApprovalPolicy {
  riskClass: RiskClass;
  autoProceedToCanary: boolean;
  autoProceedToFullOnCanarySuccess: boolean;
  policyApprovedCanaryScope?: number;
  planHash?: string;
  targetSetHash?: string;
  gates: Record<GateId, GateStatus>;
}

export interface SafetyAuditResult {
  passed: boolean;
  violations: string[];
  warnings: string[];
}
