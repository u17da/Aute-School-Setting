/**
 * Execution Plan and Operation DSL / IR types
 */
import { z } from 'zod';

export type RiskClass =
  | 'READ_ONLY'
  | 'REVERSIBLE_WRITE'
  | 'SENSITIVE_WRITE'
  | 'DESTRUCTIVE_WRITE'
  | 'IRREVERSIBLE_WRITE';

export type ActionPrimitiveType =
  | 'navigate'
  | 'waitFor'
  | 'observe'
  | 'click'
  | 'fill'
  | 'select'
  | 'drag'
  | 'assertText'
  | 'assertValue'
  | 'assertOrder'
  | 'save'
  | 'reload'
  | 'verify';

export interface ActionPrimitive {
  type: ActionPrimitiveType;
  selector?: string;
  value?: string | number | boolean;
  timeoutMs?: number;
  description?: string;
  critical?: boolean;
}

export interface OperationPrecondition {
  description: string;
  checkType: 'URL_MATCH' | 'ELEMENT_VISIBLE' | 'SCHOOL_IDENTITY' | 'CURRENT_VALUE';
  expected: any;
}

export interface OperationVerification {
  description: string;
  verifyType: 'RELOAD_AND_CHECK' | 'ELEMENT_TEXT' | 'ELEMENT_VALUE' | 'STATE_HASH';
  expected: any;
}

export interface OperationIR {
  operationId: string;
  operationType: string; // e.g. "LOGIN_AND_VERIFY", "CREATE_SCHOOL_ADMIN", "CHANGE_SCHOOL_SETTING", "REORDER_CONTENTS", "CREATE_GRADE_AND_CLASS", "ADD_BOOKMARK"
  capabilityId: string; // 単一情報源 (SSOT) として Capability を識別する必須ID
  targetSchoolCodes?: string[]; // If undefined, applies to all ready schools in targetSet
  targetSelector?: Record<string, any>;
  inputMapping: Record<string, any>;
  preconditions: OperationPrecondition[];
  actions?: ActionPrimitive[];
  postconditions?: string[];
  verification: OperationVerification[];
  riskClass: RiskClass;
  reversible: boolean;
  estimatedDurationMs?: number;
}

export const SupportedSchoolTypeSchema = z.enum([
  'ELEMENTARY',
  'JUNIOR_HIGH',
  'HIGH',
  'COMBINED',
  'ALL'
]);

export type SupportedSchoolType = z.infer<typeof SupportedSchoolTypeSchema>;

export const OperationIRSchema = z.object({
  operationId: z.string().min(1, 'operationId is required'),
  operationType: z.string().min(1, 'operationType is required'),
  capabilityId: z.string().min(1, 'capabilityId is required and cannot be empty'),
  targetSchoolCodes: z.array(z.string()).optional(),
  targetSelector: z.record(z.any()).optional(),
  inputMapping: z.record(z.any()),
  preconditions: z.array(
    z.object({
      description: z.string(),
      checkType: z.enum(['URL_MATCH', 'ELEMENT_VISIBLE', 'SCHOOL_IDENTITY', 'CURRENT_VALUE']),
      expected: z.any()
    })
  ),
  actions: z.array(z.any()).optional(),
  postconditions: z.array(z.string()).optional(),
  verification: z.array(
    z.object({
      description: z.string(),
      verifyType: z.enum(['RELOAD_AND_CHECK', 'ELEMENT_TEXT', 'ELEMENT_VALUE', 'STATE_HASH']),
      expected: z.any()
    })
  ),
  riskClass: z.enum(['READ_ONLY', 'REVERSIBLE_WRITE', 'SENSITIVE_WRITE', 'DESTRUCTIVE_WRITE', 'IRREVERSIBLE_WRITE']),
  reversible: z.boolean(),
  estimatedDurationMs: z.number().optional()
});

export function validateOperationIR(op: any): OperationIR {
  const result = OperationIRSchema.safeParse(op);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`INVALID_OPERATION_IR: Operation fails domain schema validation: ${issues}`);
  }
  if (op.targetSelector && typeof op.targetSelector === 'object' && Object.keys(op.targetSelector).length > 0) {
    throw new Error(`UNSUPPORTED_TARGET_SELECTOR: Operation "${op.operationId}" specified targetSelector which is unsupported in V1.`);
  }
  return result.data as OperationIR;
}

export interface PlanAssumption {
  id: string;
  description: string;
  impactIfFalse: string;
}

export interface PlanQuestion {
  id: string;
  question: string;
  context: string;
  suggestedAnswers?: string[];
}

export interface PlanHumanSummary {
  interpretedIntent: string;
  targetScope: string;
  actionSummary: string;
  settingValueSummary?: string;
  skipBehavior?: string;
  capabilityUsed: string;
  riskLevel: string;
}

export interface PlanDiff {
  added: string[];
  unchanged: string[];
  removed: string[];
  summaryText: string;
}

export interface ValidationScopeProposal {
  unit: 'SCHOOL' | 'ACCOUNT' | 'CLASS' | 'SETTING_ITEM' | 'CUSTOM';
  count: number;
  description: string;
  policyApproved: boolean;
  policyFeedback?: string;
}

export interface ExecutionPlan {
  planId: string;
  targetSetId: string;
  userInstruction: string;
  status: 'READY' | 'NEEDS_CLARIFICATION' | 'UNSUPPORTED' | 'PLAN_AI_UNAVAILABLE';
  humanSummary?: PlanHumanSummary;
  planDiff?: PlanDiff;
  validationScopeProposal?: ValidationScopeProposal;
  previousPlanId?: string;
  refinementInstruction?: string;
  sourceFiles: string[];
  targetFilter?: {
    schoolType?: SupportedSchoolType;
    schoolCodes?: string[];
    excludeSchoolCodes?: string[];
  };
  operations: OperationIR[];
  assumptions: PlanAssumption[];
  questions: PlanQuestion[];
  riskLevel: RiskClass;
  estimatedAffectedSchools: number;
  approvalStatus: 'DRAFT' | 'APPROVED' | 'REJECTED';
  planHash: string;
  createdAt: string;
}


