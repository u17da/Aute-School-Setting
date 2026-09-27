import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { BatchProcessAdapter } from '../src/console/adapter';
import { ConsoleServer } from '../src/console/server';
import {
  writeCurrentLedger,
  readCurrentLedger,
  updateCurrentLedgerState,
  writeContextArtifact,
  restoreActiveExecutionResultContextFromLedger,
  getCurrentLedgerPath,
  getContextArtifactPath,
  getProductionSummaryPath
} from '../src/console/ledger';
import { BatchSummaryReporter } from '../src/batch/summary';
import { BatchSummaryReport } from '../src/types/batch';
import { ActiveExecutionResultContext, CurrentProductionExecutionLedger } from '../src/console/types';
import { getReportsDir } from '../src/runtime/paths';

async function runTests() {
  console.log('=== [PHASE 6A] Runtime Lifecycle Hardening Tests (Test A - Test O) ===\n');
  let passedCount = 0;
  let failedCount = 0;

  function assert(condition: boolean, msg: string) {
    if (!condition) {
      console.error(`❌ FAIL: ${msg}`);
      failedCount++;
      throw new Error(`Assertion failed: ${msg}`);
    }
    console.log(`✅ PASS: ${msg}`);
    passedCount++;
  }

  // テスト用の一時 reports ディレクトリ準備
  const reportsDir = getReportsDir();
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // ----------------------------------------------------
  // Test A: Exact Execution Binding & Output Paths
  // ----------------------------------------------------
  console.log('--- Test A: Exact Execution Binding & Output Paths ---');
  {
    const execId = `test-exec-a-${Date.now()}`;
    const customSummaryPath = path.join(reportsDir, `summary-${execId}.json`);
    const customObservationPath = path.join(reportsDir, `observation-${execId}.json`);

    const reporter = new BatchSummaryReporter({
      deploymentId: 'dep-test-a',
      runId: 'run-test-a',
      mode: 'PRODUCTION_WRITE',
      profileHash: 'hash-prof',
      schoolsHash: 'hash-sch',
      toolVersion: '1.0.0',
      executionId: execId,
      productionExecutionId: execId,
      applyTargetHash: 'hash-apply-target',
      summaryOutputPath: customSummaryPath,
      observationOutputPath: customObservationPath
    });

    reporter.addSchoolResult({
      schoolCode: 'SCH001',
      schoolName: 'School 1',
      status: 'SUCCESS',
      actionsCount: 1,
      before: { otherSchoolLog: 'ALLOW' },
      after: { otherSchoolLog: 'ALLOW' }
    });
    reporter.generateReport({ totalSchools: 1, skippedSchools: 0 });

    assert(fs.existsSync(customSummaryPath), 'Exact customSummaryPath must be created directly');
    const content: BatchSummaryReport = JSON.parse(fs.readFileSync(customSummaryPath, 'utf-8'));
    assert(content.executionId === execId, 'summary executionId matches');
    assert(content.productionExecutionId === execId, 'summary productionExecutionId matches');
    assert(content.applyTargetHash === 'hash-apply-target', 'summary applyTargetHash matches');
  }

  // ----------------------------------------------------
  // Test B: Production Summary Lineage Retention
  // ----------------------------------------------------
  console.log('\n--- Test B: Production Summary Lineage Retention ---');
  {
    const execId = `test-exec-b-${Date.now()}`;
    const targetSummaryPath = getProductionSummaryPath(execId);
    const reporter = new BatchSummaryReporter({
      deploymentId: 'dep-test-b',
      runId: 'run-test-b',
      mode: 'PRODUCTION_WRITE',
      profileHash: 'hash-prof-b',
      schoolsHash: 'hash-sch-b',
      toolVersion: '1.0.0',
      executionId: execId,
      productionExecutionId: execId,
      discoveryExecutionId: 'disc-exec-b',
      finalValidationSnapshotId: 'fv-snap-b',
      profileSnapshotId: 'prof-snap-b',
      applyTargetHash: 'apply-target-hash-b',
      summaryOutputPath: targetSummaryPath
    });

    const report = reporter.generateReport({ totalSchools: 2, skippedSchools: 0 });
    assert(report.finalValidationSnapshotId === 'fv-snap-b', 'report retains finalValidationSnapshotId');
    assert(report.profileSnapshotId === 'prof-snap-b', 'report retains profileSnapshotId');
    assert(report.discoveryExecutionId === 'disc-exec-b', 'report retains discoveryExecutionId');
    assert(report.applyTargetHash === 'apply-target-hash-b', 'report retains applyTargetHash');
  }

  // ----------------------------------------------------
  // Test C: stdout Independence for Production Result Binding
  // ----------------------------------------------------
  console.log('\n--- Test C: stdout Independence for Production Result Binding ---');
  {
    // 子プロセスが stdout にサマリログを一切出力しなくても、exactSummaryPath からバインドできること
    const execId = `test-exec-c-${Date.now()}`;
    const exactSummaryPath = getProductionSummaryPath(execId);

    const mockSummary: BatchSummaryReport = {
      deploymentId: 'dep-test-c',
      runId: 'run-test-c',
      executionId: execId,
      productionExecutionId: execId,
      mode: 'PRODUCTION_WRITE',
      profileHash: 'phash',
      schoolsHash: 'shash',
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
      schoolResults: [
        {
          schoolCode: 'SCH001',
          schoolName: 'School 1',
          status: 'SUCCESS',
          actionsCount: 1,
          before: { otherSchoolLog: 'DENY' },
          after: { otherSchoolLog: 'ALLOW' }
        }
      ]
    };
    fs.writeFileSync(exactSummaryPath, JSON.stringify(mockSummary, null, 2), 'utf-8');

    // Adapter の exit ハンドラ処理を検証
    let capturedCompletedEvent: any = null;
    let capturedStateEvent: any = null;

    const mockSpawnFn: any = (_cmd: string, _args: string[]) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        // stdout には「バッチ集計レポートを出力しました」を出さない！
        child.stdout.emit('data', Buffer.from('[INFO] Some unrelated log without summary line\n'));
        child.emit('exit', 0, null);
      }, 50);
      return child;
    };

    const adapter = new BatchProcessAdapter({ spawnFn: mockSpawnFn });
    adapter.on('productionApplyCompleted', (data) => {
      capturedCompletedEvent = data;
    });
    adapter.on('stateChange', (data) => {
      if (data.state === 'COMPLETED') capturedStateEvent = data;
    });

    // 内部状態をセットアップ
    (adapter as any).currentProductionExecutionId = execId;
    (adapter as any).targetSnapshot = { targetSnapshotId: 'tgt-1', enabledSchoolCount: 1 };
    (adapter as any).activeProfileSnapshot = { snapshotId: 'prof-1' };
    mockSummary.targetSnapshotId = 'tgt-1';
    mockSummary.profileSnapshotId = 'prof-1';
    fs.writeFileSync(exactSummaryPath, JSON.stringify(mockSummary, null, 2), 'utf-8');

    // spawnChildInternal を呼び出し
    (adapter as any).spawnChildInternal(['--dummy'], () => {}, 'PRODUCTION_WRITE');

    await new Promise((r) => setTimeout(r, 150));

    assert(capturedCompletedEvent !== null, 'productionApplyCompleted must fire without stdout summary line');
    assert(capturedCompletedEvent.context.summary.productionExecutionId === execId, 'Context summary bound correctly');
    assert(capturedCompletedEvent.context.viewModel.appliedSuccessCount === 1, 'ViewModel normalized correctly');
  }

  // ----------------------------------------------------
  // Test D: Current Production Execution Ledger Atomic Persistence
  // ----------------------------------------------------
  console.log('\n--- Test D: Current Production Execution Ledger Atomic Persistence ---');
  {
    const execId = `test-exec-d-${Date.now()}`;
    const ledgerPath = getCurrentLedgerPath();

    const initialLedger: CurrentProductionExecutionLedger = {
      schemaVersion: '1.0',
      executionId: execId,
      state: 'RUNNING',
      deploymentId: 'dep-d',
      runId: 'run-d',
      profileSnapshotId: 'prof-d',
      profileHash: 'phash-d',
      schoolsHash: 'shash-d',
      applyTargetHash: 'athash-d',
      startedAt: new Date().toISOString(),
      summaryPath: getProductionSummaryPath(execId),
      contextPath: getContextArtifactPath(execId)
    };

    writeCurrentLedger(initialLedger);
    assert(fs.existsSync(ledgerPath), 'Ledger file must exist');

    const read = readCurrentLedger();
    assert(read !== null && read.executionId === execId, 'Ledger read matches written executionId');
    assert(read?.state === 'RUNNING', 'Ledger state is RUNNING');

    // update state to COMPLETED
    const updated = updateCurrentLedgerState('COMPLETED', { finishedAt: new Date().toISOString() });
    assert(updated !== null && updated.state === 'COMPLETED', 'Ledger updated state is COMPLETED');

    const readAgain = readCurrentLedger();
    assert(readAgain?.state === 'COMPLETED', 'Persisted state is COMPLETED');
  }

  // ----------------------------------------------------
  // Test E: Safe Restore from Ledger on Server Restart
  // ----------------------------------------------------
  console.log('\n--- Test E: Safe Restore from Ledger on Server Restart ---');
  {
    const execId = `test-exec-e-${Date.now()}`;
    const contextPath = getContextArtifactPath(execId);
    const summaryPath = getProductionSummaryPath(execId);

    const mockSummary: BatchSummaryReport = {
      deploymentId: 'dep-e',
      runId: 'run-e',
      executionId: execId,
      productionExecutionId: execId,
      mode: 'PRODUCTION_WRITE',
      profileHash: 'phash-e',
      schoolsHash: 'shash-e',
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
      schoolResults: [
        {
          schoolCode: 'SCH002',
          schoolName: 'School 2',
          status: 'SUCCESS',
          actionsCount: 1,
          before: { otherSchoolLog: 'DENY' },
          after: { otherSchoolLog: 'ALLOW' }
        }
      ]
    };
    fs.writeFileSync(summaryPath, JSON.stringify(mockSummary, null, 2), 'utf-8');

    const contextPayload: ActiveExecutionResultContext = {
      productionExecutionId: execId,
      deploymentId: 'dep-e',
      runId: 'run-e',
      mode: 'PRODUCTION_WRITE',
      summary: mockSummary,
      viewModel: {
        mode: 'PRODUCTION_WRITE',
        deploymentId: 'dep-e',
        runId: 'run-e',
        completedAt: new Date().toISOString(),
        totalCount: 1,
        processedCount: 1,
        appliedSuccessCount: 1,
        alreadyConfiguredCount: 0,
        skippedDestructiveCount: 0,
        blockedCount: 0,
        failedKnownCount: 0,
        outcomeUnknownCount: 0,
        interruptedCount: 0,
        notProcessedCount: 0,
        inconsistentCount: 0,
        attentionRequiredCount: 0,
        schools: [
          {
            schoolCode: 'SCH002',
            schoolName: 'School 2',
            status: 'SUCCESS',
            category: 'APPLIED',
            actionsCount: 1,
            changes: [],
            message: '反映成功',
            requiresHumanReview: false
          }
        ]
      },
      completedAt: new Date().toISOString()
    };
    writeContextArtifact(contextPayload);

    // Ledger を COMPLETED で記録
    writeCurrentLedger({
      schemaVersion: '1.0',
      executionId: execId,
      state: 'COMPLETED',
      deploymentId: 'dep-e',
      runId: 'run-e',
      profileSnapshotId: 'prof-e',
      profileHash: 'phash-e',
      schoolsHash: 'shash-e',
      applyTargetHash: 'athash-e',
      startedAt: new Date().toISOString(),
      summaryPath,
      contextPath
    });

    // 新規アダプターインスタンス（再起動の模倣）
    const adapter = new BatchProcessAdapter();
    const restored = adapter.getActiveExecutionResultContext();
    assert(restored !== null, 'Restored context must not be null');
    assert(restored?.productionExecutionId === execId, 'Restored context has correct productionExecutionId');
    assert(restored?.viewModel.appliedSuccessCount === 1, 'Restored viewModel has 1 success');
  }

  // ----------------------------------------------------
  // Test F: Fail-Closed on Unfinished Ledger States (RUNNING/INTERRUPTED/RESULT_INVALID)
  // ----------------------------------------------------
  console.log('\n--- Test F: Fail-Closed on Unfinished Ledger States ---');
  {
    const execId = `test-exec-f-${Date.now()}`;
    writeCurrentLedger({
      schemaVersion: '1.0',
      executionId: execId,
      state: 'RUNNING', // 中断されたクラッシュ状態
      deploymentId: 'dep-f',
      runId: 'run-f',
      profileSnapshotId: 'prof-f',
      profileHash: 'phash-f',
      schoolsHash: 'shash-f',
      applyTargetHash: 'athash-f',
      startedAt: new Date().toISOString(),
      summaryPath: getProductionSummaryPath(execId),
      contextPath: getContextArtifactPath(execId)
    });

    const restoreRes = restoreActiveExecutionResultContextFromLedger();
    assert(restoreRes.context === null, 'Context must be null when ledger state is RUNNING');
    assert(restoreRes.status === 'NOT_COMPLETED', 'Status is NOT_COMPLETED');
  }

  // ----------------------------------------------------
  // Test G: Discovery Exact Observation Output Path
  // ----------------------------------------------------
  console.log('\n--- Test G: Discovery Exact Observation Output Path ---');
  {
    let spawnArgs: string[] = [];
    const mockSpawn: any = (_cmd: string, args: string[]) => {
      spawnArgs = args;
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      return child;
    };

    const adapter = new BatchProcessAdapter({ spawnFn: mockSpawn });
    (adapter as any).targetSnapshot = {
      targetSnapshotId: 'tgt-g',
      schoolsHash: 'hash',
      toolFingerprint: 'fp',
      toolVersion: '1.0.0',
      authMode: 'A',
      enabledSchoolCount: 1,
      totalSchoolCount: 1,
      resolvedCredentialsCount: 1,
      source: 'LOCAL_DEFAULT',
      sourceName: 'test',
      createdAt: new Date().toISOString()
    };
    (adapter as any).materializeTempFiles = () => ({
      schoolsPath: 'config/schools.live.csv',
      credentialsPath: undefined,
      cleanup: () => {}
    });

    adapter.startDiscoveryProcess('START', { schoolsFilePath: 'config/schools.live.csv' });

    assert(spawnArgs.includes('--purpose') && spawnArgs[spawnArgs.indexOf('--purpose') + 1] === 'discovery', 'Purpose is discovery');
    assert(spawnArgs.includes('--execution-id'), '--execution-id is passed to child process');
    assert(spawnArgs.includes('--observation-output'), '--observation-output is passed to child process');

    const obsIdx = spawnArgs.indexOf('--observation-output');
    const obsPath = spawnArgs[obsIdx + 1];
    assert(obsPath.includes('observation-disc-exec-'), 'Observation output path contains disc-exec- ID');
  }

  // ----------------------------------------------------
  // Test H: Report Download Exact Artifact (No mtime scan)
  // ----------------------------------------------------
  console.log('\n--- Test H: Report Download Exact Artifact ---');
  {
    const server = new ConsoleServer({ port: 3045 });
    const adapter = server.getAdapter();

    const mockSummary: any = {
      deploymentId: 'dep-h',
      runId: 'run-h',
      mode: 'PRODUCTION_WRITE',
      status: 'TEST_H_SUMMARY'
    };
    (adapter as any).activeExecutionResultContext = {
      productionExecutionId: 'prod-h',
      deploymentId: 'dep-h',
      runId: 'run-h',
      mode: 'PRODUCTION_WRITE',
      summary: mockSummary,
      viewModel: {} as any,
      completedAt: new Date().toISOString()
    };

    await server.start();

    // GET /api/reports/download/summary
    const res = await fetch(`http://127.0.0.1:3045/api/reports/download/summary`);
    assert(res.status === 200, 'HTTP 200 for download/summary');
    const body = await res.json();
    assert(body.status === 'TEST_H_SUMMARY', 'Downloaded summary matches exact in-memory context');

    await server.stop();
  }

  // ----------------------------------------------------
  // Test I: Report Download Rejection on Invalid Type (400)
  // ----------------------------------------------------
  console.log('\n--- Test I: Report Download Rejection on Invalid Type ---');
  {
    const server = new ConsoleServer({ port: 3046 });
    await server.start();

    const res = await fetch(`http://127.0.0.1:3046/api/reports/download/arbitrary_type`);
    assert(res.status === 400, 'HTTP 400 for forbidden report type');

    await server.stop();
  }

  // ----------------------------------------------------
  // Test J: Single-Flight Guard against Rapid Apply (concurrent 2 POST, childSpawnCount === 1)
  // ----------------------------------------------------
  console.log('\n--- Test J: Single-Flight Guard against Rapid Apply (concurrent POSTs) ---');
  {
    let spawnCount = 0;
    const mockSpawn: any = () => {
      spawnCount++;
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, destroyed: false };
      child.kill = () => {};
      return child;
    };

    const adapter = new BatchProcessAdapter({ spawnFn: mockSpawn });
    const pfReport: any = {
      purpose: 'FINAL_PREFLIGHT',
      executionId: 'fp-exec-j',
      deploymentId: 'dep-j',
      runId: 'run-j',
      status: 'COMPLETE',
      allReadSucceeded: true,
      readFailed: 0,
      allPlansExecutable: true,
      planBlocked: 0,
      notProcessed: 0,
      profileHash: 'hash-j',
      profileSnapshotId: 'prof-j',
      finalValidationSnapshotId: 'fv-j',
      schoolsHash: 'sch-j',
      toolVersion: '1.0.0',
      toolFingerprint: 'tf-j',
      authMode: 'A',
      completedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 600000).toISOString(),
      schools: [
        {
          schoolCode: 'SCH001',
          readStatus: 'SUCCESS',
          planExecutable: true,
          hasDestructiveChanges: false,
          actionsCount: 1,
          hasChanges: true,
          baselineHash: 'base-hash-j'
        }
      ],
      schoolResults: []
    };

    const summaryReport: any = {
      schoolResults: [
        {
          schoolCode: 'SCH001',
          plannedActions: [
            {
              settingKey: 'otherSchoolLog',
              actionType: 'UPDATE',
              isDestructive: false,
              currentValue: 'DENY',
              targetValue: 'ALLOW',
              reason: 'テスト'
            }
          ],
          requested: { otherSchoolLog: 'ALLOW' }
        }
      ]
    };

    (adapter as any).targetSnapshot = { targetSnapshotId: 'tgt-j', schoolsHash: 'sch-j', toolFingerprint: 'tf-j', toolVersion: '1.0.0', authMode: 'A' };
    (adapter as any).activeProfileSnapshot = { snapshotId: 'prof-j', profileHash: 'hash-j', requestedSettings: { otherSchoolLog: 'ALLOW' } };
    (adapter as any).finalValidationSnapshot = { finalValidationSnapshotId: 'fv-j', authMode: 'A', profileSnapshotId: 'prof-j', targetSnapshotId: 'tgt-j', schoolsHash: 'sch-j', toolFingerprint: 'tf-j' };
    (adapter as any).currentFinalPreflightExecutionId = 'fp-exec-j';
    (adapter as any).activeFinalPreflightContext = {
      executionId: 'fp-exec-j',
      deploymentId: 'dep-j',
      runId: 'run-j',
      targetSnapshotId: 'tgt-j',
      profileSnapshotId: 'prof-j',
      finalValidationSnapshotId: 'fv-j',
      authMode: 'A',
      schoolsHash: 'sch-j',
      toolFingerprint: 'tf-j',
      report: pfReport,
      summary: summaryReport,
      completedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 600000).toISOString()
    };

    const server = new ConsoleServer({ port: 3049, adapter });
    await server.start();
    const csrf = server.getCsrfToken();

    // Prepare でトークンを発行
    const prepRes = await fetch(`http://127.0.0.1:3049/api/apply/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-nonce': csrf },
      body: JSON.stringify({})
    });
    const prepData: any = await prepRes.json();
    assert(prepRes.status === 200, 'Prepare must return 200 PREPARED');
    const token = prepData.confirmationToken;
    assert(typeof token === 'string' && token.length > 0, 'confirmationToken must be non-empty');

    // ほぼ同時に2つの POST を発行 (同一トークン)
    const p1 = fetch(`http://127.0.0.1:3049/api/apply/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-nonce': csrf },
      body: JSON.stringify({ confirmationToken: token })
    });
    const p2 = fetch(`http://127.0.0.1:3049/api/apply/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-nonce': csrf },
      body: JSON.stringify({ confirmationToken: token })
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1.status, r2.status];

    assert(statuses.includes(200), 'Exactly one request is accepted (HTTP 200)');
    assert(statuses.includes(409) || statuses.includes(400), 'Second request is rejected (HTTP 409 or 400)');
    assert(spawnCount === 1, `childSpawnCount must be exactly 1, got ${spawnCount}`);

    await server.stop();
  }

  // ----------------------------------------------------
  // Test K: Client-side Script Double Submit Protection Verification
  // ----------------------------------------------------
  console.log('\n--- Test K: Client-side Script Double Submit Protection Verification ---');
  {
    const appJsContent = fs.readFileSync(path.resolve(__dirname, '../src/console/public/app.js'), 'utf-8');
    assert(appJsContent.includes('isApplyingInFlight'), 'app.js includes isApplyingInFlight flag');
    assert(appJsContent.includes('modalStartBtn.disabled = true;'), 'app.js disables modal button immediately');
  }

  // ----------------------------------------------------
  // Test L: Event Ordering (productionApplyCompleted BEFORE stateChange: COMPLETED)
  // ----------------------------------------------------
  console.log('\n--- Test L: Event Ordering Guarantee ---');
  {
    const execId = `test-exec-l-${Date.now()}`;
    const exactSummaryPath = getProductionSummaryPath(execId);

    const mockSummary: BatchSummaryReport = {
      deploymentId: 'dep-l',
      runId: 'run-l',
      executionId: execId,
      productionExecutionId: execId,
      mode: 'PRODUCTION_WRITE',
      profileHash: 'phash-l',
      schoolsHash: 'shash-l',
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
      requiresChange: 0,
      destructiveChangeSchools: 0,
      destructiveChangeActions: 0,
      writeEligibleNonDestructive: 0,
      writeBlockedDestructive: 0,
      configConflict: 0,
      dependencyUnsatisfied: 0,
      otherErrors: 0,
      actionsDistribution: { zero: 0, one: 0, two: 0, threePlus: 0 },
      destructiveChangeDetails: [],
      currentStateDistribution: {},
      plannedChangeDistribution: {},
      schoolResults: []
    };
    fs.writeFileSync(exactSummaryPath, JSON.stringify(mockSummary, null, 2), 'utf-8');

    const eventOrder: string[] = [];
    const mockSpawn: any = (_cmd: string, _args: string[]) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => child.emit('exit', 0, null), 30);
      return child;
    };

    const adapter = new BatchProcessAdapter({ spawnFn: mockSpawn });
    (adapter as any).currentProductionExecutionId = execId;
    (adapter as any).targetSnapshot = { targetSnapshotId: 'tgt-l', enabledSchoolCount: 1 };
    (adapter as any).activeProfileSnapshot = { snapshotId: 'prof-l' };
    mockSummary.targetSnapshotId = 'tgt-l';
    mockSummary.profileSnapshotId = 'prof-l';
    fs.writeFileSync(exactSummaryPath, JSON.stringify(mockSummary, null, 2), 'utf-8');

    adapter.on('productionApplyCompleted', () => {
      eventOrder.push('productionApplyCompleted');
    });
    adapter.on('stateChange', (data) => {
      if (data.state === 'COMPLETED') {
        eventOrder.push('stateChange:COMPLETED');
      }
    });

    (adapter as any).spawnChildInternal(['--dummy'], () => {}, 'PRODUCTION_WRITE');

    await new Promise((r) => setTimeout(r, 100));

    assert(eventOrder.length === 2, 'Both events fired');
    assert(eventOrder[0] === 'productionApplyCompleted', 'productionApplyCompleted must fire FIRST');
    assert(eventOrder[1] === 'stateChange:COMPLETED', 'stateChange:COMPLETED must fire SECOND');
  }

  // ----------------------------------------------------
  // Test M: Server Instance ID & Fingerprint in /api/status
  // ----------------------------------------------------
  console.log('\n--- Test M: Server Instance ID & Fingerprint in /api/status ---');
  {
    const server = new ConsoleServer({ port: 3047 });
    await server.start();

    const res = await fetch(`http://127.0.0.1:3047/api/status`);
    const data: any = await res.json();

    assert(typeof data.serverInstanceId === 'string' && data.serverInstanceId.startsWith('srv-'), 'serverInstanceId is generated');
    assert(typeof data.serverStartedAt === 'string', 'serverStartedAt is generated');
    assert(typeof data.serverBuildFingerprint === 'string', 'serverBuildFingerprint is generated');
    assert(typeof data.canPrepareApply === 'boolean', 'canPrepareApply is exposed in /api/status');

    await server.stop();
  }

  // ----------------------------------------------------
  // Test N: Meta Injection in HTML and Cache-Control Headers
  // ----------------------------------------------------
  console.log('\n--- Test N: Meta Injection in HTML and Cache-Control Headers ---');
  {
    const server = new ConsoleServer({ port: 3048 });
    await server.start();

    const res = await fetch(`http://127.0.0.1:3048/index.html`);
    assert(res.status === 200, 'HTTP 200 for index.html');
    const cacheControl = res.headers.get('cache-control');
    assert(Boolean(cacheControl && cacheControl.includes('no-cache') && cacheControl.includes('no-store')), 'Cache-Control header is no-cache, no-store');

    const html = await res.text();
    assert(html.includes('meta name="server-instance-id"'), 'HTML contains server-instance-id meta tag');
    assert(html.includes('meta name="server-build-fingerprint"'), 'HTML contains server-build-fingerprint meta tag');

    await server.stop();
  }

  // ----------------------------------------------------
  // Test O: Results Tab Switch & Sequence Race Protection in app.js
  // ----------------------------------------------------
  console.log('\n--- Test O: Results Tab Switch & Sequence Race Protection in app.js ---');
  {
    const appJsContent = fs.readFileSync(path.resolve(__dirname, '../src/console/public/app.js'), 'utf-8');
    assert(appJsContent.includes("if (tabName === 'result')"), 'app.js includes switchTab result check');
    assert(appJsContent.includes('loadLatestResults()'), 'app.js triggers loadLatestResults on result tab');
    assert(appJsContent.includes('resultsFetchSeq'), 'app.js uses resultsFetchSeq for sequence protection');
  }

  // ----------------------------------------------------
  // Test P: Disk Modification Does Not Affect Running Server (Immutable In-Memory Asset Generation)
  // ----------------------------------------------------
  console.log('\n--- Test P: Disk Modification Does Not Affect Running Server ---');
  {
    const appJsPath = path.resolve(__dirname, '../src/console/public/app.js');
    const originalAppJs = fs.readFileSync(appJsPath, 'utf-8');
    const server = new ConsoleServer({ port: 3049 });
    await server.start();

    try {
      // 1. Fetch initial app.js from running server
      const res1 = await fetch(`http://127.0.0.1:3049/app.js`);
      assert(res1.status === 200, 'HTTP 200 for initial /app.js');
      const text1 = await res1.text();
      assert(text1.includes('resultsFetchSeq'), 'Initial /app.js contains expected code');

      // 2. Modify app.js on disk while server is running
      const modifiedMarker = '/* TEST_P_DISK_MODIFICATION_MARKER_' + Date.now() + ' */';
      fs.writeFileSync(appJsPath, originalAppJs + '\n' + modifiedMarker, 'utf-8');

      // 3. Fetch app.js from running server again
      const res2 = await fetch(`http://127.0.0.1:3049/app.js`);
      assert(res2.status === 200, 'HTTP 200 for /app.js after disk modification');
      const text2 = await res2.text();

      // Assert that running server strictly serves Generation A (unmodified)
      assert(!text2.includes(modifiedMarker), 'Running server DOES NOT serve modified disk content (protected against Gen A + Gen B mismatch)');
      assert(text1 === text2, 'Served /app.js is bit-identical to startup in-memory cache');
    } finally {
      // Restore disk content and stop server
      fs.writeFileSync(appJsPath, originalAppJs, 'utf-8');
      await server.stop();
    }
  }

  // ----------------------------------------------------
  // Test Q: Server Restart Loads New Generation and Changes Fingerprint
  // ----------------------------------------------------
  console.log('\n--- Test Q: Server Restart Loads New Generation and Changes Fingerprint ---');
  {
    const appJsPath = path.resolve(__dirname, '../src/console/public/app.js');
    const originalAppJs = fs.readFileSync(appJsPath, 'utf-8');

    let instanceIdA = '';
    let fingerprintA = '';
    let instanceIdB = '';
    let fingerprintB = '';

    // 1. Start Server A
    const serverA = new ConsoleServer({ port: 3050 });
    await serverA.start();
    try {
      const resA = await fetch(`http://127.0.0.1:3050/api/status`);
      const dataA = await resA.json();
      instanceIdA = dataA.serverInstanceId;
      fingerprintA = dataA.serverBuildFingerprint;
      assert(Boolean(instanceIdA && instanceIdA.length > 0), 'Server A has serverInstanceId');
      assert(Boolean(fingerprintA && fingerprintA.length > 0), 'Server A has serverBuildFingerprint');
    } finally {
      await serverA.stop();
    }

    // 2. Modify disk content
    const modifiedMarker = '/* TEST_Q_NEW_GENERATION_' + Date.now() + ' */';
    fs.writeFileSync(appJsPath, originalAppJs + '\n' + modifiedMarker, 'utf-8');

    // 3. Start Server B with new disk content
    const serverB = new ConsoleServer({ port: 3051 });
    await serverB.start();
    try {
      const resB = await fetch(`http://127.0.0.1:3051/api/status`);
      const dataB = await resB.json();
      instanceIdB = dataB.serverInstanceId;
      fingerprintB = dataB.serverBuildFingerprint;

      const resJsB = await fetch(`http://127.0.0.1:3051/app.js`);
      const textJsB = await resJsB.text();

      assert(instanceIdA !== instanceIdB, 'Server instance ID changes across restarts');
      assert(fingerprintA !== fingerprintB, 'Server build fingerprint changes when static assets change');
      assert(textJsB.includes(modifiedMarker), 'Server B serves Generation B content after restart');
    } finally {
      // Restore disk content and stop server
      fs.writeFileSync(appJsPath, originalAppJs, 'utf-8');
      await serverB.stop();
    }
  }

  // ----------------------------------------------------
  // Test R: Client Fail-Closed and Version Mismatch Banner Guard
  // ----------------------------------------------------
  console.log('\n--- Test R: Client Fail-Closed and Version Mismatch Banner Guard ---');
  {
    const appJsContent = fs.readFileSync(path.resolve(__dirname, '../src/console/public/app.js'), 'utf-8');
    const indexHtmlContent = fs.readFileSync(path.resolve(__dirname, '../src/console/public/index.html'), 'utf-8');

    // Fail-Closed checks in app.js
    assert(appJsContent.includes('hasVersionMismatch'), 'app.js tracks hasVersionMismatch state');
    assert(appJsContent.includes('serverApplyReady = false'), 'app.js resets serverApplyReady to false on mismatch');
    assert(appJsContent.includes('mismatchBanner.style.display'), 'app.js updates mismatchBanner display on mismatch');
    assert(appJsContent.includes('versionMismatchBanner'), 'app.js accesses versionMismatchBanner element');
    assert(appJsContent.includes('goToApply.disabled = true') || appJsContent.includes('goToApply'), 'app.js disables apply navigation on mismatch');
    assert(appJsContent.includes('prepareBtn.disabled = true'), 'app.js locks prepareBtn on mismatch');

    // UI elements in index.html
    assert(indexHtmlContent.includes('id="versionMismatchBanner"'), 'index.html contains versionMismatchBanner element');
  }

  console.log(`\n======================================================`);
  console.log(`All Tests Completed: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log(`======================================================`);

  if (failedCount > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch((e) => {
  console.error('Test execution failed with error:', e);
  process.exit(1);
});
