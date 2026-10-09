import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { chromium, Browser, Page } from 'playwright';
import { TargetInterpreter } from '../ai/targetInterpreter';
import { TaskPlanner } from '../ai/taskPlanner';
import { Estimator } from '../ai/estimator';
import { ResultAnalyst } from '../ai/resultAnalyst';
import { CapabilityRegistry } from '../capabilities/registry';
import { PolicyEngine } from '../policy/policyEngine';
import { JobStore } from '../runtime/jobStore';
import { PlatformRunner } from '../runtime/platformRunner';
import { PlatformJob, JobExecutionMode, JobExecutionModeSchema } from '../types/job';
import { GateId } from '../types/policy';
import { LocalSecretVault } from '../ingestion/documentIngestion';
import { LoginPage } from '../../pages/LoginPage';
import { HomePage } from '../../pages/HomePage';

export class PlatformRouter {
  private runner = new PlatformRunner();

  async handle(
    pathname: string,
    method: string,
    req: http.IncomingMessage,
    body: any,
    sendJson: (statusCode: number, data: any) => void,
    broadcastSse?: (event: string, data: any) => void
  ): Promise<boolean> {
    const jobStore = JobStore.getInstance();
    const registry = CapabilityRegistry.getInstance();

    // 0. API Key Config Endpoints
    if (method === 'GET' && pathname === '/api/platform/config/api-key-status') {
      const key = process.env.ANTHROPIC_API_KEY || '';
      const configured = Boolean(key && key.trim().length > 0);
      const maskedKey = configured
        ? `${key.slice(0, 7)}...${key.slice(-4)}`
        : null;
      sendJson(200, {
        configured,
        maskedKey,
        model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5'
      });
      return true;
    }

    if (method === 'POST' && pathname === '/api/platform/config/api-key') {
      const { apiKey, model } = body;
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        sendJson(400, { error: 'INVALID_API_KEY', message: '有効なAPIキーを入力してください。' });
        return true;
      }
      const trimmedKey = apiKey.trim();
      process.env.ANTHROPIC_API_KEY = trimmedKey;
      if (model) {
        process.env.ANTHROPIC_MODEL = model.trim();
      }

      // Persist to .env file if possible
      try {
        const envPath = path.resolve(process.cwd(), '.env');
        let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
        if (envContent.includes('ANTHROPIC_API_KEY=')) {
          envContent = envContent.replace(/ANTHROPIC_API_KEY=.*(\r?\n|$)/g, `ANTHROPIC_API_KEY=${trimmedKey}$1`);
        } else {
          envContent += `\nANTHROPIC_API_KEY=${trimmedKey}\n`;
        }
        if (model) {
          if (envContent.includes('ANTHROPIC_MODEL=')) {
            envContent = envContent.replace(/ANTHROPIC_MODEL=.*(\r?\n|$)/g, `ANTHROPIC_MODEL=${model.trim()}$1`);
          } else {
            envContent += `ANTHROPIC_MODEL=${model.trim()}\n`;
          }
        }
        fs.writeFileSync(envPath, envContent, 'utf-8');
      } catch (e: any) {
        console.warn('Failed to write .env file:', e.message);
      }

      sendJson(200, {
        success: true,
        message: 'Claude APIキーを設定・保存しました。Haiku 5.5 による自律計画立案が利用可能です。',
        maskedKey: `${trimmedKey.slice(0, 7)}...${trimmedKey.slice(-4)}`
      });
      return true;
    }

    // 1. GET /api/platform/capabilities
    if (method === 'GET' && pathname === '/api/platform/capabilities') {
      sendJson(200, {
        capabilities: registry.list().map(c => ({
          capabilityId: c.capabilityId,
          version: c.version,
          description: c.description,
          riskClass: c.riskClass,
          supportedPages: c.supportedPages,
          testStatus: c.testStatus,
          productionValidated: c.productionValidated
        }))
      });
      return true;
    }

    // 2. GET /api/platform/jobs
    if (method === 'GET' && pathname === '/api/platform/jobs') {
      const jobs = jobStore.listJobs().map(j => ({
        jobId: j.jobId,
        title: j.title,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        status: j.status,
        targetSchoolsCount: j.targetSet?.schools.length || 0,
        riskLevel: j.executionPlan?.riskLevel || 'READ_ONLY'
      }));
      sendJson(200, { jobs });
      return true;
    }

    // 3. GET /api/platform/jobs/:id
    if (method === 'GET' && pathname.startsWith('/api/platform/jobs/')) {
      const parts = pathname.split('/');
      const jobId = parts[4];
      if (parts[5] === 'export') {
        // Export endpoint
        const job = jobStore.getJob(jobId);
        if (!job) {
          sendJson(404, { error: 'JOB_NOT_FOUND' });
          return true;
        }
        const activeRun = job.activeRunId ? job.runs[job.activeRunId] : undefined;
        sendJson(200, {
          jobId: job.jobId,
          title: job.title,
          exportedAt: new Date().toISOString(),
          plan: job.executionPlan,
          summary: activeRun?.summary,
          results: activeRun?.results || []
        });
        return true;
      }

      const job = jobStore.getJob(jobId);
      if (!job) {
        sendJson(404, { error: 'JOB_NOT_FOUND' });
        return true;
      }
      sendJson(200, { job });
      return true;
    }

    // 3b. DELETE /api/platform/jobs/:id
    if (method === 'DELETE' && pathname.startsWith('/api/platform/jobs/')) {
      const parts = pathname.split('/');
      const jobId = parts[4];
      const job = jobStore.getJob(jobId);
      if (!job) {
        sendJson(404, { error: 'JOB_NOT_FOUND' });
        return true;
      }
      jobStore.deleteJob(jobId);
      sendJson(200, { success: true, message: `Job ${jobId} and its associated secrets have been deleted.` });
      return true;
    }

    // 4. POST /api/platform/targets/parse
    if (method === 'POST' && pathname === '/api/platform/targets/parse') {
      const { rawText, files } = body || {};
      // Server-authoritative jobId generation for new parses
      const serverJobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

      broadcastSse?.('platformEvent', {
        stage: 'TARGET_PARSING',
        message: '対象リストの読み取り・整理を開始しました...'
      });
      const targetSet = TargetInterpreter.parseTargets({ rawText, files, jobId: serverJobId });

      // Save initial DRAFT / TARGETS_CONFIGURED Job in JobStore so serverJobId is registered
      const draftJob: PlatformJob = {
        jobId: serverJobId,
        title: targetSet.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'TARGETS_CONFIGURED',
        targetSet,
        policy: PolicyEngine.createDefaultPolicy('READ_ONLY'),
        sourceFiles: targetSet.sourceFiles || [],
        runs: {}
      };
      jobStore.saveJob(draftJob);

      broadcastSse?.('platformEvent', {
        stage: 'TARGET_PARSED',
        message: `対象リストの読み取り完了: 計 ${targetSet.summary.total} 校（正常: ${targetSet.summary.ready} 校）`
      });
      sendJson(200, { jobId: serverJobId, targetSet });
      return true;
    }

    // 5. POST /api/platform/targets/validate-login
    if (method === 'POST' && pathname === '/api/platform/targets/validate-login') {
      const { schoolCodes, targetSet, jobId } = body || {};
      const validationJobId = jobId || targetSet?.jobId || targetSet?.targetSetId || '';
      const targetList = targetSet?.schools || [];
      const baseUrl = process.env.MANAPOKE_BASE_URL || 'https://ed-cl.com';
      const totalSchools = targetList.length;
      let currentIndex = 0;
      const results: any[] = [];

      for (const s of targetList) {
        currentIndex++;
        const percent = Math.round((currentIndex / totalSchools) * 100);

        broadcastSse?.('platformEvent', {
          stage: 'LOGIN_START',
          schoolCode: s.schoolCode,
          schoolName: s.schoolName,
          index: currentIndex,
          total: totalSchools,
          percent,
          message: `[${currentIndex}/${totalSchools}校 (${percent}%)] ${s.schoolName} (${s.schoolCode}) のログイン確認を開始します...`
        });

        let password = '';
        if (s.credentialRef && validationJobId) {
          password = LocalSecretVault.getSecret(s.credentialRef, validationJobId) || '';
        }

        if (!password) {
          results.push({
            schoolCode: s.schoolCode,
            schoolName: s.schoolName,
            status: 'MISSING_CREDENTIAL',
            message: 'パスワードが設定されていません。認証情報を登録してください。'
          });
          broadcastSse?.('platformEvent', {
            stage: 'LOGIN_FAILED',
            schoolCode: s.schoolCode,
            schoolName: s.schoolName,
            index: currentIndex,
            total: totalSchools,
            percent,
            message: `[${currentIndex}/${totalSchools}校] ${s.schoolName} (${s.schoolCode}): パスワード未設定のためスキップ`
          });
          continue;
        }

        // Real browser validation
        let browser: Browser | null = null;
        try {
          browser = await chromium.launch({ headless: true });
          const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
          const page = await context.newPage();

          // Phase 1 & 2: LoginPage guarantees reaching authenticated Home
          const loginPage = new LoginPage(page);
          await loginPage.navigateAndSubmitSchoolCode(baseUrl, s.schoolCode, 'A');
          await loginPage.loginWithLocalPassword(s.adminUserId || 'schooladmin', password);

          broadcastSse?.('platformEvent', {
            stage: 'IDENTITY_VERIFY',
            schoolCode: s.schoolCode,
            schoolName: s.schoolName,
            index: currentIndex,
            total: totalSchools,
            percent,
            message: `[${currentIndex}/${totalSchools}校] ${s.schoolName} の学校所属・権限 (Strict Identity Verify) を照合中...`
          });

          // Phase 3: HomePage verifies strict school identity
          const homePage = new HomePage(page);
          await homePage.verifySchool(s.schoolCode, s.schoolName);

          const status = 'VALID';
          const msg = `実機ログインおよび学校所属確認成功: 「${s.schoolName} (${s.schoolCode})」を確認しました。`;

          results.push({
            schoolCode: s.schoolCode,
            schoolName: s.schoolName,
            status,
            message: msg
          });

          broadcastSse?.('platformEvent', {
            stage: 'LOGIN_SUCCESS',
            schoolCode: s.schoolCode,
            schoolName: s.schoolName,
            index: currentIndex,
            total: totalSchools,
            percent,
            message: msg
          });
        } catch (err: any) {
          const errMsg = `ログイン検証エラー: ${err.message}`;
          results.push({
            schoolCode: s.schoolCode,
            schoolName: s.schoolName,
            status: 'INVALID',
            message: errMsg
          });
          broadcastSse?.('platformEvent', {
            stage: 'LOGIN_FAILED',
            schoolCode: s.schoolCode,
            schoolName: s.schoolName,
            index: currentIndex,
            total: totalSchools,
            percent,
            message: errMsg
          });
        } finally {
          if (browser) await browser.close();
        }
      }

      const validCount = results.filter(r => r.status === 'VALID').length;
      sendJson(200, {
        total: results.length,
        valid: validCount,
        failed: results.length - validCount,
        results
      });
      return true;
    }

    // 6. POST /api/platform/plan/generate (対話型再計画・無効化対応)
    if (method === 'POST' && pathname === '/api/platform/plan/generate') {
      const { jobId: inputJobId, targetSet: inputTargetSet, userInstruction, sourceFiles, previousJobId, refinementInstruction } = body || {};

      // Server-authoritative validation: jobId is mandatory and must refer to an existing valid job
      const targetJobId = inputJobId || inputTargetSet?.jobId;
      if (!targetJobId || typeof targetJobId !== 'string' || targetJobId.trim().length === 0) {
        sendJson(400, { error: 'INVALID_JOB_ID', message: '有効な jobId を指定してください。' });
        return true;
      }

      const existingJob = jobStore.getJob(targetJobId.trim());
      if (!existingJob) {
        sendJson(404, { error: 'JOB_NOT_FOUND', message: `指定された Job (${targetJobId}) が存在しません。` });
        return true;
      }

      // Check job status is eligible for plan generation
      const allowedStatuses = ['TARGETS_CONFIGURED', 'PLAN_GENERATED', 'DRAFT', 'CREDENTIAL_REQUIRED'];
      if (!allowedStatuses.includes(existingJob.status)) {
        sendJson(400, { error: 'INVALID_JOB_STATE', message: `Job状態 "${existingJob.status}" からは計画作成できません。` });
        return true;
      }

      // TargetSet SSOT: Use stored targetSet from JobStore as SSOT
      const authoritativeTargetSet = existingJob.targetSet;
      if (!authoritativeTargetSet) {
        sendJson(400, { error: 'TARGET_SET_NOT_FOUND', message: 'Job に対象学校リストが登録されていません。' });
        return true;
      }

      // If client supplied inputTargetSet, verify binding
      if (inputTargetSet && inputTargetSet.jobId && inputTargetSet.jobId !== existingJob.jobId) {
        sendJson(400, { error: 'TARGET_SET_JOB_MISMATCH', message: '送信された targetSet の jobId が Job と一致しません。' });
        return true;
      }

      if (!userInstruction && !refinementInstruction) {
        sendJson(400, { error: 'INVALID_INPUT', message: '作業指示を入力してください。' });
        return true;
      }

      let previousPlan = undefined;
      if (previousJobId) {
        const prevJob = jobStore.getJob(previousJobId);
        if (prevJob) {
          previousPlan = prevJob.executionPlan;
        }
      }

      broadcastSse?.('platformEvent', {
        stage: 'AI_PLANNING',
        message: refinementInstruction
          ? 'Claude Haiku 5.5 が修正指示に基づき作業計画を再検討しています...'
          : 'Claude Haiku 5.5 が指示を解釈し、安全な自動化作業計画を立案しています...'
      });

      const planResult = await TaskPlanner.generatePlanAsync({
        targetSet: authoritativeTargetSet,
        userInstruction: userInstruction || previousPlan?.userInstruction || '',
        sourceFiles,
        previousPlan,
        refinementInstruction
      });
      const executionPlan = planResult.plan;

      if (executionPlan.status === 'PLAN_AI_UNAVAILABLE') {
        broadcastSse?.('platformEvent', {
          stage: 'PLAN_FAILED',
          message: 'Claude APIキーが未設定のため計画立案を停止しました'
        });
        sendJson(400, {
          error: 'PLAN_AI_UNAVAILABLE',
          message: 'Claude APIキー (ANTHROPIC_API_KEY) が設定されていないため、自律AIプランニングを実行できません。上部の「Claude APIキー設定」からキーを入力して保存してください。',
          executionPlan
        });
        return true;
      }

      broadcastSse?.('platformEvent', {
        stage: 'PLAN_READY',
        message: `作業計画の立案完了 (Plan ID: ${executionPlan.planId})`
      });

      const timeEstimate = Estimator.estimateTime(executionPlan, authoritativeTargetSet);
      const costEstimate = Estimator.estimateCost(executionPlan, authoritativeTargetSet);
      costEstimate.estimatedInputTokens = planResult.tokenUsage.inputTokens;
      costEstimate.estimatedOutputTokens = planResult.tokenUsage.outputTokens;
      costEstimate.model = `${planResult.aiProvider} (${planResult.aiModel})`;

      // 新しいPlanでは承認ポリシーをゼロから初期化（古い承認を流用禁止: Invalidation）
      const initialCanaryScope = executionPlan.validationScopeProposal?.policyApproved
        ? executionPlan.validationScopeProposal.count
        : undefined;
      const policy = PolicyEngine.createDefaultPolicy(executionPlan.riskLevel, initialCanaryScope);
      policy.planHash = PolicyEngine.computePlanHash(executionPlan);
      policy.targetSetHash = PolicyEngine.computeTargetSetHash(authoritativeTargetSet);

      const job: PlatformJob = {
        jobId: existingJob.jobId,
        title: (executionPlan.userInstruction || '無題の計画').slice(0, 30) + '...',
        createdAt: existingJob.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'PLAN_GENERATED',
        targetSet: authoritativeTargetSet,
        userInstruction: executionPlan.userInstruction,
        sourceFiles: sourceFiles || existingJob.sourceFiles || authoritativeTargetSet.sourceFiles || [],
        executionPlan,
        policy,
        timeEstimate,
        costEstimate,
        runs: existingJob.runs || {}
      };
      jobStore.saveJob(job);

      sendJson(200, {
        jobId: job.jobId,
        executionPlan,
        timeEstimate,
        costEstimate,
        policy,
        aiMetadata: {
          provider: planResult.aiProvider,
          model: planResult.aiModel,
          isRealApiCall: planResult.isRealApiCall,
          tokenUsage: planResult.tokenUsage,
          latencyMs: planResult.latencyMs
        }
      });
      return true;
    }


    // 7. POST /api/platform/policy/approve
    if (method === 'POST' && pathname === '/api/platform/policy/approve') {
      const validation = PolicyEngine.validateApproveRequest(body);
      if (!validation.success) {
        sendJson(400, {
          error: 'INVALID_APPROVE_REQUEST',
          message: 'ポリシー承認リクエストが不正です。schema検証に失敗しました。',
          details: validation.error.errors
        });
        return true;
      }

      const { jobId, gateId, approvedBy, notes, autoProceedToFull } = validation.data;
      const job = jobStore.getJob(jobId);
      if (!job) {
        sendJson(404, { error: 'JOB_NOT_FOUND' });
        return true;
      }

      // Gate 1 (Plan approval) 防壁: Plan / TargetSet の改ざん・不整合を検証
      if (gateId === 'GATE_1_PLAN') {
        const curPlanHash = PolicyEngine.computePlanHash(job.executionPlan);
        const curTargetSetHash = PolicyEngine.computeTargetSetHash(job.targetSet);
        if (job.policy.planHash !== curPlanHash || job.policy.targetSetHash !== curTargetSetHash) {
          job.policy = PolicyEngine.invalidatePolicy(job.policy, 'Plan or TargetSet changed before approval');
          jobStore.saveJob(job);
          sendJson(400, {
            error: 'POLICY_STALE',
            message: 'Plan または TargetSet が計画立案時から変更されています。Gate 1 承認は拒絶されました。再計画と Dry-run が必要です。'
          });
          return true;
        }
      }

      PolicyEngine.approveGate(job.policy, gateId as GateId, approvedBy, notes);
      if (autoProceedToFull !== undefined) {
        job.policy.autoProceedToFullOnCanarySuccess = autoProceedToFull;
      }
      jobStore.saveJob(job);

      sendJson(200, { policy: job.policy });
      return true;
    }

    // 8. POST /api/platform/jobs/run
    if (method === 'POST' && pathname === '/api/platform/jobs/run') {
      const { jobId, mode } = body || {};

      // Runtime schema validation of JobExecutionMode before launching browser
      const modeResult = JobExecutionModeSchema.safeParse(mode);
      if (!modeResult.success) {
        sendJson(400, {
          error: 'INVALID_EXECUTION_MODE',
          message: `無効な実行モード "${mode}" が指定されました。LOGICAL_DRY_RUN, CANARY_VALIDATION, FULL_PRODUCTION のいずれかを指定してください。`,
          details: modeResult.error.errors
        });
        return true;
      }
      const validatedMode = modeResult.data;

      const job = jobStore.getJob(jobId);
      if (!job) {
        sendJson(404, { error: 'JOB_NOT_FOUND' });
        return true;
      }

      let browser: Browser | null = null;
      try {
        browser = await chromium.launch({ headless: true });
        const result = await this.runner.runJob(
          job,
          validatedMode,
          (summary, curRes, event) => {
            if (event) {
              console.log(`[PlatformRunner][EVENT] ${event.stage}: ${event.message}`);
              broadcastSse?.('platformProgress', { summary, curRes, event });
            }
          },
          { browser }
        );

        const analysis = ResultAnalyst.analyzeResults(result.summary, result.results);
        sendJson(200, {
          summary: result.summary,
          results: result.results,
          analysis
        });
      } catch (err: any) {
        let userMessage = err.message;
        if (err.message.includes('Execution Blocked by Policy Engine')) {
          userMessage = '安全ポリシーにより処理が停止されました。必要な承認手順をご確認ください。';
        } else if (err.message.includes('AUTH_CREDENTIAL_REJECTED') || err.message.includes('ログイン')) {
          userMessage = '学校アカウントにログインできませんでした。入力したID・パスワードをご確認ください。';
        }
        sendJson(400, { error: 'EXECUTION_REJECTED', message: userMessage, rawError: err.message });
      } finally {
        if (browser) await browser.close();
      }
      return true;
    }

    // 9. POST /api/platform/jobs/stop
    if (method === 'POST' && pathname === '/api/platform/jobs/stop') {
      this.runner.stop();
      sendJson(200, { message: 'Stop signal sent to platform runner' });
      return true;
    }

    return false; // Not handled by platform router
  }
}
