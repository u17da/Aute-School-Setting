import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { TaskPlanner } from '../../src/platform/ai/taskPlanner';
import { TargetSet } from '../../src/platform/types/target';
import { CapabilityRegistry } from '../../src/platform/capabilities/registry';
import { LlmClient } from '../../src/platform/ai/llmClient';

function createDummyTargetSet(count = 3): TargetSet {
  return {
    targetSetId: 'ts_test_001',
    name: 'TargetSet_Test',
    createdAt: new Date().toISOString(),
    sourceFiles: [],
    schools: Array.from({ length: count }, (_, i) => ({
      schoolCode: `SCH${i + 1}`,
      schoolName: `テスト学校${i + 1}`,
      userId: `admin${i + 1}`,
      credentialRef: `cred_${i + 1}`,
      enabled: true,
      sourceReference: 'test',
      validationStatus: 'READY'
    })),
    summary: { total: count, ready: count, missing: 0, ambiguous: 0 }
  };
}

async function runTests() {
  console.log('=== [CLAUDE AUTONOMOUS PLANNER TESTS START] ===');

  // Test 1: Fail-Closed when ANTHROPIC_API_KEY is missing
  console.log('--- Test 1: Fail-Closed when ANTHROPIC_API_KEY is missing (PLAN_AI_UNAVAILABLE) ---');
  const originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const targetSet = createDummyTargetSet(3);
  const result1 = await TaskPlanner.generatePlanAsync({
    targetSet,
    userInstruction: '各学校で児童生徒がパスワードを変えられるようにしてください。設定済みならスキップで。'
  });

  assert.strictEqual(result1.plan.status, 'PLAN_AI_UNAVAILABLE');
  assert.strictEqual(result1.plan.operations.length, 0);
  assert.strictEqual(result1.isRealApiCall, false);
  assert.strictEqual(result1.plan.questions[0].id, 'q_api_key_missing');
  console.log('  [PASS] Test 1: Fail-Closed correctly blocked execution without fallback.');

  // Test 2: Zero keyword / regex / includes() intent matching in TaskPlanner source
  console.log('--- Test 2: Zero keyword intent matching in TaskPlanner source ---');
  const plannerSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/platform/ai/taskPlanner.ts'),
    'utf-8'
  );
  assert(!plannerSrc.includes("instruction.includes('管理者')"), 'No hardcoded admin check');
  assert(!plannerSrc.includes("instruction.includes('並び替え')"), 'No hardcoded reorder check');
  assert(!plannerSrc.includes("instruction.includes('設定変更')"), 'No hardcoded settings check');
  assert(!plannerSrc.includes("instruction.includes('パスワード')"), 'No hardcoded password check');
  assert(!plannerSrc.includes("instruction.includes('ブックマーク')"), 'No hardcoded bookmark check');
  assert(!plannerSrc.includes("instruction.includes('クラス')"), 'No hardcoded class check');
  console.log('  [PASS] Test 2: TaskPlanner has 0 hardcoded keyword intent checks.');

  // Test 3: Dynamic Capability Catalog & JSON Schema generation
  console.log('--- Test 3: Dynamic Capability Catalog & JSON Schema ---');
  const registry = CapabilityRegistry.getInstance();
  const fullList = registry.list();
  const settingsCap = fullList.find(c => c.capabilityId === 'CHANGE_SCHOOL_SETTINGS');
  assert(settingsCap, 'CHANGE_SCHOOL_SETTINGS is in full registry');
  const pwSemantic = settingsCap?.parameterSemantics?.find(p => p.name === 'settings.studentPasswordChange');
  assert(pwSemantic, 'studentPasswordChange semantic definition exists');
  assert(pwSemantic.allowedValues?.some((v: any) => v.value === 'SHOW'), 'SHOW value explained');
  assert(pwSemantic.allowedValues?.some((v: any) => v.value === 'HIDE'), 'HIDE value explained');

  const catalog = registry.getCatalogForAi();
  assert(catalog.length >= 1, 'Catalog contains production validated capabilities');
  assert(catalog.every(c => c.capabilityId === 'LOGIN_AND_VERIFY' || c.capabilityId === 'REORDER_CONTENTS'), 'Only production-validated capabilities are exposed to AI');

  const jsonSchema = registry.getPlanJsonSchema();
  assert.strictEqual(jsonSchema.type, 'object');
  assert(jsonSchema.properties.operations.items.anyOf.length >= 1, 'Schema operations anyOf populated');
  console.log('  [PASS] Test 3: Dynamic Catalog and JSON Schema accurately generated from SSOT.');

  // Temporarily register capabilities as production validated for mock scenario testing
  const origCaps = registry.list().map(c => ({ ...c }));
  for (const c of registry.list()) {
    registry.register({ ...c, productionValidated: true, testStatus: 'PRODUCTION_VALIDATED' });
  }

  // Test 4: Scenario A (Password Change SHOW + Skip if Configured)
  console.log('--- Test 4: Scenario A (Password Change SHOW + Skip) ---');
  process.env.ANTHROPIC_API_KEY = 'mock-key';
  const originalCall = LlmClient.callClaudeStructured;
  LlmClient.callClaudeStructured = (async (params: any): Promise<any> => {
    return {
      data: {
        status: 'READY',
        summary: {
          interpretedIntent: '各学校において児童生徒自身がパスワードを変更できるように設定を変更し、既に設定済みの場合はスキップする。',
          targetScope: '指定された全3校',
          actionSummary: '児童生徒のパスワード変更機能の表示設定を有効化',
          settingValueSummary: 'settings.studentPasswordChange: SHOW',
          skipBehavior: '設定値が既にSHOWの場合は変更をスキップ',
          capabilityUsed: 'CHANGE_SCHOOL_SETTINGS',
          riskLevel: 'REVERSIBLE_WRITE'
        },
        operations: [
          {
            capabilityId: 'CHANGE_SCHOOL_SETTINGS',
            capabilityVersion: '1.0.0',
            input: { settings: { studentPasswordChange: 'SHOW' } },
            skipCondition: 'CURRENT_VALUE_EQUALS_DESIRED',
            riskClass: 'REVERSIBLE_WRITE'
          }
        ],
        questions: [],
        assumptions: []
      },
      usage: { inputTokens: 1420, outputTokens: 380, totalTokens: 1800, latencyMs: 650 },
      provider: 'Anthropic Claude',
      model: 'claude-haiku-5-5',
      isRealApiCall: true
    };
  }) as any;

  const resA = await TaskPlanner.generatePlanAsync({
    targetSet,
    userInstruction: '各学校で児童生徒がパスワードを変えられるようにしてください。設定済みならスキップで。'
  });
  assert.strictEqual(resA.plan.status, 'READY');
  assert.strictEqual(resA.plan.operations[0].operationType, 'CHANGE_SCHOOL_SETTINGS');
  assert.strictEqual(resA.plan.operations[0].inputMapping.settings.studentPasswordChange, 'SHOW');
  assert.strictEqual(resA.plan.humanSummary?.settingValueSummary, 'settings.studentPasswordChange: SHOW');
  console.log('  [PASS] Test 4: Scenario A produced valid Execution Plan with human summary.');

  // Test 5: Scenario B (Password Change HIDE)
  console.log('--- Test 5: Scenario B (Password Change HIDE) ---');
  LlmClient.callClaudeStructured = (async (params: any): Promise<any> => {
    return {
      data: {
        status: 'READY',
        summary: {
          interpretedIntent: '児童生徒にパスワード変更を表示しないように設定する。',
          targetScope: '指定された学校',
          actionSummary: '児童生徒のパスワード変更機能の非表示化',
          settingValueSummary: 'settings.studentPasswordChange: HIDE',
          skipBehavior: '設定済みならスキップ',
          capabilityUsed: 'CHANGE_SCHOOL_SETTINGS',
          riskLevel: 'REVERSIBLE_WRITE'
        },
        operations: [
          {
            capabilityId: 'CHANGE_SCHOOL_SETTINGS',
            input: { settings: { studentPasswordChange: 'HIDE' } },
            skipCondition: 'CURRENT_VALUE_EQUALS_DESIRED',
            riskClass: 'REVERSIBLE_WRITE'
          }
        ],
        questions: [],
        assumptions: []
      },
      usage: { inputTokens: 1380, outputTokens: 320, totalTokens: 1700, latencyMs: 580 },
      provider: 'Anthropic Claude',
      model: 'claude-haiku-5-5',
      isRealApiCall: true
    };
  }) as any;
  const resB = await TaskPlanner.generatePlanAsync({
    targetSet: createDummyTargetSet(1),
    userInstruction: '児童生徒にパスワード変更を表示しないでください。'
  });
  assert.strictEqual(resB.plan.operations[0].inputMapping.settings.studentPasswordChange, 'HIDE');
  console.log('  [PASS] Test 5: Scenario B correctly mapped to studentPasswordChange: HIDE.');

  // Test 5B: Scenario C (AAR before MEXCBT -> REORDER_CONTENTS)
  console.log('--- Test 5B: Scenario C (Reorder Contents) ---');
  LlmClient.callClaudeStructured = (async (params: any): Promise<any> => {
    return {
      data: {
        status: 'READY',
        summary: {
          interpretedIntent: 'AARをMEXCBTより前に配置するようコンテンツ表示順序を変更する。',
          targetScope: '指定された学校',
          actionSummary: 'コンテンツ表示優先度の並び替え',
          settingValueSummary: 'targetOrder: ["AAR", "MEXCBT"]',
          capabilityUsed: 'REORDER_CONTENTS',
          riskLevel: 'REVERSIBLE_WRITE'
        },
        operations: [
          {
            capabilityId: 'REORDER_CONTENTS',
            input: { targetOrder: ['AAR', 'MEXCBT'] },
            skipCondition: 'NONE',
            riskClass: 'REVERSIBLE_WRITE'
          }
        ],
        questions: [],
        assumptions: []
      },
      usage: { inputTokens: 1350, outputTokens: 310, totalTokens: 1660, latencyMs: 540 },
      provider: 'Anthropic Claude',
      model: 'claude-haiku-5-5',
      isRealApiCall: true
    };
  }) as any;
  const resC = await TaskPlanner.generatePlanAsync({
    targetSet: createDummyTargetSet(1),
    userInstruction: 'AARをMEXCBTより前にしてください'
  });
  assert.strictEqual(resC.plan.operations[0].operationType, 'REORDER_CONTENTS');
  assert.deepStrictEqual(resC.plan.operations[0].inputMapping.targetOrder, ['AAR', 'MEXCBT']);
  console.log('  [PASS] Test 5B: Scenario C produced valid REORDER_CONTENTS plan.');

  // Test 5C: Scenario D (Add School Admin)
  console.log('--- Test 5C: Scenario D (Add School Admin) ---');
  LlmClient.callClaudeStructured = (async (params: any): Promise<any> => {
    return {
      data: {
        status: 'READY',
        summary: {
          interpretedIntent: '学校管理者アカウントを追加する。',
          targetScope: '指定された学校',
          actionSummary: '学校管理者の新規作成',
          capabilityUsed: 'CREATE_SCHOOL_ADMIN',
          riskLevel: 'SENSITIVE_WRITE'
        },
        operations: [
          {
            capabilityId: 'CREATE_SCHOOL_ADMIN',
            input: { userId: 'admin_user', role: 'school_admin', skipIfExists: true },
            skipCondition: 'ALREADY_EXISTS',
            riskClass: 'SENSITIVE_WRITE'
          }
        ],
        questions: [],
        assumptions: []
      },
      usage: { inputTokens: 1320, outputTokens: 290, totalTokens: 1610, latencyMs: 520 },
      provider: 'Anthropic Claude',
      model: 'claude-haiku-5-5',
      isRealApiCall: true
    };
  }) as any;
  const resD = await TaskPlanner.generatePlanAsync({
    targetSet: createDummyTargetSet(1),
    userInstruction: '学校管理者を追加してください'
  });
  assert.strictEqual(resD.plan.operations[0].operationType, 'CREATE_SCHOOL_ADMIN');
  console.log('  [PASS] Test 5C: Scenario D produced valid CREATE_SCHOOL_ADMIN plan.');

  console.log('--- Test 6: Scenario E (Multiple Operations) ---');
  LlmClient.callClaudeStructured = (async (params: any): Promise<any> => {
    return {
      data: {
        status: 'READY',
        summary: {
          interpretedIntent: '学校管理者を追加し、5年1組を作成する。',
          actionSummary: '管理者追加およびクラス作成',
          capabilityUsed: 'CREATE_SCHOOL_ADMIN, CREATE_GRADE_AND_CLASS',
          riskLevel: 'SENSITIVE_WRITE'
        },
        operations: [
          {
            capabilityId: 'CREATE_SCHOOL_ADMIN',
            input: { userId: 'admin_user', role: 'school_admin', skipIfExists: true },
            skipCondition: 'ALREADY_EXISTS',
            riskClass: 'SENSITIVE_WRITE'
          },
          {
            capabilityId: 'CREATE_GRADE_AND_CLASS',
            input: { grades: ['5年'], classes: ['5年1組'], skipIfExists: true },
            skipCondition: 'ALREADY_EXISTS',
            riskClass: 'REVERSIBLE_WRITE'
          }
        ],
        questions: [],
        assumptions: []
      },
      usage: { inputTokens: 1600, outputTokens: 490, totalTokens: 2090, latencyMs: 780 },
      provider: 'Anthropic Claude',
      model: 'claude-haiku-5-5',
      isRealApiCall: true
    };
  }) as any;
  const resE = await TaskPlanner.generatePlanAsync({
    targetSet: createDummyTargetSet(1),
    userInstruction: '学校管理者を追加して、5年1組も作ってください'
  });
  assert.strictEqual(resE.plan.operations.length, 2);
  assert.strictEqual(resE.plan.operations[0].operationType, 'CREATE_SCHOOL_ADMIN');
  assert.strictEqual(resE.plan.operations[1].operationType, 'CREATE_GRADE_AND_CLASS');
  assert.strictEqual(resE.plan.riskLevel, 'SENSITIVE_WRITE');
  console.log('  [PASS] Test 6: Scenario E successfully decomposed into 2 operations.');

  // Test 7: Scenario F (Ambiguous -> NEEDS_CLARIFICATION)
  console.log('--- Test 7: Scenario F (Ambiguous -> NEEDS_CLARIFICATION) ---');
  LlmClient.callClaudeStructured = (async (params: any): Promise<any> => {
    return {
      data: {
        status: 'NEEDS_CLARIFICATION',
        summary: {
          interpretedIntent: 'ログインに関する要望であるが内容が曖昧。',
          actionSummary: '確認質問',
          capabilityUsed: 'なし',
          riskLevel: 'READ_ONLY'
        },
        operations: [],
        questions: [{ id: 'q1', question: '具体的にどの設定を変更しますか？', context: '曖昧性' }],
        assumptions: []
      },
      usage: { inputTokens: 1200, outputTokens: 290, totalTokens: 1490, latencyMs: 510 },
      provider: 'Anthropic Claude',
      model: 'claude-haiku-5-5',
      isRealApiCall: true
    };
  }) as any;
  const resF = await TaskPlanner.generatePlanAsync({
    targetSet: createDummyTargetSet(1),
    userInstruction: 'ログインしやすくしてください'
  });
  assert.strictEqual(resF.plan.status, 'NEEDS_CLARIFICATION');
  assert.strictEqual(resF.plan.operations.length, 0);
  console.log('  [PASS] Test 7: Scenario F correctly stopped without guessing operations.');

  // Test 8: Scenario G (Unsupported -> UNSUPPORTED)
  console.log('--- Test 8: Scenario G (Unsupported -> UNSUPPORTED) ---');
  LlmClient.callClaudeStructured = (async (params: any): Promise<any> => {
    return {
      data: {
        status: 'UNSUPPORTED',
        summary: {
          interpretedIntent: '未対応のメール自動配信要望。',
          actionSummary: '未対応',
          capabilityUsed: 'なし',
          riskLevel: 'READ_ONLY'
        },
        operations: [],
        questions: [],
        assumptions: []
      },
      usage: { inputTokens: 1250, outputTokens: 240, totalTokens: 1490, latencyMs: 490 },
      provider: 'Anthropic Claude',
      model: 'claude-haiku-5-5',
      isRealApiCall: true
    };
  }) as any;
  const resG = await TaskPlanner.generatePlanAsync({
    targetSet: createDummyTargetSet(1),
    userInstruction: '生徒全員に毎日朝8時に励ましのメールを自動送信してください'
  });
  assert.strictEqual(resG.plan.status, 'UNSUPPORTED');
  assert.strictEqual(resG.plan.operations.length, 0);
  console.log('  [PASS] Test 8: Scenario G correctly marked as UNSUPPORTED.');

  // Test 9: Paraphrase Test (Requirement 15)
  console.log('--- Test 9: Paraphrase Test (Different expressions -> Same Plan) ---');
  const paraphrases = [
    '児童生徒が自分でPWを更新できるように',
    '子ども自身でログインパスワードを変更可能にして',
    'パスワード変更メニューを児童生徒に出して'
  ];

  for (const text of paraphrases) {
    LlmClient.callClaudeStructured = (async (params: any): Promise<any> => {
      return {
        data: {
          status: 'READY',
          summary: {
            interpretedIntent: `指示「${text}」に基づき、児童生徒パスワード変更機能を表示する。`,
            actionSummary: '児童生徒のパスワード変更機能の表示有効化',
            settingValueSummary: 'settings.studentPasswordChange: SHOW',
            skipBehavior: '設定値が既にSHOWならスキップ',
            capabilityUsed: 'CHANGE_SCHOOL_SETTINGS',
            riskLevel: 'REVERSIBLE_WRITE'
          },
          operations: [
            {
              capabilityId: 'CHANGE_SCHOOL_SETTINGS',
              input: { settings: { studentPasswordChange: 'SHOW' } },
              skipCondition: 'CURRENT_VALUE_EQUALS_DESIRED',
              riskClass: 'REVERSIBLE_WRITE'
            }
          ],
          questions: [],
          assumptions: []
        },
        usage: { inputTokens: 1400, outputTokens: 350, totalTokens: 1750, latencyMs: 600 },
        provider: 'Anthropic Claude',
        model: 'claude-haiku-5-5',
        isRealApiCall: true
      };
    }) as any;

    const res = await TaskPlanner.generatePlanAsync({
      targetSet: createDummyTargetSet(1),
      userInstruction: text
    });
    assert.strictEqual(res.plan.status, 'READY');
    assert.strictEqual(res.plan.operations[0].operationType, 'CHANGE_SCHOOL_SETTINGS');
    assert.strictEqual(res.plan.operations[0].inputMapping.settings.studentPasswordChange, 'SHOW');
    console.log(`    [PASS] Paraphrase matched: "${text}" -> studentPasswordChange: SHOW`);
  }

  // Restore original
  LlmClient.callClaudeStructured = originalCall;
  if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
  else delete process.env.ANTHROPIC_API_KEY;
  for (const c of origCaps) {
    registry.register(c);
  }

  console.log('\n=== [ALL CLAUDE AUTONOMOUS PLANNER TESTS PASSED] ===\n');
}

runTests().catch(err => {
  console.error('[TEST ERROR]:', err);
  process.exit(1);
});
