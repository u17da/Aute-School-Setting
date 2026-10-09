import * as crypto from 'crypto';
import { z } from 'zod';
import { ApprovalPolicy, GateId, GateIdSchema, GateStatus, PolicyApproveRequest, PolicyApproveRequestSchema, SafetyAuditResult } from '../types/policy';
import { RiskClass } from '../types/plan';
import { JobExecutionMode, RunEvidence } from '../types/job';

export class PolicyEngine {
  /**
   * Validate approval request body against strict Zod schema
   */
  static validateApproveRequest(body: any): z.SafeParseReturnType<any, PolicyApproveRequest> {
    return PolicyApproveRequestSchema.safeParse(body);
  }

  static computePlanHash(plan: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(plan || {})).digest('hex');
  }

  static computeTargetSetHash(targetSet: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(targetSet || {})).digest('hex');
  }

  /**
   * Create an initial approval policy according to the plan's risk level
   */
  static createDefaultPolicy(riskClass: RiskClass): ApprovalPolicy {
    const isSensitive = riskClass === 'SENSITIVE_WRITE' || riskClass === 'DESTRUCTIVE_WRITE' || riskClass === 'IRREVERSIBLE_WRITE';

    return {
      riskClass,
      autoProceedToCanary: false,
      autoProceedToFullOnCanarySuccess: !isSensitive, // High-risk requires explicit Gate 4 approval
      gates: {
        GATE_1_PLAN: {
          gateId: 'GATE_1_PLAN',
          name: 'Execution Plan 承認',
          required: true,
          approved: false
        },
        GATE_2_DRY_RUN: {
          gateId: 'GATE_2_DRY_RUN',
          name: 'Dry-run 結果承認',
          required: true,
          approved: false
        },
        GATE_3_CANARY: {
          gateId: 'GATE_3_CANARY',
          name: 'Canary Production 承認',
          required: isSensitive, // SENSITIVEはCanary検証を必須化
          approved: false
        },
        GATE_4_FULL_PRODUCTION: {
          gateId: 'GATE_4_FULL_PRODUCTION',
          name: 'Full Production 承認',
          required: true,
          approved: false
        }
      }
    };
  }

  /**
   * Approve a specific gate with strict validation
   */
  static approveGate(
    policy: ApprovalPolicy,
    gateId: GateId,
    approvedBy = 'Operator',
    notes?: string
  ): void {
    const gateIdParsed = GateIdSchema.parse(gateId);
    const gate = policy.gates[gateIdParsed];
    if (gate) {
      gate.approved = true;
      gate.approvedBy = approvedBy.trim();
      gate.approvedAt = new Date().toISOString();
      gate.notes = notes;
    }
  }

  /**
   * Check whether a requested execution mode is permitted by policy gates AND actual run evidence
   */
  static verifyExecutionAllowed(
    policy: ApprovalPolicy,
    mode: JobExecutionMode,
    context?: {
      planHash?: string;
      targetSetHash?: string;
      evidences?: RunEvidence[];
    }
  ): SafetyAuditResult {
    const violations: string[] = [];
    const warnings: string[] = [];

    // Gate 1 check: Always required
    if (policy.gates.GATE_1_PLAN.required && !policy.gates.GATE_1_PLAN.approved) {
      violations.push('Gate 1 (Execution Plan 承認) が完了していません。実行は許可されません。');
    }

    if (mode === 'LOGICAL_DRY_RUN') {
      return {
        passed: violations.length === 0,
        violations,
        warnings
      };
    }

    // Gate 2 check: Required for any production write (Canary or Full)
    if (policy.gates.GATE_2_DRY_RUN.required && !policy.gates.GATE_2_DRY_RUN.approved) {
      violations.push('Gate 2 (Dry-run 結果承認) が完了していません。実環境への変更は許可されません。');
    }

    const evidences: RunEvidence[] = Array.isArray(context) ? context : (context?.evidences || []);
    const planHash = Array.isArray(context) ? policy.planHash : (context?.planHash || policy.planHash);
    const targetSetHash = Array.isArray(context) ? policy.targetSetHash : (context?.targetSetHash || policy.targetSetHash);

    // Check Dry-run Evidence (Execution Proof) for Canary and Full
    const matchingDryRunEvidence = evidences.find(e =>
      e.mode === 'LOGICAL_DRY_RUN' &&
      e.status === 'SUCCESS' &&
      (!planHash || e.fingerprint.planHash === planHash) &&
      (!targetSetHash || e.fingerprint.targetSetHash === targetSetHash)
    );

    if (!matchingDryRunEvidence) {
      violations.push('現在のPlan/TargetSetに対するDry-run正常完了の実行証跡(Evidence)が存在しません。');
    }

    if (mode === 'CANARY_VALIDATION') {
      if (policy.gates.GATE_3_CANARY.required && !policy.gates.GATE_3_CANARY.approved) {
        if (!policy.autoProceedToCanary) {
          violations.push('Gate 3 (Canary Production 承認) が完了していません。');
        }
      }
      return {
        passed: violations.length === 0,
        violations,
        warnings
      };
    }

    if (mode === 'FULL_PRODUCTION') {
      // Full Production REQUIRES successful Canary validation evidence
      const matchingCanaryEvidence = evidences.find(e =>
        e.mode === 'CANARY_VALIDATION' &&
        e.status === 'SUCCESS' &&
        e.failedCount === 0 &&
        e.blockedCount === 0 &&
        e.allVerified === true &&
        e.successCount > 0 &&
        (!planHash || e.fingerprint.planHash === planHash) &&
        (!targetSetHash || e.fingerprint.targetSetHash === targetSetHash)
      );

      if (!matchingCanaryEvidence) {
        violations.push('Full Production 前に必要な Canary検証の正常完了証跡(全校成功・検証一致・失敗0)が存在しません。');
      }

      if (policy.gates.GATE_3_CANARY.required && !policy.gates.GATE_3_CANARY.approved) {
        violations.push('高リスク操作のため、Canary検証 (Gate 3) を先に完了・承認する必要があります。');
      }

      const isHighRisk = policy.riskClass === 'SENSITIVE_WRITE' || policy.riskClass === 'DESTRUCTIVE_WRITE' || policy.riskClass === 'IRREVERSIBLE_WRITE';

      if (policy.gates.GATE_4_FULL_PRODUCTION.required && !policy.gates.GATE_4_FULL_PRODUCTION.approved) {
        // autoProceedToFullOnCanarySuccess works ONLY when Canary succeeded AND risk is low
        if (!policy.autoProceedToFullOnCanarySuccess || !matchingCanaryEvidence || isHighRisk) {
          violations.push('Gate 4 (Full Production 承認) が完了していません。');
        }
      }
    }

    return {
      passed: violations.length === 0,
      violations,
      warnings
    };
  }

  /**
   * Determine approved Canary validation scope count with strict upper limits
   */
  static getApprovedCanaryScope(
    policyOrRisk: ApprovalPolicy | RiskClass,
    totalTargets: number,
    proposedCount?: number
  ): number {
    const riskClass = typeof policyOrRisk === 'string' ? policyOrRisk : policyOrRisk.riskClass;
    if (typeof policyOrRisk === 'object' && policyOrRisk.policyApprovedCanaryScope) {
      return policyOrRisk.policyApprovedCanaryScope;
    }
    let maxAllowed = 3; // Default max for READ_ONLY and REVERSIBLE_WRITE
    if (riskClass === 'SENSITIVE_WRITE') {
      maxAllowed = 2;
    } else if (riskClass === 'DESTRUCTIVE_WRITE' || riskClass === 'IRREVERSIBLE_WRITE') {
      maxAllowed = 1;
    }

    const baseCount = proposedCount && proposedCount > 0 ? proposedCount : 1;
    const capped = Math.min(baseCount, maxAllowed);
    return Math.max(1, Math.min(capped, totalTargets > 0 ? totalTargets : 1));
  }

  /**
   * AIによる先行検証提案の安全性検証 (Policy Engine SSOT)
   */
  static evaluateValidationScopeProposal(
    proposal: { unit: string; count: number; description: string },
    riskClass: RiskClass,
    totalTargets: number
  ): { approved: boolean; feedback: string; approvedCount: number } {
    if (proposal.count <= 0) {
      return {
        approved: false,
        feedback: 'ポリシー違反: 先行検証の対象件数は1件以上である必要があります（0件の先行検証は禁止されています）。',
        approvedCount: 1
      };
    }

    const approvedCount = this.getApprovedCanaryScope(riskClass, totalTargets, proposal.count);

    if (totalTargets > 0 && proposal.count > totalTargets) {
      return {
        approved: false,
        feedback: `ポリシー違反: 先行検証提案件数 (${proposal.count}) が全体の対象総数 (${totalTargets}) を超えています。ポリシーにより ${approvedCount} 校に制限されます。`,
        approvedCount
      };
    }

    if ((riskClass === 'DESTRUCTIVE_WRITE' || riskClass === 'IRREVERSIBLE_WRITE') && proposal.count > 1) {
      return {
        approved: false,
        feedback: `ポリシー違反: 高リスク・破壊的操作の先行検証は最大1件に制限されます。ポリシーにより 1 校に制限されます。`,
        approvedCount: 1
      };
    }

    if (proposal.count > approvedCount) {
      return {
        approved: false,
        feedback: `ポリシー制限: 提案件数 (${proposal.count}) はポリシー上限 (${approvedCount}) を超過しています。ポリシー上限値が適用されます。`,
        approvedCount
      };
    }

    return {
      approved: true,
      feedback: `ポリシー承認: 先行検証として ${approvedCount} ${proposal.unit} (${proposal.description}) の実行を許可します。`,
      approvedCount
    };
  }

  /**
   * Invalidate all prior approvals and evidences when Plan or TargetSet changes
   */
  static invalidatePolicy(policy: ApprovalPolicy, reason: string): ApprovalPolicy {
    return {
      ...policy,
      policyApprovedCanaryScope: undefined,
      gates: {
        GATE_1_PLAN: { ...policy.gates.GATE_1_PLAN, approved: false, notes: `Invalidated: ${reason}` },
        GATE_2_DRY_RUN: { ...policy.gates.GATE_2_DRY_RUN, approved: false, notes: `Invalidated: ${reason}` },
        GATE_3_CANARY: { ...policy.gates.GATE_3_CANARY, approved: false, notes: `Invalidated: ${reason}` },
        GATE_4_FULL_PRODUCTION: { ...policy.gates.GATE_4_FULL_PRODUCTION, approved: false, notes: `Invalidated: ${reason}` }
      }
    };
  }
}
