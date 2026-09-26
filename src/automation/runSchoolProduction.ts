import { chromium, Browser, BrowserContext } from 'playwright';
import { EffectiveExecutionOptions, RequestedSettings } from '../types/config';
import { ExecutionResult, ExecutionPlan } from '../types/plan';
import { SchoolSettingsObservation } from '../types/settings';
import { AutomationError } from '../types/errors';
import { ResultManager } from '../logger/resultManager';
import { logger } from '../logger/logger';
import { createSchoolBrowserContext } from '../browser/createBrowserContext';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
import { SchoolSettingsPage } from '../pages/SchoolSettingsPage';
import { buildExecutionPlan } from './buildExecutionPlan';
import { evaluateExecutionPlan } from './evaluateExecutionPlan';
import { screenshotManager, ScreenshotSafetyContext } from '../utils/screenshot';
import { withRetry } from '../utils/retry';

export interface ProductionSchoolRunParams {
  schoolCode: string;
  schoolName: string;
  userId: string;
  password?: string;
  desiredSettings: RequestedSettings;
  executionOptions: EffectiveExecutionOptions;
  envConfig: import('../types/config').AppEnvConfig;
  /**
   * Batch実行時のフラグ（破壊的変更の強制ブロックなど指示24の適用）
   */
  isBatchMode?: boolean;
  signal?: AbortSignal;
}

/**
 * 1学校に対する本番適用用 Runner (指示1, 10: Restoreは行わず、Desired Stateへ適用・永続化確認して終了)
 */
export async function runSchoolProduction(params: ProductionSchoolRunParams): Promise<ExecutionResult> {
  const { schoolCode, schoolName, userId, password, desiredSettings, executionOptions, envConfig, isBatchMode = false, signal } = params;
  const resultManager = new ResultManager();
  let context: BrowserContext | null = null;
  let browser: Browser | null = null;
  let page: any = null;

  // 指示11: Allow-list方式のスクリーンショット安全コンテキスト
  const safetyContext: ScreenshotSafetyContext = {
    authenticationCompleted: false,
    schoolVerified: false,
    pageType: 'AUTH'
  };

  const abortHandler = () => {
    logger.warn(`[${schoolCode}] AbortSignal 検知: BrowserContext を即時強制クローズします`);
    if (context) {
      context.close().catch(() => {});
    }
  };
  if (signal) {
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    if (signal?.aborted) {
      throw new AutomationError('TIMEOUT', `学校処理開始前にタイムアウトまたは中断シグナルを検知しました`);
    }

    resultManager.setExecutionOptions(executionOptions);
    resultManager.setSchoolInfo(schoolCode, schoolName);
    resultManager.setHashes(desiredSettings, executionOptions);

    // 指示13: AUTH_MODE=B は本番・Batch適用禁止
    if (executionOptions.authMode !== 'A') {
      throw new AutomationError(
        'UNSAFE_CONFIGURATION',
        `Production Runnerでは AUTH_MODE=A のみが許可されています (指定: ${executionOptions.authMode})`,
        { authMode: executionOptions.authMode }
      );
    }

    // 1学校1Contextの作成 (指示12)
    browser = await chromium.launch({
      headless: executionOptions.headless,
      slowMo: executionOptions.slowMoMs
    });
    context = await createSchoolBrowserContext(browser, envConfig);
    page = await context.newPage();

    // 1. ログイン画面アクセス & 学校コード入力 & 認証方式観測 (指示12: Read-only処理は安全にリトライ可)
    const loginPage = new LoginPage(page);
    const authObs = await withRetry(
      () => loginPage.navigateAndSubmitSchoolCode(envConfig.baseUrl, schoolCode, executionOptions.authMode),
      { retries: 2, delayMs: 1500 }
    );
    resultManager.setAuthObservation(authObs);

    if (authObs.resolvedProvider !== 'LOCAL' || authObs.externalIdpDetected) {
      throw new AutomationError(
        'UNSAFE_CONFIGURATION',
        `LOCAL認証以外の外部IdPが検出されたため実行を中止します (Provider: ${authObs.resolvedProvider}, 外部IdP: ${authObs.externalIdpDetected})`,
        { authObs }
      );
    }

    // 2. ログイン実行 (パスワード送信はリトライしない)
    const actualPassword = password || envConfig.password;
    if (!actualPassword) {
      throw new AutomationError('LOGIN_FAILED', 'ログインパスワードが提供されていません');
    }
    await loginPage.loginWithLocalPassword(userId, actualPassword);
    safetyContext.authenticationCompleted = true;
    safetyContext.pageType = 'HOME';

    // 3. ホーム画面での厳格な学校名完全一致照合
    const homePage = new HomePage(page);
    await homePage.verifySchool(schoolCode, schoolName);
    safetyContext.schoolVerified = true;

    // 4. 設定メニューから「学校設定」画面へ遷移 (指示12: Read-only遷移はリトライ可)
    await withRetry(
      () => homePage.navigateToSchoolSettings(),
      { retries: 2, delayMs: 1500 }
    );

    // 5. 学校設定画面のロード検証 & 最新 Baseline Observation 取得 (指示12: 読取リトライ可)
    const schoolSettingsPage = new SchoolSettingsPage(page);
    await schoolSettingsPage.verifyPageLoaded();
    safetyContext.pageType = 'SCHOOL_SETTINGS';
    const { observation: baselineObservation } = await withRetry(
      () => schoolSettingsPage.readAllSettingsObservation(),
      { retries: 2, delayMs: 1000 }
    );
    resultManager.setBeforeObservation(baselineObservation);

    // 指示4: フォーム内の optimistic locking (lock_version等) の確認
    const lockFields = await page.locator('form input[type="hidden"]').evaluateAll((inputs: HTMLInputElement[]) => {
      return inputs
        .map((i) => ({ name: i.name, value: i.value }))
        .filter((i) => /lock|version|revision|updated_at|timestamp/i.test(i.name));
    }).catch(() => []);
    if (lockFields.length > 0) {
      logger.info(`【Lost Update対策】楽観的ロックフィールドを検出しました (通常フォーム送信で維持): ${lockFields.map((f: any) => f.name).join(', ')}`);
    }

    // 6. Execution Plan の再生成
    const plan = buildExecutionPlan({
      schoolCode,
      schoolName,
      currentObservation: baselineObservation,
      requestedSettings: desiredSettings
    });

    const evaluation = evaluateExecutionPlan(plan);
    resultManager.setPlanAndEvaluation(plan, evaluation);

    // 指示24: 破壊的変更のBatch書き込み実行は強制ブロック (Dry Runでは観測・集計のため通過)
    if (isBatchMode && executionOptions.apply && plan.hasDestructiveChanges) {
      throw new AutomationError(
        'DESTRUCTIVE_CHANGE_BLOCKED',
        'Batch実行での破壊的変更（予約投稿削除リスク）を含む設定書き込みは安全のため強制ブロックされます',
        { hasDestructiveChanges: plan.hasDestructiveChanges, actions: plan.actions }
      );
    }

    // 差分なし（ALREADY_CONFIGURED）の判定
    if (!plan.hasChanges) {
      logger.info('全設定項目が既に期待状態と一致しています (NO_CHANGES_REQUIRED)');
      resultManager.setStatus('SUCCESS_ALREADY_CONFIGURED');
      resultManager.setAfterObservation(baselineObservation);
      const logPath = resultManager.save();
      logger.info(`結果ログを保存しました: ${logPath}`);
      return resultManager.getResult();
    }

    // Execution Gate による実行可否評価
    if (!evaluation.isExecutable) {
      throw new AutomationError(
        'PRE_SAVE_VALIDATION_FAILED',
        `ExecutionPlanが実行不可と判定されました: ${evaluation.blockReasons.map((r) => r.message).join('; ')}`,
        { blockReasons: evaluation.blockReasons }
      );
    }

    // Dry Run 表示
    logger.printDryRunPlan(plan, evaluation, executionOptions.allowDestructive);

    // 指示1, 21: 書き込みGateチェック
    // Single校では apply && allowLiveWrite, Batchではさらに batchApply が必要
    const isWritePermitted = executionOptions.apply && executionOptions.allowLiveWrite;
    if (!isWritePermitted) {
      logger.info('【Dry Run完了】書き込みフラグ未指定のため、設定変更および保存は行わず安全終了しました');
      resultManager.setStatus('DRY_RUN_COMPLETED');
      const logPath = resultManager.save();
      logger.info(`Dry Runログを保存しました: ${logPath}`);
      return resultManager.getResult();
    }

    // =========================================================================
    // 本番適用実行 (Multi-action適用 -> Pre-Save検証 -> 保存 -> 永続化確認 -> 終了: Restoreなし)
    // =========================================================================
    logger.info(`\n=== Production Write 開始: 対象学校=${schoolName} (${schoolCode}) Actions=${plan.actions.length}件 ===`);

    const ssBefore = await screenshotManager.captureStage(page, '01-before-write', schoolCode);
    if (ssBefore) resultManager.setScreenshotPath('01-before-write', ssBefore);

    // 指示8, 9, 10: Multi-action 適用 & 保存 & 永続化検証 (Restoreは行わない)
    const writeResult = await schoolSettingsPage.applyAndVerifyProduction({
      plan,
      baselineObservation,
      timeoutMs: executionOptions.defaultTimeoutMs,
      exactOnly: true,
      signal
    });

    const ssAfter = await screenshotManager.captureStage(page, '02-after-write-reload', schoolCode);
    if (ssAfter) resultManager.setScreenshotPath('02-after-write-reload', ssAfter);

    resultManager.setAfterObservation(writeResult.afterObservation);
    resultManager.setStatus(writeResult.recovered ? 'SUCCESS_RECOVERED' : 'SUCCESS');

    const logPath = resultManager.save();
    logger.info(`【Production適用完了】学校=${schoolName} (${schoolCode}) Status=${resultManager.getResult().status}`);
    logger.info(`結果ログ: ${logPath}`);

    return resultManager.getResult();
  } catch (error: any) {
    logger.error(`Production Runner エラー: ${error.message}`);
    const status = error.status || 'UNEXPECTED_ERROR';
    resultManager.setStatus(status);
    resultManager.addIssue({
      code: error.issueCode || status,
      message: error.message,
      details: error.details
    });

    // 指示10, 11: 失敗時スクリーンショット（Allow-list方式: 学校設定画面かつ認証・照合完了時のみ）
    if (page) {
      try {
        const ssErr = await screenshotManager.captureError(page, schoolCode, safetyContext);
        if (ssErr) resultManager.setScreenshotPath('failure', ssErr);
      } catch {}
    }

    const logPath = resultManager.save();
    logger.info(`エラーログを保存しました: ${logPath}`);
    return resultManager.getResult();
  } finally {
    if (signal) {
      signal.removeEventListener('abort', abortHandler);
    }
    if (context) {
      await context.close().catch(() => {});
      logger.info(`[${schoolCode}] BrowserContext を正常に破棄しました`);
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
