import { CapabilityDefinition } from '../types/capability';
import { RiskClass } from '../types/plan';

export interface StaticSafetyReport {
  passed: boolean;
  violations: string[];
}

export class CapabilityBuilder {
  /**
   * Static Safety Analysis for AI Generated Capability code or specifications.
   * Prohibits unsafe primitives: eval, Function, child_process, fs, process.env, network, git, etc.
   */
  static inspectSafety(code: string): StaticSafetyReport {
    const violations: string[] = [];

    const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
      { pattern: /\beval\s*\(/, reason: 'Use of eval() is strictly forbidden.' },
      { pattern: /\bnew\s+Function\s*\(/, reason: 'Use of Function constructor is strictly forbidden.' },
      { pattern: /\bchild_process\b/, reason: 'Direct execution of child processes is forbidden.' },
      { pattern: /\bexec\s*\(|\bspawn\s*\(|\bexecSync\s*\(/, reason: 'Execution of arbitrary shell commands is forbidden.' },
      { pattern: /\bfs\b|\bpromises\/fs\b|\bnode:fs\b/, reason: 'Arbitrary filesystem access is forbidden in capability code.' },
      { pattern: /\bprocess\.env\b/, reason: 'Direct access to process.env is forbidden to prevent credential leakage.' },
      { pattern: /\b(password|secret|credential|api[_-]?key)\s*[:=]\s*["'`][^"'`]+["'`]/i, reason: 'Hardcoded secrets detected.' },
      { pattern: /\bgit\s+(push|commit|checkout|reset|branch)/i, reason: 'Git operations are strictly forbidden.' },
      { pattern: /\bfetch\s*\(|\baxios\b|\bhttp\.request\b/, reason: 'Unrestricted external network calls are forbidden.' }
    ];

    for (const item of FORBIDDEN_PATTERNS) {
      if (item.pattern.test(code)) {
        violations.push(item.reason);
      }
    }

    return {
      passed: violations.length === 0,
      violations
    };
  }

  /**
   * Build a candidate capability from vetted parameters and primitives.
   */
  static createCandidateCapability(params: {
    capabilityId: string;
    description: string;
    supportedPages: string[];
    riskClass: RiskClass;
    rawScript?: string;
  }): { capability?: CapabilityDefinition; safetyReport: StaticSafetyReport } {
    if (params.rawScript) {
      const safetyReport = this.inspectSafety(params.rawScript);
      if (!safetyReport.passed) {
        return { safetyReport };
      }
    }

    const candidate: CapabilityDefinition = {
      capabilityId: params.capabilityId.toUpperCase(),
      version: '0.1.0-candidate',
      description: params.description,
      supportedPages: params.supportedPages,
      riskClass: params.riskClass,
      testStatus: 'UNTESTED',
      productionValidated: false,
      createdBy: 'AI_GENERATED',
      updatedAt: new Date().toISOString(),

      async observe(context, input) {
        context.logger.info(`[CANDIDATE_${params.capabilityId}] Observing`);
        return { currentState: {}, eligible: true };
      },

      async plan(context, input) {
        return { planned: true, capabilityId: params.capabilityId };
      },

      async execute(context, input) {
        if (!candidate.productionValidated && !context.isDryRun) {
          throw new Error(`Capability ${params.capabilityId} is not PRODUCTION_VALIDATED. Dry-run only.`);
        }
        return {
          success: true,
          appliedChanges: { candidate: true },
          verified: true,
          message: `Candidate capability ${params.capabilityId} executed in safe sandbox`
        };
      },

      async verify(context, input) {
        return true;
      }
    };

    return {
      capability: candidate,
      safetyReport: { passed: true, violations: [] }
    };
  }
}
