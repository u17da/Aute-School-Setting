import { chromium, Browser, BrowserContext } from 'playwright';
import { RawCliOptions, SchoolConfigFile, EffectiveExecutionOptions } from '../types/config';
import { ExecutionResult } from '../types/plan';
import { AutomationError } from '../types/errors';
import { ResultManager } from '../logger/resultManager';
import { logger } from '../logger/logger';
import { resolveExecutionOptions } from '../config/options';
import { loadSchoolConfigFile, loadEnvConfig } from '../config/loader';
import { validateConfigStatic } from '../settings/staticValidation';
import { createSchoolBrowserContext } from '../browser/createBrowserContext';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
import { SchoolSettingsPage } from '../pages/SchoolSettingsPage';
import { buildExecutionPlan } from './buildExecutionPlan';
import { evaluateExecutionPlan } from './evaluateExecutionPlan';

export async function runSchoolPhase2A(cliOptions: RawCliOptions): Promise<ExecutionResult> {
  const resultManager = new ResultManager();
  let context: BrowserContext | null = null;
  let browser: Browser | null = null;

  try {
    // 1. 実行オプションの解決 (CLI > .env > デフォルト)
    const envConfig = loadEnvConfig();
    const effectiveOptions = resolveExecutionOptions(cliOptions, envConfig);
    resultManager.setExecutionOptions(effectiveOptions);

    // 2. 設定ファイルの読み込みとバリデーション
    const config: SchoolConfigFile = loadSchoolConfigFile(effectiveOptions.configFile);
    resultManager.setSchoolInfo(config.school.schoolCode, config.school.schoolName);
    resultManager.setHashes(config.settings, effectiveOptions);

    // 3. ブラウザ起動前の静的バリデーション
    validateConfigStatic(config, effectiveOptions);

    // 4. ブラウザ起動と1学校1Contextの作成
    logger.info(`ブラウザを起動中 (headless=${effectiveOptions.headless})...`);
    browser = await chromium.launch({
      headless: effectiveOptions.headless,
      slowMo: effectiveOptions.slowMoMs
    });
    context = await createSchoolBrowserContext(browser, envConfig);
    const page = await context.newPage();

    // 5. ログイン画面アクセス & 学校コード入力 & 認証方式観測
    const loginPage = new LoginPage(page);
    const authObs = await loginPage.navigateAndSubmitSchoolCode(
      envConfig.baseUrl,
      config.school.schoolCode,
      effectiveOptions.authMode
    );
    resultManager.setAuthObservation(authObs);

    // 6. Runtime 外部IdP安全チェック (要求6)
    if (authObs.externalIdpDetected && config.settings.studentPasswordChange === 'SHOW') {
      throw new AutomationError(
        'UNSAFE_CONFIGURATION',
        '実行時安全チェック違反: 外部IdP連携が検出されたため、児童・生徒へのパスワード変更表示(SHOW)は許可されません',
        { authObs, studentPasswordChange: 'SHOW' }
      );
    }

    // 7. ログイン実行
    if (authObs.resolvedProvider === 'LOCAL' && effectiveOptions.authMode === 'A') {
      await loginPage.loginWithLocalPassword(envConfig.userId, envConfig.password);
    } else {
      if (envConfig.password) {
        await loginPage.loginWithExternalIdp(envConfig.userId, envConfig.password, envConfig.externalIdpTimeoutMs);
      } else {
        await loginPage.waitForExternalIdpLogin(envConfig.externalIdpTimeoutMs);
      }
    }

    // 8. ホーム画面での厳格な学校照合 (完全一致)
    const homePage = new HomePage(page);
    await homePage.verifySchool(config.school.schoolCode, config.school.schoolName);

    // 9. 設定メニューから「学校設定」画面へ遷移
    await homePage.navigateToSchoolSettings();

    // 10. 学校設定画面のロード検証 & 11項目のObservation取得
    const schoolSettingsPage = new SchoolSettingsPage(page);
    await schoolSettingsPage.verifyPageLoaded();
    const { observation: currentObservation, inspectionDetails } = await schoolSettingsPage.readAllSettingsObservation();
    resultManager.setBeforeObservation(currentObservation);

    logger.info('--- 11項目の実画面DOM観測結果 ---');
    for (const [key, detail] of Object.entries(inspectionDetails)) {
      if (!detail) {
        logger.info(`[${key}] 画面非表示 (CONTRACT_NOT_AVAILABLE)`);
      } else {
        const checkedRadio = detail.radios.find((r) => r.checked);
        logger.info(
          `[${key}] tag=<${detail.containerTag}> class="${detail.containerClass}" 選択肢数=${detail.radios.length} checked=${checkedRadio?.label} (Domain=${checkedRadio?.value}) disabled=${checkedRadio?.disabled}`
        );
      }
    }
    logger.info('--------------------------------');

    // 11. 保存UIおよびシグナル候補のDOM調査 (Phase 2A: クリックは一切行わない)
    const saveInspection = await schoolSettingsPage.inspectSaveButtonAndSignals();
    logger.info(`保存UI調査結果: ${saveInspection.candidateSignals.join(' / ')}`);

    // 12. Phase 1 の BuildExecutionPlan と EvaluateExecutionPlan へ接続
    const plan = buildExecutionPlan({
      schoolCode: config.school.schoolCode,
      schoolName: config.school.schoolName,
      currentObservation,
      requestedSettings: config.settings
    });

    const evaluation = evaluateExecutionPlan(plan);
    resultManager.setPlanAndEvaluation(plan, evaluation);

    // 13. Dry Run 結果のフォーマット表示
    logger.printDryRunPlan(plan, evaluation, effectiveOptions.allowDestructive);
    resultManager.setStatus('DRY_RUN_COMPLETED');

    // 14. 実行結果JSONログの保存
    const logPath = resultManager.save();
    logger.info(`Phase 2A (Read-only) 完了: ログ=${logPath}`);

    return resultManager.getResult();
  } catch (error: any) {
    logger.error(`エラーが発生しました: ${error.message}`);
    const status = error.status || 'UNEXPECTED_ERROR';
    resultManager.setStatus(status);
    resultManager.addIssue({
      code: error.issueCode || status,
      message: error.message,
      details: error.details
    });

    const logPath = resultManager.save();
    logger.info(`エラー結果ログを保存しました: ${logPath}`);
    return resultManager.getResult();
  } finally {
    // どの終了経路でもBrowserContextを必ず確実に破棄 (セッション・Cookie分離)
    if (context) {
      await context.close().catch(() => {});
      logger.info('BrowserContext を正常に破棄しました');
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
