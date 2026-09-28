/**
 * Phase 6B: 破壊的変更（予約投稿削除リスク）の明示的合意・本番反映結合テスト
 * 
 * 実行: npx ts-node -T test/phase6b_destructive_apply.test.ts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { BatchProcessAdapter } from '../src/console/adapter';
import { ConsoleServer } from '../src/console/server';
import { PreflightReport } from '../src/types/batch';

let passedCount = 0;
let failedCount = 0;

function runAssert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`✅ PASS: ${msg}`);
    passedCount++;
  } else {
    console.error(`❌ FAIL: ${msg}`);
    failedCount++;
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTests() {
  console.log('=== [PHASE 6B] Destructive Changes Consent & Apply Tests ===\n');

  const baseReport: PreflightReport = {
    purpose: 'FINAL_PREFLIGHT',
    executionId: 'fp-exec-6b',
    deploymentId: 'dep-6b',
    runId: 'run-6b',
    status: 'COMPLETE',
    writeGateEligible: true,
    total: 2,
    processed: 2,
    readSuccess: 2,
    allReadSucceeded: true,
    readFailed: 0,
    allPlansExecutable: true,
    planBlocked: 0,
    notProcessed: 0,
    alreadyConfigured: 0,
    requiresChange: 2,
    destructiveChangeSchools: 2, // 2校とも破壊的変更（チャンネルOFFなど）
    profileHash: 'hash-6b',
    profileSnapshotId: 'prof-6b',
    finalValidationSnapshotId: 'fv-6b',
    schoolsHash: 'sch-6b',
    toolVersion: '1.0.0',
    toolFingerprint: 'tf-6b',
    authMode: 'A',
    completedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 600000).toISOString(),
    summaryPath: 'dummy-summary.json',
    schools: [
      {
        schoolCode: 'SCH001',
        schoolName: '学校1',
        readStatus: 'SUCCESS',
        planExecutable: true,
        hasDestructiveChanges: true, // 破壊的変更あり
        actionsCount: 1,
        hasChanges: true,
        writeEligible: false,
        baselineHash: 'base-hash-6b-1'
      },
      {
        schoolCode: 'SCH002',
        schoolName: '学校2',
        readStatus: 'SUCCESS',
        planExecutable: true,
        hasDestructiveChanges: true, // 破壊的変更あり
        actionsCount: 1,
        hasChanges: true,
        writeEligible: false,
        baselineHash: 'base-hash-6b-2'
      }
    ]
  };

  const summaryReport: any = {
    schoolResults: [
      {
        schoolCode: 'SCH001',
        plannedActions: [{ settingKey: 'allChannel', actionType: 'UPDATE', isDestructive: true, currentValue: 'ON', targetValue: 'OFF' }],
        requested: { allChannel: 'OFF' }
      },
      {
        schoolCode: 'SCH002',
        plannedActions: [{ settingKey: 'parentChannel', actionType: 'UPDATE', isDestructive: true, currentValue: 'ON', targetValue: 'OFF' }],
        requested: { parentChannel: 'OFF' }
      }
    ]
  };

  function setupAdapter(): BatchProcessAdapter {
    const adapter = new BatchProcessAdapter();
    (adapter as any).targetSnapshot = { targetSnapshotId: 'tgt-6b', schoolsHash: 'sch-6b', toolFingerprint: 'tf-6b', toolVersion: '1.0.0', authMode: 'A' };
    (adapter as any).activeProfileSnapshot = { snapshotId: 'prof-6b', profileHash: 'hash-6b', requestedSettings: { allChannel: 'OFF', parentChannel: 'OFF' } };
    (adapter as any).finalValidationSnapshot = { finalValidationSnapshotId: 'fv-6b', authMode: 'A', profileSnapshotId: 'prof-6b', targetSnapshotId: 'tgt-6b', schoolsHash: 'sch-6b', toolFingerprint: 'tf-6b' };
    (adapter as any).currentFinalPreflightExecutionId = 'fp-exec-6b';
    (adapter as any).activeFinalPreflightContext = {
      executionId: 'fp-exec-6b',
      deploymentId: 'dep-6b',
      runId: 'run-6b',
      targetSnapshotId: 'tgt-6b',
      profileSnapshotId: 'prof-6b',
      finalValidationSnapshotId: 'fv-6b',
      authMode: 'A',
      schoolsHash: 'sch-6b',
      toolFingerprint: 'tf-6b',
      report: baseReport,
      summary: summaryReport,
      completedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 600000).toISOString()
    };
    return adapter;
  }

  // ----------------------------------------------------
  // Case 1: allowDestructive = false (デフォルト非破壊保護)
  // ----------------------------------------------------
  console.log('--- Case 1: allowDestructive = false (Safe by Default: All Destructive Skipped) ---');
  {
    const adapter = setupAdapter();
    let errorThrown: any = null;
    try {
      adapter.prepareProductionApply(undefined, undefined, false);
    } catch (e: any) {
      errorThrown = e;
    }
    runAssert(errorThrown !== null, 'prepareProductionApply throws error when all schools are destructive and allowDestructive=false');
    runAssert(errorThrown.issueCode === 'CONFIG_INVALID' || errorThrown.message.includes('0 校'), 'Error is CONFIG_INVALID (0 schools eligible)');
  }

  // ----------------------------------------------------
  // Case 2: allowDestructive = true (明示的合意による破壊的変更適用)
  // ----------------------------------------------------
  console.log('\n--- Case 2: allowDestructive = true (Explicit Consent Manifest & Token) ---');
  {
    const adapter = setupAdapter();
    const result = adapter.prepareProductionApply(undefined, undefined, true);
    runAssert(result.manifest.applyTargets.length === 2, `applyTargets length is 2, got ${result.manifest.applyTargets.length}`);
    runAssert(result.manifest.skippedDestructiveCount === 0, `skippedDestructiveCount is 0, got ${result.manifest.skippedDestructiveCount}`);
    runAssert(result.manifest.allowDestructive === true, 'manifest.allowDestructive is true');
    runAssert(result.tokenData.allowDestructive === true, 'tokenData.allowDestructive is true');
    runAssert(typeof result.tokenData.token === 'string' && result.tokenData.token.length > 0, 'confirmationToken is issued');
  }

  // ----------------------------------------------------
  // Case 3: API Endpoint Integration (POST /api/apply/prepare)
  // ----------------------------------------------------
  console.log('\n--- Case 3: API Endpoint Integration (POST /api/apply/prepare) ---');
  {
    const adapter = setupAdapter();
    const server = new ConsoleServer({ port: 3090, adapter });
    await server.start();
    const csrf = server.getCsrfToken();

    try {
      // 1. Without allowDestructive -> 400
      const res1 = await fetch('http://127.0.0.1:3090/api/apply/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-nonce': csrf },
        body: JSON.stringify({})
      });
      runAssert(res1.status === 400, `Prepare without allowDestructive returns 400, got ${res1.status}`);

      // 2. With allowDestructive: false -> 400
      const res2 = await fetch('http://127.0.0.1:3090/api/apply/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-nonce': csrf },
        body: JSON.stringify({ allowDestructive: false })
      });
      runAssert(res2.status === 400, `Prepare with allowDestructive:false returns 400, got ${res2.status}`);

      // 3. With allowDestructive: true -> 200 PREPARED
      const res3 = await fetch('http://127.0.0.1:3090/api/apply/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-nonce': csrf },
        body: JSON.stringify({ allowDestructive: true })
      });
      runAssert(res3.status === 200, `Prepare with allowDestructive:true returns 200, got ${res3.status}`);
      const data3: any = await res3.json();
      runAssert(data3.status === 'PREPARED', 'Status is PREPARED');
      runAssert(data3.targetCount === 2, `targetCount is 2, got ${data3.targetCount}`);
      runAssert(data3.allowDestructive === true, 'allowDestructive is true in response');
    } finally {
      await server.stop();
    }
  }

  // ----------------------------------------------------
  // Case 4: Subprocess Execution Boundary (--allow-destructive flag check)
  // ----------------------------------------------------
  console.log('\n--- Case 4: Subprocess Execution Boundary (--allow-destructive flag check) ---');
  {
    let capturedArgs: string[] = [];
    const mockSpawn: any = (_cmd: string, args: string[]) => {
      capturedArgs = args;
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, destroyed: false };
      child.kill = () => {};
      return child;
    };

    const adapter = setupAdapter();
    (adapter as any).spawnFn = mockSpawn;

    // 1. Prepare with allowDestructive: true
    const prepResult = adapter.prepareProductionApply(undefined, undefined, true);
    const token = prepResult.tokenData.token;

    // 2. Start process
    adapter.startProductionApplyProcess(token);

    runAssert(capturedArgs.includes('--apply'), 'Subprocess args contain --apply');
    runAssert(capturedArgs.includes('--allow-live-write'), 'Subprocess args contain --allow-live-write');
    runAssert(capturedArgs.includes('--allow-destructive'), 'Subprocess args contain --allow-destructive when token permits');
  }

  // ----------------------------------------------------
  // Case 5: UI Elements & Script Consistency Check
  // ----------------------------------------------------
  console.log('\n--- Case 5: UI Elements & Script Consistency Check ---');
  {
    const indexHtml = fs.readFileSync(path.resolve(__dirname, '../src/console/public/index.html'), 'utf-8');
    const appJs = fs.readFileSync(path.resolve(__dirname, '../src/console/public/app.js'), 'utf-8');

    runAssert(indexHtml.includes('id="applyAllowDestructiveCheckbox"'), 'index.html has applyAllowDestructiveCheckbox');
    runAssert(indexHtml.includes('id="modalDestructiveAlert"'), 'index.html has modalDestructiveAlert');
    runAssert(indexHtml.includes('id="modalDestructiveConfirmCheckbox"'), 'index.html has modalDestructiveConfirmCheckbox');

    runAssert(appJs.includes('onAllowDestructiveToggled'), 'app.js includes onAllowDestructiveToggled function');
    runAssert(appJs.includes('updateApplyGateCounts'), 'app.js includes updateApplyGateCounts function');
    runAssert(appJs.includes('updateModalApplyStartBtn'), 'app.js includes updateModalApplyStartBtn function');
    runAssert(appJs.includes('allowDestructive'), 'app.js passes allowDestructive in prepare call');
  }

  console.log(`\n======================================================`);
  console.log(`Phase 6B Destructive Apply Tests: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log(`======================================================`);

  if (failedCount > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch((e) => {
  console.error('Test error:', e);
  process.exit(1);
});
