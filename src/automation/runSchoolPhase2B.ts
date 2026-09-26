import { chromium, Browser, BrowserContext } from 'playwright';
import { RawCliOptions, SchoolConfigFile, EffectiveExecutionOptions } from '../types/config';
import { ExecutionResult } from '../types/plan';
import { SettingKey, SettingValue, SchoolSettingsObservation, SettingExpectation } from '../types/settings';
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
import { ALL_SETTING_KEYS } from '../settings/definitions';
import { screenshotManager } from '../utils/screenshot';

export interface Phase2BOptions extends RawCliOptions {
  allowLiveWrite?: boolean;
}

export async function runSchoolPhase2B(cliOptions: Phase2BOptions): Promise<ExecutionResult> {
  const resultManager = new ResultManager();
  let context: BrowserContext | null = null;
  let browser: Browser | null = null;

  try {
    // 1. 実行オプションの解決 (指示1, 2)
    const envConfig = loadEnvConfig();
    const effectiveOptions = resolveExecutionOptions(cliOptions, envConfig);

    // 指示1: Live Writeの3重Gate (--phase2b, --apply, --allow-live-write)
    // 3つすべてが揃っている場合のみ isLiveWriteAllowed = true
    const isLiveWriteAllowed = effectiveOptions.apply && effectiveOptions.allowLiveWrite;

    // 指示3: 最初のLive Writeは headless=false 固定 (目視可能にする)
    if (isLiveWriteAllowed) {
      logger.info('【Live Write モード】指示3に従い、実行者が目視確認できるよう headless=false で起動します');
      effectiveOptions.headless = false;
    }

    resultManager.setExecutionOptions(effectiveOptions);

    // 2. 設定ファイルの読み込みとバリデーション
    const config: SchoolConfigFile = loadSchoolConfigFile(effectiveOptions.configFile);
    resultManager.setSchoolInfo(config.school.schoolCode, config.school.schoolName);
    resultManager.setHashes(config.settings, effectiveOptions);

    // 3. 静的バリデーション
    validateConfigStatic(config, effectiveOptions);

    // Phase 2B ガード: requested項目数の静的チェック (指示1)
    const requestedKeys = ALL_SETTING_KEYS.filter((k) => config.settings[k] !== null && config.settings[k] !== undefined);
    if (requestedKeys.length !== 1) {
      throw new AutomationError(
        'POC_SCOPE_VIOLATION',
        `Phase 2B PoCでは設定変更要求は厳密に1項目のみ指定する必要があります (指定数: ${requestedKeys.length}項目: ${requestedKeys.join(', ')})`,
        { requestedKeys, count: requestedKeys.length }
      );
    }
    const targetKey = requestedKeys[0];
    const targetRequestedValue = config.settings[targetKey] as SettingValue;

    // 4. ブラウザ起動と1学校1Contextの作成 (指示3: slowMoで追跡可能に)
    logger.info(`ブラウザを起動中 (headless=${effectiveOptions.headless}, slowMo=${effectiveOptions.slowMoMs}ms)...`);
    browser = await chromium.launch({
      headless: effectiveOptions.headless,
      slowMo: isLiveWriteAllowed ? 200 : effectiveOptions.slowMoMs
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

    // 指示5, 12: AUTH_MODE=A かつ LOCAL認証、外部IdP未検出を厳格チェック
    if (effectiveOptions.authMode !== 'A' || authObs.resolvedProvider !== 'LOCAL' || authObs.externalIdpDetected) {
      throw new AutomationError(
        'UNSAFE_CONFIGURATION',
        `Phase 2B Single Safe Write PoCは AUTH_MODE=A かつ LOCAL認証でのみ実行可能です (要求: ${effectiveOptions.authMode}, 解決: ${authObs.resolvedProvider}, 外部IdP: ${authObs.externalIdpDetected})`,
        { authMode: effectiveOptions.authMode, resolvedProvider: authObs.resolvedProvider, externalIdpDetected: authObs.externalIdpDetected }
      );
    }

    // 6. ログイン実行
    await loginPage.loginWithLocalPassword(envConfig.userId, envConfig.password);

    // 7. ホーム画面での厳格な学校照合 (完全一致)
    const homePage = new HomePage(page);
    await homePage.verifySchool(config.school.schoolCode, config.school.schoolName);

    // 8. 設定メニューから「学校設定」画面へ遷移
    await homePage.navigateToSchoolSettings();

    // 9. 学校設定画面のロード検証 & 最新 Baseline Observation 取得 (指示5: Optimistic Concurrency)
    const schoolSettingsPage = new SchoolSettingsPage(page);
    await schoolSettingsPage.verifyPageLoaded();
    const { observation: baselineObservation } = await schoolSettingsPage.readAllSettingsObservation();
    resultManager.setBeforeObservation(baselineObservation);

    // 10. Execution Plan の生成 (指示5)
    const plan = buildExecutionPlan({
      schoolCode: config.school.schoolCode,
      schoolName: config.school.schoolName,
      currentObservation: baselineObservation,
      requestedSettings: config.settings
    });

    const evaluation = evaluateExecutionPlan(plan);
    resultManager.setPlanAndEvaluation(plan, evaluation);

    // 11. Phase 2B 専用安全条件の厳格検証 (指示5)
    // (a) plan.actions.length === 1
    if (plan.actions.length !== 1) {
      throw new AutomationError(
        'POC_SCOPE_VIOLATION',
        `Phase 2B PoCでは生成されるAction数は厳密に1件でなければなりません (生成数: ${plan.actions.length}件)`,
        { actionsCount: plan.actions.length, actions: plan.actions }
      );
    }

    // (b) plan.dependencyEffects.length === 0
    if (plan.dependencyEffects.length > 0) {
      throw new AutomationError(
        'POC_SCOPE_VIOLATION',
        `Phase 2B PoCでは連動影響 (dependencyEffects) が発生する設定は対象外です (検出数: ${plan.dependencyEffects.length}件)`,
        { dependencyEffects: plan.dependencyEffects }
      );
    }

    // (c) hasDestructiveChanges === false
    if (plan.hasDestructiveChanges) {
      throw new AutomationError(
        'POC_SCOPE_VIOLATION',
        'Phase 2B PoCでは破壊的変更を含む設定は対象外です',
        { hasDestructiveChanges: plan.hasDestructiveChanges }
      );
    }

    // (d) 対象項目: studentPasswordChange, current: HIDE, requested: SHOW, expected: SHOW, availability: AVAILABLE
    const targetBaseline = baselineObservation[targetKey];
    if (targetKey !== 'studentPasswordChange' || targetBaseline.value !== 'HIDE' || targetRequestedValue !== 'SHOW' || targetBaseline.availability !== 'AVAILABLE') {
      throw new AutomationError(
        'POC_SCOPE_VIOLATION',
        `Phase 2B Live Write対象条件不一致: targetKey=${targetKey}, current=${targetBaseline.value}, requested=${targetRequestedValue}, availability=${targetBaseline.availability}`,
        { targetKey, current: targetBaseline.value, requested: targetRequestedValue, availability: targetBaseline.availability }
      );
    }

    // (e) Evaluation による実行可否検証
    if (!evaluation.isExecutable) {
      throw new AutomationError(
        'PRE_SAVE_VALIDATION_FAILED',
        `ExecutionPlanが実行不可と判定されました: ${evaluation.blockReasons.map((r) => r.message).join('; ')}`,
        { blockReasons: evaluation.blockReasons }
      );
    }

    // 12. Dry Run 計画表示
    logger.printDryRunPlan(plan, evaluation, effectiveOptions.allowDestructive);

    // 指示1: 3重Gateチェック (--phase2b, --apply, --allow-live-write が全て揃っていない場合は安全停止)
    if (!isLiveWriteAllowed) {
      logger.info('【安全停止】3重Gate (--phase2b, --apply, --allow-live-write) が揃っていないため、実環境への書き込みは行わずDry Runとして安全停止しました');
      resultManager.setStatus('DRY_RUN_COMPLETED');
      const logPath = resultManager.save();
      logger.info(`Dry Run結果ログを保存しました: ${logPath}`);
      return resultManager.getResult();
    }

    // =========================================================================
    // Phase 2B Single Safe Write & Restore PoC シーケンス
    // =========================================================================
    const originalBaselineValue = targetBaseline.value as SettingValue;

    // 指示6: Write直前の最終内容（LIVE WRITE TARGET）をコンソール＆ログに明示表示
    console.log('\n================================================');
    console.log('LIVE WRITE TARGET');
    console.log('================================================');
    console.log(`School:             ${config.school.schoolName} (${config.school.schoolCode})`);
    console.log(`Auth:               ${effectiveOptions.authMode} / ${authObs.resolvedProvider}`);
    console.log(`Setting:            児童・生徒へパスワード変更を表示 (${targetKey})`);
    console.log(`Before:             ${originalBaselineValue}`);
    console.log(`Write:              ${targetRequestedValue}`);
    console.log(`Restore:            ${originalBaselineValue}`);
    console.log(`Actions:            ${plan.actions.length}`);
    console.log(`Dependency Effects: ${plan.dependencyEffects.length}`);
    console.log(`Destructive:        ${plan.hasDestructiveChanges}`);
    console.log(`Live Write:         explicitly allowed (3重Gate通過)`);
    console.log('================================================\n');

    logger.info(`LIVE WRITE TARGET: School=${config.school.schoolName}, Setting=${targetKey}, Before=${originalBaselineValue}, Write=${targetRequestedValue}, Restore=${originalBaselineValue}`);

    // 指示11: スクリーンショット 01-before-write
    const ssBeforeWrite = await screenshotManager.captureStage(page, '01-before-write', config.school.schoolCode);
    if (ssBeforeWrite) resultManager.setScreenshotPath('01-before-write', ssBeforeWrite);

    // (A) Write 用の期待状態を構築
    const expectedWriteObservation: Record<SettingKey, SettingExpectation> = {} as any;
    for (const k of ALL_SETTING_KEYS) {
      if (k === targetKey) {
        expectedWriteObservation[k] = { value: targetRequestedValue, availability: 'AVAILABLE' };
      } else {
        expectedWriteObservation[k] = { value: baselineObservation[k].value, availability: baselineObservation[k].availability };
      }
    }

    // (B) Write 実行 (指示4: exactOnly=true で input[type="submit"][name="commit"][value="更新する"] のみ使用)
    logger.info(`\n--- Step 1: Write (変更適用 & 検証) ---`);
    const writeResult = await schoolSettingsPage.applyAndVerifySingleChange({
      key: targetKey,
      targetValue: targetRequestedValue,
      baselineObservation,
      expectedObservation: expectedWriteObservation,
      timeoutMs: effectiveOptions.defaultTimeoutMs,
      exactOnly: true
    });

    // 指示11: スクリーンショット 02-after-write-reload
    const ssAfterWrite = await screenshotManager.captureStage(page, '02-after-write-reload', config.school.schoolCode);
    if (ssAfterWrite) resultManager.setScreenshotPath('02-after-write-reload', ssAfterWrite);

    logger.info(`Write完了: サーバー永続状態確認済み (Status: ${writeResult.recovered ? 'SUCCESS_RECOVERED' : 'SUCCESS'})`);

    // (C) Restore 用の期待状態 (Baseline と完全一致)
    const expectedRestoreObservation: Record<SettingKey, SettingExpectation> = {} as any;
    for (const k of ALL_SETTING_KEYS) {
      expectedRestoreObservation[k] = { value: baselineObservation[k].value, availability: baselineObservation[k].availability };
    }

    // (D) Restore 実行 (指示9: SHOW -> HIDE への完全復元 & 再検証)
    logger.info(`\n--- Step 2: Restore (元値復元 & 検証) ---`);
    let restoreResult;
    try {
      restoreResult = await schoolSettingsPage.applyAndVerifySingleChange({
        key: targetKey,
        targetValue: originalBaselineValue,
        baselineObservation: writeResult.afterObservation, // Restore直前のベースラインはWrite後の状態
        expectedObservation: expectedRestoreObservation,
        timeoutMs: effectiveOptions.defaultTimeoutMs,
        exactOnly: true
      });

      // 指示11: スクリーンショット 03-after-restore-reload
      const ssAfterRestore = await screenshotManager.captureStage(page, '03-after-restore-reload', config.school.schoolCode);
      if (ssAfterRestore) resultManager.setScreenshotPath('03-after-restore-reload', ssAfterRestore);

      logger.info(`Restore完了: ベースライン状態への完全復元を確認しました`);
    } catch (restoreError: any) {
      // 指示10: Restore失敗を重大エラー RESTORE_FAILED として扱う
      console.error('\n****************************************************************');
      console.error('【重大警告】設定が元に戻っていない可能性があるため、人間による確認が必要です！');
      console.error('****************************************************************\n');
      logger.error(`【重大エラー】元値への復元 (Restore) に失敗しました: ${restoreError.message}`);

      resultManager.setStatus('RESTORE_FAILED');
      resultManager.addIssue({
        code: 'RESTORE_FAILED',
        message: `設定項目「${targetKey}」の元値復元に失敗しました: ${restoreError.message}`,
        settingKey: targetKey,
        details: {
          settingKey: targetKey,
          originalValue: originalBaselineValue,
          currentValue: targetRequestedValue,
          restoreExpectedValue: originalBaselineValue,
          restoreSaveError: restoreError.message
        }
      });
      const logPath = resultManager.save();
      logger.error(`RESTORE_FAILED ログを保存しました: ${logPath}。追加の自動保存Retryは行いません。人間による確認を要求します`);
      return resultManager.getResult();
    }

    // (E) PoC SUCCESS 判定 (指示9)
    resultManager.setAfterObservation(restoreResult.afterObservation);
    resultManager.setStatus(writeResult.recovered ? 'SUCCESS_RECOVERED' : 'SUCCESS');
    const logPath = resultManager.save();
    logger.info(`\n=== Phase 2B Single Safe Write PoC 完了 (SUCCESS) ===`);
    logger.info(`実行結果ログ: ${logPath}`);

    return resultManager.getResult();
  } catch (error: any) {
    logger.error(`Phase 2B エラー: ${error.message}`);
    const status = error.status || 'UNEXPECTED_ERROR';
    resultManager.setStatus(status);
    resultManager.addIssue({
      code: error.issueCode || status,
      message: error.message,
      details: error.details
    });

    const logPath = resultManager.save();
    logger.info(`エラーログを保存しました: ${logPath}`);
    return resultManager.getResult();
  } finally {
    if (context) {
      await context.close().catch(() => {});
      logger.info('BrowserContext を正常に破棄しました');
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
