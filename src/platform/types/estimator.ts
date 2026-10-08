export interface ModelCostConfig {
  modelId: string;
  inputCostPer1M: number;  // JPY or USD
  outputCostPer1M: number;
}

export interface CostEstimate {
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedToolCalls: number;
  estimatedCostJpy: number;
  breakdown: {
    planGenerationJpy: number;
    fileInterpretationJpy: number;
    exceptionReserveJpy: number;
    resultSummaryJpy: number;
  };
}

export interface TimeEstimate {
  targetCount: number;
  avgDurationPerTargetSec: number;
  p50DurationSec: number;
  p95DurationSec: number;
  authTimeAvgSec: number;
  operationTimeAvgSec: number;
  verifyTimeAvgSec: number;
  totalEstimatedSeconds: number;
  displayFormatted: string; // e.g. "2h45m ～ 3h20m"
  confidenceRange: {
    minFormatted: string;
    maxFormatted: string;
  };
}
