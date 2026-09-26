import { ExecutionStatus } from '../types/errors';
import { CircuitBreakerConfig, CircuitBreakerTripInfo, ErrorSeverity } from '../types/batch';
import { logger } from '../logger/logger';

export class CircuitBreaker {
  private consecutiveSystemicFailures = 0;
  private isTripped = false;
  private tripInfo: CircuitBreakerTripInfo | null = null;
  private config: CircuitBreakerConfig;

  // 重大度別ステータスマップ
  private static readonly CRITICAL_ERRORS: ExecutionStatus[] = [
    'SAVE_OUTCOME_UNKNOWN',
    'UNEXPECTED_SIDE_EFFECT',
    'VERIFY_MISMATCH',
    'RESTORE_FAILED',
    'CLEANUP_TIMEOUT',
    'CHECKPOINT_IO_ERROR'
  ];

  private static readonly SYSTEMIC_ERRORS: ExecutionStatus[] = [
    'UI_STRUCTURE_MISMATCH',
    'SAVE_FAILED',
    'TIMEOUT',
    'LOGIN_FAILED'
  ];

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      consecutiveFailureThreshold: config?.consecutiveFailureThreshold ?? 3,
      canaryMode: config?.canaryMode ?? false
    };
  }

  /**
   * 1学校の実行結果を記録し、重大度別のCircuit Breaker判定を行う (指示8, 9, 10)
   */
  recordResult(
    status: ExecutionStatus,
    schoolCode: string,
    mode: 'PREFLIGHT_DRY_RUN' | 'PRODUCTION_WRITE' = 'PREFLIGHT_DRY_RUN'
  ): void {
    if (this.isTripped) return;

    if (status === 'SUCCESS' || status === 'SUCCESS_ALREADY_CONFIGURED' || status === 'DRY_RUN_COMPLETED') {
      // 正常完了時はSYSTEMIC連続失敗カウントをリセット
      this.consecutiveSystemicFailures = 0;
      return;
    }

    // 指示8: Write Mode における SCHOOL_MISMATCH は重大安全事象 (CRITICAL) として即PAUSE
    if (status === 'SCHOOL_MISMATCH' && mode === 'PRODUCTION_WRITE') {
      this.trip({
        category: 'CRITICAL',
        errorCode: status,
        consecutiveCount: 1,
        tripReason: `【CRITICAL: SCHOOL MISMATCH IN WRITE MODE】Writeモード実行中に学校名不一致 (${schoolCode}) を検知しました。誤適用防止のため即座にバッチ全体を PAUSE しました`
      });
      return;
    }

    // 1. CRITICAL カテゴリ: 1件発生した時点で即座にPAUSE
    if (CircuitBreaker.CRITICAL_ERRORS.includes(status)) {
      this.trip({
        category: 'CRITICAL',
        errorCode: status,
        consecutiveCount: 1,
        tripReason: `【CRITICAL ERROR】${schoolCode} にて致命的エラー [${status}] が発生したため、重大度ポリシーに基づき即座にバッチ全体を PAUSE しました`
      });
      return;
    }

    // 2. 指示10: Canary段階における SAVE_FAILED の扱い (1件でPAUSE)
    if (status === 'SAVE_FAILED' && this.config.canaryMode) {
      this.trip({
        category: 'SYSTEMIC',
        errorCode: status,
        consecutiveCount: 1,
        tripReason: `【CANARY SAFE WRITE】Canary実行中に保存エラー [SAVE_FAILED] (${schoolCode}) が発生したため、安全確保のため即座に PAUSE しました`
      });
      return;
    }

    // 3. SYSTEMIC カテゴリ: 同種またはSYSTEMICカテゴリが閾値(デフォルト3校)連続したらPAUSE
    if (CircuitBreaker.SYSTEMIC_ERRORS.includes(status)) {
      this.consecutiveSystemicFailures++;
      logger.warn(`【Circuit Breaker】SYSTEMICエラー検知 (${schoolCode}): status=${status} (連続失敗回数: ${this.consecutiveSystemicFailures} / ${this.config.consecutiveFailureThreshold})`);

      if (this.consecutiveSystemicFailures >= this.config.consecutiveFailureThreshold) {
        this.trip({
          category: 'SYSTEMIC',
          errorCode: status,
          consecutiveCount: this.consecutiveSystemicFailures,
          tripReason: `【SYSTEMIC FAILURE】システム共通エラー [${status}] が ${this.consecutiveSystemicFailures} 校連続で発生したため、残りの学校への処理を安全に一時停止 (PAUSE) しました`
        });
      }
      return;
    }

    // 4. SCHOOL_SPECIFIC カテゴリ: 当該学校をFAILEDとして記録し、次校へ進む
    logger.info(`【Circuit Breaker】SCHOOL_SPECIFICエラー (${schoolCode}): status=${status}。個別学校のエラーとして記録し次校へ継続します`);
  }

  private trip(params: {
    category: ErrorSeverity;
    errorCode: ExecutionStatus;
    consecutiveCount: number;
    tripReason: string;
  }): void {
    this.isTripped = true;
    this.tripInfo = {
      category: params.category,
      errorCode: params.errorCode,
      consecutiveCount: params.consecutiveCount,
      tripReason: params.tripReason,
      trippedAt: new Date().toISOString()
    };

    logger.error(`\n****************************************************************`);
    logger.error(`【CIRCUIT BREAKER TRIPPED】[${params.category}] ${params.tripReason}`);
    logger.error(`****************************************************************\n`);
  }

  shouldStop(): boolean {
    return this.isTripped;
  }

  getReason(): string {
    return this.tripInfo?.tripReason ?? '';
  }

  getTripInfo(): CircuitBreakerTripInfo | null {
    return this.tripInfo;
  }

  reset(): void {
    this.consecutiveSystemicFailures = 0;
    this.isTripped = false;
    this.tripInfo = null;
  }
}
