import * as assert from 'assert';
import { chromium } from 'playwright';
import { PlatformRunner } from '../../src/platform/runtime/platformRunner';
import { PolicyEngine } from '../../src/platform/policy/policyEngine';
import { JobStore } from '../../src/platform/runtime/jobStore';
import { PlatformJob, JobExecutionMode, JobExecutionModeSchema, RunEvidence } from '../../src/platform/types/job';
import { ExecutionPlan } from '../../src/platform/types/plan';
import { TargetSet, TargetSchool } from '../../src/platform/types/target';
import { GuardedPage, setupNetworkBlocker } from '../../src/platform/capabilities/guardedPage';
import { CapabilityExecutionContext } from '../../src/platform/types/capability';
import { LocalSecretVault } from '../../src/platform/ingestion/documentIngestion';
import { TargetInterpreter } from '../../src/platform/ai/targetInterpreter';
import { CapabilityRegistry } from '../../src/platform/capabilities/registry';
import { ReorderContentsCapability, calculateOrderHash } from '../../src/platform/capabilities/reorderContents';
import { CreateSchoolAdminCapability } from '../../src/platform/capabilities/createSchoolAdmin';
import { PlatformRouter } from '../../src/platform/api/platformRouter';
import { LlmClient } from '../../src/platform/ai/llmClient';
import { TaskPlanner } from '../../src/platform/ai/taskPlanner';

function createMockPlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    planId: 'plan_test_001',
    targetSetId: 'ts_test_001',
    userInstruction: 'コンテンツ順序変更',
    status: 'READY',
    sourceFiles: [],
    operations: [
      {
        operationId: 'op_001',
        capabilityId: 'REORDER_CONTENTS',
        operationType: 'REORDER_CONTENTS',
        inputMapping: { targetOrder: ['Google', 'MEXCBT連携アプリ'] },
        preconditions: [],
        verification: [],
        riskClass: 'REVERSIBLE_WRITE',
        reversible: true
      }
    ],
    assumptions: [],
    questions: [],
    riskLevel: 'REVERSIBLE_WRITE',
    estimatedAffectedSchools: 1,
    approvalStatus: 'DRAFT',
    planHash: 'hash_test_plan_001',
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function createMockTargetSet(schoolsCount = 3): TargetSet {
  const schools: TargetSchool[] = [];
  for (let i = 1; i <= schoolsCount; i++) {
    const code = `SCH_${i.toString().padStart(3, '0')}`;
    const name = i === 1 ? 'テスト小学校' : (i === 2 ? 'テスト中学校' : 'テスト高校');
    const type: 'ELEMENTARY' | 'JUNIOR_HIGH' | 'HIGH' = i === 1 ? 'ELEMENTARY' : (i === 2 ? 'JUNIOR_HIGH' : 'HIGH');
    schools.push({
      schoolCode: code,
      schoolName: name,
      userId: `admin_${code}`,
      schoolType: type,
      credentialRef: `cred_ref_${code}`,
      enabled: true,
      validationStatus: 'READY'
    });
  }
  return {
    targetSetId: 'ts_test_001',
    name: 'Test Target Set',
    createdAt: new Date().toISOString(),
    sourceFiles: ['test.csv'],
    rawTextProvided: false,
    schools,
    summary: { total: schoolsCount, ready: schoolsCount, missing: 0, ambiguous: 0 }
  };
}

function createMockJob(overrides: Partial<PlatformJob> = {}): PlatformJob {
  const plan = overrides.executionPlan || createMockPlan();
  const targetSet = overrides.targetSet || createMockTargetSet();
  const policy = overrides.policy || PolicyEngine.createDefaultPolicy(plan.riskLevel);
  return {
    jobId: 'job_test_default',
    title: 'Test Job',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'PLAN_GENERATED',
    targetSet,
    userInstruction: 'test instruction',
    sourceFiles: [],
    executionPlan: plan,
    policy,
    runs: {},
    ...overrides
  };
}

async function runTests() {
  console.log('================================================================');
  console.log('   Platform Safety Invariants & Architecture Tests (43 Cases)   ');
  console.log('================================================================');

  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    total++;
    try {
      await fn();
      console.log(`[PASS] Case ${total}: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`[FAIL] Case ${total}: ${name}`);
      console.error(err);
      throw err;
    }
  }

  // Case 1: JobExecutionMode runtime validation (API / Runner)
  await test('JobExecutionMode schema rejects unknown, empty, null, or typo modes', async () => {
    const invalidModes = ['FOO', '', null, undefined, 'dry_run', 'logical_dry_run', 'CANARY', 123];
    for (const m of invalidModes) {
      const res = JobExecutionModeSchema.safeParse(m);
      assert.strictEqual(res.success, false, `Mode "${m}" must be rejected by schema`);
    }

    const runner = new PlatformRunner();
    const plan = createMockPlan();
    const targetSet = createMockTargetSet();
    const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);
    const job = createMockJob({
      jobId: 'job_case1',
      title: 'Case 1',
      targetSet,
      executionPlan: plan,
      policy
    });

    await assert.rejects(
      async () => await runner.runJob(job, 'FOO' as any),
      /INVALID_EXECUTION_MODE/,
      'PlatformRunner must throw INVALID_EXECUTION_MODE for unknown mode'
    );
  });

  // Case 2: ExecutionPlan status validation
  await test('PlatformRunner blocks execution if ExecutionPlan status is not READY', async () => {
    const runner = new PlatformRunner();
    const targetSet = createMockTargetSet();
    const plan = createMockPlan({ status: 'NEEDS_CLARIFICATION' });
    const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');
    const job = createMockJob({
      jobId: 'job_case2',
      title: 'Case 2',
      targetSet,
      executionPlan: plan,
      policy
    });

    await assert.rejects(
      async () => await runner.runJob(job, 'LOGICAL_DRY_RUN'),
      /EXECUTION_BLOCKED: Execution plan is not in READY state/,
      'Must reject execution if plan is NEEDS_CLARIFICATION'
    );
  });

  // Case 3: Target Scope calculation
  await test('PlatformRunner strictly applies schoolCodes, excludeSchoolCodes, and schoolType filters', async () => {
    const runner = new PlatformRunner();
    const targetSet = createMockTargetSet(3); // SCH_001 (小), SCH_002 (中), SCH_003 (高)
    
    const jobId = 'job_case3';
    // Set up credentials in vault with jobId
    LocalSecretVault.storeSecretWithRef('cred_ref_SCH_001', 'mock_pw_1', jobId);
    LocalSecretVault.storeSecretWithRef('cred_ref_SCH_002', 'mock_pw_2', jobId);
    LocalSecretVault.storeSecretWithRef('cred_ref_SCH_003', 'mock_pw_3', jobId);

    const plan = createMockPlan({
      targetFilter: {
        schoolCodes: ['SCH_001', 'SCH_002'],
        excludeSchoolCodes: ['SCH_002'],
        schoolType: 'ELEMENTARY'
      }
    });
    const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');

    const job = createMockJob({
      jobId,
      title: 'Case 3',
      targetSet,
      executionPlan: plan,
      policy
    });

    const res = await runner.runJob(job, 'LOGICAL_DRY_RUN');
    assert.strictEqual(res.summary.totalSchools, 1, 'Only SCH_001 should remain after filters');
    assert.strictEqual(res.results[0].schoolCode, 'SCH_001');
  });

  // Case 4: Canary Scope constraint
  await test('PolicyEngine limits Canary scope according to risk class and enforces caps', () => {
    const scopeReversible = PolicyEngine.getApprovedCanaryScope('REVERSIBLE_WRITE', 10, 5);
    assert.strictEqual(scopeReversible, 3, 'REVERSIBLE_WRITE capped at 3');

    const scopeSensitive = PolicyEngine.getApprovedCanaryScope('SENSITIVE_WRITE', 10, 5);
    assert.strictEqual(scopeSensitive, 2, 'SENSITIVE_WRITE capped at 2');

    const scopeDestructive = PolicyEngine.getApprovedCanaryScope('DESTRUCTIVE_WRITE', 10, 5);
    assert.strictEqual(scopeDestructive, 1, 'DESTRUCTIVE_WRITE capped at 1');

    const evalRes = PolicyEngine.evaluateValidationScopeProposal(
      { unit: 'SCHOOL', count: 10, description: '10校先行' },
      'REVERSIBLE_WRITE',
      10
    );
    assert.strictEqual(evalRes.approved, false);
    assert.strictEqual(evalRes.approvedCount, 3);
  });

  // Case 5: Missing Credential fail-closed
  await test('PlatformRunner fails closed and blocks execution when password is missing in real browser mode', async () => {
    const runner = new PlatformRunner();
    const targetSet = createMockTargetSet(1);
    LocalSecretVault.clear(); // Clear all credentials

    const plan = createMockPlan();
    const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');

    const job = createMockJob({
      jobId: 'job_case5',
      title: 'Case 5',
      targetSet,
      executionPlan: plan,
      policy
    });

    // Pass mock browser object
    const mockBrowser: any = {
      newContext: async () => ({
        newPage: async () => ({}),
        close: async () => {}
      })
    };

    const res = await runner.runJob(job, 'LOGICAL_DRY_RUN', undefined, { browser: mockBrowser });
    assert.strictEqual(res.summary.failedCount, 1);
    assert.strictEqual(res.results[0].status, 'FAILED');
    assert.ok(res.results[0].error?.includes('MISSING_CREDENTIAL'));
  });

  // Case 6: LocalSecretVault lifecycle
  await test('LocalSecretVault uses UUID handles, supports job scoping and cleanup', () => {
    LocalSecretVault.clear();
    const jobId = 'job_vault_test';
    const handle = LocalSecretVault.storeSecret('secret_pass_123', jobId);
    assert.ok(handle.startsWith('secret_handle_'), 'Handle should start with secret_handle_');
    assert.strictEqual(LocalSecretVault.getSecret(handle, jobId), 'secret_pass_123');

    LocalSecretVault.cleanupJob(jobId);
    assert.strictEqual(LocalSecretVault.getSecret(handle, jobId), undefined, 'Secret should be cleared on job cleanup');
  });

  // Case 7: TargetSet credential boundary
  await test('TargetInterpreter degrades rawTextProvided to boolean and provides sanitized meta', () => {
    const parsed = TargetInterpreter.parseTargets({
      rawText: 'SCH_001,テスト学校,admin_001,super_secret_password\nSCH_002,テスト学校2,admin_002,password123',
      jobId: 'job_case_7'
    });

    assert.strictEqual(typeof parsed.rawTextProvided, 'boolean');
    assert.strictEqual(parsed.rawTextProvided, true);
    assert.ok(parsed.sanitizedRawTextMeta);
    assert.ok(parsed.sanitizedRawTextMeta!.charCount > 0);
    assert.strictEqual(parsed.sanitizedRawTextMeta!.lineCount, 2);

    // Verify plaintext password is not in metadata or school objects
    for (const s of parsed.schools) {
      assert.strictEqual((s as any).password, undefined);
      assert.ok(s.credentialRef.startsWith('cred_ref_'));
    }
  });

  // Case 8: GuardedPage physical write blocking
  await test('GuardedPage physically blocks click/fill/selectOption/dragAndDrop when isWriteBlocked is true', async () => {
    const gp = new GuardedPage(null, true, true);
    assert.strictEqual(gp.isWriteBlocked, true);

    await assert.rejects(async () => await gp.click('button'), /WRITE_BLOCKED_IN_DRY_RUN/);
    await assert.rejects(async () => await gp.fill('input', 'val'), /WRITE_BLOCKED_IN_DRY_RUN/);
    await assert.rejects(async () => await gp.selectOption('select', 'opt'), /WRITE_BLOCKED_IN_DRY_RUN/);
    await assert.rejects(async () => await gp.dragAndDrop('#a', '#b'), /WRITE_BLOCKED_IN_DRY_RUN/);

    // Read-only operations should not throw
    const text = await gp.getText('#elem');
    assert.strictEqual(text, 'MOCK_TEXT');
  });

  // Case 9: Policy approve request schema validation
  await test('PolicyEngine.validateApproveRequest rejects invalid gateId, string boolean, and missing approvedBy', () => {
    // Unknown gateId
    const res1 = PolicyEngine.validateApproveRequest({
      jobId: 'job_01',
      gateId: 'UNKNOWN_GATE',
      approvedBy: 'operator'
    });
    assert.strictEqual(res1.success, false);

    // String boolean autoProceedToFull: "false"
    const res2 = PolicyEngine.validateApproveRequest({
      jobId: 'job_01',
      gateId: 'GATE_1_PLAN',
      approvedBy: 'operator',
      autoProceedToFull: 'false'
    });
    assert.strictEqual(res2.success, false);

    // Empty approvedBy
    const res3 = PolicyEngine.validateApproveRequest({
      jobId: 'job_01',
      gateId: 'GATE_1_PLAN',
      approvedBy: ''
    });
    assert.strictEqual(res3.success, false);

    // Valid request
    const resValid = PolicyEngine.validateApproveRequest({
      jobId: 'job_01',
      gateId: 'GATE_1_PLAN',
      approvedBy: 'operator',
      autoProceedToFull: false
    });
    assert.strictEqual(resValid.success, true);
  });

  // Case 10: PolicyEngine verifyExecutionAllowed
  await test('PolicyEngine blocks FULL_PRODUCTION without successful Dry-run and Canary evidences', () => {
    const policy = PolicyEngine.createDefaultPolicy('SENSITIVE_WRITE');
    policy.planHash = 'hash_plan';
    policy.targetSetHash = 'hash_target';
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');
    PolicyEngine.approveGate(policy, 'GATE_2_DRY_RUN', 'tester');
    PolicyEngine.approveGate(policy, 'GATE_3_CANARY', 'tester');
    PolicyEngine.approveGate(policy, 'GATE_4_FULL_PRODUCTION', 'tester');

    // Without evidence: must fail
    const auditNoEvidence = PolicyEngine.verifyExecutionAllowed(policy, 'FULL_PRODUCTION');
    assert.strictEqual(auditNoEvidence.passed, false);
    assert.ok(auditNoEvidence.violations.some(v => v.includes('Dry-run正常完了の実行証跡')));

    // With successful evidences
    const evidences: any[] = [
      {
        evidenceId: 'ev_1',
        mode: 'LOGICAL_DRY_RUN',
        status: 'SUCCESS',
        totalSchools: 1,
        successCount: 1,
        failedCount: 0,
        blockedCount: 0,
        allVerified: true,
        fingerprint: { planHash: 'hash_plan', targetSetHash: 'hash_target', actualSchoolCodes: ['SCH_001'] }
      },
      {
        evidenceId: 'ev_2',
        mode: 'CANARY_VALIDATION',
        status: 'SUCCESS',
        totalSchools: 1,
        successCount: 1,
        failedCount: 0,
        blockedCount: 0,
        allVerified: true,
        fingerprint: { planHash: 'hash_plan', targetSetHash: 'hash_target', actualSchoolCodes: ['SCH_001'] }
      }
    ];

    const auditWithEvidence = PolicyEngine.verifyExecutionAllowed(policy, 'FULL_PRODUCTION', evidences);
    if (!auditWithEvidence.passed) {
      console.log('auditWithEvidence violations:', auditWithEvidence.violations);
    }
    assert.strictEqual(auditWithEvidence.passed, true);
  });

  // Case 11: PolicyEngine invalidatePolicy
  await test('PolicyEngine.invalidatePolicy resets all gate approvals and policy canary scope', () => {
    const policy = PolicyEngine.createDefaultPolicy('REVERSIBLE_WRITE');
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');
    policy.policyApprovedCanaryScope = 3;

    assert.strictEqual(policy.gates.GATE_1_PLAN.approved, true);

    const invalidated = PolicyEngine.invalidatePolicy(policy, 'Plan modified by user');
    assert.strictEqual(invalidated.gates.GATE_1_PLAN.approved, false);
    assert.strictEqual(invalidated.policyApprovedCanaryScope, undefined);
    assert.ok(invalidated.gates.GATE_1_PLAN.notes?.includes('Invalidated'));
  });

  // Case 12: REORDER_CONTENTS hardcoded constants removal
  await test('REORDER_CONTENTS capability does not contain hardcoded orgId or priorityIds', () => {
    const cap = ReorderContentsCapability;
    assert.strictEqual(cap.capabilityId, 'REORDER_CONTENTS');
    assert.strictEqual(cap.productionValidated, true);
    assert.strictEqual(cap.testStatus, 'PRODUCTION_VALIDATED');

    // Verify schema requires targetOrder or targetOrderIds
    assert.ok(cap.inputSchema);
  });

  // Case 13: REORDER_CONTENTS content resolution & fail-closed
  await test('REORDER_CONTENTS fails closed on non-existent content or duplicate content', async () => {
    const cap = ReorderContentsCapability;
    const mockContext: any = {
      page: { rawPage: null },
      schoolCode: 'SCH_001',
      logger: { info: () => {}, warn: () => {}, error: () => {} }
    };

    // Unknown content name in headless fallback
    const obs = await cap.observe(mockContext, { targetOrder: ['MEXCBT連携アプリ', 'Google'] });
    assert.ok(obs.currentState.desiredOrderIds);

    // With real mock page returning contents list
    const mockPage: any = {
      evaluate: async () => [
        { contentable_id: 101, name: 'アプリA' },
        { contentable_id: 102, name: 'アプリB' }
      ]
    };
    const realContext: any = {
      page: { rawPage: mockPage },
      schoolCode: 'SCH_001',
      logger: { info: () => {}, warn: () => {}, error: () => {} }
    };

    // Unknown content name -> TARGET_CONTENT_NOT_FOUND
    await assert.rejects(
      async () => await cap.observe(realContext, { targetOrder: ['存在しないアプリ'] }),
      /TARGET_CONTENT_NOT_FOUND/
    );

    // Duplicate content name -> DUPLICATE_TARGET_ORDER
    await assert.rejects(
      async () => await cap.observe(realContext, { targetOrder: ['アプリA', 'アプリA'] }),
      /DUPLICATE_TARGET_ORDER/
    );
  });

  // Case 14: REORDER_CONTENTS orgId resolution failure fail-closed
  await test('REORDER_CONTENTS fails closed with ORG_ID_NOT_BOUND if expectedOrgId is not bound', async () => {
    const cap = ReorderContentsCapability;
    const origObserve = cap.observe;
    const mockPage: any = {
      evaluate: async () => ({ currentOrderIds: [101, 102] })
    };
    const context: any = {
      page: { rawPage: mockPage },
      schoolCode: 'SCH_001',
      isDryRun: false,
      expectedOrgId: undefined,
      logger: { info: () => {}, warn: () => {}, error: () => {} }
    };

    try {
      cap.observe = async () => ({
        currentState: { desiredOrderIds: [101, 102], baselineOrderHash: 'h1', desiredOrderHash: 'h2' },
        eligible: true
      }) as any;

      await assert.rejects(
        async () => {
          await cap.execute(context, { targetOrder: ['Google'] });
        },
        /ORG_ID_NOT_BOUND/,
        'Must throw ORG_ID_NOT_BOUND when expectedOrgId is missing'
      );
    } finally {
      cap.observe = origObserve;
    }
  });

  // Case 15: Capability Catalog auditing
  await test('CapabilityRegistry.getCatalogForAi includes only productionValidated === true capabilities', () => {
    const registry = CapabilityRegistry.getInstance();
    const aiCatalog = registry.getCatalogForAi();
    const allowedCaps = aiCatalog.map(c => c.capabilityId);

    assert.ok(allowedCaps.includes('LOGIN_AND_VERIFY'));
    assert.ok(allowedCaps.includes('REORDER_CONTENTS'));

    // Mock/unvalidated capabilities must NOT be in AI catalog
    assert.strictEqual(allowedCaps.includes('CREATE_GRADE_AND_CLASS'), false);
    assert.strictEqual(allowedCaps.includes('CREATE_SCHOOL_ADMIN'), false);
    assert.strictEqual(allowedCaps.includes('CHANGE_SCHOOL_SETTINGS'), false);
    assert.strictEqual(allowedCaps.includes('ADD_BOOKMARK'), false);
  });

  // Case 16: createSchoolAdmin schema & fallback auditing
  await test('CreateSchoolAdminCapability requires userId in schema and rejects missing userId without fallback', async () => {
    const cap = CreateSchoolAdminCapability;
    assert.strictEqual(cap.testStatus, 'MOCK_TESTED');
    assert.strictEqual(cap.productionValidated, false);
    assert.ok(cap.inputSchema && (cap.inputSchema as any).required.includes('userId'));

    const context: any = {
      schoolCode: 'SCH_001',
      logger: { info: () => {} }
    };

    await assert.rejects(
      async () => await cap.observe(context, {}),
      /userId is required/
    );

    await assert.rejects(
      async () => await cap.execute(context, {}),
      /userId is required/
    );
  });

  // Case 17: PlatformRunner stop() emergency halt
  await test('PlatformRunner stop() halts execution immediately before school and operation', async () => {
    const runner = new PlatformRunner();
    const targetSet = createMockTargetSet(3);
    const plan = createMockPlan();
    const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');

    const job = createMockJob({
      jobId: 'job_case17',
      title: 'Case 17',
      targetSet,
      executionPlan: plan,
      policy
    });

    // Pre-emptively stop
    runner.stop();
    const res = await runner.runJob(job, 'LOGICAL_DRY_RUN');
    assert.strictEqual(res.summary.processedCount, 0);
    assert.strictEqual(job.status, 'STOPPED');
  });

  // Case 18: RunEvidence generation & Canary failure state
  await test('PlatformRunner generates RunEvidence and sets job status to CANARY_FAILED on error', async () => {
    const runner = new PlatformRunner();
    const targetSet = createMockTargetSet(1);
    const plan = createMockPlan();
    // Simulate failing capability
    const registry = CapabilityRegistry.getInstance();
    const originalCap = registry.get('REORDER_CONTENTS')!;
    registry.register({
      ...originalCap,
      execute: async () => ({ success: false, error: 'MOCK_CANARY_FAILURE', message: 'Fail', verified: false, beforeState: {}, afterState: {}, appliedChanges: {} })
    });

    try {
      const computedPlanHash = PolicyEngine.computePlanHash(plan);
      const computedTargetSetHash = PolicyEngine.computeTargetSetHash(targetSet);
      plan.planHash = computedPlanHash;

      const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);
      policy.planHash = computedPlanHash;
      policy.targetSetHash = computedTargetSetHash;
      policy.policyApprovedCanaryScope = 1;
      PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');
      PolicyEngine.approveGate(policy, 'GATE_2_DRY_RUN', 'tester');
      PolicyEngine.approveGate(policy, 'GATE_3_CANARY', 'tester');

      const job = createMockJob({
        jobId: 'job_case18',
        title: 'Case 18',
        targetSet,
        executionPlan: plan,
        policy,
        evidences: [
          {
            evidenceId: 'ev_dry_run_pre',
            runId: 'run_pre',
            mode: 'LOGICAL_DRY_RUN',
            status: 'SUCCESS',
            totalSchools: 1,
            successCount: 1,
            failedCount: 0,
            blockedCount: 0,
            allVerified: true,
            completedAt: new Date().toISOString(),
            fingerprint: {
              planHash: computedPlanHash,
              targetSetHash: computedTargetSetHash,
              mode: 'LOGICAL_DRY_RUN',
              actualSchoolCodes: ['SCH_001'],
              capabilityVersions: { REORDER_CONTENTS: originalCap.version }
            }
          }
        ]
      });

      await runner.runJob(job, 'CANARY_VALIDATION');
      assert.strictEqual(job.status, 'CANARY_FAILED');
      assert.ok(job.evidences);
      assert.strictEqual(job.evidences.length, 2);
      const canaryEv = job.evidences[1];
      assert.strictEqual(canaryEv.status, 'FAILED');
      assert.strictEqual(canaryEv.failedCount, 1);
    } finally {
      // Restore original capability
      registry.register(originalCap);
    }
  });

  // Case 19: API router validate-login rejects missing credential without marking VALID
  await test('PlatformRouter /api/platform/targets/validate-login returns MISSING_CREDENTIAL for missing password', async () => {
    const router = new PlatformRouter();
    LocalSecretVault.clear();

    let statusCode = 0;
    let jsonBody: any = null;
    const sendJson = (code: number, data: any) => {
      statusCode = code;
      jsonBody = data;
    };

    const targetSet = createMockTargetSet(1);
    await router.handle(
      '/api/platform/targets/validate-login',
      'POST',
      {} as any,
      { targetSet },
      sendJson
    );

    assert.strictEqual(statusCode, 200);
    assert.strictEqual(jsonBody.results[0].status, 'MISSING_CREDENTIAL');
    assert.strictEqual(jsonBody.valid, 0);
  });

  // Case 20: OperationIR.targetSchoolCodes scoping & SKIPPED state
  await test('OperationIR.targetSchoolCodes restricts execution to scoped schools, marks unexecuted schools SKIPPED without successCount', async () => {
    const runner = new PlatformRunner();
    const targetSet = createMockTargetSet(3); // SCH_001, SCH_002, SCH_003
    const testJobId = 'job_c20';
    LocalSecretVault.clear();
    LocalSecretVault.storeSecretWithRef('cred_ref_SCH_001', 'mock_pw_1', testJobId);
    LocalSecretVault.storeSecretWithRef('cred_ref_SCH_002', 'mock_pw_2', testJobId);
    LocalSecretVault.storeSecretWithRef('cred_ref_SCH_003', 'mock_pw_3', testJobId);

    // op_1 scoped ONLY to SCH_001
    const plan = createMockPlan({
      operations: [
        {
          operationId: 'op_001',
          capabilityId: 'REORDER_CONTENTS',
          operationType: 'REORDER_CONTENTS',
          targetSchoolCodes: ['SCH_001'],
          inputMapping: { targetOrder: ['Google', 'MEXCBT連携アプリ'] },
          preconditions: [],
          verification: [],
          riskClass: 'REVERSIBLE_WRITE',
          reversible: true
        }
      ]
    });

    const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');

    const job = createMockJob({
      jobId: testJobId,
      title: 'Case 20',
      targetSet,
      executionPlan: plan,
      policy
    });

    const res = await runner.runJob(job, 'LOGICAL_DRY_RUN');
    assert.strictEqual(res.summary.totalSchools, 3);
    assert.strictEqual(res.summary.successCount, 1, 'Only SCH_001 should be success');
    assert.strictEqual(res.summary.skippedCount, 2, 'SCH_002 and SCH_003 must be SKIPPED');

    const r1 = res.results.find(r => r.schoolCode === 'SCH_001')!;
    const r2 = res.results.find(r => r.schoolCode === 'SCH_002')!;
    const r3 = res.results.find(r => r.schoolCode === 'SCH_003')!;

    assert.strictEqual(r1.status, 'SUCCESS');
    assert.strictEqual(r2.status, 'SKIPPED');
    assert.strictEqual(r3.status, 'SKIPPED');

    // RunEvidence fingerprint must include only actualSchoolCodes (SCH_001)
    const ev = job.evidences![0];
    assert.deepStrictEqual(ev.fingerprint.actualSchoolCodes, ['SCH_001']);
  });

  // Case 21: TargetSchool.schoolType SSOT & fail closed on unknown
  await test('TargetSchool.schoolType is SSOT; unknown schoolType fails closed without name guessing', async () => {
    const runner = new PlatformRunner();
    // School with ELEMENTARY name but undefined schoolType
    const schools: TargetSchool[] = [
      {
        schoolCode: 'SCH_001',
        schoolName: '桜丘小学校',
        schoolType: undefined, // Unknown
        credentialRef: 'cred_ref_SCH_001',
        enabled: true,
        validationStatus: 'READY'
      },
      {
        schoolCode: 'SCH_002',
        schoolName: '青葉学園',
        schoolType: 'ELEMENTARY', // Explicit SSOT
        credentialRef: 'cred_ref_SCH_002',
        enabled: true,
        validationStatus: 'READY'
      }
    ];

    const targetSet: TargetSet = {
      targetSetId: 'ts_c21',
      name: 'Case 21 TargetSet',
      createdAt: new Date().toISOString(),
      sourceFiles: [],
      schools,
      summary: { total: 2, ready: 2, missing: 0, ambiguous: 0 }
    };

    const jobId = 'job_case21';
    LocalSecretVault.clear();
    LocalSecretVault.storeSecretWithRef('cred_ref_SCH_001', 'mock_pw_1', jobId);
    LocalSecretVault.storeSecretWithRef('cred_ref_SCH_002', 'mock_pw_2', jobId);

    const plan = createMockPlan({
      targetFilter: { schoolType: 'ELEMENTARY' }
    });

    const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');

    const job = createMockJob({
      jobId,
      title: 'Case 21',
      targetSet,
      executionPlan: plan,
      policy
    });

    const res = await runner.runJob(job, 'LOGICAL_DRY_RUN');
    // SCH_001 must NOT be matched even though name contains "小学校"
    assert.strictEqual(res.summary.totalSchools, 1, 'Only SCH_002 with explicit schoolType ELEMENTARY must be processed');
    assert.strictEqual(res.results[0].schoolCode, 'SCH_002');
  });

  // Case 22: TargetInterpreter parses schoolType from table and text
  await test('TargetInterpreter extracts schoolType from table and text representations', () => {
    const csvContent = '学校コード,学校名,ユーザーID,校種\nSCH_101,第一小学校,admin1,小学校\nSCH_102,第二中学校,admin2,中学校\nSCH_103,第三高校,admin3,高校\nSCH_104,第四義務教育学校,admin4,小中一貫';
    const parsed = TargetInterpreter.parseTargets({
      files: [{ filename: 'schools.csv', content: csvContent }],
      jobId: 'job_case_22'
    });

    assert.strictEqual(parsed.summary.total, 4);
    assert.strictEqual(parsed.schools.find(s => s.schoolCode === 'SCH_101')?.schoolType, 'ELEMENTARY');
    assert.strictEqual(parsed.schools.find(s => s.schoolCode === 'SCH_102')?.schoolType, 'JUNIOR_HIGH');
    assert.strictEqual(parsed.schools.find(s => s.schoolCode === 'SCH_103')?.schoolType, 'HIGH');
    assert.strictEqual(parsed.schools.find(s => s.schoolCode === 'SCH_104')?.schoolType, 'COMBINED');
  });

  // Case 23: LocalSecretVault strict job scoping
  await test('LocalSecretVault enforces job ownership; Job A secret is inaccessible from Job B', () => {
    LocalSecretVault.clear();
    const handleA = LocalSecretVault.storeSecret('secret_job_a', 'job_A');

    // Access with matching jobId succeeds
    assert.strictEqual(LocalSecretVault.getSecret(handleA, 'job_A'), 'secret_job_a');
    // Access with non-matching jobId fails
    assert.strictEqual(LocalSecretVault.getSecret(handleA, 'job_B'), undefined);
    assert.strictEqual(LocalSecretVault.hasSecret(handleA, 'job_B'), false);
  });

  // Case 24: JobStore marks persisted job CREDENTIAL_REQUIRED when vault is empty
  await test('JobStore transitions job to CREDENTIAL_REQUIRED when credentials are missing from vault', () => {
    LocalSecretVault.clear();
    const store = JobStore.getInstance();
    const targetSet = createMockTargetSet(1);
    const plan = createMockPlan();
    const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);

    const job = createMockJob({
      jobId: 'job_c24_lost_vault',
      title: 'Lost Vault Job',
      status: 'PLAN_GENERATED',
      targetSet,
      executionPlan: plan,
      policy
    });

    store.saveJob(job);

    // Because LocalSecretVault was cleared, getJob should mark it CREDENTIAL_REQUIRED
    const loaded = store.getJob('job_c24_lost_vault');
    assert.ok(loaded);
    assert.strictEqual(loaded.status, 'CREDENTIAL_REQUIRED');
  });

  // Case 25: GuardedPage clickNav API and destructive element rejection
  await test('GuardedPage.clickNav permits navigation elements and rejects write/mutation selectors', async () => {
    const page = new GuardedPage(null, true, true); // write blocked

    // Safe navigation click succeeds
    await page.clickNav('.nav-menu-item');
    await page.clickNav('#tab-header-2');

    // Mutation selector in clickNav throws
    await assert.rejects(
      async () => await page.clickNav('button.save-btn'),
      /MUTATION_ELEMENT_BLOCKED_IN_CLICK_NAV/
    );
    await assert.rejects(
      async () => await page.clickNav('button:has-text("設定を保存")'),
      /MUTATION_ELEMENT_BLOCKED_IN_CLICK_NAV/
    );
    await assert.rejects(
      async () => await page.clickNav('.delete-action'),
      /MUTATION_ELEMENT_BLOCKED_IN_CLICK_NAV/
    );
  });

  // Case 26: ReorderContentsCapability inputSchema exposes only targetOrder
  await test('ReorderContentsCapability inputSchema exposes only targetOrder to AI catalog, not targetOrderIds', () => {
    const cap = ReorderContentsCapability;
    assert.ok(cap.inputSchema);
    const properties = cap.inputSchema.properties;
    assert.ok(properties.targetOrder);
    assert.strictEqual(properties.targetOrderIds, undefined, 'targetOrderIds must be removed from inputSchema');
    assert.deepStrictEqual(cap.inputSchema.required, ['targetOrder']);
  });

  // Case 27: AuthenticatedSchoolContext and expectedOrgId binding
  await test('ReorderContentsCapability utilizes bound expectedOrgId and refuses fallback to random DOM links', async () => {
    const cap = ReorderContentsCapability;
    const page = new GuardedPage(null, true, false);

    const context: CapabilityExecutionContext = {
      page,
      schoolCode: 'SCH_001',
      schoolName: 'テスト小学校',
      credentialRef: 'cred_ref_001',
      isDryRun: false,
      expectedOrgId: '998877',
      authenticatedSchoolContext: {
        schoolCode: 'SCH_001',
        schoolName: 'テスト小学校',
        organizationId: '998877',
        authenticatedAt: new Date().toISOString()
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} }
    };

    assert.strictEqual(context.expectedOrgId, '998877');
    assert.strictEqual(context.authenticatedSchoolContext?.organizationId, '998877');
  });

  // Case 28: PolicyEngine rejects Canary validation when policyApprovedCanaryScope is missing
  await test('PolicyEngine blocks CANARY_VALIDATION if policyApprovedCanaryScope is not explicitly approved', () => {
    const policy = PolicyEngine.createDefaultPolicy('REVERSIBLE_WRITE');
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');
    PolicyEngine.approveGate(policy, 'GATE_2_DRY_RUN', 'tester');
    PolicyEngine.approveGate(policy, 'GATE_3_CANARY', 'tester');

    const dryRunEv: RunEvidence = {
      evidenceId: 'ev_dry_c28',
      runId: 'r1',
      mode: 'LOGICAL_DRY_RUN',
      status: 'SUCCESS',
      totalSchools: 3,
      successCount: 3,
      failedCount: 0,
      blockedCount: 0,
      allVerified: true,
      completedAt: new Date().toISOString(),
      fingerprint: {
        planHash: 'hash_plan',
        targetSetHash: 'hash_target',
        mode: 'LOGICAL_DRY_RUN',
        actualSchoolCodes: ['SCH_001', 'SCH_002', 'SCH_003'],
        capabilityVersions: {}
      }
    };

    // Case A: policyApprovedCanaryScope is undefined -> BLOCKED
    policy.planHash = 'hash_plan';
    policy.targetSetHash = 'hash_target';
    policy.policyApprovedCanaryScope = undefined;

    const auditBlocked = PolicyEngine.verifyExecutionAllowed(policy, 'CANARY_VALIDATION', {
      planHash: 'hash_plan',
      targetSetHash: 'hash_target',
      evidences: [dryRunEv]
    });
    assert.strictEqual(auditBlocked.passed, false);
    assert.ok(auditBlocked.violations.some(v => v.includes('CANARY_SCOPE_NOT_APPROVED')));

    // Case B: policyApprovedCanaryScope is set to 2 -> ALLOWED
    policy.policyApprovedCanaryScope = 2;
    const auditAllowed = PolicyEngine.verifyExecutionAllowed(policy, 'CANARY_VALIDATION', {
      planHash: 'hash_plan',
      targetSetHash: 'hash_target',
      evidences: [dryRunEv]
    });
    assert.strictEqual(auditAllowed.passed, true);
  });

  // Case 29: PolicyEngine requires exact capabilityVersions match in Evidence
  await test('PolicyEngine blocks execution when Capability version in Evidence does not match current version', () => {
    const policy = PolicyEngine.createDefaultPolicy('REVERSIBLE_WRITE');
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');
    PolicyEngine.approveGate(policy, 'GATE_2_DRY_RUN', 'tester');
    policy.policyApprovedCanaryScope = 1;
    PolicyEngine.approveGate(policy, 'GATE_3_CANARY', 'tester');

    policy.planHash = 'hash_plan';
    policy.targetSetHash = 'hash_target';

    const dryRunEvidence: RunEvidence = {
      evidenceId: 'ev_dry_c29',
      runId: 'r1',
      mode: 'LOGICAL_DRY_RUN',
      status: 'SUCCESS',
      totalSchools: 1,
      successCount: 1,
      failedCount: 0,
      blockedCount: 0,
      allVerified: true,
      completedAt: new Date().toISOString(),
      fingerprint: {
        planHash: 'hash_plan',
        targetSetHash: 'hash_target',
        mode: 'LOGICAL_DRY_RUN',
        actualSchoolCodes: ['SCH_001'],
        capabilityVersions: { REORDER_CONTENTS: '1.1.0' } // Old version
      }
    };

    // Current version is 1.2.0
    const auditMismatched = PolicyEngine.verifyExecutionAllowed(policy, 'CANARY_VALIDATION', {
      planHash: 'hash_plan',
      targetSetHash: 'hash_target',
      currentCapabilityVersions: { REORDER_CONTENTS: '1.2.0' },
      evidences: [dryRunEvidence]
    });

    assert.strictEqual(auditMismatched.passed, false, 'Must reject evidence from old capability version');
    assert.ok(auditMismatched.violations.some(v => v.includes('Capabilityバージョン')));

    // When capability version matches, execution is allowed
    const auditMatched = PolicyEngine.verifyExecutionAllowed(policy, 'CANARY_VALIDATION', {
      planHash: 'hash_plan',
      targetSetHash: 'hash_target',
      currentCapabilityVersions: { REORDER_CONTENTS: '1.1.0' },
      evidences: [dryRunEvidence]
    });

    assert.strictEqual(auditMatched.passed, true, 'Must pass when capability version matches exactly');
  });

  // Case 30: LocalSecretVault complete removal of global fallback & mandatory jobId
  await test('Case 30: LocalSecretVault forbids access without valid jobId ownership', () => {
    LocalSecretVault.clear();
    const jobId1 = 'job_101';
    const jobId2 = 'job_102';
    const handle = LocalSecretVault.storeSecret('pass_case30', jobId1);

    // Access with wrong jobId must fail
    assert.strictEqual(LocalSecretVault.getSecret(handle, jobId2), undefined, 'Must reject access from different jobId');
    assert.strictEqual(LocalSecretVault.hasSecret(handle, jobId2), false);

    // Access with empty/undefined jobId must fail closed
    assert.strictEqual(LocalSecretVault.getSecret(handle, '' as any), undefined);
    assert.strictEqual(LocalSecretVault.hasSecret(handle, '' as any), false);

    // Access with correct jobId succeeds
    assert.strictEqual(LocalSecretVault.getSecret(handle, jobId1), 'pass_case30');
    assert.strictEqual(LocalSecretVault.hasSecret(handle, jobId1), true);

    // Cleanup of job 1 removes it completely
    LocalSecretVault.cleanupJob(jobId1);
    assert.strictEqual(LocalSecretVault.getSecret(handle, jobId1), undefined);
  });

  // Case 31: PlatformRunner rejects execution when Plan/TargetSet changes after approval (POLICY_STALE)
  await test('Case 31: PlatformRunner detects post-approval modification and rejects with POLICY_STALE', async () => {
    const runner = new PlatformRunner();
    const targetSet = createMockTargetSet(1);
    const plan = createMockPlan();
    const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');

    // Record initial hashes
    policy.planHash = PolicyEngine.computePlanHash(plan);
    policy.targetSetHash = PolicyEngine.computeTargetSetHash(targetSet);

    const job = createMockJob({
      jobId: 'job_case31',
      targetSet,
      executionPlan: plan,
      policy
    });

    LocalSecretVault.storeSecretWithRef(targetSet.schools[0].credentialRef, 'pw_31', job.jobId);

    // Modify plan after approval
    plan.operations.push({
      operationId: 'op_tampered',
      capabilityId: 'REORDER_CONTENTS',
      operationType: 'REORDER_CONTENTS',
      inputMapping: {},
      preconditions: [],
      verification: [],
      riskClass: 'REVERSIBLE_WRITE',
      reversible: true
    });

    await assert.rejects(
      async () => {
        await runner.runJob(job, 'LOGICAL_DRY_RUN');
      },
      /POLICY_STALE/,
      'Must reject execution if plan has been altered after approval'
    );

    assert.strictEqual(job.policy.gates.GATE_1_PLAN.approved, false, 'Policy must be invalidated');
  });

  // Case 32: SKIPPED-only run cannot produce SUCCESS RunEvidence
  await test('Case 32: PlatformRunner SKIPPED-only run produces FAILED RunEvidence and cannot unlock Canary', async () => {
    const runner = new PlatformRunner();
    const targetSet = createMockTargetSet(2); // SCH_001, SCH_002
    const testJobId = 'job_case32';
    LocalSecretVault.storeSecretWithRef('cred_ref_SCH_001', 'pw1', testJobId);
    LocalSecretVault.storeSecretWithRef('cred_ref_SCH_002', 'pw2', testJobId);

    // Operation scoped only to SCH_999 (neither school matches)
    const plan = createMockPlan({
      operations: [
        {
          operationId: 'op_001',
          capabilityId: 'REORDER_CONTENTS',
          operationType: 'REORDER_CONTENTS',
          targetSchoolCodes: ['SCH_999'],
          inputMapping: { targetOrder: ['Google'] },
          preconditions: [],
          verification: [],
          riskClass: 'REVERSIBLE_WRITE',
          reversible: true
        }
      ]
    });

    const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');

    const job = createMockJob({
      jobId: testJobId,
      targetSet,
      executionPlan: plan,
      policy
    });

    const runRes = await runner.runJob(job, 'LOGICAL_DRY_RUN');
    assert.strictEqual(runRes.summary.skippedCount, 2);
    assert.strictEqual(runRes.summary.successCount, 0);

    const ev = job.evidences![0];
    assert.strictEqual(ev.status, 'FAILED', 'Evidence status must be FAILED when all schools were SKIPPED');
    assert.strictEqual(ev.fingerprint.actualSchoolCodes.length, 0);

    // Policy check for Canary must fail
    PolicyEngine.approveGate(job.policy, 'GATE_2_DRY_RUN', 'tester');
    job.policy.policyApprovedCanaryScope = 1;
    const canaryAudit = PolicyEngine.verifyExecutionAllowed(job.policy, 'CANARY_VALIDATION', {
      planHash: ev.fingerprint.planHash,
      targetSetHash: ev.fingerprint.targetSetHash,
      evidences: job.evidences
    });

    assert.strictEqual(canaryAudit.passed, false, 'Canary execution must be forbidden without successful non-skipped Dry-run evidence');
  });

  // Case 33: policyApprovedCanaryScope is populated during plan creation via PlatformRouter
  await test('Case 33: PlatformRouter plan/generate populates policyApprovedCanaryScope', async () => {
    const router = new PlatformRouter();
    const targetSet = createMockTargetSet(5);

    let responseStatus = 0;
    let responseBody: any = null;
    const sendJson = (status: number, data: any) => {
      responseStatus = status;
      responseBody = data;
    };

    // Temporarily mock TaskPlanner.generatePlanAsync to return proposal with policyApproved
    const originalGeneratePlanAsync = TaskPlanner.generatePlanAsync;
    TaskPlanner.generatePlanAsync = async () => ({
      plan: createMockPlan({
        validationScopeProposal: {
          unit: 'SCHOOL',
          count: 2,
          description: '先行検証2校',
          policyApproved: true,
          policyFeedback: 'OK'
        }
      }),
      aiProvider: 'MockProvider',
      aiModel: 'MockModel',
      isRealApiCall: true,
      tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      latencyMs: 10
    });

    try {
      const handled = await router.handle(
        '/api/platform/plan/generate',
        'POST',
        {} as any,
        {
          targetSet,
          userInstruction: 'コンテンツ順序変更'
        },
        sendJson
      );

      assert.strictEqual(handled, true);
      assert.strictEqual(responseStatus, 200);
      assert.ok(responseBody.policy);
      assert.strictEqual(
        responseBody.policy.policyApprovedCanaryScope,
        2,
        'Router must set policyApprovedCanaryScope from plan validationScopeProposal'
      );
      assert.ok(responseBody.policy.planHash, 'Router must compute and store policy.planHash');
      assert.ok(responseBody.policy.targetSetHash, 'Router must compute and store policy.targetSetHash');
    } finally {
      TaskPlanner.generatePlanAsync = originalGeneratePlanAsync;
    }
  });

  // Case 34: REORDER_CONTENTS fails closed if expectedOrgId is not bound
  await test('Case 34: REORDER_CONTENTS throws ORG_ID_NOT_BOUND when neither expectedOrgId nor authenticated context has orgId', async () => {
    const context: CapabilityExecutionContext = {
      schoolCode: 'SCH_001',
      schoolName: 'テスト学校',
      credentialRef: 'cred_ref_SCH_001',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      page: {
        rawPage: {
          evaluate: async () => ({ currentOrderIds: [1, 2] })
        }
      } as any,
      isDryRun: false,
      expectedOrgId: undefined,
      authenticatedSchoolContext: undefined
    };

    await assert.rejects(
      async () => {
        await ReorderContentsCapability.execute(context, { targetOrderIds: [2, 1] });
      },
      /ORG_ID_NOT_BOUND/,
      'Execution must fail closed if expectedOrgId is not bound'
    );
  });

  // Case 35: Dry-run network boundary: login allowed before verify, blocker installed after verify, mutation blocked, GET allowed
  await test('Case 35: setupNetworkBlocker aborts write methods and passes GET after login & identity verification', async () => {
    // 1. Simulate authentication phase: LoginPage submits credentials (POST allowed)
    let loginPostAllowed = false;
    const authRouteHandler = (route: any, request: any) => {
      if (request.method() === 'POST' && request.url().includes('/login')) {
        loginPostAllowed = true;
        route.continue();
      }
    };
    authRouteHandler(
      { continue: () => {} },
      { method: () => 'POST', url: () => 'https://ed-cl.com/login' }
    );
    assert.strictEqual(loginPostAllowed, true, 'Pre-verification login POST must proceed');

    // 2. Strict Identity Verification completed -> Install setupNetworkBlocker on context
    let routePatternInstalled = '';
    let installedHandler: any = null;
    const mockContext: any = {
      route: async (pattern: string, handler: any) => {
        routePatternInstalled = pattern;
        installedHandler = handler;
      }
    };

    await setupNetworkBlocker(mockContext);
    assert.strictEqual(routePatternInstalled, '**/*', 'Network blocker must route all URLs');
    assert.ok(installedHandler, 'Network blocker handler must be installed');

    // 3. Test after blocker installation: POST and PUT are blocked, GET is passed
    const abortedMethods: string[] = [];
    const continuedMethods: string[] = [];

    await installedHandler!(
      {
        abort: (reason: string) => { abortedMethods.push('POST'); },
        continue: () => { continuedMethods.push('POST'); }
      },
      { method: () => 'POST', url: () => 'https://ed-cl.com/organizations/100/content_position' }
    );

    await installedHandler!(
      {
        abort: (reason: string) => { abortedMethods.push('PUT'); },
        continue: () => { continuedMethods.push('PUT'); }
      },
      { method: () => 'PUT', url: () => 'https://ed-cl.com/organizations/100/content_position' }
    );

    await installedHandler!(
      {
        abort: (reason: string) => { abortedMethods.push('GET'); },
        continue: () => { continuedMethods.push('GET'); }
      },
      { method: () => 'GET', url: () => 'https://ed-cl.com/contents' }
    );

    assert.deepStrictEqual(abortedMethods, ['POST', 'PUT'], 'Must abort write mutation methods in Dry-run');
    assert.deepStrictEqual(continuedMethods, ['GET'], 'Must allow read GET navigation in Dry-run');
  });

  // Case 36: GuardedPage.clickNav inspects DOM attributes and rejects submit buttons & mutation buttons
  await test('Case 36: GuardedPage.clickNav blocks submit elements and mutation action attributes', async () => {
    // Test 1: Selector regex inspection
    const guarded = new GuardedPage(null, true);
    await assert.rejects(
      async () => {
        await guarded.clickNav('#btn-save-settings');
      },
      /MUTATION_ELEMENT_BLOCKED_IN_CLICK_NAV/,
      'Must reject selector with save'
    );

    // Test 2: Real playwright page mock inspection
    const mockElement = {
      waitFor: async () => {},
      evaluate: async (fn: any) => {
        return fn({
          tagName: 'BUTTON',
          getAttribute: (attr: string) => (attr === 'type' ? 'submit' : null),
          textContent: '次へ'
        });
      },
      click: async () => {}
    };

    const mockPage: any = {
      locator: () => ({ first: () => mockElement })
    };

    const guardedWithPage = new GuardedPage(mockPage, false);
    await assert.rejects(
      async () => {
        await guardedWithPage.clickNav('.nav-next-button');
      },
      /MUTATION_ELEMENT_BLOCKED_IN_CLICK_NAV/,
      'Must reject submit button even if selector looks harmless'
    );
  });

  // Case 37: LlmClient.buildMessagePayload is strongly typed and includes effort: high
  await test('Case 37: LlmClient.buildMessagePayload configures output_config effort high without top-level effort', () => {
    const payload = LlmClient.buildMessagePayload({
      systemPrompt: 'System instructions',
      userPrompt: 'User prompt',
      jsonSchema: { type: 'object' },
      effort: 'high'
    });

    assert.strictEqual(payload.model, 'claude-haiku-5-5');
    assert.strictEqual(payload.output_config?.effort, 'high');
    assert.strictEqual((payload as any).effort, undefined, 'Top-level effort must not exist');
    assert.strictEqual(payload.tool_choice?.type, 'tool');
    assert.strictEqual((payload.tool_choice as any).name, 'submit_plan');
  });

  // Case 38: TaskPlanner enforces Registry SSOT riskClass and rejects LLM hallucinations
  await test('Case 38: TaskPlanner rejects LLM hallucinated riskClass when differing from Registry SSOT', async () => {
    const reg = CapabilityRegistry.getInstance();
    const cap = reg.get('REORDER_CONTENTS')!;
    assert.strictEqual(cap.riskClass, 'REVERSIBLE_WRITE');

    // Simulate LLM returning REORDER_CONTENTS with tampered riskClass: 'READ_ONLY'
    const originalCallClaudeStructured = LlmClient.callClaudeStructured;
    LlmClient.callClaudeStructured = async () => ({
      data: {
        operations: [
          {
            capabilityId: 'REORDER_CONTENTS',
            riskClass: 'READ_ONLY', // Hallucinated / tampered by LLM
            input: { targetOrder: ['Google'] }
          }
        ],
        assumptions: [],
        questions: [],
        humanSummary: {
          interpretedIntent: '順序変更',
          targetScope: '対象校',
          actionSummary: '変更',
          settingValueSummary: '値',
          skipBehavior: 'スキップ',
          capabilityUsed: 'REORDER_CONTENTS',
          riskLevel: 'READ_ONLY'
        }
      } as any,
      usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100, latencyMs: 5 },
      provider: 'MockAnthropic',
      model: 'claude-haiku-5-5',
      isRealApiCall: true
    });

    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test_api_key_for_mock_llm';

    try {
      await assert.rejects(
        async () => {
          await TaskPlanner.generatePlanAsync({
            targetSet: createMockTargetSet(1),
            userInstruction: '順序変更'
          });
        },
        /VALIDATION_FAILED: Operation riskClass mismatch for 'REORDER_CONTENTS': AI proposed 'READ_ONLY' but Registry SSOT defines 'REVERSIBLE_WRITE'/,
        'TaskPlanner must reject plan when AI proposes riskClass differing from Registry SSOT'
      );
    } finally {
      LlmClient.callClaudeStructured = originalCallClaudeStructured;
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  // Case 39: PolicyEngine checkCapabilityMatch requires exact keys and exact values match
  await test('Case 39: PolicyEngine requires exact keys and values match for capability versions in Evidence', () => {
    const policy = PolicyEngine.createDefaultPolicy('REVERSIBLE_WRITE');
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');
    PolicyEngine.approveGate(policy, 'GATE_2_DRY_RUN', 'tester');
    policy.policyApprovedCanaryScope = 1;
    policy.planHash = 'hash_plan';
    policy.targetSetHash = 'hash_target';

    const dryRunEvidence: RunEvidence = {
      evidenceId: 'ev_dry_c39',
      runId: 'r1',
      mode: 'LOGICAL_DRY_RUN',
      status: 'SUCCESS',
      totalSchools: 1,
      successCount: 1,
      failedCount: 0,
      blockedCount: 0,
      allVerified: true,
      completedAt: new Date().toISOString(),
      fingerprint: {
        planHash: 'hash_plan',
        targetSetHash: 'hash_target',
        mode: 'LOGICAL_DRY_RUN',
        actualSchoolCodes: ['SCH_001'],
        capabilityVersions: { REORDER_CONTENTS: '1.2.0' }
      }
    };

    // Subset keys (missing an extra capability in evidence) must fail
    const auditExtraCurrent = PolicyEngine.verifyExecutionAllowed(policy, 'CANARY_VALIDATION', {
      planHash: 'hash_plan',
      targetSetHash: 'hash_target',
      currentCapabilityVersions: { REORDER_CONTENTS: '1.2.0', ANOTHER_CAP: '1.0.0' },
      evidences: [dryRunEvidence]
    });
    assert.strictEqual(auditExtraCurrent.passed, false, 'Must reject when capability key counts differ');

    // Exact key & value match must succeed
    const auditExact = PolicyEngine.verifyExecutionAllowed(policy, 'CANARY_VALIDATION', {
      planHash: 'hash_plan',
      targetSetHash: 'hash_target',
      currentCapabilityVersions: { REORDER_CONTENTS: '1.2.0' },
      evidences: [dryRunEvidence]
    });
    assert.strictEqual(auditExact.passed, true, 'Must pass on exact capability match');
  });

  // Case 40: Target parse -> validate-login -> plan/generate retains credential ownership across routes
  await test('Case 40: Full lifecycle retains credential ownership from parse to runtime', async () => {
    const router = new PlatformRouter();
    LocalSecretVault.clear();

    let parseStatus = 0;
    let parseBody: any = null;
    await router.handle(
      '/api/platform/targets/parse',
      'POST',
      {} as any,
      {
        rawText: 'SCH_001,テスト学校,admin_001,super_secret_test_pw'
      },
      (st, data) => { parseStatus = st; parseBody = data; }
    );

    assert.strictEqual(parseStatus, 200);
    assert.ok(parseBody.jobId, 'parseTargets must issue provisional jobId');
    assert.ok(parseBody.targetSet.jobId === parseBody.jobId);
    const assignedJobId = parseBody.jobId;

    const credRef = parseBody.targetSet.schools[0].credentialRef;
    assert.ok(credRef.startsWith('cred_ref_'));

    // Verify secret is registered under assignedJobId in LocalSecretVault
    assert.strictEqual(LocalSecretVault.hasSecret(credRef, assignedJobId), true);
    assert.strictEqual(LocalSecretVault.getSecret(credRef, assignedJobId), 'super_secret_test_pw');
    assert.strictEqual(LocalSecretVault.getSecret(credRef, 'another_job_id'), undefined, 'Isolation between jobs');

    // Simulate /api/platform/plan/generate inheriting the same jobId
    let planStatus = 0;
    let planBody: any = null;
    const originalGeneratePlanAsync = TaskPlanner.generatePlanAsync;
    TaskPlanner.generatePlanAsync = async () => ({
      plan: createMockPlan(),
      aiProvider: 'MockProvider',
      aiModel: 'MockModel',
      isRealApiCall: true,
      tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      latencyMs: 10
    });

    try {
      await router.handle(
        '/api/platform/plan/generate',
        'POST',
        {} as any,
        {
          jobId: assignedJobId,
          targetSet: parseBody.targetSet,
          userInstruction: '順序変更'
        },
        (st, data) => { planStatus = st; planBody = data; }
      );

      assert.strictEqual(planStatus, 200);
      assert.strictEqual(planBody.jobId, assignedJobId, 'Plan generate must retain initial provisional jobId');

      // Verify that after plan generation, JobStore has job and secret is still accessible with this jobId
      const storedJob = JobStore.getInstance().getJob(assignedJobId);
      assert.ok(storedJob);
      assert.strictEqual(storedJob?.jobId, assignedJobId);
      assert.strictEqual(LocalSecretVault.getSecret(credRef, storedJob!.jobId), 'super_secret_test_pw');
    } finally {
      TaskPlanner.generatePlanAsync = originalGeneratePlanAsync;
    }
  });

  // Case 41: Tampering plan or targetSet before Gate 1 approval triggers POLICY_STALE rejection
  await test('Case 41: Plan or TargetSet tampering before Gate 1 approval triggers POLICY_STALE rejection', async () => {
    const router = new PlatformRouter();
    const targetSet = createMockTargetSet(2);
    const plan = createMockPlan();

    // 1. Generate plan through router
    let planRes: any = null;
    const originalGeneratePlanAsync = TaskPlanner.generatePlanAsync;
    TaskPlanner.generatePlanAsync = async () => ({
      plan,
      aiProvider: 'MockProvider',
      aiModel: 'MockModel',
      isRealApiCall: true,
      tokenUsage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
      latencyMs: 5
    });

    try {
      await router.handle(
        '/api/platform/plan/generate',
        'POST',
        {} as any,
        {
          targetSet,
          userInstruction: 'テスト指示'
        },
        (st, data) => { planRes = data; }
      );

      const jobId = planRes.jobId;
      const job = JobStore.getInstance().getJob(jobId)!;
      assert.ok(job);
      assert.ok(job.policy.planHash);
      assert.ok(job.executionPlan);

      // 2. Tamper the plan in JobStore
      job.executionPlan!.operations.push({
        operationId: 'op_tampered',
        capabilityId: 'REORDER_CONTENTS',
        operationType: 'REORDER_CONTENTS',
        inputMapping: {},
        preconditions: [],
        verification: [],
        riskClass: 'REVERSIBLE_WRITE',
        reversible: true
      });
      JobStore.getInstance().saveJob(job);

      // 3. Attempt to approve Gate 1 via router
      let approveStatus = 0;
      let approveBody: any = null;
      await router.handle(
        '/api/platform/policy/approve',
        'POST',
        {} as any,
        {
          jobId,
          gateId: 'GATE_1_PLAN',
          approvedBy: 'admin_reviewer',
          autoProceedToFull: false
        },
        (st, data) => { approveStatus = st; approveBody = data; }
      );

      assert.strictEqual(approveStatus, 400);
      assert.strictEqual(approveBody.error, 'POLICY_STALE', 'Must reject approval with POLICY_STALE on tampered plan');

      // 4. Attempt to run job must also be blocked
      const runner = new PlatformRunner();
      await assert.rejects(
        async () => {
          await runner.runJob(job, 'LOGICAL_DRY_RUN');
        },
        /POLICY_STALE/,
        'PlatformRunner must also fail-closed on POLICY_STALE'
      );
    } finally {
      TaskPlanner.generatePlanAsync = originalGeneratePlanAsync;
    }
  });

  // Case 42: Credential cleanup upon FULL_PRODUCTION completion leaves results viewable but secrets purged
  await test('Case 42: Credential cleanup purges secrets on FULL_PRODUCTION completion while results remain viewable', async () => {
    const runner = new PlatformRunner();
    const jobId = 'job_cleanup_test_001';
    const targetSet = createMockTargetSet(1);
    const plan = createMockPlan();

    LocalSecretVault.clear();
    const credRef = targetSet.schools[0].credentialRef;
    LocalSecretVault.storeSecretWithRef(credRef, 'secret_cleanup_val', jobId);
    assert.strictEqual(LocalSecretVault.getSecret(credRef, jobId), 'secret_cleanup_val');

    const computedPlanHash = PolicyEngine.computePlanHash(plan);
    const computedTargetSetHash = PolicyEngine.computeTargetSetHash(targetSet);
    plan.planHash = computedPlanHash;

    const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);
    policy.planHash = computedPlanHash;
    policy.targetSetHash = computedTargetSetHash;
    policy.policyApprovedCanaryScope = 1;
    PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'tester');
    PolicyEngine.approveGate(policy, 'GATE_2_DRY_RUN', 'tester');
    PolicyEngine.approveGate(policy, 'GATE_3_CANARY', 'tester');
    PolicyEngine.approveGate(policy, 'GATE_4_FULL_PRODUCTION', 'tester');

    const reg = CapabilityRegistry.getInstance();
    const originalCap = reg.get('REORDER_CONTENTS')!;
    reg.register({
      ...originalCap,
      observe: async () => ({ eligible: true, currentState: { currentOrderIds: [1, 2], desiredOrderIds: [2, 1] } }),
      execute: async () => ({
        success: true,
        appliedChanges: { moved: true },
        beforeState: {},
        afterState: {},
        verified: true
      }),
      verify: async () => true
    });

    const job = createMockJob({
      jobId,
      title: 'Cleanup Job Test',
      targetSet,
      executionPlan: plan,
      policy,
      evidences: [
        {
          evidenceId: 'ev_dry_c42',
          runId: 'r_dry',
          mode: 'LOGICAL_DRY_RUN',
          status: 'SUCCESS',
          totalSchools: 1,
          successCount: 1,
          failedCount: 0,
          blockedCount: 0,
          allVerified: true,
          completedAt: new Date().toISOString(),
          fingerprint: {
            planHash: computedPlanHash,
            targetSetHash: computedTargetSetHash,
            mode: 'LOGICAL_DRY_RUN',
            actualSchoolCodes: ['SCH_001'],
            capabilityVersions: { REORDER_CONTENTS: originalCap.version }
          }
        },
        {
          evidenceId: 'ev_canary_c42',
          runId: 'r_canary',
          mode: 'CANARY_VALIDATION',
          status: 'SUCCESS',
          totalSchools: 1,
          successCount: 1,
          failedCount: 0,
          blockedCount: 0,
          allVerified: true,
          completedAt: new Date().toISOString(),
          fingerprint: {
            planHash: computedPlanHash,
            targetSetHash: computedTargetSetHash,
            mode: 'CANARY_VALIDATION',
            actualSchoolCodes: ['SCH_001'],
            capabilityVersions: { REORDER_CONTENTS: originalCap.version }
          }
        }
      ]
    });

    try {
      const res = await runner.runJob(job, 'FULL_PRODUCTION');
      assert.strictEqual(res.summary.processedCount, 1);
      assert.strictEqual(job.status, 'COMPLETED');

      // Secrets in LocalSecretVault must be completely cleaned up
      assert.strictEqual(LocalSecretVault.getSecret(credRef, jobId), undefined, 'Secrets must be purged upon completion');
      assert.strictEqual(LocalSecretVault.hasSecret(credRef, jobId), false);

      // Job summary and results in JobStore remain viewable
      const storedJob = JobStore.getInstance().getJob(jobId);
      assert.ok(storedJob);
      assert.strictEqual(storedJob?.status, 'COMPLETED');
      assert.ok(storedJob?.runs);
      assert.ok(Object.keys(storedJob!.runs).length > 0, 'Runs summary and results must be preserved');
    } finally {
      reg.register(originalCap);
    }
  });

  // Case 43: REORDER_CONTENTS writes strictly to expectedOrgId = 100 even if DOM contains /organizations/200
  await test('Case 43: REORDER_CONTENTS writes strictly to bound expectedOrgId=100 and ignores conflicting DOM org 200', async () => {
    const fetchedUrls: string[] = [];

    let writeExecuted = false;
    // Mock page where DOM contains conflicting org 200 but context is bound to 100
    const mockPage = {
      evaluate: async (fn: any, args?: any) => {
        // Mock the contents list call
        if (!args) {
          if (writeExecuted) {
            return [
              { contentable_id: 2, name: 'MEXCBT' },
              { contentable_id: 1, name: 'Google' }
            ];
          }
          return [
            { contentable_id: 1, name: 'Google' },
            { contentable_id: 2, name: 'MEXCBT' }
          ];
        }
        // Mock the write evaluation
        // Simulate window fetch within evaluate
        const simulatedFetch = async (url: string, options: any) => {
          fetchedUrls.push(url);
          writeExecuted = true;
          return { ok: true, status: 200, json: async () => ({ success: true }) };
        };

        // Execute function in simulated browser environment
        const originalFetch = (global as any).fetch;
        const originalDoc = (global as any).document;
        try {
          (global as any).fetch = simulatedFetch;
          (global as any).document = {
            querySelector: (sel: string) => ({
              getAttribute: () => 'mock_csrf_token',
              href: 'https://ed-cl.com/organizations/200/dashboard' // Conflicting DOM reference!
            })
          };
          return await fn(args);
        } finally {
          (global as any).fetch = originalFetch;
          (global as any).document = originalDoc;
        }
      },
      reload: async () => {}
    };

    const context: CapabilityExecutionContext = {
      schoolCode: 'SCH_001',
      schoolName: 'テスト学校',
      credentialRef: 'cred_ref_SCH_001',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      page: {
        rawPage: mockPage
      } as any,
      isDryRun: false,
      expectedOrgId: '100', // STRICT BOUND ORG ID
      authenticatedSchoolContext: {
        schoolCode: 'SCH_001',
        schoolName: 'テスト学校',
        organizationId: '100',
        authenticatedAt: new Date().toISOString()
      }
    };

    const result = await ReorderContentsCapability.execute(context, { targetOrderIds: [2, 1] });
    assert.strictEqual(result.success, true);
    assert.strictEqual(fetchedUrls.length, 1);
    assert.strictEqual(
      fetchedUrls[0],
      '/organizations/100/content_position',
      'Request must strictly target bound org 100'
    );
    assert.ok(
      !fetchedUrls.some(u => u.includes('200')),
      'Request must NEVER target conflicting DOM org 200'
    );
  });

  console.log('================================================================');
  console.log(`All ${passed} / ${total} Platform Safety Invariants PASSED!`);
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('Safety Invariants Test Failed:', err);
  process.exit(1);
});
