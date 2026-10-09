import { SchoolRunResult, JobRunSummary } from '../types/job';

export interface ResultAnalysisReport {
  headlineSummary: string;
  totalSchools: number;
  successRatePercent: number;
  outcomeBreakdown: {
    success: number;
    alreadyConfigured: number;
    blocked: number;
    failed: number;
    skipped: number;
  };
  keyFindings: string[];
  recommendations: string[];
}

export class ResultAnalyst {
  static analyzeResults(summary: JobRunSummary, results: SchoolRunResult[]): ResultAnalysisReport {
    const total = summary.totalSchools || results.length;
    const success = summary.successCount;
    const alreadyConfigured = summary.alreadyConfiguredCount;
    const blocked = summary.blockedCount;
    const failed = summary.failedCount;
    const skipped = summary.skippedCount;

    const successRate = total > 0 ? Math.round(((success + alreadyConfigured) / total) * 1000) / 10 : 0;

    const keyFindings: string[] = [];
    const recommendations: string[] = [];

    if (failed > 0) {
      keyFindings.push(`エラーが発生した学校が ${failed} 校あります。認証失敗またはタイムアウトの可能性があります。`);
      recommendations.push('失敗した学校の個別エラーログを確認し、ログイン情報やネットワーク状態を点検してください。');
    }

    if (blocked > 0) {
      keyFindings.push(`安全機構（Circuit Breaker / Identity Mismatch等）により ${blocked} 校の実行がブロックされました。`);
      recommendations.push('学校コード・IDの不一致や予期しない画面構造がないか確認してください。');
    }

    if (alreadyConfigured > 0) {
      keyFindings.push(`${alreadyConfigured} 校は既に目的の設定またはアカウントが存在していたため、冪等性に基づきスキップされました。`);
    }

    if (failed === 0 && blocked === 0) {
      keyFindings.push('全対象校に対して、安全かつ計画通りに変更・検証が完了しました。');
      recommendations.push('適用台帳およびエクスポートレポートを保管してください。');
    }

    const headlineSummary = `${total}校中 ${success}校で適用成功、${alreadyConfigured}校で設定済みスキップ（成功率 ${successRate}%）。所要時間: ${Math.round(summary.elapsedSeconds / 60)}分、累計AIコスト: 約¥${summary.accumulatedAiCostJpy}`;

    return {
      headlineSummary,
      totalSchools: total,
      successRatePercent: successRate,
      outcomeBreakdown: {
        success,
        alreadyConfigured,
        blocked,
        failed,
        skipped
      },
      keyFindings,
      recommendations
    };
  }
}
