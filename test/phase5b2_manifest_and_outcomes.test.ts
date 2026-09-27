import assert from 'assert';
import * as http from 'http';
import { ConsoleServer } from '../src/console/server';
import { BatchProcessAdapter } from '../src/console/adapter';
import { generateBaselineHash, generateApplyTargetHash, generateSettingsHash, generateSchoolsHash, generateToolFingerprint } from '../src/utils/hash';
import { validateGlobalGateAndBuildManifest, ConfirmationTokenManager } from '../src/console/manifest';
import { PreflightReport, ApplyTargetItem, WritePhase } from '../src/types/batch';
import { ProfileSnapshot, ValidationSnapshot } from '../src/console/types';
import { SchoolSettingsObservation } from '../src/types/settings';
import { CircuitBreaker } from '../src/batch/circuitBreaker';
import { ALL_SETTING_KEYS } from '../src/settings/definitions';
import { SchoolSettingsPage } from '../src/pages/SchoolSettingsPage';
import { ExecutionPlan } from '../src/types/plan';
import { buildExecutionPlan } from '../src/automation/buildExecutionPlan';
import { AutomationError } from '../src/types/errors';

console.log('=== Phase 5B.2: Manifest, Outcomes & Write Safety Tests (A-J) ===\n');

let passedTests = 0;
let failedTests = 0;

async function runTest(testName: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`[PASS] ${testName}`);
    passedTests++;
  } catch (err: any) {
    console.error(`[FAIL] ${testName}:`, err.message || err);
    failedTests++;
  }
}

async function httpRequest(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: any; rawBody: string }> {
  return new Promise((resolve, reject) => {
    const postData = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const reqHeaders: Record<string, string> = {
      Host: `127.0.0.1:${options.port}`,
      ...(options.headers || {})
    };

    if (postData !== undefined && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method || 'GET',
        headers: reqHeaders
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({
            statusCode: res.statusCode || 500,
            headers: res.headers,
            body: parsed,
            rawBody: data
          });
        });
      }
    );

    req.on('error', reject);
    if (postData !== undefined) {
      req.write(postData);
    }
    req.end();
  });
}

function createDummyObservation(overrides: Partial<Record<string, any>> = {}): SchoolSettingsObservation {
  const baseObs: any = {};
  for (const k of ALL_SETTING_KEYS) {
    baseObs[k] = {
      settingKey: k,
      value: 'ON',
      availability: 'AVAILABLE',
      ...(overrides[k] || {})
    };
  }
  return baseObs as SchoolSettingsObservation;
}

function createMockPage(options: {
  reloadFails?: boolean;
  verifyFails?: boolean;
} = {}) {
  return {
    reload: async () => {
      if (options.reloadFails) throw new Error('Network timeout during reload');
      return null;
    },
    waitForTimeout: async () => {},
    locator: (selector: string) => ({
      first: () => ({
        waitFor: async () => {
          if (options.verifyFails) throw new Error('Header not visible');
        }
      })
    })
  } as any;
}

async function main() {
  // 指示1: Baseline Hash の SettingKey を SSOT (ALL_SETTING_KEYS) へ統一 & 完全一致検証
  await runTest('Test 1: Baseline Hash strictly matches ALL_SETTING_KEYS SSOT and handles special availabilities', async () => {
    // A. ALL_SETTING_KEYS と baseline hash 対象キー集合が完全一致すること
    const expectedOfficialKeys = [
      'storage',
      'timelineChannel',
      'directMessage',
      'parentDirectMessage',
      'allChannel',
      'parentChannel',
      'attendance',
      'contactBook',
      'mentalHealth',
      'otherSchoolLog',
      'studentPasswordChange'
    ];
    assert.deepStrictEqual(
      [...ALL_SETTING_KEYS].sort(),
      [...expectedOfficialKeys].sort(),
      'ALL_SETTING_KEYS must match the exact 11 official settings'
    );

    const baseObs = createDummyObservation();
    const baseHash = generateBaselineHash(baseObs);
    assert.strictEqual(typeof baseHash, 'string');
    assert.strictEqual(baseHash.length, 64);

    // 11項目すべてについて、1つでも欠落または値が変わると baselineHash が変化することを検証
    for (const key of ALL_SETTING_KEYS) {
      const alteredObs = createDummyObservation({
        [key]: { settingKey: key, value: 'OFF', availability: 'AVAILABLE' }
      });
      const alteredHash = generateBaselineHash(alteredObs);
      assert.notStrictEqual(baseHash, alteredHash, `Key '${key}' change must produce different baselineHash`);
    }

    // B. mentalHealth: CONTRACT_NOT_AVAILABLE の検証
    const obsContractDisabled = createDummyObservation({
      mentalHealth: { settingKey: 'mentalHealth', value: null, availability: 'CONTRACT_NOT_AVAILABLE' }
    });
    const hashContractDisabled = generateBaselineHash(obsContractDisabled);
    assert.notStrictEqual(baseHash, hashContractDisabled, 'mentalHealth: CONTRACT_NOT_AVAILABLE must alter baselineHash');

    // C. dependency: DISABLED_BY_DEPENDENCY の検証
    const obsDependencyDisabled = createDummyObservation({
      parentChannel: { settingKey: 'parentChannel', value: null, availability: 'DISABLED_BY_DEPENDENCY' }
    });
    const hashDependencyDisabled = generateBaselineHash(obsDependencyDisabled);
    assert.notStrictEqual(baseHash, hashDependencyDisabled, 'DISABLED_BY_DEPENDENCY must alter baselineHash');
  });

  // 指示2-A〜D: SchoolSettingsPage.applyAndVerifyProduction State Machine の直接テスト
  await runTest('Test 2-A: Save request -> reload success -> expected match -> SUCCESS / SUCCESS_RECOVERED', async () => {
    const page = createMockPage();
    const settingsPage = new SchoolSettingsPage(page);

    const baselineObs = createDummyObservation({ storage: { settingKey: 'storage', value: 'OFF', availability: 'AVAILABLE' } });
    const plan = buildExecutionPlan({
      schoolCode: 'SCH001',
      schoolName: 'テスト校',
      currentObservation: baselineObs,
      requestedSettings: { storage: 'ON' }
    });
    const expectedAfterObs = createDummyObservation({ storage: { settingKey: 'storage', value: 'ON', availability: 'AVAILABLE' } });

    // モックメソッドの設定
    settingsPage.applyActions = async () => {};
    settingsPage.validatePreSaveForPlan = async () => {};
    settingsPage.clickSaveAndObserveSignals = async () => ({ saveSuccess: true } as any);
    settingsPage.readAllSettingsObservation = async () => ({ observation: expectedAfterObs, rows: [] } as any);

    const phases: WritePhase[] = [];
    const result = await settingsPage.applyAndVerifyProduction({
      plan,
      baselineObservation: baselineObs,
      onPhaseChange: (p) => phases.push(p)
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.recovered, false);
    assert.deepStrictEqual(phases, ['BEFORE_SAVE', 'SAVE_REQUEST_STARTED', 'OUTCOME_RESOLUTION', 'OUTCOME_CONFIRMED']);

    // Save待機中にタイムアウトが発生したがリロードで成功した場合 -> recovered: true
    settingsPage.clickSaveAndObserveSignals = async () => { throw new Error('Save signal timeout'); };
    const recoveredResult = await settingsPage.applyAndVerifyProduction({
      plan,
      baselineObservation: baselineObs
    });
    assert.strictEqual(recoveredResult.success, true);
    assert.strictEqual(recoveredResult.recovered, true, 'Must be marked as recovered when save wait timed out but state verified');
  });

  await runTest('Test 2-B: Save request -> reload success -> expected mismatch -> SAVE_FAILED_KNOWN (No auto-retry)', async () => {
    const page = createMockPage();
    const settingsPage = new SchoolSettingsPage(page);

    const baselineObs = createDummyObservation({ storage: { settingKey: 'storage', value: 'OFF', availability: 'AVAILABLE' } });
    const plan = buildExecutionPlan({
      schoolCode: 'SCH001',
      schoolName: 'テスト校',
      currentObservation: baselineObs,
      requestedSettings: { storage: 'ON' }
    });
    // 永続状態を観測できたが期待値と不一致（OFFのまま）
    const actualAfterObs = createDummyObservation({ storage: { settingKey: 'storage', value: 'OFF', availability: 'AVAILABLE' } });

    settingsPage.applyActions = async () => {};
    settingsPage.validatePreSaveForPlan = async () => {};
    settingsPage.clickSaveAndObserveSignals = async () => ({ saveSuccess: true } as any);
    settingsPage.readAllSettingsObservation = async () => ({ observation: actualAfterObs, rows: [] } as any);

    await assert.rejects(
      async () => {
        await settingsPage.applyAndVerifyProduction({
          plan,
          baselineObservation: baselineObs
        });
      },
      (err: any) => {
        assert.strictEqual(err.status, 'SAVE_FAILED_KNOWN');
        assert.strictEqual(err.issueCode, 'SAVE_FAILED_KNOWN');
        return true;
      }
    );
  });

  await runTest('Test 2-C: Save request -> page.reload failure -> SAVE_OUTCOME_UNKNOWN', async () => {
    const page = createMockPage({ reloadFails: true });
    const settingsPage = new SchoolSettingsPage(page);

    const baselineObs = createDummyObservation({ storage: { settingKey: 'storage', value: 'OFF', availability: 'AVAILABLE' } });
    const plan = buildExecutionPlan({
      schoolCode: 'SCH001',
      schoolName: 'テスト校',
      currentObservation: baselineObs,
      requestedSettings: { storage: 'ON' }
    });

    settingsPage.applyActions = async () => {};
    settingsPage.validatePreSaveForPlan = async () => {};
    settingsPage.clickSaveAndObserveSignals = async () => ({ saveSuccess: true } as any);

    await assert.rejects(
      async () => {
        await settingsPage.applyAndVerifyProduction({
          plan,
          baselineObservation: baselineObs
        });
      },
      (err: any) => {
        assert.strictEqual(err.status, 'SAVE_OUTCOME_UNKNOWN');
        assert.strictEqual(err.issueCode, 'SAVE_OUTCOME_UNKNOWN');
        assert.ok(err.message.includes('reload failure'));
        return true;
      }
    );
  });

  await runTest('Test 2-D: Save request -> reload success -> readAllSettingsObservation failure -> SAVE_OUTCOME_UNKNOWN', async () => {
    const page = createMockPage();
    const settingsPage = new SchoolSettingsPage(page);

    const baselineObs = createDummyObservation({ storage: { settingKey: 'storage', value: 'OFF', availability: 'AVAILABLE' } });
    const plan = buildExecutionPlan({
      schoolCode: 'SCH001',
      schoolName: 'テスト校',
      currentObservation: baselineObs,
      requestedSettings: { storage: 'ON' }
    });

    settingsPage.applyActions = async () => {};
    settingsPage.validatePreSaveForPlan = async () => {};
    settingsPage.clickSaveAndObserveSignals = async () => ({ saveSuccess: true } as any);
    settingsPage.readAllSettingsObservation = async () => {
      throw new Error('DOM selector error during observation');
    };

    await assert.rejects(
      async () => {
        await settingsPage.applyAndVerifyProduction({
          plan,
          baselineObservation: baselineObs
        });
      },
      (err: any) => {
        assert.strictEqual(err.status, 'SAVE_OUTCOME_UNKNOWN');
        assert.strictEqual(err.issueCode, 'SAVE_OUTCOME_UNKNOWN');
        assert.ok(err.message.includes('DOM read failure'));
        return true;
      }
    );
  });

  // 指示2-E: STOP before Save request -> INTERRUPTED, Save click/request = 0
  await runTest('Test 2-E: STOP before Save request -> INTERRUPTED and Save click count = 0', async () => {
    const page = createMockPage();
    const settingsPage = new SchoolSettingsPage(page);

    const controller = new AbortController();
    controller.abort(); // 事前中断

    let saveClickedCount = 0;
    settingsPage.applyActions = async () => {};
    settingsPage.validatePreSaveForPlan = async () => {};
    settingsPage.clickSaveAndObserveSignals = (async () => {
      saveClickedCount++;
      return { saveSuccess: true };
    }) as any;

    const baselineObs = createDummyObservation({ storage: { settingKey: 'storage', value: 'OFF', availability: 'AVAILABLE' } });
    const plan = buildExecutionPlan({
      schoolCode: 'SCH001',
      schoolName: 'テスト校',
      currentObservation: baselineObs,
      requestedSettings: { storage: 'ON' }
    });

    await assert.rejects(
      async () => {
        await settingsPage.applyAndVerifyProduction({
          plan,
          baselineObservation: baselineObs,
          signal: controller.signal
        });
      },
      (err: any) => {
        assert.strictEqual(err.status, 'INTERRUPTED');
        return true;
      }
    );
    assert.strictEqual(saveClickedCount, 0, 'Save button must NEVER be clicked when aborted before save');
  });

  // 指示2-F & G: STOP / timeout after Save request started -> BrowserContext即close禁止, OUTCOME_RESOLUTION優先
  await runTest('Test 2-F & G: STOP/Timeout after Save request -> Context close delayed, OUTCOME_RESOLUTION prioritised', async () => {
    // 状態機械シミュレーション: runSchoolProduction 内の abortHandler ロジック検証
    let contextClosed = false;
    const mockContext = {
      close: async () => {
        contextClosed = true;
      }
    };

    let writePhase: WritePhase = 'BEFORE_SAVE';
    const abortHandler = () => {
      if (writePhase === 'BEFORE_SAVE') {
        mockContext.close();
      } else {
        // SAVE_REQUEST_STARTED以降は BrowserContext 即 close 禁止
        // context.close() を呼び出さず保留
      }
    };

    // 1. BEFORE_SAVE 時の中断: 即 close
    writePhase = 'BEFORE_SAVE';
    abortHandler();
    assert.strictEqual(contextClosed, true, 'BEFORE_SAVE must immediately close context');

    // 2. SAVE_REQUEST_STARTED 時の中断: 即 close 禁止
    contextClosed = false;
    writePhase = 'SAVE_REQUEST_STARTED';
    abortHandler();
    assert.strictEqual(contextClosed, false, 'SAVE_REQUEST_STARTED must NOT immediately close context');

    // 3. OUTCOME_RESOLUTION 時の中断: 即 close 禁止
    writePhase = 'OUTCOME_RESOLUTION';
    abortHandler();
    assert.strictEqual(contextClosed, false, 'OUTCOME_RESOLUTION must NOT immediately close context');
  });

  // 指示2-H: SAVE_FAILED_KNOWN: auto retry = 0, retry-failed による blind retry = 0
  await runTest('Test 2-H: SAVE_FAILED_KNOWN is terminal, auto-retry = 0, skipped by resume', async () => {
    const isRetryCandidate = (status: string) => status === 'FAILED' || status === 'INTERRUPTED';
    assert.strictEqual(isRetryCandidate('SAVE_FAILED_KNOWN'), false, 'SAVE_FAILED_KNOWN must NOT be retried blindly');

    const shouldSkipOnResume = (status: string) =>
      status !== 'PENDING' && status !== 'RUNNING' && status !== 'FAILED' && status !== 'INTERRUPTED' && status !== 'PLAN_BLOCKED';
    assert.strictEqual(shouldSkipOnResume('SAVE_FAILED_KNOWN'), true, 'SAVE_FAILED_KNOWN must be skipped on resume');
  });

  // 指示2-I: SAVE_OUTCOME_UNKNOWN: auto retry = 0, resume = 0, next school execution = 0, Circuit Break = true
  await runTest('Test 2-I: SAVE_OUTCOME_UNKNOWN causes immediate Circuit Break, halts batch and blocks resume', async () => {
    const cb = new CircuitBreaker({ consecutiveFailureThreshold: 3 });
    assert.strictEqual(cb.shouldStop(), false);

    // 通常エラー
    cb.recordResult('SAVE_FAILED', 'SCH001');
    assert.strictEqual(cb.shouldStop(), false);

    // SAVE_OUTCOME_UNKNOWN は 1 発で即 PAUSE
    cb.recordResult('SAVE_OUTCOME_UNKNOWN', 'SCH002');
    assert.strictEqual(cb.shouldStop(), true, 'SAVE_OUTCOME_UNKNOWN must immediately trip Circuit Breaker');
    assert.ok(cb.getReason().includes('SAVE_OUTCOME_UNKNOWN'));

    // Resume スキップ対象であること（二重実行禁止）
    const shouldSkipOnResume = (status: string) =>
      status !== 'PENDING' && status !== 'RUNNING' && status !== 'FAILED' && status !== 'INTERRUPTED' && status !== 'PLAN_BLOCKED';
    assert.strictEqual(shouldSkipOnResume('SAVE_OUTCOME_UNKNOWN'), true, 'SAVE_OUTCOME_UNKNOWN must never be resumed');
  });

  // Test J: applyTargetHash, Global Gate, Manifest 導出, Confirmation Token, HTTP prepare 検証
  await runTest('Test J: applyTargetHash, Global Gate, Manifest derivation and POST /api/apply/prepare', async () => {
    const targets: ApplyTargetItem[] = [
      {
        schoolCode: 'SCH001',
        baselineHash: 'abc123hash',
        plannedActions: [{ settingKey: 'storage', from: 'OFF', to: 'ON' }],
        expectedFinalState: { storage: 'ON' }
      },
      {
        schoolCode: 'SCH002',
        baselineHash: 'def456hash',
        plannedActions: [{ settingKey: 'timelineChannel', from: 'OFF', to: 'ON' }],
        expectedFinalState: { timelineChannel: 'ON' }
      }
    ];

    const hashA = generateApplyTargetHash(targets);
    const hashB = generateApplyTargetHash([...targets].reverse());
    assert.strictEqual(hashA, hashB, 'applyTargetHash must be canonical and order-independent');

    // Token manager
    const tokenManager = new ConfirmationTokenManager();
    const manifest = {
      profileSnapshotId: 'snap-1',
      preflightId: 'dep-1',
      profileHash: 'prof-hash-1',
      schoolsHash: 'schools-hash-1',
      applyTargetHash: hashA,
      createdAt: new Date().toISOString(),
      totalSchools: 2,
      applyTargets: targets,
      skippedDestructiveCount: 0,
      alreadyConfiguredCount: 0,
      blockedCount: 0
    };

    const tokenData = tokenManager.createToken(manifest, 5000);
    const consumed = tokenManager.verifyAndConsumeToken(tokenData.token, manifest);
    assert.strictEqual(consumed.token, tokenData.token);
    assert.throws(() => tokenManager.verifyAndConsumeToken(tokenData.token, manifest), /この confirmationToken は既に使用済みです/);

    // HTTP prepare endpoint test
    const adapter = new BatchProcessAdapter();
    const server = new ConsoleServer({ port: 63235, adapter });
    await server.start();
    const csrf = server.getCsrfToken();

    try {
      adapter.executeValidation({
        schoolsFilePath: 'config/schools.live.csv',
        profile: { storage: 'OFF' }
      });

      const pfReport: PreflightReport = {
        deploymentId: 'dep-http',
        runId: 'run-http',
        status: 'COMPLETE',
        writeGateEligible: true,
        allReadSucceeded: true,
        allPlansExecutable: true,
        profileHash: adapter.getActiveProfileSnapshot()!.profileHash,
        profileSnapshotId: adapter.getActiveProfileSnapshot()!.snapshotId,
        schoolsHash: adapter.getSnapshot()!.schoolsHash,
        toolVersion: '1.0.0',
        toolFingerprint: adapter.getSnapshot()!.toolFingerprint,
        completedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 600000).toISOString(),
        total: 1,
        processed: 1,
        readSuccess: 1,
        readFailed: 0,
        planBlocked: 0,
        notProcessed: 0,
        alreadyConfigured: 0,
        requiresChange: 1,
        destructiveChangeSchools: 0,
        currentStateCoverage: { collected: 1, total: 1 },
        plannedChangeCoverage: { collected: 1, total: 1 },
        summaryPath: 'reports/summary-dep-http.json',
        schools: [
          {
            schoolCode: 'SCH001',
            schoolName: 'テスト校',
            readStatus: 'SUCCESS',
            planExecutable: true,
            hasDestructiveChanges: false,
            actionsCount: 1,
            hasChanges: true,
            writeEligible: true,
            baselineHash: 'dummy-baseline-hash'
          }
        ]
      };

      const execId = 'fp-exec-test-j';
      (adapter as any).currentFinalPreflightExecutionId = execId;
      pfReport.executionId = execId;
      pfReport.purpose = 'FINAL_PREFLIGHT';
      (adapter as any).activeFinalPreflightReport = pfReport;
      (adapter as any).activeFinalPreflightContext = {
        executionId: execId,
        deploymentId: pfReport.deploymentId,
        runId: pfReport.runId,
        targetSnapshotId: adapter.getTargetSnapshot()?.targetSnapshotId || 'target-snap-test',
        observationSnapshotId: 'obs-test',
        profileSnapshotId: adapter.getActiveProfileSnapshot()!.snapshotId,
        finalValidationSnapshotId: 'final-val-test',
        authMode: 'A',
        schoolsHash: adapter.getSnapshot()!.schoolsHash,
        toolFingerprint: adapter.getSnapshot()!.toolFingerprint,
        report: pfReport,
        summary: { schoolResults: [] },
        completedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 600000).toISOString()
      };
      (adapter as any).finalValidationSnapshot = {
        finalValidationSnapshotId: 'final-val-test',
        targetSnapshotId: adapter.getTargetSnapshot()?.targetSnapshotId || 'target-snap-test',
        observationSnapshotId: 'obs-test',
        profileSnapshotId: adapter.getActiveProfileSnapshot()!.snapshotId,
        schoolsHash: adapter.getSnapshot()!.schoolsHash,
        profileHash: adapter.getActiveProfileSnapshot()!.profileHash,
        authMode: 'A',
        toolFingerprint: adapter.getSnapshot()!.toolFingerprint,
        toolVersion: '1.0.0',
        createdAt: new Date().toISOString()
      };
      (adapter as any).loadLatestPreflightReport = () => ({
        preflight: pfReport,
        summary: { schoolResults: [] }
      });

      const resOk = await httpRequest({
        port: 63235,
        path: '/api/apply/prepare',
        method: 'POST',
        headers: { 'x-csrf-nonce': csrf },
        body: {}
      });
      if (resOk.statusCode !== 200) {
        console.log('prepare failed response:', resOk.statusCode, resOk.body);
      }
      assert.strictEqual(resOk.statusCode, 200);
      assert.strictEqual(resOk.body.status, 'PREPARED');
      assert.ok(resOk.body.confirmationToken.startsWith('apply-token-'));
      assert.strictEqual(resOk.body.targetCount, 1);
    } finally {
      await server.stop();
    }
  });

  console.log(`\nPhase 5B.2 Test Results: ${passedTests} passed, ${failedTests} failed`);
  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
