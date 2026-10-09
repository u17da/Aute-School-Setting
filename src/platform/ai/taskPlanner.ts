import * as crypto from 'crypto';
import { z } from 'zod';
import { ExecutionPlan, OperationIR, RiskClass, PlanAssumption, PlanQuestion, PlanHumanSummary, PlanDiff, ValidationScopeProposal } from '../types/plan';
import { TargetSet } from '../types/target';
import { CapabilityRegistry } from '../capabilities/registry';
import { PolicyEngine } from '../policy/policyEngine';
import { LlmClient, LlmResponse } from './llmClient';

export interface PlanTaskInput {
  targetSet: TargetSet;
  userInstruction: string;
  sourceFiles?: string[];
  additionalContext?: string;
  previousPlan?: ExecutionPlan;
  refinementInstruction?: string;
}

// Zod Schema for Double Validation of Claude Structured Outputs
export const AiOperationZodSchema = z.object({
  capabilityId: z.string(),
  capabilityVersion: z.string().optional(),
  input: z.record(z.any()),
  skipCondition: z.enum(['NONE', 'CURRENT_VALUE_EQUALS_DESIRED', 'ALREADY_EXISTS']).default('NONE'),
  riskClass: z.enum(['READ_ONLY', 'REVERSIBLE_WRITE', 'SENSITIVE_WRITE', 'DESTRUCTIVE_WRITE', 'IRREVERSIBLE_WRITE'])
});

export const AiValidationScopeProposalZodSchema = z.object({
  unit: z.enum(['SCHOOL', 'ACCOUNT', 'CLASS', 'SETTING_ITEM', 'CUSTOM']).default('SCHOOL'),
  count: z.union([z.number(), z.string().transform(v => parseInt(v, 10) || 1)]).default(1),
  description: z.string().default('先行検証')
});

export const AiPlanDiffZodSchema = z.union([
  z.object({
    added: z.array(z.string()).default([]),
    unchanged: z.array(z.string()).default([]),
    removed: z.array(z.string()).default([]),
    summaryText: z.string().default('')
  }),
  z.string().transform(str => ({ added: [], unchanged: [], removed: [], summaryText: str })),
  z.null().transform(() => undefined)
]);

export const AiPlanResponseZodSchema = z.object({
  status: z.enum(['READY', 'NEEDS_CLARIFICATION', 'UNSUPPORTED']),
  summary: z.object({
    interpretedIntent: z.string(),
    targetScope: z.string().optional().default('指定された学校'),
    actionSummary: z.string(),
    settingValueSummary: z.string().optional(),
    skipBehavior: z.string().optional(),
    capabilityUsed: z.string(),
    riskLevel: z.string()
  }),
  operations: z.array(AiOperationZodSchema),
  questions: z.array(z.object({
    id: z.string(),
    question: z.string(),
    context: z.string()
  })),
  assumptions: z.array(z.object({
    id: z.string(),
    description: z.string(),
    impactIfFalse: z.string().optional().default('')
  })),
  validationScopeProposal: AiValidationScopeProposalZodSchema.optional(),
  planDiff: AiPlanDiffZodSchema.optional()
});

export type AiPlanResponse = z.infer<typeof AiPlanResponseZodSchema>;

export class TaskPlanner {
  /**
   * Claude Haiku 5.5 による自律型対話プランニング
   * - キーワード判定・includes()・正規表現による意図判定は完全廃止 (0件)
   * - ANTHROPIC_API_KEY 未設定時は旧ルールへフォールバックせず Fail-Closed (PLAN_AI_UNAVAILABLE)
   * - 修正指示がある場合は前回計画との差分 (PlanDiff) を自律抽出
   * - 安全な先行検証の単位と規模 (ValidationScopeProposal) を自律提案し、Policy Engineで検証
   */
  static async generatePlanAsync(input: PlanTaskInput): Promise<{
    plan: ExecutionPlan;
    aiProvider: string;
    aiModel: string;
    isRealApiCall: boolean;
    tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
    latencyMs: number;
  }> {
    const registry = CapabilityRegistry.getInstance();
    const dynamicCatalog = registry.getCatalogForAi();
    const jsonSchema = registry.getPlanJsonSchema();

    const planId = `plan_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // 1. ANTHROPIC_API_KEY check: Fail-Closed if missing
    if (!process.env.ANTHROPIC_API_KEY) {
      const unavailablePlan: ExecutionPlan = {
        planId,
        targetSetId: input.targetSet.targetSetId,
        userInstruction: input.userInstruction,
        status: 'PLAN_AI_UNAVAILABLE',
        sourceFiles: input.sourceFiles || [],
        operations: [],
        assumptions: [],
        questions: [
          {
            id: 'q_api_key_missing',
            question: 'Claude APIキー (ANTHROPIC_API_KEY) が環境変数に設定されていないため、自律AIプランニングを実行できません。',
            context: 'Fail-Closed: Rule-based fallback is disabled.'
          }
        ],
        riskLevel: 'READ_ONLY',
        estimatedAffectedSchools: 0,
        approvalStatus: 'DRAFT',
        planHash: crypto.createHash('sha256').update(planId).digest('hex'),
        createdAt: new Date().toISOString()
      };

      return {
        plan: unavailablePlan,
        aiProvider: 'None',
        aiModel: 'None',
        isRealApiCall: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 0
      };
    }

    // 2. Build Dynamic System Prompt with Capability Catalog & Semantic Metadata
    const catalogDescription = JSON.stringify(dynamicCatalog, null, 2);
    const systemPrompt = `You are the AI Task Planner for an enterprise browser automation platform governing educational services.
Your duty is to analyze natural language user instructions and produce a strictly minimal, safe, and structured Execution Plan.

# Available Capabilities Catalog (Single Source of Truth)
${catalogDescription}

# Critical Planning Directives:
1. MINIMUM SAFE PLAN:
   - Select ONLY the minimal set of capabilities required to fulfill the user intent.
   - Never add unnecessary write operations. If read-only suffices, use READ_ONLY.
2. SEMANTIC REASONING:
   - Understand the semantic intent of the Japanese text without keyword matching (e.g., "児童生徒がパスワードを変えられるようにする" means setting "studentPasswordChange" to "SHOW").
3. IDEMPOTENCY & SKIP CONDITION:
   - If the instruction mentions "設定済みならスキップ" (skip if already configured), set skipCondition = "CURRENT_VALUE_EQUALS_DESIRED".
4. DYNAMIC VALIDATION SCOPE PROPOSAL:
   - In "validationScopeProposal", propose the safest minimal unit and count for initial validation before full rollout (e.g., unit: "SCHOOL", count: 1, description: "先行検証として代表1校で確認"). Never propose 0.
5. INTERACTIVE REPLANNING & PLAN DIFF:
   - If a previous plan and refinement instruction are supplied, reflect the modifications. Populate "planDiff" with added, unchanged, removed items, and a clear Japanese explanation of changes.
6. HUMAN SUMMARY:
   - Provide a clear, natural Japanese summary describing what the plan will do, target scope, values, and skip behavior. Avoid raw JSON in summary.`;

    let userPrompt = `User Instruction: "${input.userInstruction}"
Target Schools Ready: ${input.targetSet.summary.ready} schools.`;

    if (input.previousPlan && input.refinementInstruction) {
      userPrompt += `\n\n[Previous Plan Summary]
Intent: ${input.previousPlan.humanSummary?.interpretedIntent || ''}
Operations: ${input.previousPlan.operations.map(o => o.operationType).join(', ')}

[User Refinement / Modification Instruction]
"${input.refinementInstruction}"
Please update the plan reflecting the user modification and provide "planDiff".`;
    }

    userPrompt += `\nPlease generate the Execution Plan using submit_plan.`;

    // 3. Call Claude Haiku 5.5 with Structured Outputs & High Effort
    const llmRes = await LlmClient.callClaudeStructured<AiPlanResponse>({
      systemPrompt,
      userPrompt,
      jsonSchema,
      schema: AiPlanResponseZodSchema as any,
      effort: 'high'
    });

    const aiOutput = llmRes.data;

    // 4. Registry & Capability Validation (Double Validation)
    const operations: OperationIR[] = [];
    for (let i = 0; i < aiOutput.operations.length; i++) {
      const op = aiOutput.operations[i];
      const cap = registry.get(op.capabilityId);

      if (!cap) {
        throw new Error(`VALIDATION_FAILED: Capability '${op.capabilityId}' chosen by AI does not exist in registry.`);
      }
      if (!cap.productionValidated) {
        throw new Error(`VALIDATION_FAILED: Capability '${op.capabilityId}' is not production validated.`);
      }
      if (op.riskClass && op.riskClass !== cap.riskClass) {
        throw new Error(`VALIDATION_FAILED: Operation riskClass mismatch for '${op.capabilityId}': AI proposed '${op.riskClass}' but Registry SSOT defines '${cap.riskClass}'.`);
      }

      // Build internal OperationIR with Registry SSOT riskClass
      operations.push({
        operationId: `op_${i + 1}_${op.capabilityId}`,
        operationType: op.capabilityId,
        capabilityId: op.capabilityId,
        inputMapping: op.input,
        preconditions: (cap.preconditions || []).map(p => ({
          description: p,
          checkType: 'URL_MATCH',
          expected: true
        })),
        verification: [
          {
            description: `${cap.description} の反映検証`,
            verifyType: 'RELOAD_AND_CHECK',
            expected: true
          }
        ],
        riskClass: cap.riskClass,
        reversible: cap.riskClass === 'REVERSIBLE_WRITE' || cap.riskClass === 'READ_ONLY',
        estimatedDurationMs: 4000
      });
    }

    // 5. Calculate overall risk & evaluate validation scope proposal with Policy Engine
    const overallRisk = this.calculateHighestRisk(operations.map(o => o.riskClass));

    let validationScopeProposal: ValidationScopeProposal | undefined = undefined;
    if (aiOutput.validationScopeProposal) {
      const policyEval = PolicyEngine.evaluateValidationScopeProposal(
        aiOutput.validationScopeProposal,
        overallRisk,
        input.targetSet.summary.ready
      );
      validationScopeProposal = {
        unit: aiOutput.validationScopeProposal.unit,
        count: aiOutput.validationScopeProposal.count,
        description: aiOutput.validationScopeProposal.description,
        policyApproved: policyEval.approved,
        policyFeedback: policyEval.feedback
      };
    } else {
      // Default safe fallback proposal
      const defaultUnit = 'SCHOOL';
      const defaultCount = Math.min(1, input.targetSet.summary.ready);
      const defaultEval = PolicyEngine.evaluateValidationScopeProposal(
        { unit: defaultUnit, count: defaultCount, description: '先行検証として1校で安全確認' },
        overallRisk,
        input.targetSet.summary.ready
      );
      validationScopeProposal = {
        unit: defaultUnit,
        count: defaultCount,
        description: '先行検証として1校で安全確認',
        policyApproved: defaultEval.approved,
        policyFeedback: defaultEval.feedback
      };
    }

    const planHash = crypto.createHash('sha256').update(JSON.stringify({
      planId,
      userInstruction: input.userInstruction,
      refinement: input.refinementInstruction,
      operations,
      overallRisk
    })).digest('hex');

    const executionPlan: ExecutionPlan = {
      planId,
      targetSetId: input.targetSet.targetSetId,
      userInstruction: input.refinementInstruction
        ? `${input.userInstruction} [修正指示: ${input.refinementInstruction}]`
        : input.userInstruction,
      status: aiOutput.status,
      humanSummary: aiOutput.summary,
      planDiff: aiOutput.planDiff,
      validationScopeProposal,
      previousPlanId: input.previousPlan?.planId,
      refinementInstruction: input.refinementInstruction,
      sourceFiles: input.sourceFiles || [],
      operations,
      assumptions: aiOutput.assumptions.map(a => ({
        id: a.id,
        description: a.description,
        impactIfFalse: a.impactIfFalse || ''
      })),
      questions: aiOutput.questions.map(q => ({
        id: q.id,
        question: q.question,
        context: q.context
      })),
      riskLevel: overallRisk,
      estimatedAffectedSchools: input.targetSet.summary.ready,
      approvalStatus: 'DRAFT',
      planHash,
      createdAt: new Date().toISOString()
    };

    return {
      plan: executionPlan,
      aiProvider: llmRes.provider,
      aiModel: llmRes.model,
      isRealApiCall: llmRes.isRealApiCall,
      tokenUsage: llmRes.usage,
      latencyMs: llmRes.usage.latencyMs
    };
  }

  private static calculateHighestRisk(risks: RiskClass[]): RiskClass {
    if (risks.length === 0) return 'READ_ONLY';
    const hierarchy: RiskClass[] = [
      'READ_ONLY',
      'REVERSIBLE_WRITE',
      'SENSITIVE_WRITE',
      'DESTRUCTIVE_WRITE',
      'IRREVERSIBLE_WRITE'
    ];
    let highestIdx = 0;
    for (const r of risks) {
      const idx = hierarchy.indexOf(r);
      if (idx > highestIdx) highestIdx = idx;
    }
    return hierarchy[highestIdx];
  }
}
