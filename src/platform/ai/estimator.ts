import { ExecutionPlan } from '../types/plan';
import { TargetSet } from '../types/target';
import { TimeEstimate, CostEstimate, ModelCostConfig } from '../types/estimator';

export class Estimator {
  private static defaultCostConfig: ModelCostConfig = {
    modelId: 'gemini-1.5-pro / claude-3-5-sonnet',
    inputCostPer1M: 450, // 約 450 円 / 100万トークン
    outputCostPer1M: 2250 // 約 2,250 円 / 100万トークン
  };

  /**
   * Estimate execution time based on plan operations and target count
   */
  static estimateTime(plan: ExecutionPlan, targetSet: TargetSet, measuredStats?: {
    avgPerTargetSec?: number;
    authTimeAvgSec?: number;
  }): TimeEstimate {
    const targetCount = plan.estimatedAffectedSchools > 0 ? plan.estimatedAffectedSchools : targetSet.summary.ready;

    // Operation duration breakdown
    let opDurationMs = 0;
    for (const op of plan.operations) {
      opDurationMs += op.estimatedDurationMs || 3000;
    }

    const authTimeAvgSec = measuredStats?.authTimeAvgSec || 4.5;
    const operationTimeAvgSec = opDurationMs / 1000;
    const verifyTimeAvgSec = 2.0;

    const basePerTargetSec = authTimeAvgSec + operationTimeAvgSec + verifyTimeAvgSec;
    const avgDurationPerTargetSec = measuredStats?.avgPerTargetSec || basePerTargetSec;
    const p50DurationSec = avgDurationPerTargetSec * 0.95;
    const p95DurationSec = avgDurationPerTargetSec * 1.35;

    // Concurrency calculation: default 2-3 parallel browser contexts or sequential with buffer
    const concurrency = 2; // 安全な並列度2
    const totalEstimatedSeconds = Math.round((targetCount * avgDurationPerTargetSec) / concurrency);

    const minSec = Math.round(totalEstimatedSeconds * 0.85);
    const maxSec = Math.round(totalEstimatedSeconds * 1.25);

    return {
      targetCount,
      avgDurationPerTargetSec: Math.round(avgDurationPerTargetSec * 10) / 10,
      p50DurationSec: Math.round(p50DurationSec * 10) / 10,
      p95DurationSec: Math.round(p95DurationSec * 10) / 10,
      authTimeAvgSec,
      operationTimeAvgSec,
      verifyTimeAvgSec,
      totalEstimatedSeconds,
      displayFormatted: `${this.formatSeconds(minSec)} ～ ${this.formatSeconds(maxSec)}`,
      confidenceRange: {
        minFormatted: this.formatSeconds(minSec),
        maxFormatted: this.formatSeconds(maxSec)
      }
    };
  }

  /**
   * Estimate AI API usage and cost.
   * Notice: AI is NOT invoked during normal deterministic Playwright execution,
   * so cost does NOT linearly scale with the hundreds of schools.
   */
  static estimateCost(plan: ExecutionPlan, targetSet: TargetSet, costConfig = this.defaultCostConfig): CostEstimate {
    // 1. Plan generation tokens (fixed)
    const planInputTokens = 3500;
    const planOutputTokens = 1200;

    // 2. File interpretation tokens (based on sources)
    const fileCount = plan.sourceFiles.length || 1;
    const fileInputTokens = fileCount * 2500;
    const fileOutputTokens = fileCount * 800;

    // 3. Exception reserve (only a few schools might trigger AI exception triage)
    const expectedExceptions = Math.max(1, Math.round(targetSet.summary.total * 0.02));
    const exceptionInputTokens = expectedExceptions * 1500;
    const exceptionOutputTokens = expectedExceptions * 500;

    // 4. Result summary (fixed)
    const summaryInputTokens = 4000;
    const summaryOutputTokens = 1500;

    const totalInput = planInputTokens + fileInputTokens + exceptionInputTokens + summaryInputTokens;
    const totalOutput = planOutputTokens + fileOutputTokens + exceptionOutputTokens + summaryOutputTokens;

    const calcJpy = (inp: number, out: number) => {
      const inpJpy = (inp / 1_000_000) * costConfig.inputCostPer1M;
      const outJpy = (out / 1_000_000) * costConfig.outputCostPer1M;
      return Math.round((inpJpy + outJpy) * 100) / 100;
    };

    const planGenerationJpy = calcJpy(planInputTokens, planOutputTokens);
    const fileInterpretationJpy = calcJpy(fileInputTokens, fileOutputTokens);
    const exceptionReserveJpy = calcJpy(exceptionInputTokens, exceptionOutputTokens);
    const resultSummaryJpy = calcJpy(summaryInputTokens, summaryOutputTokens);

    const totalJpy = Math.ceil(planGenerationJpy + fileInterpretationJpy + exceptionReserveJpy + resultSummaryJpy);

    return {
      model: costConfig.modelId,
      estimatedInputTokens: totalInput,
      estimatedOutputTokens: totalOutput,
      estimatedToolCalls: plan.operations.length + 2,
      estimatedCostJpy: totalJpy,
      breakdown: {
        planGenerationJpy,
        fileInterpretationJpy,
        exceptionReserveJpy,
        resultSummaryJpy
      }
    };
  }

  private static formatSeconds(totalSeconds: number): string {
    const s = Math.max(1, Math.round(totalSeconds));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;

    if (hours > 0) {
      return `${hours}時間${minutes}分${seconds > 0 ? `${seconds}秒` : ''}`;
    }
    if (minutes > 0) {
      return `${minutes}分${seconds > 0 ? `${seconds < 10 ? '0' : ''}${seconds}秒` : ''}`;
    }
    return `${seconds}秒`;
  }
}

