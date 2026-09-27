import assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { ConsoleServer } from '../src/console/server';
import { BatchProcessAdapter } from '../src/console/adapter';
import { BatchSummaryReport } from '../src/types/batch';
import { normalizeExecutionResult, categorizeCheckpointStatus, extractExecutionChangeDetails } from '../src/console/resultsNormalizer';
import { getReportsDir } from '../src/runtime/paths';

function httpRequest(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method || 'GET',
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...options.headers
        }
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {}
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: parsed
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function createMockSummary(overrides: Partial<BatchSummaryReport> = {}): BatchSummaryReport {
  return {
    deploymentId: 'dep-mock',
    runId: 'run-mock',
    mode: 'PRODUCTION_WRITE',
    profileHash: 'hash-p',
    schoolsHash: 'hash-s',
    toolVersion: '1.0.0',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    totalSchools: 1,
    processedSchools: 1,
    skippedSchools: 0,
    readSuccess: 1,
    readFailed: 0,
    loginSuccess: 1,
    loginFailed: 0,
    schoolMismatch: 0,
    uiStructureMismatch: 0,
    planExecutable: 1,
    planBlocked: 0,
    alreadyConfigured: 0,
    requiresChange: 1,
    destructiveChangeSchools: 0,
    destructiveChangeActions: 0,
    writeEligibleNonDestructive: 1,
    writeBlockedDestructive: 0,
    configConflict: 0,
    dependencyUnsatisfied: 0,
    otherErrors: 0,
    actionsDistribution: { zero: 0, one: 1, two: 0, threePlus: 0 },
    destructiveChangeDetails: [],
    currentStateDistribution: {},
    plannedChangeDistribution: {},
    schoolResults: [],
    ...overrides
  };
}

async function runTestSuite() {
  console.log('=== Phase 6A: Execution Result Contract & Normalizer Tests ===\n');

  let passed = 0;
  let failed = 0;

  const test = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`[FAIL] ${name}:`, err.message || err);
      failed++;
    }
  };

  // -------------------------------------------------------------------------
  // 要件 21: Status Matrix Unit Tests
  // -------------------------------------------------------------------------

  await test('Normalizer Test A: SUCCESS + before != after -> APPLIED & changes generated', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-a',
      runId: 'run-test-a',
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'SUCCESS',
          actionsCount: 1,
          before: { otherSchoolLog: 'DENY' },
          after: { otherSchoolLog: 'ALLOW' }
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.appliedSuccessCount, 1);
    assert.strictEqual(vm.schools.length, 1);
    assert.strictEqual(vm.schools[0].category, 'APPLIED');
    assert.strictEqual(vm.schools[0].changes.length, 1);
    assert.strictEqual(vm.schools[0].changes[0].settingKey, 'otherSchoolLog');
    assert.strictEqual(vm.schools[0].changes[0].settingLabel, '他校のログ表示を許可');
    assert.strictEqual(vm.schools[0].changes[0].before, 'DENY');
    assert.strictEqual(vm.schools[0].changes[0].after, 'ALLOW');
    assert.strictEqual(vm.schools[0].changes[0].beforeLabel, 'しない');
    assert.strictEqual(vm.schools[0].changes[0].afterLabel, 'する');
    assert.strictEqual(vm.attentionRequiredCount, 0);
    assert.strictEqual(vm.schools[0].requiresHumanReview, false);
  });

  await test('Normalizer Test B: SUCCESS_RECOVERED -> APPLIED & recovery message', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-b',
      runId: 'run-test-b',
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'SUCCESS_RECOVERED',
          actionsCount: 1,
          before: { otherSchoolLog: 'DENY' },
          after: { otherSchoolLog: 'ALLOW' }
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.appliedSuccessCount, 1);
    assert.strictEqual(vm.schools[0].category, 'APPLIED');
    assert.strictEqual(vm.schools[0].status, 'SUCCESS_RECOVERED');
    assert.ok(vm.schools[0].message.includes('リカバリ'));
    assert.strictEqual(vm.attentionRequiredCount, 0);
  });

  await test('Normalizer Test C: SUCCESS_ALREADY_CONFIGURED -> ALREADY_CONFIGURED & changes = []', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-c',
      runId: 'run-test-c',
      actionsDistribution: { zero: 1, one: 0, two: 0, threePlus: 0 },
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'SUCCESS_ALREADY_CONFIGURED',
          actionsCount: 0,
          before: { otherSchoolLog: 'ALLOW' },
          after: { otherSchoolLog: 'ALLOW' }
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.appliedSuccessCount, 0);
    assert.strictEqual(vm.alreadyConfiguredCount, 1);
    assert.strictEqual(vm.schools[0].category, 'ALREADY_CONFIGURED');
    assert.strictEqual(vm.schools[0].changes.length, 0);
    assert.ok(vm.schools[0].message.includes('設定変更不要'));
  });

  await test('Normalizer Test D: SKIPPED_DESTRUCTIVE -> SKIPPED', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-d',
      runId: 'run-test-d',
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'SKIPPED_DESTRUCTIVE',
          actionsCount: 0
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.skippedDestructiveCount, 1);
    assert.strictEqual(vm.schools[0].category, 'SKIPPED');
    assert.ok(vm.schools[0].message.includes('破壊的変更を伴うため'));
  });

  await test('Normalizer Test E: PLAN_BLOCKED -> BLOCKED & failure', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-e',
      runId: 'run-test-e',
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'PLAN_BLOCKED',
          error: '依存関係チェック失敗',
          actionsCount: 0
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.blockedCount, 1);
    assert.strictEqual(vm.schools[0].category, 'BLOCKED');
    assert.strictEqual(vm.schools[0].errorMessage, '依存関係チェック失敗');
    assert.strictEqual(vm.attentionRequiredCount, 0);
  });

  await test('Normalizer Test F: PREFLIGHT_STATE_CHANGED -> BLOCKED & conflict message', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-f',
      runId: 'run-test-f',
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'PREFLIGHT_STATE_CHANGED',
          error: '事前検証時の設定状態から変更を検知しました',
          actionsCount: 0
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.blockedCount, 1);
    assert.strictEqual(vm.schools[0].category, 'BLOCKED');
    assert.ok(vm.schools[0].message.includes('事前検証時の設定状態から変更'));
    assert.strictEqual(vm.attentionRequiredCount, 0);
  });

  await test('Normalizer Test G: SAVE_FAILED_KNOWN -> FAILED_KNOWN', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-g',
      runId: 'run-test-g',
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'SAVE_FAILED_KNOWN',
          error: 'HTTP 500 Internal Error on Save',
          actionsCount: 0
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.failedKnownCount, 1);
    assert.strictEqual(vm.schools[0].category, 'FAILED_KNOWN');
    assert.strictEqual(vm.schools[0].errorMessage, 'HTTP 500 Internal Error on Save');
    assert.strictEqual(vm.attentionRequiredCount, 0);
  });

  await test('Normalizer Test H: SAVE_OUTCOME_UNKNOWN -> OUTCOME_UNKNOWN & requiresHumanReview = true', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-h',
      runId: 'run-test-h',
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'SAVE_OUTCOME_UNKNOWN',
          error: 'Socket timeout waiting for response',
          actionsCount: 1
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.outcomeUnknownCount, 1);
    assert.strictEqual(vm.appliedSuccessCount, 0);
    assert.strictEqual(vm.schools[0].category, 'OUTCOME_UNKNOWN');
    assert.strictEqual(vm.schools[0].requiresHumanReview, true);
    assert.strictEqual(vm.attentionRequiredCount, 1);
    assert.ok(vm.schools[0].message.includes('手動確認が必要です'));
  });

  await test('Normalizer Test I: Invariant Check - Category Counts == Total Schools', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-i',
      runId: 'run-test-i',
      totalSchools: 7,
      processedSchools: 7,
      schoolResults: [
        { schoolCode: 'S1', schoolName: '校1', status: 'SUCCESS', actionsCount: 1, before: { otherSchoolLog: 'DENY' }, after: { otherSchoolLog: 'ALLOW' } },
        { schoolCode: 'S2', schoolName: '校2', status: 'SUCCESS_RECOVERED', actionsCount: 1, before: { otherSchoolLog: 'DENY' }, after: { otherSchoolLog: 'ALLOW' } },
        { schoolCode: 'S3', schoolName: '校3', status: 'SUCCESS_ALREADY_CONFIGURED', actionsCount: 0 },
        { schoolCode: 'S4', schoolName: '校4', status: 'SKIPPED_DESTRUCTIVE', actionsCount: 0 },
        { schoolCode: 'S5', schoolName: '校5', status: 'PLAN_BLOCKED', actionsCount: 0 },
        { schoolCode: 'S6', schoolName: '校6', status: 'SAVE_FAILED_KNOWN', actionsCount: 0 },
        { schoolCode: 'S7', schoolName: '校7', status: 'SAVE_OUTCOME_UNKNOWN', actionsCount: 0 }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.totalCount, 7);
    assert.strictEqual(vm.appliedSuccessCount, 2);
    assert.strictEqual(vm.alreadyConfiguredCount, 1);
    assert.strictEqual(vm.skippedDestructiveCount, 1);
    assert.strictEqual(vm.blockedCount, 1);
    assert.strictEqual(vm.failedKnownCount, 1);
    assert.strictEqual(vm.outcomeUnknownCount, 1);

    const sum =
      vm.appliedSuccessCount +
      vm.alreadyConfiguredCount +
      vm.skippedDestructiveCount +
      vm.blockedCount +
      vm.failedKnownCount +
      vm.outcomeUnknownCount +
      vm.interruptedCount +
      vm.notProcessedCount +
      vm.inconsistentCount;
    assert.strictEqual(sum, vm.totalCount);
  });

  await test('Normalizer Test J: Invariant Failure - status SUCCESS but actionsCount > 0 and before == after -> RESULT_INCONSISTENT', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-j',
      runId: 'run-test-j',
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'SUCCESS',
          actionsCount: 1,
          before: { otherSchoolLog: 'ALLOW' },
          after: { otherSchoolLog: 'ALLOW' } // 変更がないのに actionsCount = 1
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.schools[0].category, 'RESULT_INCONSISTENT');
    assert.strictEqual(vm.schools[0].requiresHumanReview, true);
    assert.strictEqual(vm.appliedSuccessCount, 0, '不整合なSUCCESSは成功に数えない');
    assert.strictEqual(vm.inconsistentCount, 1);
    assert.strictEqual(vm.attentionRequiredCount, 1);
    assert.ok(vm.schools[0].message.includes('差分(changes)が0件'));
  });

  await test('Normalizer Test K: Pure Function verification (no state mutation on input summary)', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-k',
      runId: 'run-test-k',
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'SUCCESS',
          actionsCount: 1,
          before: { otherSchoolLog: 'DENY' },
          after: { otherSchoolLog: 'ALLOW' }
        }
      ]
    });

    const originalJson = JSON.stringify(summary);
    const vm1 = normalizeExecutionResult(summary);
    const vm2 = normalizeExecutionResult(summary);

    assert.strictEqual(JSON.stringify(summary), originalJson, 'Input summary must remain completely unmodified');
    assert.deepStrictEqual(vm1, vm2, 'Pure function must return identical outputs for identical inputs');
  });

  // -------------------------------------------------------------------------
  // 要件 16: 追加 Normalizer Tests (L - T)
  // -------------------------------------------------------------------------

  await test('Normalizer Test L: PENDING -> NOT_PROCESSED', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-l',
      runId: 'run-test-l',
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'PENDING',
          actionsCount: 0
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.notProcessedCount, 1);
    assert.strictEqual(vm.processedCount, 0);
    assert.strictEqual(vm.schools[0].category, 'NOT_PROCESSED');
    assert.strictEqual(vm.schools[0].requiresHumanReview, false);
    assert.ok(vm.schools[0].message.includes('未処理'));
  });

  await test('Normalizer Test M: RUNNING in final result -> RESULT_INCONSISTENT', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-m',
      runId: 'run-test-m',
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'RUNNING',
          actionsCount: 0
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.inconsistentCount, 1);
    assert.strictEqual(vm.schools[0].category, 'RESULT_INCONSISTENT');
    assert.strictEqual(vm.schools[0].requiresHumanReview, true);
    assert.strictEqual(vm.attentionRequiredCount, 1);
    assert.ok(vm.schools[0].message.includes('RUNNING状態が残存'));
  });

  await test('Normalizer Test N: SAVE_OUTCOME_UNKNOWN + 2 PENDING -> Invariant valid', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-n',
      runId: 'run-test-n',
      totalSchools: 3,
      processedSchools: 1,
      schoolResults: [
        { schoolCode: 'S1', schoolName: '校1', status: 'SAVE_OUTCOME_UNKNOWN', actionsCount: 1 },
        { schoolCode: 'S2', schoolName: '校2', status: 'PENDING', actionsCount: 0 },
        { schoolCode: 'S3', schoolName: '校3', status: 'PENDING', actionsCount: 0 }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.totalCount, 3);
    assert.strictEqual(vm.processedCount, 1);
    assert.strictEqual(vm.outcomeUnknownCount, 1);
    assert.strictEqual(vm.notProcessedCount, 2);
    assert.strictEqual(vm.attentionRequiredCount, 1);
    assert.strictEqual(vm.schools[0].category, 'OUTCOME_UNKNOWN');
    assert.strictEqual(vm.schools[0].requiresHumanReview, true);
    assert.strictEqual(vm.schools[1].category, 'NOT_PROCESSED');
    assert.strictEqual(vm.schools[2].category, 'NOT_PROCESSED');
  });

  await test('Normalizer Test O: SUCCESS + INTERRUPTED + PENDING -> Invariant valid', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-o',
      runId: 'run-test-o',
      totalSchools: 3,
      processedSchools: 2,
      schoolResults: [
        { schoolCode: 'S1', schoolName: '校1', status: 'SUCCESS', actionsCount: 1, before: { otherSchoolLog: 'DENY' }, after: { otherSchoolLog: 'ALLOW' } },
        { schoolCode: 'S2', schoolName: '校2', status: 'INTERRUPTED', actionsCount: 0 },
        { schoolCode: 'S3', schoolName: '校3', status: 'PENDING', actionsCount: 0 }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.totalCount, 3);
    assert.strictEqual(vm.appliedSuccessCount, 1);
    assert.strictEqual(vm.interruptedCount, 1);
    assert.strictEqual(vm.notProcessedCount, 1);
    assert.strictEqual(vm.attentionRequiredCount, 1);
    assert.strictEqual(vm.schools[0].category, 'APPLIED');
    assert.strictEqual(vm.schools[1].category, 'INTERRUPTED');
    assert.strictEqual(vm.schools[2].category, 'NOT_PROCESSED');
  });

  await test('Normalizer Test P: SUCCESS actionsCount>0 before==after -> RESULT_INCONSISTENT and excluded from appliedSuccessCount', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-p',
      runId: 'run-test-p',
      totalSchools: 1,
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'SUCCESS',
          actionsCount: 2,
          before: { otherSchoolLog: 'ALLOW' },
          after: { otherSchoolLog: 'ALLOW' }
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.appliedSuccessCount, 0, 'Must NOT be counted in appliedSuccessCount');
    assert.strictEqual(vm.inconsistentCount, 1);
    assert.strictEqual(vm.schools[0].category, 'RESULT_INCONSISTENT');
    assert.strictEqual(vm.schools[0].requiresHumanReview, true);
  });

  await test('Normalizer Test Q: SUCCESS actionsCount=0 changes>0 -> RESULT_INCONSISTENT', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-q',
      runId: 'run-test-q',
      totalSchools: 1,
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'SUCCESS',
          actionsCount: 0,
          before: { otherSchoolLog: 'DENY' },
          after: { otherSchoolLog: 'ALLOW' }
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.appliedSuccessCount, 0);
    assert.strictEqual(vm.inconsistentCount, 1);
    assert.strictEqual(vm.schools[0].category, 'RESULT_INCONSISTENT');
    assert.strictEqual(vm.schools[0].requiresHumanReview, true);
  });

  await test('Normalizer Test R: SUCCESS_ALREADY_CONFIGURED + changes>0 -> RESULT_INCONSISTENT', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-r',
      runId: 'run-test-r',
      totalSchools: 1,
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'SUCCESS_ALREADY_CONFIGURED',
          actionsCount: 0,
          before: { otherSchoolLog: 'DENY' },
          after: { otherSchoolLog: 'ALLOW' } // 差分があるのにALREADY_CONFIGURED
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.alreadyConfiguredCount, 0);
    assert.strictEqual(vm.inconsistentCount, 1);
    assert.strictEqual(vm.schools[0].category, 'RESULT_INCONSISTENT');
    assert.strictEqual(vm.schools[0].requiresHumanReview, true);
  });

  await test('Normalizer Test S: SKIPPED_DESTRUCTIVE + actual change -> RESULT_INCONSISTENT', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-s',
      runId: 'run-test-s',
      totalSchools: 1,
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: '学校1',
          status: 'SKIPPED_DESTRUCTIVE',
          actionsCount: 0,
          before: { otherSchoolLog: 'DENY' },
          after: { otherSchoolLog: 'ALLOW' } // スキップのはずなのに差分
        }
      ]
    });

    const vm = normalizeExecutionResult(summary);
    assert.strictEqual(vm.skippedDestructiveCount, 0);
    assert.strictEqual(vm.inconsistentCount, 1);
    assert.strictEqual(vm.schools[0].category, 'RESULT_INCONSISTENT');
    assert.strictEqual(vm.schools[0].requiresHumanReview, true);
  });

  await test('Normalizer Test T: attentionRequiredCount === count of requiresHumanReview=true schools (SSOT)', () => {
    const summary = createMockSummary({
      deploymentId: 'dep-test-t',
      runId: 'run-test-t',
      totalSchools: 5,
      schoolResults: [
        { schoolCode: 'S1', schoolName: '校1', status: 'SUCCESS', actionsCount: 1, before: { otherSchoolLog: 'DENY' }, after: { otherSchoolLog: 'ALLOW' } }, // review: false
        { schoolCode: 'S2', schoolName: '校2', status: 'SAVE_OUTCOME_UNKNOWN', actionsCount: 1 }, // review: true
        { schoolCode: 'S3', schoolName: '校3', status: 'INTERRUPTED', actionsCount: 0 }, // review: true
        { schoolCode: 'S4', schoolName: '校4', status: 'RUNNING', actionsCount: 0 }, // review: true
        { schoolCode: 'S5', schoolName: '校5', status: 'PENDING', actionsCount: 0 } // review: false
      ]
    });

    const vm = normalizeExecutionResult(summary);
    const reviewCount = vm.schools.filter((s) => s.requiresHumanReview).length;
    assert.strictEqual(vm.attentionRequiredCount, reviewCount);
    assert.strictEqual(vm.attentionRequiredCount, 3);
  });

  // -------------------------------------------------------------------------
  // 要件 22: 実バグ再現（3校 DENY -> ALLOW）Regression Test
  // -------------------------------------------------------------------------

  await test('Regression Test: Real bug reproduction (3 schools otherSchoolLog DENY -> ALLOW)', () => {
    const realBugSummary = createMockSummary({
      deploymentId: 'dep-real-bug',
      runId: 'run-real-bug',
      totalSchools: 3,
      processedSchools: 3,
      actionsDistribution: { zero: 0, one: 3, two: 0, threePlus: 0 },
      schoolResults: [
        {
          schoolCode: '13101',
          schoolName: '千代田区立第一小学校',
          status: 'SUCCESS',
          actionsCount: 1,
          before: { otherSchoolLog: 'DENY' },
          after: { otherSchoolLog: 'ALLOW' }
        },
        {
          schoolCode: '13102',
          schoolName: '千代田区立第二小学校',
          status: 'SUCCESS',
          actionsCount: 1,
          before: { otherSchoolLog: 'DENY' },
          after: { otherSchoolLog: 'ALLOW' }
        },
        {
          schoolCode: '13103',
          schoolName: '千代田区立第三小学校',
          status: 'SUCCESS',
          actionsCount: 1,
          before: { otherSchoolLog: 'DENY' },
          after: { otherSchoolLog: 'ALLOW' }
        }
      ]
    });

    const vm = normalizeExecutionResult(realBugSummary);

    // 成功数が 0 ではなく 3 になること
    assert.strictEqual(vm.appliedSuccessCount, 3);
    assert.strictEqual(vm.alreadyConfiguredCount, 0);
    assert.strictEqual(vm.failedKnownCount, 0);
    assert.strictEqual(vm.notProcessedCount, 0);
    assert.strictEqual(vm.attentionRequiredCount, 0);

    // 変更なし ではなく 具体的な設定変更内容（他校ログ閲覧 DENY → ALLOW）が全校で抽出されること
    assert.strictEqual(vm.schools.length, 3);
    for (const school of vm.schools) {
      assert.strictEqual(school.category, 'APPLIED');
      assert.strictEqual(school.actionsCount, 1);
      assert.strictEqual(school.changes.length, 1);
      assert.strictEqual(school.changes[0].settingKey, 'otherSchoolLog');
      assert.strictEqual(school.changes[0].settingLabel, '他校のログ表示を許可');
      assert.strictEqual(school.changes[0].before, 'DENY');
      assert.strictEqual(school.changes[0].after, 'ALLOW');
      assert.strictEqual(school.changes[0].beforeLabel, 'しない');
      assert.strictEqual(school.changes[0].afterLabel, 'する');
      assert.strictEqual(school.requiresHumanReview, false);
    }
  });

  // -------------------------------------------------------------------------
  // 要件 17: Exact Result Binding Tests (U - Y)
  // -------------------------------------------------------------------------

  await test('Binding Test U: Run A summary exists, Run B is current -> Run A not returned', async () => {
    const adapter = new BatchProcessAdapter();
    const port = 9878;
    const server = new ConsoleServer({ port, adapter });
    await server.start();

    try {
      const summaryRunA = createMockSummary({
        deploymentId: 'dep-a',
        runId: 'run-a',
        schoolResults: [{ schoolCode: 'A', schoolName: 'A校', status: 'SUCCESS', actionsCount: 1, before: { otherSchoolLog: 'DENY' }, after: { otherSchoolLog: 'ALLOW' } }]
      });
      const summaryRunB = createMockSummary({
        deploymentId: 'dep-b',
        runId: 'run-b',
        schoolResults: [{ schoolCode: 'B', schoolName: 'B校', status: 'SUCCESS', actionsCount: 1, before: { otherSchoolLog: 'DENY' }, after: { otherSchoolLog: 'ALLOW' } }]
      });

      adapter.setActiveExecutionResultContext({
        deploymentId: 'dep-b',
        runId: 'run-b',
        mode: 'PRODUCTION_WRITE',
        completedAt: new Date().toISOString(),
        summary: summaryRunB,
        viewModel: normalizeExecutionResult(summaryRunB)
      });

      const res = await httpRequest({ port, path: '/api/results/latest' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.result.runId, 'run-b');
      assert.strictEqual(res.body.result.schools[0].schoolCode, 'B');
    } finally {
      await server.stop();
    }
  });

  await test('Binding Test V: No Current Context, old production summary on disk -> NO speculative fallback', async () => {
    const adapter = new BatchProcessAdapter();
    const port = 9879;
    const server = new ConsoleServer({ port, adapter });
    await server.start();

    const reportsDir = getReportsDir();
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    const currentLedgerFile = path.join(reportsDir, 'current-production-execution.json');
    if (fs.existsSync(currentLedgerFile)) {
      try { fs.unlinkSync(currentLedgerFile); } catch {}
    }
    const oldSummaryPath = path.join(reportsDir, 'summary-dep-old-run-old.json');
    const oldSummary = createMockSummary({ deploymentId: 'dep-old', runId: 'run-old' });
    fs.writeFileSync(oldSummaryPath, JSON.stringify(oldSummary, null, 2), 'utf8');

    try {
      // Memory Context は null
      assert.strictEqual(adapter.getActiveExecutionResultContext(), null);

      const res = await httpRequest({ port, path: '/api/results/latest' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'NOT_AVAILABLE');
      assert.strictEqual(res.body.ok, false);
      assert.strictEqual(res.body.reason, 'RESULT_CONTEXT_NOT_AVAILABLE');
    } finally {
      if (fs.existsSync(oldSummaryPath)) fs.unlinkSync(oldSummaryPath);
      await server.stop();
    }
  });

  await test('Binding Test W: Summary mode or runId mismatch -> Context generation refused', () => {
    const summaryMismatch = createMockSummary({
      deploymentId: 'dep-w',
      runId: 'run-w',
      mode: 'PREFLIGHT_DRY_RUN' as any // PRODUCTION_WRITE ではない
    });

    assert.throws(
      () => normalizeExecutionResult(summaryMismatch),
      (err: any) => err.code === 'PURPOSE_MISMATCH' || err.status === 'PURPOSE_MISMATCH'
    );
  });

  await test('Binding Test X: Newer Preflight Summary does not corrupt Production Result', async () => {
    const adapter = new BatchProcessAdapter();
    const port = 9880;
    const server = new ConsoleServer({ port, adapter });
    await server.start();

    try {
      const prodSummary = createMockSummary({
        deploymentId: 'dep-prod-x',
        runId: 'run-prod-x',
        schoolResults: [{ schoolCode: 'X1', schoolName: 'X1校', status: 'SUCCESS', actionsCount: 1, before: { otherSchoolLog: 'DENY' }, after: { otherSchoolLog: 'ALLOW' } }]
      });

      adapter.setActiveExecutionResultContext({
        runId: 'run-prod-x',
        deploymentId: 'dep-prod-x',
        mode: 'PRODUCTION_WRITE',
        completedAt: new Date().toISOString(),
        summary: prodSummary,
        viewModel: normalizeExecutionResult(prodSummary)
      });

      // その後 Preflight Context が更新されたと仮定
      adapter.setActiveFinalPreflightContext({
        executionId: 'run-preflight-new',
        deploymentId: 'dep-preflight-new',
        completedAt: new Date().toISOString()
      } as any);

      const res = await httpRequest({ port, path: '/api/results/latest' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.result.runId, 'run-prod-x');
    } finally {
      await server.stop();
    }
  });

  await test('Binding Test Y: New Production Apply Start clears old activeExecutionResultContext', () => {
    const adapter = new BatchProcessAdapter();
    const oldSummary = createMockSummary({ deploymentId: 'old', runId: 'old' });
    adapter.setActiveExecutionResultContext({
      runId: 'old',
      deploymentId: 'old',
      mode: 'PRODUCTION_WRITE',
      completedAt: new Date().toISOString(),
      summary: oldSummary,
      viewModel: normalizeExecutionResult(oldSummary)
    });

    assert.notStrictEqual(adapter.getActiveExecutionResultContext(), null);

    // resetAllResults により確実にクリアされること
    adapter.resetAllResults();
    assert.strictEqual(adapter.getActiveExecutionResultContext(), null);
  });

  // ==================================================
  // Section 6: Execution Scope & Population Tests (Z1 - Z5)
  // ==================================================

  await test('Test Z1: Disabled schools (enabled=false are excluded from Execution Result population)', () => {
    // 5校: 3校 enabled, 2校 disabled
    const summary = createMockSummary({
      totalSchools: 5,
      schoolResults: [
        { schoolCode: 'S1', schoolName: 'S1校', status: 'SUCCESS', actionsCount: 1, before: { storage: 'OFF' }, after: { storage: 'ON' } },
        { schoolCode: 'S2', schoolName: 'S2校', status: 'SUCCESS', actionsCount: 1, before: { storage: 'OFF' }, after: { storage: 'ON' } },
        { schoolCode: 'S3', schoolName: 'S3校', status: 'SUCCESS', actionsCount: 1, before: { storage: 'OFF' }, after: { storage: 'ON' } },
        { schoolCode: 'S4', schoolName: 'S4校', status: 'PENDING', actionsCount: 0 },
        { schoolCode: 'S5', schoolName: 'S5校', status: 'PENDING', actionsCount: 0 }
      ]
    });

    const allSchools = [
      { schoolCode: 'S1', schoolName: 'S1校', enabled: true },
      { schoolCode: 'S2', schoolName: 'S2校', enabled: true },
      { schoolCode: 'S3', schoolName: 'S3校', enabled: true },
      { schoolCode: 'S4', schoolName: 'S4校', enabled: false },
      { schoolCode: 'S5', schoolName: 'S5校', enabled: false }
    ];

    const vm = normalizeExecutionResult(summary, { allSchools });
    assert.strictEqual(vm.totalCount, 3, 'totalCount は enabled な 3校のみであること');
    assert.strictEqual(vm.appliedSuccessCount, 3);
    assert.strictEqual(vm.notProcessedCount, 0, 'disabled 2校は NOT_PROCESSED として表示されないこと');
    assert.strictEqual(vm.schools.length, 3);
    assert.strictEqual(vm.schools.some((s) => s.schoolCode === 'S4' || s.schoolCode === 'S5'), false);
  });

  await test('Test Z2: targetSchoolCodes filter (unfiltered schools are excluded from Result population)', () => {
    // 10校中3校だけ今回Runの対象 (targetSchoolCodes / executionScopeCodes)
    const summary = createMockSummary({
      totalSchools: 10,
      executionScopeCodes: ['T1', 'T2', 'T3'],
      schoolResults: [
        { schoolCode: 'T1', schoolName: 'T1校', status: 'SUCCESS', actionsCount: 1, before: { storage: 'OFF' }, after: { storage: 'ON' } },
        { schoolCode: 'T2', schoolName: 'T2校', status: 'SUCCESS', actionsCount: 1, before: { storage: 'OFF' }, after: { storage: 'ON' } },
        { schoolCode: 'T3', schoolName: 'T3校', status: 'SUCCESS_ALREADY_CONFIGURED', actionsCount: 0 },
        { schoolCode: 'T4', schoolName: 'T4校', status: 'PENDING', actionsCount: 0 },
        { schoolCode: 'T5', schoolName: 'T5校', status: 'PENDING', actionsCount: 0 },
        { schoolCode: 'T6', schoolName: 'T6校', status: 'PENDING', actionsCount: 0 },
        { schoolCode: 'T7', schoolName: 'T7校', status: 'PENDING', actionsCount: 0 },
        { schoolCode: 'T8', schoolName: 'T8校', status: 'PENDING', actionsCount: 0 },
        { schoolCode: 'T9', schoolName: 'T9校', status: 'PENDING', actionsCount: 0 },
        { schoolCode: 'T10', schoolName: 'T10校', status: 'PENDING', actionsCount: 0 }
      ]
    });

    const vm = normalizeExecutionResult(summary, { executionScopeCodes: ['T1', 'T2', 'T3'] });
    assert.strictEqual(vm.totalCount, 3, 'targetSchoolCodes で指定された 3校のみが母集団となること');
    assert.strictEqual(vm.appliedSuccessCount, 2);
    assert.strictEqual(vm.alreadyConfiguredCount, 1);
    assert.strictEqual(vm.notProcessedCount, 0, '残り7校は「安全停止による未処理」と表示されないこと');
    assert.strictEqual(vm.schools.length, 3);
  });

  await test('Test Z3: Canary limit (schools outside limit are excluded from Result population)', () => {
    // 20校候補, limit=5, Execution Scope = 5校 (全部SUCCESS)
    const scopeCodes = ['C1', 'C2', 'C3', 'C4', 'C5'];
    const schoolResults: any[] = scopeCodes.map((code) => ({
      schoolCode: code,
      schoolName: `${code}校`,
      status: 'SUCCESS',
      actionsCount: 1,
      before: { attendance: 'OFF' },
      after: { attendance: 'ON' }
    }));
    // 残り15校 (limit外)
    for (let i = 6; i <= 20; i++) {
      schoolResults.push({
        schoolCode: `C${i}`,
        schoolName: `C${i}校`,
        status: 'PENDING',
        actionsCount: 0
      });
    }

    const summary = createMockSummary({
      totalSchools: 20,
      executionScopeCodes: scopeCodes,
      schoolResults
    });

    const vm = normalizeExecutionResult(summary, { executionScopeCodes: scopeCodes });
    assert.strictEqual(vm.totalCount, 5, 'Canary limit=5 の Execution Scope 5校のみが母集団');
    assert.strictEqual(vm.appliedSuccessCount, 5);
    assert.strictEqual(vm.notProcessedCount, 0, 'limit外の15校は NOT_PROCESSED にならないこと');
    assert.strictEqual(vm.schools.length, 5);
  });

  await test('Test Z4: Safety stop inside scope (schools stopped by safety halt are correctly NOT_PROCESSED)', () => {
    // Execution Scope = 5校。1校目 SAVE_OUTCOME_UNKNOWN, 残り4校 Safety Stop (PENDING)
    const scopeCodes = ['S1', 'S2', 'S3', 'S4', 'S5'];
    const summary = createMockSummary({
      totalSchools: 5,
      executionScopeCodes: scopeCodes,
      schoolResults: [
        {
          schoolCode: 'S1',
          schoolName: 'S1校',
          status: 'SAVE_OUTCOME_UNKNOWN',
          executionStatus: 'SAVE_OUTCOME_UNKNOWN',
          actionsCount: 1,
          error: 'Save button clicked but response timed out'
        },
        { schoolCode: 'S2', schoolName: 'S2校', status: 'PENDING', actionsCount: 0 },
        { schoolCode: 'S3', schoolName: 'S3校', status: 'PENDING', actionsCount: 0 },
        { schoolCode: 'S4', schoolName: 'S4校', status: 'PENDING', actionsCount: 0 },
        { schoolCode: 'S5', schoolName: 'S5校', status: 'PENDING', actionsCount: 0 }
      ]
    });

    const vm = normalizeExecutionResult(summary, { executionScopeCodes: scopeCodes });
    assert.strictEqual(vm.totalCount, 5);
    assert.strictEqual(vm.outcomeUnknownCount, 1);
    assert.strictEqual(vm.notProcessedCount, 4, 'Scope内での安全停止は正しく NOT_PROCESSED');
    assert.strictEqual(vm.processedCount, 1, 'processedCount = 5 - 4 = 1');
    assert.strictEqual(vm.attentionRequiredCount, 1);
    // 未処理校のメッセージ検証
    const notProcessedSchools = vm.schools.filter((s) => s.category === 'NOT_PROCESSED');
    assert.strictEqual(notProcessedSchools.length, 4);
    assert.strictEqual(notProcessedSchools[0].message, '安全停止または中断により未処理');
  });

  await test('Test Z5: Scope + Safety Stop mixed (out of scope excluded, in-scope safety stop counted as NOT_PROCESSED)', () => {
    // CSV全体20校, Execution Scope 5校 (S1〜S5)
    // S1: SAVE_OUTCOME_UNKNOWN, S2〜S5: Safety Stop (PENDING), S6〜S20: Scope外
    const scopeCodes = ['S1', 'S2', 'S3', 'S4', 'S5'];
    const schoolResults: any[] = [
      {
        schoolCode: 'S1',
        schoolName: 'S1校',
        status: 'SAVE_OUTCOME_UNKNOWN',
        executionStatus: 'SAVE_OUTCOME_UNKNOWN',
        actionsCount: 1,
        error: 'Save outcome unknown'
      },
      { schoolCode: 'S2', schoolName: 'S2校', status: 'PENDING', actionsCount: 0 },
      { schoolCode: 'S3', schoolName: 'S3校', status: 'PENDING', actionsCount: 0 },
      { schoolCode: 'S4', schoolName: 'S4校', status: 'PENDING', actionsCount: 0 },
      { schoolCode: 'S5', schoolName: 'S5校', status: 'PENDING', actionsCount: 0 }
    ];
    for (let i = 6; i <= 20; i++) {
      schoolResults.push({
        schoolCode: `S${i}`,
        schoolName: `S${i}校`,
        status: 'PENDING',
        actionsCount: 0
      });
    }

    const summary = createMockSummary({
      totalSchools: 20,
      executionScopeCodes: scopeCodes,
      schoolResults
    });

    const vm = normalizeExecutionResult(summary, { executionScopeCodes: scopeCodes });
    assert.strictEqual(vm.totalCount, 5, 'Scope外の15校は母集団から除外され totalCount = 5');
    assert.strictEqual(vm.outcomeUnknownCount, 1);
    assert.strictEqual(vm.notProcessedCount, 4, 'Scope内の4校のみが NOT_PROCESSED');
    assert.strictEqual(vm.processedCount, 1);
    assert.strictEqual(vm.schools.length, 5);
    // Invariant: totalCount === sum of categories
    assert.strictEqual(vm.totalCount, vm.processedCount + vm.notProcessedCount);
  });

  console.log(`\n=== Test Suite Finished: ${passed} Passed, ${failed} Failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
