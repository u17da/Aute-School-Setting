import * as crypto from 'crypto';
import { Browser, Page, BrowserContext } from 'playwright';
import { PlatformJob, JobExecutionMode, JobExecutionModeSchema, SchoolRunResult, JobRunSummary, RunEvidence } from '../types/job';
import { PolicyEngine } from '../policy/policyEngine';
import { CapabilityRegistry } from '../capabilities/registry';
import { GuardedPage, setupNetworkBlocker } from '../capabilities/guardedPage';
import { CapabilityExecutionContext } from '../types/capability';
import { LocalSecretVault } from '../ingestion/documentIngestion';
import { LoginPage } from '../../pages/LoginPage';
import { HomePage } from '../../pages/HomePage';
import { JobStore } from './jobStore';
import { validateOperationIR } from '../types/plan';

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
   * 完全隔離BrowserContext + 実機ログイン前処理 + 物理遮断 + リアルタイム進捗イベント発行 + RunEvidence生成
   */
  async runJob(
    job: PlatformJob,
    mode: JobExecutionMode,
    onProgress?: ProgressCallback,
    options?: { browser?: Browser; page?: Page }
  ): Promise<{ summary: JobRunSummary; results: SchoolRunResult[] }> {
    if (this.isHalted) {
      job.status = 'STOPPED';
      const runId = `run_${Date.now()}`;
      const summary: JobRunSummary = {
        runId,
        mode,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        elapsedSeconds: 0,
        totalSchools: 0,
        processedCount: 0,
        successCount: 0,
        alreadyConfiguredCount: 0,
        blockedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        accumulatedAiCostJpy: 0,
        circuitBreakerState: 'CLOSED',
        runtimeHealth: 'HALTED',
        etaSeconds: 0
      };
      return { summary, results: [] };
    }
    this.isHalted = false;

    // 0. Runtime Schema Validation of JobExecutionMode (Defense-in-depth)
    const modeParse = JobExecutionModeSchema.safeParse(mode);
    if (!modeParse.success) {
      throw new Error(`INVALID_EXECUTION_MODE: Unknown or invalid execution mode "${mode}". Allowed modes: LOGICAL_DRY_RUN, CANARY_VALIDATION, FULL_PRODUCTION.`);
    }
    const validatedMode = modeParse.data;

    if (!job.targetSet || !job.executionPlan) {
      throw new Error('TargetSet or ExecutionPlan is missing.');
    }

    // 1.2. Invariant: Execution Plan must be READY
    if (job.executionPlan.status !== 'READY') {
      throw new Error(`EXECUTION_BLOCKED: Execution plan is not in READY state (current status: "${job.executionPlan.status}"). Clarification or resolution required.`);
    }

    // 1.5. Runtime Schema Validation of Execution Plan & Operations (Fail-Closed Invariant)
    const registry = CapabilityRegistry.getInstance();
    const capabilityVersions: Record<string, string> = {};

    for (const op of job.executionPlan.operations) {
      validateOperationIR(op);
      if (!op.capabilityId || typeof op.capabilityId !== 'string' || op.capabilityId.trim().length === 0) {
        throw new Error(`INVALID_PLAN: Operation "${op.operationId}" is missing required capabilityId.`);
      }
      const cap = registry.get(op.capabilityId);
      if (!cap) {
        throw new Error(`UNREGISTERED_CAPABILITY: Operation "${op.operationId}" uses unregistered capability "${op.capabilityId}".`);
      }
      capabilityVersions[op.capabilityId] = cap.version;
    }

    // 1. Policy Gate Check & Invalidation Detection (Defense-in-depth)
    const currentPlanHash = PolicyEngine.computePlanHash(job.executionPlan);
    const currentTargetSetHash = PolicyEngine.computeTargetSetHash(job.targetSet);

    if (job.policy.planHash && (job.policy.planHash !== currentPlanHash || job.policy.targetSetHash !== currentTargetSetHash)) {
      job.policy = PolicyEngine.invalidatePolicy(job.policy, 'Plan or TargetSet changed after approval');
      throw new Error('POLICY_STALE: Plan or TargetSet changed after approval. Re-approval and new Dry-run are required.');
    }

    const audit = PolicyEngine.verifyExecutionAllowed(job.policy, validatedMode, {
      planHash: job.policy.planHash || currentPlanHash,
      targetSetHash: job.policy.targetSetHash || currentTargetSetHash,
      currentCapabilityVersions: capabilityVersions,
      evidences: job.evidences || []
    });
    if (!audit.passed) {
      throw new Error(`Execution Blocked by Policy Engine: ${audit.violations.join('; ')}`);
    }

    // 2. Compute strict target scope
    // Formula: (READY & enabled) ∩ targetFilter ∩ targetSchoolCodes - excludeSchoolCodes
    let targetSchools = job.targetSet.schools.filter(s => s.validationStatus === 'READY' && s.enabled);

    // Apply explicit schoolCodes if defined in targetFilter
    if (job.executionPlan.targetFilter?.schoolCodes && job.executionPlan.targetFilter.schoolCodes.length > 0) {
      const allowedCodes = new Set(job.executionPlan.targetFilter.schoolCodes);
      targetSchools = targetSchools.filter(s => allowedCodes.has(s.schoolCode));
    }

    // Apply explicit excludeSchoolCodes if defined in targetFilter
    if (job.executionPlan.targetFilter?.excludeSchoolCodes && job.executionPlan.targetFilter.excludeSchoolCodes.length > 0) {
      const excludedCodes = new Set(job.executionPlan.targetFilter.excludeSchoolCodes);
      targetSchools = targetSchools.filter(s => !excludedCodes.has(s.schoolCode));
    }

    // Apply school type filter from plan (TargetSchool.schoolType SSOT)
    if (job.executionPlan.targetFilter?.schoolType && job.executionPlan.targetFilter.schoolType !== 'ALL') {
      const requiredType = job.executionPlan.targetFilter.schoolType;
      targetSchools = targetSchools.filter(s => {
        if (!s.schoolType) {
          // Fail closed: Unknown schoolType must not be guessed from name
          return false;
        }
        return s.schoolType === requiredType;
      });
    }

    // Apply Canary restriction: Policy approved scope ONLY
    if (validatedMode === 'CANARY_VALIDATION') {
      const approvedScope = PolicyEngine.getApprovedCanaryScope(
        job.policy,
        targetSchools.length,
        job.executionPlan.validationScopeProposal?.count
      );
      targetSchools = targetSchools.slice(0, Math.min(approvedScope, targetSchools.length));
    }

    const runId = `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const startTime = new Date().toISOString();
    const isDryRun = validatedMode === 'LOGICAL_DRY_RUN';

    const summary: JobRunSummary = {
      runId,
      mode: validatedMode,
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
        // A. Resolve password from LocalSecretVault with strict job-scoping check
        const password = LocalSecretVault.getSecret(school.credentialRef, job.jobId) || '';

        // Check credential existence: fail closed if missing
        if (!password && options?.browser) {
          throw new Error(`MISSING_CREDENTIAL: No password available for school ${school.schoolCode} (${school.schoolName}). Execution blocked.`);
        }

        // B. Create Isolated BrowserContext per School
        let authenticatedOrgId: string | undefined = undefined;
        if (options?.browser) {
          schoolContext = await options.browser.newContext({ viewport: { width: 1280, height: 900 } });
          targetPage = await schoolContext.newPage();

          if (password) {
            // Check halt flag before login
            if (this.isHalted) {
              job.status = 'STOPPED';
              break;
            }

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

            // Extract verified orgId from URL pathname or DOM if available
            try {
              const url = targetPage.url();
              const orgMatch = url.match(/\/organizations\/(\d+)/);
              if (orgMatch && orgMatch[1]) {
                authenticatedOrgId = orgMatch[1];
              }
            } catch {
              // ignore
            }
          }

          // In Dry-Run mode, activate mutation network blocker AFTER login & identity verification completes
          if (isDryRun) {
            await setupNetworkBlocker(schoolContext);
          }
        }

        // GuardedPage with physical write block in Dry-Run
        const guardedPage = targetPage
          ? new GuardedPage(targetPage, false, isDryRun)
          : new GuardedPage(null, true, isDryRun);

        const context: CapabilityExecutionContext = {
          page: guardedPage,
          schoolCode: school.schoolCode,
          schoolName: school.schoolName,
          credentialRef: school.credentialRef,
          isDryRun,
          jobId: job.jobId,
          expectedOrgId: authenticatedOrgId,
          authenticatedSchoolContext: {
            schoolCode: school.schoolCode,
            schoolName: school.schoolName,
            organizationId: authenticatedOrgId,
            authenticatedAt: new Date().toISOString()
          },
          logger: {
            info: (msg) => console.log(`[PlatformRunner][INFO] ${msg}`),
            warn: (msg) => console.warn(`[PlatformRunner][WARN] ${msg}`),
            error: (msg) => console.error(`[PlatformRunner][ERROR] ${msg}`)
          }
        };

        // C. Execute operations in the plan with per-operation targetSchoolCodes scoping
        let executedOperationsCount = 0;
        let skippedByOpScopeCount = 0;

        for (const op of job.executionPlan.operations) {
          // Check emergency stop before operation
          if (this.isHalted) {
            job.status = 'STOPPED';
            break;
          }

          // Check operation-level targetSchoolCodes scope
          if (op.targetSchoolCodes && !op.targetSchoolCodes.includes(school.schoolCode)) {
            // Operation is scoped to other schools; skip for this school
            appliedDiff[op.operationType] = { skipped: true, reason: 'OPERATION_SCOPE_EXCLUDED' };
            skippedByOpScopeCount++;
            continue;
          }

          summary.currentOperation = op.capabilityId;
          const cap = registry.get(op.capabilityId);

          if (!cap) {
            schoolStatus = 'BLOCKED';
            schoolError = `操作 "${op.capabilityId}" はカタログに登録されていません。`;
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
            if (schoolStatus === 'SUCCESS') {
              schoolStatus = 'ALREADY_CONFIGURED';
            }
            appliedDiff[op.operationType] = { skipped: true, reason: observation.skipReason };
            continue;
          }

          // Check emergency stop immediately before execution
          if (this.isHalted) {
            job.status = 'STOPPED';
            break;
          }

          // 2. Execute
          const execRes = await cap.execute(context, op.inputMapping);
          if (!execRes.success) {
            schoolStatus = 'FAILED';
            schoolError = execRes.error || execRes.message;
            break;
          }

          executedOperationsCount++;
          appliedDiff[op.operationType] = execRes.appliedChanges;

          // 3. Verify
          const verified = await cap.verify(context, op.inputMapping);
          if (!verified) {
            schoolStatus = 'FAILED';
            schoolError = `設定後の確認検証に失敗しました (${op.operationType})`;
            break;
          }
        }

        // If all operations were excluded by operation scope for this school, status is SKIPPED
        if (skippedByOpScopeCount === job.executionPlan.operations.length && executedOperationsCount === 0) {
          schoolStatus = 'SKIPPED';
        }
      } catch (err: any) {
        schoolStatus = 'FAILED';
        schoolError = err.message || String(err);
      } finally {
        // D. Dispose isolated BrowserContext cleanly
        if (schoolContext) {
          try {
            await schoolContext.close();
          } catch (e) {
            // ignore context close error
          }
        }
      }

      if (this.isHalted) {
        job.status = 'STOPPED';
        break;
      }

      if (schoolStatus === 'SUCCESS') {
        summary.successCount++;
        consecutiveErrors = 0;
      } else if (schoolStatus === 'ALREADY_CONFIGURED') {
        summary.alreadyConfiguredCount++;
        consecutiveErrors = 0;
      } else if (schoolStatus === 'SKIPPED') {
        summary.skippedCount++;
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
        verificationPassed: schoolStatus === 'SUCCESS' || schoolStatus === 'ALREADY_CONFIGURED' || schoolStatus === 'SKIPPED',
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

    // Actual school codes are schools that were NOT SKIPPED (i.e. evaluated or executed at least one operation)
    const nonSkippedResults = results.filter(r => r.status !== 'SKIPPED');
    const actualSchoolCodes = nonSkippedResults
      .map(r => r.schoolCode)
      .sort();

    // Generate strict RunEvidence: must have at least 1 non-skipped school with full verification pass
    const isEvidenceSuccess = summary.failedCount === 0 &&
      summary.blockedCount === 0 &&
      actualSchoolCodes.length > 0 &&
      nonSkippedResults.length > 0 &&
      nonSkippedResults.every(r => r.verificationPassed);

    const allVerified = isEvidenceSuccess;
    const runEvidence: RunEvidence = {
      evidenceId: `ev_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      runId,
      mode: validatedMode,
      fingerprint: {
        planHash: currentPlanHash,
        targetSetHash: currentTargetSetHash,
        mode: validatedMode,
        actualSchoolCodes,
        capabilityVersions
      },
      status: isEvidenceSuccess ? 'SUCCESS' : 'FAILED',
      totalSchools: summary.totalSchools,
      successCount: summary.successCount,
      failedCount: summary.failedCount,
      blockedCount: summary.blockedCount,
      allVerified,
      completedAt: new Date().toISOString()
    };

    if (!job.evidences) {
      job.evidences = [];
    }
    job.evidences.push(runEvidence);

    // Update job status
    if (job.status !== 'HALTED_BY_CIRCUIT_BREAKER' && job.status !== 'STOPPED') {
      if (validatedMode === 'LOGICAL_DRY_RUN') {
        job.status = runEvidence.status === 'SUCCESS' ? 'DRY_RUN_COMPLETED' : 'FAILED';
      } else if (validatedMode === 'CANARY_VALIDATION') {
        job.status = runEvidence.status === 'SUCCESS' ? 'CANARY_COMPLETED' : 'CANARY_FAILED';
      } else {
        job.status = runEvidence.status === 'SUCCESS' ? 'COMPLETED' : 'FAILED';
      }
    }

    job.runs[runId] = { summary, results };
    JobStore.getInstance().saveJob(job);

    return { summary, results };
  }
}
