import * as assert from 'assert';
import { TargetInterpreter } from '../../src/platform/ai/targetInterpreter';
import { TaskPlanner } from '../../src/platform/ai/taskPlanner';
import { Estimator } from '../../src/platform/ai/estimator';
import { PolicyEngine } from '../../src/platform/policy/policyEngine';
import { PlatformRunner } from '../../src/platform/runtime/platformRunner';
import { PlatformJob } from '../../src/platform/types/job';
import { ResultAnalyst } from '../../src/platform/ai/resultAnalyst';

async function runEndToEndScenario() {
  console.log('=== [PLATFORM E2E SCENARIO TEST START] ===');
  console.log('Scenario: User: "このExcelにある学校について、学校設定を変更してください"');

  // Step 1: Ingestion & Target Parsing
  const excelMockCsv = `
schoolCode,schoolName,adminId,password
C2001001,大淀小学校,admin_oyodo,Pass_Oyodo_999
C2001002,中津小学校,admin_nakatsu,Pass_Nakatsu_888
C2001003,豊崎中学校,admin_toyosaki,Pass_Toyo_777
C2001004,扇町小学校,admin_ogimachi,Pass_Ogi_666
C2001005,菅北小学校,admin_sugakita,Pass_Suga_555
`.trim();

  const targetSet = TargetInterpreter.parseTargets({
    files: [{ filename: 'target_schools.csv', content: excelMockCsv }]
  });

  assert.strictEqual(targetSet.schools.length, 5, '5 schools parsed');
  assert.strictEqual(targetSet.summary.ready, 5, 'All 5 schools are READY');
  console.log('Step 1 PASSED: Target parsed 5 schools successfully.');

  // Step 2: Task Planning & Capability Resolution
  const userInstruction = 'このExcelにある学校について、学校設定を変更してください。ただし中学校は除外してください。';
  const planResult = await TaskPlanner.generatePlanAsync({
    targetSet,
    userInstruction,
    sourceFiles: ['target_schools.csv']
  });
  const plan = planResult.plan;

  assert.strictEqual(plan.targetFilter?.schoolType, 'ELEMENTARY', 'Excluded Junior High');
  assert.strictEqual(plan.estimatedAffectedSchools, 4, '4 elementary schools affected');
  assert.ok(plan.operations.some((o: any) => o.operationType === 'CHANGE_SCHOOL_SETTINGS'), 'CHANGE_SCHOOL_SETTINGS planned');

  const timeEst = Estimator.estimateTime(plan, targetSet);
  const costEst = Estimator.estimateCost(plan, targetSet);
  console.log(`Step 2 PASSED: Plan generated. Affected: ${plan.estimatedAffectedSchools} schools. ETA: ${timeEst.displayFormatted}, AI Cost: ¥${costEst.estimatedCostJpy}`);

  // Create Platform Job
  const policy = PolicyEngine.createDefaultPolicy(plan.riskLevel);
  const job: PlatformJob = {
    jobId: `job_e2e_test_${Date.now()}`,
    title: '学校設定変更 E2E ジョブ',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'PLAN_GENERATED',
    targetSet,
    userInstruction,
    sourceFiles: ['target_schools.csv'],
    executionPlan: plan,
    policy,
    timeEstimate: timeEst,
    costEstimate: costEst,
    runs: {}
  };

  const runner = new PlatformRunner();

  // Gate 1 Approval
  PolicyEngine.approveGate(job.policy, 'GATE_1_PLAN', 'TestOperator');

  // Step 3a: Logical Dry-run (Read-only)
  console.log('--- Step 3a: Executing Logical Dry-run ---');
  const dryRunRes = await runner.runJob(job, 'LOGICAL_DRY_RUN');
  assert.strictEqual(dryRunRes.summary.mode, 'LOGICAL_DRY_RUN');
  assert.strictEqual(dryRunRes.summary.processedCount, 4, '4 schools processed in dry run');
  assert.strictEqual(dryRunRes.summary.successCount, 4, '4 schools succeeded in dry run');
  console.log('Step 3a PASSED: Dry-run completed with 0 saves.');

  // Gate 2 Approval
  PolicyEngine.approveGate(job.policy, 'GATE_2_DRY_RUN', 'TestOperator');

  // Step 3b: Mock Canary Validation (少数校: 1〜3校)
  console.log('--- Step 3b: Executing Canary Validation ---');
  PolicyEngine.approveGate(job.policy, 'GATE_3_CANARY', 'TestOperator');
  const canaryRes = await runner.runJob(job, 'CANARY_VALIDATION');
  assert.ok(canaryRes.summary.processedCount <= 3, 'Canary processed limited schools');
  assert.strictEqual(canaryRes.summary.successCount, 3, 'Canary succeeded');
  console.log(`Step 3b PASSED: Canary validated ${canaryRes.summary.processedCount} schools.`);

  // Step 3c: Full Production Execution
  console.log('--- Step 3c: Executing Full Production Run ---');
  PolicyEngine.approveGate(job.policy, 'GATE_4_FULL_PRODUCTION', 'TestOperator');
  let progressCount = 0;
  const prodRes = await runner.runJob(job, 'FULL_PRODUCTION', (summary) => {
    progressCount++;
  });

  assert.strictEqual(prodRes.summary.processedCount, 4, 'All 4 elementary schools processed');
  assert.strictEqual(prodRes.summary.successCount, 4, 'All 4 succeeded');
  assert.strictEqual(prodRes.summary.failedCount, 0, '0 failures');
  assert.strictEqual(prodRes.summary.circuitBreakerState, 'CLOSED', 'Circuit breaker remained CLOSED');
  assert.ok(progressCount >= 4, 'Progress callback invoked');
  console.log('Step 3c PASSED: Full Production run completed.');

  // Step 4: Result Analysis & Credential Safety Audit
  const analysis = ResultAnalyst.analyzeResults(prodRes.summary, prodRes.results);
  assert.strictEqual(analysis.successRatePercent, 100, '100% success rate');
  assert.ok(analysis.headlineSummary.includes('4校'), 'Headline mentions 4 schools');

  // Security Check: Credential Leakage = 0
  const serializedResults = JSON.stringify(prodRes.results);
  const serializedSummary = JSON.stringify(prodRes.summary);
  const combined = serializedResults + serializedSummary;

  const forbiddenStrings = ['Pass_Oyodo_999', 'Pass_Nakatsu_888', 'Pass_Toyo_777', 'Pass_Ogi_666', 'Pass_Suga_555'];
  for (const str of forbiddenStrings) {
    assert.ok(!combined.includes(str), `CRITICAL SECURITY FAILURE: Plaintext password "${str}" was leaked in execution results!`);
  }
  console.log('Step 4 PASSED: Result Analyst summary generated & Credential leakage = 0 verified.');

  console.log('=== [PLATFORM E2E SCENARIO TEST COMPLETED: ALL PASS] ===\n');
}

runEndToEndScenario().catch((e) => {
  console.error('E2E scenario test failed:', e);
  process.exit(1);
});
