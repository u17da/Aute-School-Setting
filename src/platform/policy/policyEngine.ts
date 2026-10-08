import { ApprovalPolicy, GateId, GateStatus, SafetyAuditResult } from '../types/policy';
import { ExecutionPlan, RiskClass } from '../types/plan';
import { JobExecutionMode } from '../types/job';

export class PolicyEngine {
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
   * Approve a specific gate
   */
  static approveGate(policy: ApprovalPolicy, gateId: GateId, approvedBy = 'Operator', notes?: string): void {
    const gate = policy.gates[gateId];
    if (gate) {
      gate.approved = true;
      gate.approvedBy = approvedBy;
      gate.approvedAt = new Date().toISOString();
      gate.notes = notes;
    }
  }

  /**
   * Check whether a requested execution mode is permitted by policy gates
   */
  static verifyExecutionAllowed(policy: ApprovalPolicy, mode: JobExecutionMode): SafetyAuditResult {
    const violations: string[] = [];
    const warnings: string[] = [];

    // Gate 1 check: Always required
    if (policy.gates.GATE_1_PLAN.required && !policy.gates.GATE_1_PLAN.approved) {
      violations.push('Gate 1 (Execution Plan 承認) が完了していません。実行は許可されません。');
    }

    if (mode === 'LOGICAL_DRY_RUN') {
      // Dry-run only requires Gate 1 approval
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

    if (mode === 'CANARY_VALIDATION') {
      if (policy.gates.GATE_3_CANARY.required && !policy.gates.GATE_3_CANARY.approved) {
        // Can be auto-approved if autoProceedToCanary is enabled
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
      if (policy.gates.GATE_3_CANARY.required && !policy.gates.GATE_3_CANARY.approved) {
        violations.push('高リスク操作のため、Canary検証 (Gate 3) を先に完了・承認する必要があります。');
      }
      if (policy.gates.GATE_4_FULL_PRODUCTION.required && !policy.gates.GATE_4_FULL_PRODUCTION.approved) {
        if (!policy.autoProceedToFullOnCanarySuccess) {
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
   * AIによる先行検証提案の安全性検証 (Policy Engine SSOT)
   */
  static evaluateValidationScopeProposal(
    proposal: { unit: string; count: number; description: string },
    riskClass: RiskClass,
    totalTargets: number
  ): { approved: boolean; feedback: string } {
    if (proposal.count <= 0) {
      return {
        approved: false,
        feedback: 'ポリシー違反: 先行検証の対象件数は1件以上である必要があります（0件の先行検証は禁止されています）。'
      };
    }
    if (totalTargets > 0 && proposal.count > totalTargets) {
      return {
        approved: false,
        feedback: `ポリシー違反: 先行検証件数 (${proposal.count}) が全体の対象総数 (${totalTargets}) を超えています。`
      };
    }
    if ((riskClass === 'DESTRUCTIVE_WRITE' || riskClass === 'IRREVERSIBLE_WRITE') && proposal.count > 1) {
      return {
        approved: false,
        feedback: 'ポリシー違反: 高リスク・破壊的操作の先行検証は最大1件に制限されます。'
      };
    }
    return {
      approved: true,
      feedback: `ポリシー承認: 先行検証として ${proposal.count} ${proposal.unit} (${proposal.description}) の実行を許可します。`
    };
  }
}

