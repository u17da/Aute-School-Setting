import * as assert from 'assert';
import { TargetInterpreter } from '../../src/platform/ai/targetInterpreter';
import { TaskPlanner } from '../../src/platform/ai/taskPlanner';
import { Estimator } from '../../src/platform/ai/estimator';
import { CapabilityRegistry } from '../../src/platform/capabilities/registry';
import { PolicyEngine } from '../../src/platform/policy/policyEngine';
import { DocumentIngestion, LocalSecretVault } from '../../src/platform/ingestion/documentIngestion';

async function runCoreTests() {
  console.log('=== [PLATFORM CORE TESTS START] ===');

  // Test 1: Document Ingestion & Credential Boundary
  console.log('--- Test 1: Document Ingestion & Credential Boundary ---');
  const rawCsvWithPasswords = `schoolCode,schoolName,password\nC2001,堀川小,SuperSecretPw123\nC2002,滝川小,AnotherPass456`;
  const doc = DocumentIngestion.ingest({
    filename: 'schools_with_pw.csv',
    bufferOrText: rawCsvWithPasswords
  });
  assert.strictEqual(doc.tables.length, 1, 'Should extract 1 table');
  assert.strictEqual(doc.sanitizedForAi, true, 'Must be sanitized for AI');
  // Check that plaintext password is NOT in sanitized tables or text
  const tableContentStr = JSON.stringify(doc.tables);
  assert.ok(!tableContentStr.includes('SuperSecretPw123'), 'Plaintext password must NOT be in sanitized table');
  assert.ok(tableContentStr.includes('SECRET:secret_handle_'), 'Must contain secret handle');
  console.log('  [PASS] Test 1: Credential boundary successfully masked secrets.');

  // Test 2: Target Interpreter Normalization & Validation
  console.log('--- Test 2: Target Interpreter Normalization & Validation ---');
  const targetSet = TargetInterpreter.parseTargets({
    rawText: `C1001,中央小学校,admin1\nC1002,北野中学校,admin2\nC1003,,admin3\nC1001,中央別校,conflict`
  });
  assert.strictEqual(targetSet.schools.length, 3, 'Should normalize unique school codes');
  assert.strictEqual(targetSet.summary.total, 3);
  // C1001 duplicate with different name -> AMBIGUOUS
  const c1001 = targetSet.schools.find(s => s.schoolCode === 'C1001');
  assert.strictEqual(c1001?.validationStatus, 'AMBIGUOUS');
  // C1003 missing name -> MISSING
  const c1003 = targetSet.schools.find(s => s.schoolCode === 'C1003');
  assert.strictEqual(c1003?.validationStatus, 'MISSING');
  // C1002 -> READY
  const c1002 = targetSet.schools.find(s => s.schoolCode === 'C1002');
  assert.strictEqual(c1002?.validationStatus, 'READY');
  assert.ok(c1002?.credentialRef.startsWith('cred_ref_'), 'Credential handle exists');
  console.log('  [PASS] Test 2: Target normalization and status detection passed.');

  // Test 3: Task Planner & Fail-Closed AI Policy
  console.log('--- Test 3: Task Planner Fail-Closed Enforcement ---');
  const planRes = await TaskPlanner.generatePlanAsync({
    targetSet,
    userInstruction: '添付Excelの管理者を各学校へ追加してください。中学校は対象外。同じIDが既に存在する場合は何もしない。'
  });
  // Without ANTHROPIC_API_KEY, must fail-closed as PLAN_AI_UNAVAILABLE
  assert.strictEqual(planRes.plan.status, 'PLAN_AI_UNAVAILABLE', 'Must fail-closed when API key missing');
  assert.strictEqual(planRes.plan.operations.length, 0, 'No operations generated on missing API key');
  console.log('  [PASS] Test 3: Task planner successfully enforced fail-closed policy (no keyword fallback).');


  // Test 4: Capability Registry & Unsupported Detection
  console.log('--- Test 4: Capability Registry & Unsupported Detection ---');
  const registry = CapabilityRegistry.getInstance();
  const resolution = registry.resolveOperations([
    'CREATE_SCHOOL_ADMIN',
    'CHANGE_SCHOOL_SETTINGS',
    'REORDER_CONTENTS',
    'UNKNOWN_CUSTOM_OP',
    'ADD_BOOKMARK'
  ]);
  assert.strictEqual(resolution.resolved.length, 4, '4 known capabilities resolved');
  assert.ok(resolution.unresolved.includes('UNKNOWN_CUSTOM_OP'), 'Detects unresolved custom operation');
  assert.ok(resolution.unsupported.some(u => u.includes('UNKNOWN_CUSTOM_OP')), 'Detects unsupported operation');
  assert.ok(resolution.unsupported.some(u => u.includes('ADD_BOOKMARK')), 'Detects non-validated capability as unsupported');
  console.log('  [PASS] Test 4: Capability registry safely flags unsupported operations.');

  // Test 5: Policy Engine Gates & Fail-Closed Enforcement
  console.log('--- Test 5: Policy Engine Approval Gates ---');
  const policy = PolicyEngine.createDefaultPolicy('SENSITIVE_WRITE');

  // Unapproved dry-run check
  const audit1 = PolicyEngine.verifyExecutionAllowed(policy, 'LOGICAL_DRY_RUN');
  assert.strictEqual(audit1.passed, false, 'Unapproved plan must fail Gate 1');

  // Approve Gate 1
  PolicyEngine.approveGate(policy, 'GATE_1_PLAN', 'OperatorA');
  const audit2 = PolicyEngine.verifyExecutionAllowed(policy, 'LOGICAL_DRY_RUN');
  assert.strictEqual(audit2.passed, true, 'Gate 1 approved allows Dry-run');

  // Full Production without Gate 2 & Gate 4
  const audit3 = PolicyEngine.verifyExecutionAllowed(policy, 'FULL_PRODUCTION');
  assert.strictEqual(audit3.passed, false, 'Full Production requires Gate 2 & Gate 4');
  console.log('  [PASS] Test 5: Policy engine enforces fail-closed gate policy.');

  // Test 6: Cost & Time Estimator
  console.log('--- Test 6: Estimator ---');
  const dummyPlan: any = {
    planId: 'plan_test_est',
    userInstruction: 'テスト管理者追加指示',
    sourceFiles: [],
    operations: [


      {
        operationId: 'op_1',
        operationType: 'CREATE_SCHOOL_ADMIN',
        riskClass: 'SENSITIVE_WRITE',
        estimatedDurationMs: 4000
      }
    ],
    riskLevel: 'SENSITIVE_WRITE'
  };
  const timeEst = Estimator.estimateTime(dummyPlan, targetSet);
  assert.ok(timeEst.totalEstimatedSeconds > 0, 'Total estimated seconds calculated');
  assert.ok(timeEst.displayFormatted.includes('～'), 'Confidence range displayed');
  const costEst = Estimator.estimateCost(dummyPlan, targetSet);
  assert.ok(costEst.estimatedCostJpy > 0, 'Estimated JPY cost calculated');
  console.log(`  [PASS] Test 6: Time (${timeEst.displayFormatted}) and Cost (¥${costEst.estimatedCostJpy}) estimated.`);


  console.log('=== [PLATFORM CORE TESTS COMPLETED: ALL PASS] ===\n');
}

runCoreTests().catch((e) => {
  console.error('Core test failed:', e);
  process.exit(1);
});
