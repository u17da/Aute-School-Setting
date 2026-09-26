import assert from 'assert';
import * as http from 'http';
import { ConsoleServer } from '../src/console/server';
import { BatchProcessAdapter } from '../src/console/adapter';
import { PreflightReport, ApplyTargetManifest } from '../src/types/batch';

console.log('=== Phase 5B.3: Non-destructive Production Apply Tests (A-H) ===\n');

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

function createDummyPreflightReport(adapter: BatchProcessAdapter, overrides: Partial<PreflightReport> = {}): PreflightReport {
  const profileSnap = adapter.getActiveProfileSnapshot()!;
  const valSnap = adapter.getSnapshot()!;

  return {
    deploymentId: 'dep-apply-test',
    runId: 'run-apply-test',
    status: 'COMPLETE',
    writeGateEligible: true,
    allReadSucceeded: true,
    allPlansExecutable: true,
    profileHash: profileSnap.profileHash,
    profileSnapshotId: profileSnap.snapshotId,
    schoolsHash: valSnap.schoolsHash,
    toolVersion: '1.0.0',
    toolFingerprint: valSnap.toolFingerprint,
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
    summaryPath: 'reports/summary-dep-apply-test.json',
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
    ],
    ...overrides
  };
}

async function main() {
  // Test A: POST /api/apply/start は CSRF 不足時に 403 Forbidden となること
  await runTest('Test A: POST /api/apply/start rejects requests without CSRF token (403)', async () => {
    const adapter = new BatchProcessAdapter();
    const server = new ConsoleServer({ port: 63240, adapter });
    await server.start();

    try {
      const res = await httpRequest({
        port: 63240,
        path: '/api/apply/start',
        method: 'POST',
        body: { confirmationToken: 'dummy-token' }
      });
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.error, 'INVALID_CSRF_TOKEN');
    } finally {
      await server.stop();
    }
  });

  // Test B: POST /api/apply/start は任意 Write フラグ注入時に 400 WRITE_FORBIDDEN で拒絶されること
  await runTest('Test B: POST /api/apply/start rejects injected write fields with 400 WRITE_FORBIDDEN', async () => {
    const adapter = new BatchProcessAdapter();
    const server = new ConsoleServer({ port: 63241, adapter });
    await server.start();
    const csrf = server.getCsrfToken();

    try {
      const forbiddenPayloads = [
        { confirmationToken: 'token', apply: true },
        { confirmationToken: 'token', allowLiveWrite: true },
        { confirmationToken: 'token', batchApply: true },
        { confirmationToken: 'token', allowDestructive: true }
      ];

      for (const payload of forbiddenPayloads) {
        const res = await httpRequest({
          port: 63241,
          path: '/api/apply/start',
          method: 'POST',
          headers: { 'x-csrf-nonce': csrf },
          body: payload
        });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error, 'WRITE_FORBIDDEN');
      }
    } finally {
      await server.stop();
    }
  });

  // Test C: POST /api/apply/start は confirmationToken 不足または不正時に 400 で拒絶されること
  await runTest('Test C: POST /api/apply/start requires valid string confirmationToken', async () => {
    const adapter = new BatchProcessAdapter();
    const server = new ConsoleServer({ port: 63242, adapter });
    await server.start();
    const csrf = server.getCsrfToken();

    try {
      const invalidPayloads = [
        {},
        { confirmationToken: '' },
        { confirmationToken: 12345 },
        { confirmationToken: null }
      ];

      for (const payload of invalidPayloads) {
        const res = await httpRequest({
          port: 63242,
          path: '/api/apply/start',
          method: 'POST',
          headers: { 'x-csrf-nonce': csrf },
          body: payload
        });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error, 'CONFIG_INVALID');
      }
    } finally {
      await server.stop();
    }
  });

  // Test D: POST /api/apply/start は使用済みトークンを 400 で拒絶すること (ワンタイム消費・再利用防止)
  await runTest('Test D: POST /api/apply/start enforces one-time consumption and rejects reused tokens', async () => {
    let spawnCalled = 0;
    const mockSpawn = () => {
      spawnCalled++;
      return {
        on: () => {},
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        stdin: { write: () => {}, destroyed: false }
      } as any;
    };

    const adapter = new BatchProcessAdapter({ spawnFn: mockSpawn as any });
    const server = new ConsoleServer({ port: 63243, adapter });
    await server.start();
    const csrf = server.getCsrfToken();

    try {
      adapter.executeValidation({
        schoolsFilePath: 'config/schools.live.csv',
        profile: { storage: 'OFF' }
      });
      const pfReport = createDummyPreflightReport(adapter);
      (adapter as any).loadLatestPreflightReport = () => ({
        preflight: pfReport,
        summary: { schoolResults: [] }
      });

      // 1. Prepare でトークンを発行
      const prepRes = await httpRequest({
        port: 63243,
        path: '/api/apply/prepare',
        method: 'POST',
        headers: { 'x-csrf-nonce': csrf },
        body: {}
      });
      assert.strictEqual(prepRes.statusCode, 200);
      const token = prepRes.body.confirmationToken;

      // 2. 1回目の Start -> 成功
      const startRes1 = await httpRequest({
        port: 63243,
        path: '/api/apply/start',
        method: 'POST',
        headers: { 'x-csrf-nonce': csrf },
        body: { confirmationToken: token }
      });
      assert.strictEqual(startRes1.statusCode, 200);
      assert.strictEqual(startRes1.body.status, 'STARTED');
      assert.strictEqual(startRes1.body.mode, 'PRODUCTION_WRITE');
      assert.strictEqual(spawnCalled, 1);

      // ジョブを終了状態に戻す (テスト用)
      (adapter as any).currentJobState = 'COMPLETED';

      // 3. 同じトークンで 2回目の Start -> 拒絶 (使用済み)
      const startRes2 = await httpRequest({
        port: 63243,
        path: '/api/apply/start',
        method: 'POST',
        headers: { 'x-csrf-nonce': csrf },
        body: { confirmationToken: token }
      });
      assert.strictEqual(startRes2.statusCode, 400);
      assert.strictEqual(startRes2.body.error, 'APPROVAL_AUDIT_INVALID');
      assert.ok(startRes2.body.message.includes('既に使用済みです'));
      assert.strictEqual(spawnCalled, 1, 'Child process must not be spawned second time');
    } finally {
      await server.stop();
    }
  });

  // Test E: Single Job Guard (RUNNING 中に呼ばれたら 409 Conflict)
  await runTest('Test E: Single Job Guard blocks apply start if job is already running (409)', async () => {
    const adapter = new BatchProcessAdapter();
    const server = new ConsoleServer({ port: 63244, adapter });
    await server.start();
    const csrf = server.getCsrfToken();

    try {
      (adapter as any).currentJobState = 'RUNNING';

      const res = await httpRequest({
        port: 63244,
        path: '/api/apply/start',
        method: 'POST',
        headers: { 'x-csrf-nonce': csrf },
        body: { confirmationToken: 'dummy' }
      });
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.error, 'JOB_CONFLICT');
    } finally {
      await server.stop();
    }
  });

  // Test F: startProductionApplyProcess はサーバー側で固定された引数で子プロセスを起動すること
  await runTest('Test F: startProductionApplyProcess spawns child process with fixed mandatory write flags', async () => {
    let capturedArgs: string[] = [];
    const mockSpawn = (cmd: string, args: string[]) => {
      capturedArgs = args;
      return {
        on: () => {},
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        stdin: { write: () => {}, destroyed: false }
      } as any;
    };

    const adapter = new BatchProcessAdapter({ spawnFn: mockSpawn as any });
    adapter.executeValidation({
      schoolsFilePath: 'config/schools.live.csv',
      profile: { storage: 'OFF' }
    });
    const pfReport = createDummyPreflightReport(adapter);
    (adapter as any).loadLatestPreflightReport = () => ({
      preflight: pfReport,
      summary: { schoolResults: [] }
    });

    const prepResult = adapter.prepareProductionApply();
    adapter.startProductionApplyProcess(prepResult.tokenData.token);

    // 必須フラグの存在確認
    assert.ok(capturedArgs.includes('--batch'), 'Must contain --batch');
    assert.ok(capturedArgs.includes('--apply'), 'Must contain --apply');
    assert.ok(capturedArgs.includes('--allow-live-write'), 'Must contain --allow-live-write');
    assert.ok(capturedArgs.includes('--batch-apply'), 'Must contain --batch-apply');
    assert.ok(capturedArgs.includes('--schools'), 'Must contain --schools');
    assert.ok(capturedArgs.includes('--profile'), 'Must contain --profile');
    assert.strictEqual(adapter.getJobState(), 'RUNNING');
  });

  // Test G: Preflight プロセス (Read-only) と Apply プロセス (Write) の実行パス分離検証
  await runTest('Test G: Read-only preflight and Production Apply execution paths are strictly separated', async () => {
    let preflightArgs: string[] = [];
    let applyArgs: string[] = [];

    const mockSpawn = (cmd: string, args: string[]) => {
      if (args.includes('--apply')) {
        applyArgs = args;
      } else {
        preflightArgs = args;
      }
      return {
        on: () => {},
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        stdin: { write: () => {}, destroyed: false }
      } as any;
    };

    const adapter = new BatchProcessAdapter({ spawnFn: mockSpawn as any });
    adapter.executeValidation({
      schoolsFilePath: 'config/schools.live.csv',
      profile: { storage: 'OFF' }
    });

    // 1. Read-only Preflight を起動
    adapter.startBatchProcess('START', {});
    assert.ok(!preflightArgs.includes('--apply'), 'Preflight must NEVER include --apply');
    assert.ok(!preflightArgs.includes('--allow-live-write'), 'Preflight must NEVER include --allow-live-write');
    assert.ok(!preflightArgs.includes('--batch-apply'), 'Preflight must NEVER include --batch-apply');

    // 状態リセット
    (adapter as any).currentJobState = 'COMPLETED';

    // 2. Production Apply を起動
    const pfReport = createDummyPreflightReport(adapter);
    (adapter as any).loadLatestPreflightReport = () => ({
      preflight: pfReport,
      summary: { schoolResults: [] }
    });
    const prepResult = adapter.prepareProductionApply();
    adapter.startProductionApplyProcess(prepResult.tokenData.token);

    assert.ok(applyArgs.includes('--apply'), 'Apply must include --apply');
    assert.ok(applyArgs.includes('--allow-live-write'), 'Apply must include --allow-live-write');
    assert.ok(applyArgs.includes('--batch-apply'), 'Apply must include --batch-apply');
  });

  // Test H: Global Gate 不合格時 (readFailed > 0 等) に POST /api/apply/start が拒絶されること
  await runTest('Test H: Global Gate failure blocks Production Apply start', async () => {
    const adapter = new BatchProcessAdapter();
    const server = new ConsoleServer({ port: 63245, adapter });
    await server.start();
    const csrf = server.getCsrfToken();

    try {
      adapter.executeValidation({
        schoolsFilePath: 'config/schools.live.csv',
        profile: { storage: 'OFF' }
      });
      // 失敗校が存在する不合格レポート
      const failedPfReport = createDummyPreflightReport(adapter, {
        readFailed: 1,
        allReadSucceeded: false
      });
      (adapter as any).loadLatestPreflightReport = () => ({
        preflight: failedPfReport,
        summary: { schoolResults: [] }
      });

      const res = await httpRequest({
        port: 63245,
        path: '/api/apply/prepare',
        method: 'POST',
        headers: { 'x-csrf-nonce': csrf },
        body: {}
      });
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.error, 'UNSAFE_CONFIGURATION');
      assert.ok(res.body.message.includes('読取失敗校が存在するため'));
    } finally {
      await server.stop();
    }
  });

  console.log(`\nPhase 5B.3 Test Results: ${passedTests} passed, ${failedTests} failed`);
  if (failedTests > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
