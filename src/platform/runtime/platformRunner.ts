import * as crypto from 'crypto';
import { Browser, Page, BrowserContext } from 'playwright';
import { PlatformJob, JobExecutionMode, SchoolRunResult, JobRunSummary } from '../types/job';
import { PolicyEngine } from '../policy/policyEngine';
import { CapabilityRegistry } from '../capabilities/registry';
import { GuardedPage } from '../capabilities/guardedPage';
import { CapabilityExecutionContext } from '../types/capability';
import { LocalSecretVault } from '../ingestion/documentIngestion';
import { LoginPage } from '../../pages/LoginPage';
import { HomePage } from '../../pages/HomePage';
import { JobStore } from './jobStore';

export interface ProgressEvent {
  stage:
    | 'TARGET_PARSING'
    | 'LOGIN_START'
    | 'LOGIN_SUCCESS'
    | 'IDENTITY_VERIFY'
    | 'AI_PLANNING'
    | 'PLAN_READY'
    | 'DRY_RUN_OBSERVING'
    | 'DRY_RUN_CALCULATING'
    | 'CANARY_RUNNING'
    | 'PERSISTED_VERIFY'
    | 'COMPLETED'
    | 'HALTED';
  message: string;
  schoolCode?: string;
  schoolName?: string;
  currentIndex?: number;
  totalSchools?: number;
}

export type ProgressCallback = (summary: JobRunSummary, currentResult?: SchoolRunResult, event?: ProgressEvent) => void;

export class PlatformRunner {
  private isHalted = false;

  stop(): void {
    this.isHalted = true;
  }

  /**
   * Execute a Job with specified execution mode (LOGICAL_DRY_RUN, CANARY_VALIDATION, FULL_PRODUCTION)
   * 完全隔離BrowserContext + 実機ログイン前処理 + リアルタイム進捗イベント発行
   */
  async runJob(
    job: PlatformJob,
    mode: JobExecutionMode,
    onProgress?: ProgressCallback,
    options?: { browser?: Browser; page?: Page }
  ): Promise<{ summary: JobRunSummary; results: SchoolRunResult[] }> {
    this.isHalted = false;

    // 1. Policy Gate Check
    const audit = PolicyEngine.verifyExecutionAllowed(job.policy, mode);
    if (!audit.passed) {
      throw new Error(`Execution Blocked by Policy Engine: ${audit.violations.join('; ')}`);
    }

    if (!job.targetSet || !job.executionPlan) {
      throw new Error('TargetSet or ExecutionPlan is missing.');
    }

    // 2. Filter target schools
    let targetSchools = job.targetSet.schools.filter(s => s.validationStatus === 'READY' && s.enabled);
    
    // Apply school type filter from plan
    if (job.executionPlan.targetFilter?.schoolType === 'ELEMENTARY') {
      targetSchools = targetSchools.filter(s => !s.schoolName.includes('中学校'));
    }

    // Apply Canary restriction: Only 1-3 schools (or AI proposed count)
    if (mode === 'CANARY_VALIDATION') {
      const canaryCount = job.executionPlan.validationScopeProposal?.count || 1;
      targetSchools = targetSchools.slice(0, Math.min(canaryCount, targetSchools.length));
    }

    const runId = `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const startTime = new Date().toISOString();
    const isDryRun = mode === 'LOGICAL_DRY_RUN';

    const summary: JobRunSummary = {
      runId,
      mode,
      startTime,
      elapsedSeconds: 0,
      totalSchools: targetSchools.length,
      processedCount: 0,
      successCount: 0,
      alreadyConfiguredCount: 0,
      blockedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      accumulatedAiCostJpy: 0,
      circuitBreakerState: 'CLOSED',
      runtimeHealth: 'HEALTHY',
      etaSeconds: 0
    };

    const results: SchoolRunResult[] = [];
    let consecutiveErrors = 0;
    const startTs = Date.now();
    const registry = CapabilityRegistry.getInstance();

    // Loop through target schools
    for (let i = 0; i < targetSchools.length; i++) {
      if (this.isHalted) {
        job.status = 'STOPPED';
        break;
      }

      // Circuit breaker check (3 consecutive errors)
      if (consecutiveErrors >= 3) {
        summary.circuitBreakerState = 'OPEN';
        summary.runtimeHealth = 'HALTED';
        job.status = 'HALTED_BY_CIRCUIT_BREAKER';
        break;
      }

      const school = targetSchools[i];
      summary.currentSchool = `${school.schoolName} (${school.schoolCode})`;
      summary.processedCount = i + 1;
      summary.elapsedSeconds = Math.round((Date.now() - startTs) / 1000);

      // Simple ETA calculation
      if (i > 0) {
        const avgSec = summary.elapsedSeconds / i;
        summary.etaSeconds = Math.round(avgSec * (targetSchools.length - i));
      }

      const schoolStart = Date.now();
      let schoolStatus: 'SUCCESS' | 'ALREADY_CONFIGURED' | 'BLOCKED' | 'FAILED' | 'SKIPPED' = 'SUCCESS';
      let schoolError: string | undefined = undefined;
      const appliedDiff: Record<string, any> = {};

      let schoolContext: BrowserContext | null = null;
      let targetPage: Page | null = options?.page || null;

      try {
        // A. Create Isolated BrowserContext per School
        if (options?.browser) {
          schoolContext = await options.browser.newContext({ viewport: { width: 1280, height: 900 } });
          targetPage = await schoolContext.newPage();

          // Resolve password from Vault
          let password = LocalSecretVault.getSecret(school.credentialRef) || '';
          if (!password) {
            password = LocalSecretVault.getSecret(`cred_ref_${school.schoolCode}`) || '';
          }
          if (!password && school.schoolCode === 'PRRHC') {
            password = process.env.MANAPOKE_PASSWORD || '';
          }

          if (password) {
            // Emit progress event: LOGIN_START
            if (onProgress) {
              onProgress(summary, undefined, {
                stage: 'LOGIN_START',
                message: `「${school.schoolName}」へのログインを開始中... (${i + 1}/${targetSchools.length}校)`,
                schoolCode: school.schoolCode,
                schoolName: school.schoolName,
                currentIndex: i + 1,
                totalSchools: targetSchools.length
              });
            }

            const baseUrl = process.env.MANAPOKE_BASE_URL || 'https://ed-cl.com';
            const loginPage = new LoginPage(targetPage);
            await loginPage.navigateAndSubmitSchoolCode(baseUrl, school.schoolCode, 'A');
            await loginPage.loginWithLocalPassword(school.userId || 'schooladmin', password);
            await targetPage.waitForLoadState('domcontentloaded');

            // Emit progress event: IDENTITY_VERIFY
            if (onProgress) {
              onProgress(summary, undefined, {
                stage: 'IDENTITY_VERIFY',
                message: `「${school.schoolName}」の画面学校名を検証中...`,
                schoolCode: school.schoolCode,
                schoolName: school.schoolName
              });
            }

            const homePage = new HomePage(targetPage);
            await homePage.verifySchool(school.schoolCode, school.schoolName);
            console.log(`[PlatformRunner][AUTH] school identity verified: ${school.schoolName} (${school.schoolCode})`);
            console.log(`[PlatformRunner][AUTH] LOGIN_AND_VERIFY completed successfully for ${school.schoolCode}`);
          }
        }

        const guardedPage = targetPage ? new GuardedPage(targetPage, false) : new GuardedPage(null, true);
        const context: CapabilityExecutionContext = {
          page: guardedPage,
          schoolCode: school.schoolCode,
          schoolName: school.schoolName,
          credentialRef: school.credentialRef,
          isDryRun,
          logger: {
            info: (msg) => console.log(`[PlatformRunner][INFO] ${msg}`),
            warn: (msg) => console.warn(`[PlatformRunner][WARN] ${msg}`),
            error: (msg) => console.error(`[PlatformRunner][ERROR] ${msg}`)
          }
        };

        // B. Execute operations in the plan
        for (const op of job.executionPlan.operations) {
          summary.currentOperation = op.operationType;
          const cap = registry.get(op.operationType);

          if (!cap) {
            schoolStatus = 'BLOCKED';
            schoolError = `操作 "${op.operationType}" はカタログに登録されていません。`;
            break;
          }

          // Emit progress: DRY_RUN_OBSERVING / CANARY_RUNNING
          if (onProgress) {
            onProgress(summary, undefined, {
              stage: isDryRun ? 'DRY_RUN_OBSERVING' : 'CANARY_RUNNING',
              message: `「${school.schoolName}」の現在の設定値を読み取り差分を計算中...`,
              schoolCode: school.schoolCode,
              schoolName: school.schoolName
            });
          }

          // 1. Observe
          const observation = await cap.observe(context, op.inputMapping);
          if (!observation.eligible) {
            schoolStatus = 'ALREADY_CONFIGURED';
            appliedDiff[op.operationType] = { skipped: true, reason: observation.skipReason };
            continue;
          }

          // 2. Execute
          const execRes = await cap.execute(context, op.inputMapping);
          if (!execRes.success) {
            schoolStatus = 'FAILED';
            schoolError = execRes.error || execRes.message;
            break;
          }

          appliedDiff[op.operationType] = execRes.appliedChanges;

          // 3. Verify
          const verified = await cap.verify(context, op.inputMapping);
          if (!verified) {
            schoolStatus = 'FAILED';
            schoolError = `設定後の確認検証に失敗しました (${op.operationType})`;
            break;
          }
        }
      } catch (err: any) {
        schoolStatus = 'FAILED';
        schoolError = err.message || String(err);
      } finally {
        // C. Dispose isolated BrowserContext cleanly
        if (schoolContext) {
          try {
            await schoolContext.close();
          } catch (e) {
            // ignore context close error
          }
        }
      }

      if (schoolStatus === 'SUCCESS') {
        summary.successCount++;
        consecutiveErrors = 0;
      } else if (schoolStatus === 'ALREADY_CONFIGURED') {
        summary.alreadyConfiguredCount++;
        consecutiveErrors = 0;
      } else if (schoolStatus === 'BLOCKED') {
        summary.blockedCount++;
        consecutiveErrors++;
      } else if (schoolStatus === 'FAILED') {
        summary.failedCount++;
        consecutiveErrors++;
      }

      const schoolResult: SchoolRunResult = {
        schoolCode: school.schoolCode,
        schoolName: school.schoolName,
        status: schoolStatus,
        planned: job.executionPlan.operations.map(o => o.operationType),
        after: appliedDiff,
        verificationPassed: schoolStatus === 'SUCCESS' || schoolStatus === 'ALREADY_CONFIGURED',
        error: schoolError,
        retries: 0,
        durationMs: Date.now() - schoolStart,
        executionId: `exec_${runId}_${school.schoolCode}`,
        timestamp: new Date().toISOString()
      };

      results.push(schoolResult);

      if (onProgress) {
        onProgress(summary, schoolResult, {
          stage: 'COMPLETED',
          message: `「${school.schoolName}」の処理が完了しました。(${schoolStatus})`,
          schoolCode: school.schoolCode,
          schoolName: school.schoolName
        });
      }
    }

    summary.endTime = new Date().toISOString();
    summary.elapsedSeconds = Math.round((Date.now() - startTs) / 1000);
    summary.currentSchool = undefined;
    summary.currentOperation = undefined;
    summary.etaSeconds = 0;

    if (job.status !== 'HALTED_BY_CIRCUIT_BREAKER' && job.status !== 'STOPPED') {
      if (mode === 'LOGICAL_DRY_RUN') job.status = 'DRY_RUN_COMPLETED';
      else if (mode === 'CANARY_VALIDATION') job.status = 'CANARY_COMPLETED';
      else job.status = 'COMPLETED';
    }

    job.runs[runId] = { summary, results };
    JobStore.getInstance().saveJob(job);

    return { summary, results };
  }
}
