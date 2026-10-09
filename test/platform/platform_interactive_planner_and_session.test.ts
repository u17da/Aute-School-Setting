import assert from 'assert';
import { TaskPlanner } from '../../src/platform/ai/taskPlanner';
import { TargetSet } from '../../src/platform/types/target';
import { Estimator } from '../../src/platform/ai/estimator';
import { PolicyEngine } from '../../src/platform/policy/policyEngine';
import { LocalSecretVault, DocumentIngestion } from '../../src/platform/ingestion/documentIngestion';
import { LlmClient } from '../../src/platform/ai/llmClient';
import { CapabilityRegistry } from '../../src/platform/capabilities/registry';

function createDummyTargetSet(count = 5): TargetSet {
  return {
    targetSetId: 'ts_test_interactive',
    name: 'TargetSet_Interactive_Test',
    createdAt: new Date().toISOString(),
    sourceFiles: [],
    schools: Array.from({ length: count }, (_, i) => ({
      schoolCode: `SCH00${i + 1}`,
      schoolName: `テスト学校${i + 1}`,
      userId: `admin0${i + 1}`,
      credentialRef: `cred_ref_SCH00${i + 1}`,
      enabled: true,
      sourceReference: 'test',
      validationStatus: 'READY'
    })),
    summary: { total: count, ready: count, missing: 0, ambiguous: 0 }
  };
}

async function runTests() {
  console.log('=== [INTERACTIVE PLANNER & RUNTIME INTEGRITY TESTS START] ===');

  const registry = CapabilityRegistry.getInstance();
  const origCaps = registry.list().map(c => ({ ...c }));
  for (const c of registry.list()) {
    registry.register({ ...c, productionValidated: true, testStatus: 'PRODUCTION_VALIDATED' });
  }

  // Test 1: Estimator 自然な日本語時間表示 (0m～0m バグ防止)
  console.log('--- Test 1: Estimator Natural Japanese Duration Display ---');
  const dummyPlan: any = {
    planId: 'plan_test_est',
    operations: [
      {
        capabilityId: 'cap_update_school_settings',
        operationType: 'UPDATE_SETTING',
        riskClass: 'REVERSIBLE_WRITE',
        estimatedDurationSec: 10,
        preconditions: [],
        verification: [],
        inputMapping: {}
      }
    ],
    riskLevel: 'REVERSIBLE_WRITE'
  };
  const targetSet = createDummyTargetSet(1);
  const timeEst = Estimator.estimateTime(dummyPlan, targetSet);
  console.log('  Calculated displayFormatted:', timeEst.displayFormatted);
  assert(timeEst.displayFormatted.includes('秒'), 'Must format seconds properly when < 60s');
  assert(!timeEst.displayFormatted.includes('0m'), 'Must not display 0m');
  console.log('  [PASS] Test 1: Estimator formats time in natural Japanese.');

  // Test 2: LocalSecretVault Credential Binding
  console.log('--- Test 2: LocalSecretVault Credential Ref Binding ---');
  LocalSecretVault.clear();
  const rawCsv = 'C2001001,堀川小学校,adminPass123\nC2001002,滝川小学校,pass456';
  const doc = DocumentIngestion.ingest({ filename: 'schools.csv', bufferOrText: rawCsv });
  assert.strictEqual(doc.tables.length, 1);
  const secret1 = LocalSecretVault.getSecret('cred_ref_C2001001');
  const secret2 = LocalSecretVault.getSecret('cred_ref_C2001002');
  assert.strictEqual(secret1, 'adminPass123', 'Password for C2001001 must match');
  assert.strictEqual(secret2, 'pass456', 'Password for C2001002 must match');
  console.log('  [PASS] Test 2: Secret vault bound credentials for school codes correctly.');

  // Test 3: Interactive Re-planning & PlanDiff Generation
  console.log('--- Test 3: Interactive Re-planning & PlanDiff ---');
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test_key_interactive';
  // Mock LLM Client responses for testing interactive flow
  const originalCall = LlmClient.callClaudeStructured;
  try {
    // Initial Plan Response
    LlmClient.callClaudeStructured = (async () => ({
      provider: 'mock_claude',
      model: 'claude-3-5-haiku-20241022',
      data: {
        status: 'READY',
        interpretedIntent: '児童生徒のパスワード変更を許可する',
        operations: [
          {
            operationType: 'UPDATE_SETTING',
            capabilityId: 'CHANGE_SCHOOL_SETTINGS',
            riskClass: 'REVERSIBLE_WRITE',
            inputMapping: { studentPasswordChange: 'SHOW' },
            preconditions: [],
            verification: [{ type: 'ASSERT_SETTING_EQUALS', description: 'パスワード変更が許可されていること' }]
          }
        ],
        targetScopeFilter: '全学校',
        assumptions: [],
        questions: [],
        humanSummary: {
          interpretedIntent: '児童生徒のパスワード変更を許可する',
          targetScope: '全学校',
          actionSummary: '設定変更',
          settingValueSummary: 'studentPasswordChange: SHOW',
          skipBehavior: '設定済みならスキップ',
          capabilityUsed: 'cap_update_school_settings',
          riskLevel: 'REVERSIBLE_WRITE'
        },
        validationScopeProposal: {
          unit: 'SCHOOL',
          count: 1,
          description: '初期検証のため1校で画面確認'
        }
      },
      usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700, latencyMs: 120 },
      isRealApiCall: false
    })) as any;

    const planResult1 = await TaskPlanner.generatePlanAsync({
      targetSet,
      userInstruction: 'パスワード変更をできるようにして'
    });
    assert.strictEqual(planResult1.plan.status, 'READY');
    assert.strictEqual(planResult1.plan.operations.length, 1);
    assert.strictEqual(planResult1.plan.validationScopeProposal?.unit, 'SCHOOL');
    assert.strictEqual(planResult1.plan.validationScopeProposal?.count, 1);
    console.log('  Initial plan generated:', planResult1.plan.planId);

    // Re-planning Response with modification
    LlmClient.callClaudeStructured = (async () => ({
      provider: 'mock_claude',
      model: 'claude-3-5-haiku-20241022',
      data: {
        status: 'READY',
        interpretedIntent: '児童生徒のパスワード変更を禁止する（修正指示を反映）',
        operations: [
          {
            operationType: 'UPDATE_SETTING',
            capabilityId: 'CHANGE_SCHOOL_SETTINGS',
            riskClass: 'REVERSIBLE_WRITE',
            inputMapping: { studentPasswordChange: 'HIDE' },
            preconditions: [],
            verification: [{ type: 'ASSERT_SETTING_EQUALS', description: 'パスワード変更が禁止されていること' }]
          }
        ],
        targetScopeFilter: '全学校',
        assumptions: [],
        questions: [],
        humanSummary: {
          interpretedIntent: '児童生徒のパスワード変更を禁止する（修正指示を反映）',
          targetScope: '全学校',
          actionSummary: '設定変更',
          settingValueSummary: 'studentPasswordChange: HIDE',
          skipBehavior: '設定済みならスキップ',
          capabilityUsed: 'cap_update_school_settings',
          riskLevel: 'REVERSIBLE_WRITE'
        },
        validationScopeProposal: {
          unit: 'SCHOOL',
          count: 1,
          description: '初期検証のため1校で画面確認'
        },
        planDiff: {
          added: ['studentPasswordChange: HIDE'],
          unchanged: [],
          removed: ['studentPasswordChange: SHOW'],
          summaryText: 'パスワード変更の許可設定を「許可」から「禁止」に変更しました。'
        }
      },
      usage: { inputTokens: 600, outputTokens: 250, totalTokens: 850, latencyMs: 130 },
      isRealApiCall: false
    })) as any;

    const planResult2 = await TaskPlanner.generatePlanAsync({
      targetSet,
      userInstruction: 'パスワード変更をできるようにして',
      previousPlan: planResult1.plan,
      refinementInstruction: 'やっぱり禁止（HIDE）にしてください'
    });

    assert.strictEqual(planResult2.plan.status, 'READY');
    assert.strictEqual(planResult2.plan.previousPlanId, planResult1.plan.planId);
    assert(planResult2.plan.planDiff, 'PlanDiff must be populated');
    assert.strictEqual(planResult2.plan.planDiff?.added.length, 1);
    assert(planResult2.plan.planDiff?.summaryText.includes('禁止'));
    console.log('  PlanDiff verified:', planResult2.plan.planDiff);
    console.log('  [PASS] Test 3: Interactive re-planning produced correct PlanDiff and previousPlanId binding.');
  } finally {
    LlmClient.callClaudeStructured = originalCall;
    if (prevKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = prevKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }

  // Test 4: Dynamic Validation Scope Policy Verification
  console.log('--- Test 4: Dynamic Validation Scope Evaluation ---');
  const proposalValid = {
    unit: 'SCHOOL' as const,
    count: 1,
    description: '先行検証'
  };
  const eval1 = PolicyEngine.evaluateValidationScopeProposal(proposalValid, 'REVERSIBLE_WRITE', 5);
  assert(eval1.approved, 'Proposal of 1 school out of 5 should be approved');

  const proposalExceeded = {
    unit: 'SCHOOL' as const,
    count: 10,
    description: '先行検証'
  };
  const eval2 = PolicyEngine.evaluateValidationScopeProposal(proposalExceeded, 'REVERSIBLE_WRITE', 5);
  assert(!eval2.approved, 'Proposal of 10 schools out of 5 must be rejected');
  console.log('  [PASS] Test 4: Dynamic Validation Scope Policy evaluates bounds strictly.');

  for (const c of origCaps) {
    registry.register(c);
  }

  console.log('=== [ALL INTERACTIVE PLANNER & RUNTIME INTEGRITY TESTS PASSED] ===');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
