import { RiskClass } from './plan';

export type GateId = 'GATE_1_PLAN' | 'GATE_2_DRY_RUN' | 'GATE_3_CANARY' | 'GATE_4_FULL_PRODUCTION';

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
  gates: Record<GateId, GateStatus>;
}

export interface SafetyAuditResult {
  passed: boolean;
  violations: string[];
  warnings: string[];
}
