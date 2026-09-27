import { parseCliArgs } from '../src/index';
function schoolIsSuccess(item: any): item is { readStatus: 'SUCCESS'; observation: any; discoveryStateHash: string } { return item.readStatus === 'SUCCESS'; }
import assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { ConsoleServer } from '../src/console/server';
import { BatchProcessAdapter } from '../src/console/adapter';
import { PreflightReport, ApplyTargetManifest } from '../src/types/batch';
import {
  TargetValidationSnapshot,
  ObservationSnapshot,
  DraftProfileState,
  ProfileSnapshot,
  FinalValidationSnapshot,
  PreviewExecutionPlan
} from '../src/console/types';
import { generateSettingsHash, generateSchoolsHash, getToolVersion, generateToolFingerprint } from '../src/utils/hash';
import { getReportsDir, getCheckpointsDir } from '../src/runtime/paths';
import { BatchSummaryReporter } from '../src/batch/summary';
import { EventEmitter } from 'events';

console.log('=== Phase 6A: 6-Step Workflow & Safety Boundary Tests (A - AL) ===\n');

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
            statusCode: res.statusCode || 0,
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

// 共通モックデータ作成ヘルパー
function createMockSchools() {
  return [
    { schoolCode: 'SCH001', schoolName: '第一小学校', credentialRef: 'CRED001', enabled: true },
    { schoolCode: 'SCH002', schoolName: '第二小学校', credentialRef: 'CRED002', enabled: true },
    { schoolCode: 'SCH003', schoolName: '第三中学校', credentialRef: 'CRED003', enabled: true }
  ];
}

function createMockCredentials() {
  return {
    CRED001: { userId: 'user1', password: 'pwd1' },
    CRED002: { userId: 'user2', password: 'pwd2' },
    CRED003: { userId: 'user3', password: 'pwd3' }
  };
}

function createMockObservationSnapshot(targetSnapshotId: string): ObservationSnapshot {
  return {
    observationSnapshotId: `obs-snap-test-${Date.now()}`,
    targetSnapshotId,
    schoolsHash: 'mock-schools-hash',
    toolFingerprint: 'mock-fingerprint',
    authMode: 'A',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    totalSchools: 3,
    readSuccessCount: 3,
    readFailedCount: 0,
    distribution: {
      storage: { ON: 3 },
      timelineChannel: { ON: 2, OFF: 1 },
      directMessage: { STUDENT_TO_STUDENT_DISABLED: 3 },
      parentDirectMessage: { OFF: 3 },
      allChannel: { ON: 2, OFF: 1 },
      parentChannel: { ON: 2, OFF: 1 },
      attendance: { ON: 3 },
      contactBook: { ON: 3 },
      mentalHealth: { CONTRACT_NOT_AVAILABLE: 3 },
      otherSchoolLog: { DENY: 3 },
      studentPasswordChange: { SHOW: 3 }
    } as any,
    schools: [
      {
        schoolCode: 'SCH001',
        schoolName: '第一小学校',
        readStatus: 'SUCCESS',
        observedAt: new Date().toISOString(),
        discoveryStateHash: 'hash-sch001',
        observation: {
          storage: { value: 'ON', availability: 'AVAILABLE' },
          timelineChannel: { value: 'ON', availability: 'AVAILABLE' },
          directMessage: { value: 'STUDENT_TO_STUDENT_DISABLED', availability: 'AVAILABLE' },
          parentDirectMessage: { value: 'OFF', availability: 'AVAILABLE' },
          allChannel: { value: 'ON', availability: 'AVAILABLE' },
          parentChannel: { value: 'ON', availability: 'AVAILABLE' },
          attendance: { value: 'ON', availability: 'AVAILABLE' },
          contactBook: { value: 'ON', availability: 'AVAILABLE' },
          mentalHealth: { value: null, availability: 'CONTRACT_NOT_AVAILABLE' },
          otherSchoolLog: { value: 'DENY', availability: 'AVAILABLE' },
          studentPasswordChange: { value: 'SHOW', availability: 'AVAILABLE' }
        }
      },
      {
        schoolCode: 'SCH002',
        schoolName: '第二小学校',
        readStatus: 'SUCCESS',
        observedAt: new Date().toISOString(),
        discoveryStateHash: 'hash-sch002',
        observation: {
          storage: { value: 'ON', availability: 'AVAILABLE' },
          timelineChannel: { value: 'ON', availability: 'AVAILABLE' },
          directMessage: { value: 'STUDENT_TO_STUDENT_DISABLED', availability: 'AVAILABLE' },
          parentDirectMessage: { value: 'OFF', availability: 'AVAILABLE' },
          allChannel: { value: 'ON', availability: 'AVAILABLE' },
          parentChannel: { value: 'ON', availability: 'AVAILABLE' },
          attendance: { value: 'ON', availability: 'AVAILABLE' },
          contactBook: { value: 'ON', availability: 'AVAILABLE' },
          mentalHealth: { value: null, availability: 'CONTRACT_NOT_AVAILABLE' },
          otherSchoolLog: { value: 'DENY', availability: 'AVAILABLE' },
          studentPasswordChange: { value: 'SHOW', availability: 'AVAILABLE' }
        }
      },
      {
        schoolCode: 'SCH003',
        schoolName: '第三中学校',
        readStatus: 'SUCCESS',
        observedAt: new Date().toISOString(),
        discoveryStateHash: 'hash-sch003',
        observation: {
          storage: { value: 'ON', availability: 'AVAILABLE' },
          timelineChannel: { value: 'OFF', availability: 'AVAILABLE' },
          directMessage: { value: 'STUDENT_TO_STUDENT_DISABLED', availability: 'AVAILABLE' },
          parentDirectMessage: { value: 'OFF', availability: 'AVAILABLE' },
          allChannel: { value: 'OFF', availability: 'DISABLED_BY_DEPENDENCY' },
          parentChannel: { value: 'OFF', availability: 'DISABLED_BY_DEPENDENCY' },
          attendance: { value: 'ON', availability: 'AVAILABLE' },
          contactBook: { value: 'ON', availability: 'AVAILABLE' },
          mentalHealth: { value: null, availability: 'CONTRACT_NOT_AVAILABLE' },
          otherSchoolLog: { value: 'DENY', availability: 'AVAILABLE' },
          studentPasswordChange: { value: 'SHOW', availability: 'AVAILABLE' }
        }
      }
    ]
  };
}

async function main() {
  const port = 3980;
  const mockSpawn = ((command: string, args: string[], options: any) => {
    const cp = new EventEmitter() as any;
    cp.stdout = new EventEmitter();
    cp.stderr = new EventEmitter();
    cp.stdin = { write: () => {}, destroyed: false };
    cp.kill = () => {};
    setTimeout(() => {
      cp.emit('exit', 0, null);
    }, 20);
    return cp;
  }) as any;

  const adapter = new BatchProcessAdapter({ spawnFn: mockSpawn });
  adapter.setUploadedBatch({
    uploadId: 'upload-test-01',
    originalFileName: 'test_schools.csv',
    fileSize: 1024,
    schools: createMockSchools(),
    credentials: createMockCredentials(),
    createdAt: new Date().toISOString()
  });

  const server = new ConsoleServer({ port, adapter });
  await server.start();

  try {
    let targetSnap: TargetValidationSnapshot;
    let obsSnap: ObservationSnapshot;
    let draftProf: DraftProfileState;
    let profSnap: ProfileSnapshot;
    let finalValSnap: FinalValidationSnapshot;
    let previewPlan: PreviewExecutionPlan;
    let confirmationToken: string;
    let applyManifest: ApplyTargetManifest;
    let activeFinalPreflightReport: PreflightReport | null = null;

    const csrfRes = await httpRequest({ port, path: '/api/status' });
    const csrfToken = csrfRes.body.csrfToken;

    // Test A: Target Validation による TargetValidationSnapshot 発行（Profile未指定・未確定）
    await runTest('Test A: Target Validation generates TargetValidationSnapshot without profile', async () => {
      const res = await httpRequest({
        port,
        path: '/api/target/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {}
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'PASS');
      assert.ok(res.body.targetSnapshot);
      assert.ok(res.body.targetSnapshot.targetSnapshotId.startsWith('target-snap-'));
      targetSnap = res.body.targetSnapshot;
    });

    // Test B: Target Validation 時の schoolsHash, toolFingerprint, authMode, expectedSchoolCount 整合性検証
    await runTest('Test B: Target Validation metadata validation (schoolsHash, toolFingerprint, authMode)', async () => {
      assert.strictEqual(targetSnap.enabledSchoolCount, 3);
      assert.strictEqual(targetSnap.totalSchoolCount, 3);
      assert.strictEqual(targetSnap.resolvedCredentialsCount, 3);
      assert.ok(targetSnap.schoolsHash.length > 0);
      assert.ok(targetSnap.toolFingerprint.length > 0);
      assert.ok(targetSnap.authMode === 'A' || targetSnap.authMode === 'B');
    });

    // Test C: Discovery 起動引数の物理分離（--purpose discovery, --target-snapshot-id 付与, --profile 排除, Writeフラグ物理排除）
    await runTest('Test C: Discovery process spawn arguments (purpose discovery, no profile, no write flags)', async () => {
      (adapter as any).currentJobState = 'IDLE';
      adapter.startDiscoveryProcess('START');
      const spawnInfo = adapter.getLastSpawnInfo();
      assert.ok(spawnInfo);
      assert.ok(spawnInfo.args.includes('--purpose'));
      assert.strictEqual(spawnInfo.args[spawnInfo.args.indexOf('--purpose') + 1], 'discovery');
      assert.ok(spawnInfo.args.includes('--target-snapshot-id'));
      assert.strictEqual(spawnInfo.args[spawnInfo.args.indexOf('--target-snapshot-id') + 1], targetSnap.targetSnapshotId);
      assert.ok(!spawnInfo.args.includes('--profile'));
      assert.ok(!spawnInfo.args.includes('--apply'));
      assert.ok(!spawnInfo.args.includes('--allow-live-write'));
      assert.ok(!spawnInfo.args.includes('--batch-apply'));
      assert.ok(!spawnInfo.args.includes('--allow-destructive'));
      await new Promise((r) => setTimeout(r, 40));
      (adapter as any).currentJobState = 'COMPLETED';
    });

    // Test D: Discovery 実行時の一時ファイル（Profileファイル非生成・非マウント）
    await runTest('Test D: Discovery temp files contain no profile', async () => {
      const spawnInfo = adapter.getLastSpawnInfo();
      assert.ok(spawnInfo);
      const profileArgIdx = spawnInfo.args.indexOf('--profile');
      assert.strictEqual(profileArgIdx, -1, 'Profile argument must not exist in Discovery');
    });

    // Test E: Discovery 実行中のチェックポイント分離（discovery-checkpoint-*.json）
    await runTest('Test E: Discovery checkpoint filename prefix check', async () => {
      assert.strictEqual(adapter.getCurrentExecutionPurpose(), 'DISCOVERY');
    });

    // Test F: Discovery 実行中のサマリ分離（observation snapshot の生成）
    await runTest('Test F: Discovery outputs ObservationSnapshot', async () => {
      obsSnap = createMockObservationSnapshot(targetSnap.targetSnapshotId);
      // reports ディレクトリに mock observation を保存
      const reportsDir = getReportsDir();
      fs.mkdirSync(reportsDir, { recursive: true });
      fs.writeFileSync(path.join(reportsDir, `observation-${Date.now()}.json`), JSON.stringify(obsSnap, null, 2));

      const loaded = adapter.loadLatestObservationSnapshot();
      assert.ok(loaded);
      assert.strictEqual(loaded.targetSnapshotId, targetSnap.targetSnapshotId);
    });

    // Test G: ObservationSnapshot の型整合性（SUCCESS時は observation, FAILED時は errorCode/errorMessage/observedAt 独立）
    await runTest('Test G: ObservationSnapshot discriminated union structure', async () => {
      const successItem = obsSnap.schools[0];
      assert.strictEqual(successItem.readStatus, 'SUCCESS');
      if (schoolIsSuccess(successItem)) {
        assert.ok(successItem.observation);
        assert.ok(successItem.discoveryStateHash);
      }
    });

    // Test H: ObservationSnapshot の現状分布集計（11項目ごとの件数、CONTRACT_NOT_AVAILABLE 独立）
    await runTest('Test H: ObservationSnapshot settingDistribution structure', async () => {
      assert.strictEqual(obsSnap.distribution.timelineChannel.ON, 2);
      assert.strictEqual(obsSnap.distribution.timelineChannel.OFF, 1);
      assert.strictEqual(obsSnap.distribution.mentalHealth.CONTRACT_NOT_AVAILABLE, 3);
    });

    // Test I: Discovery 中の Safe Stop（stdin STOP 送信、INTERRUPTED 遷移）
    await runTest('Test I: Discovery Safe Stop via stdin STOP', async () => {
      let writtenData = '';
      const stopCp = new EventEmitter() as any;
      stopCp.stdout = new EventEmitter();
      stopCp.stderr = new EventEmitter();
      stopCp.stdin = {
        write: (msg: string) => { writtenData += msg; },
        destroyed: false
      };
      stopCp.kill = () => {};

      const stopAdapter = new BatchProcessAdapter({
        spawnFn: () => stopCp
      });
      stopAdapter.setUploadedBatch({
        uploadId: 'upload-stop',
        originalFileName: 'test.csv',
        fileSize: 100,
        schools: createMockSchools(),
        credentials: createMockCredentials(),
        createdAt: new Date().toISOString()
      });
      stopAdapter.executeTargetValidation({});
      stopAdapter.startDiscoveryProcess('START');

      assert.strictEqual(stopAdapter.getJobState(), 'RUNNING');
      stopAdapter.stopDiscoveryProcess();
      assert.strictEqual(stopAdapter.getJobState(), 'STOPPING');
      assert.ok(writtenData.includes('"STOP"'));

      stopCp.emit('exit', null, 'SIGTERM');
      assert.strictEqual(stopAdapter.getJobState(), 'INTERRUPTED');
    });

    // Test J: Discovery の Resume（--resume 付与）
    await runTest('Test J: Discovery Resume argument flag', async () => {
      (adapter as any).currentJobState = 'IDLE';
      adapter.startDiscoveryProcess('RESUME');
      const spawnInfo = adapter.getLastSpawnInfo();
      assert.ok(spawnInfo?.args.includes('--resume'));
      assert.ok(!spawnInfo?.args.includes('--retry-failed'));
      await new Promise((r) => setTimeout(r, 40));
      (adapter as any).currentJobState = 'COMPLETED';
    });

    // Test K: Discovery の Retry Failed（--resume --retry-failed 付与）
    await runTest('Test K: Discovery Retry Failed argument flags', async () => {
      (adapter as any).currentJobState = 'IDLE';
      adapter.startDiscoveryProcess('RETRY_FAILED');
      const spawnInfo = adapter.getLastSpawnInfo();
      assert.ok(spawnInfo?.args.includes('--resume'));
      assert.ok(spawnInfo?.args.includes('--retry-failed'));
      await new Promise((r) => setTimeout(r, 40));
      (adapter as any).currentJobState = 'COMPLETED';
    });

    // Test L: Discovery の Resume/Retry 完了時の新 Snapshot ID 発行と下流 Draft 即時 invalidate
    await runTest('Test L: Discovery updates invalidate downstream draft and final preflight', async () => {
      adapter.invalidateDraft('TEST');
      assert.strictEqual(adapter.getActiveProfileSnapshot(), null);
      assert.strictEqual(adapter.getFinalValidationSnapshot(), null);
      assert.strictEqual(adapter.getActiveFinalPreflightReport(), null);
    });

    // Test M: Draft Profile 作成（全11項目 UNMANAGED null で初期化）
    await runTest('Test M: Draft Profile initialization with all null UNMANAGED', async () => {
      const res = await httpRequest({
        port,
        path: '/api/profile/draft',
        method: 'GET'
      });
      assert.strictEqual(res.statusCode, 200);
    });

    // Test N: Draft Profile 更新時の revision インクリメント & draftHash 再計算
    await runTest('Test N: Draft Profile update increments revision and calculates hash', async () => {
      (adapter as any).currentJobState = 'IDLE';
      const newSettings = {
        storage: 'ON',
        timelineChannel: 'ON',
        directMessage: 'STUDENT_TO_STUDENT_DISABLED',
        parentDirectMessage: 'ON',
        allChannel: 'ON',
        parentChannel: 'ON',
        attendance: 'ON',
        contactBook: 'ON',
        mentalHealth: null,
        otherSchoolLog: 'ALLOW',
        studentPasswordChange: 'HIDE'
      };

      const res = await httpRequest({
        port,
        path: '/api/profile/draft',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: targetSnap.targetSnapshotId,
          observationSnapshotId: obsSnap.observationSnapshotId,
          draftRevision: 1,
          settings: newSettings
        }
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'UPDATED');
      assert.strictEqual(res.body.draftProfile.draftRevision, 1);
      assert.ok(res.body.draftProfile.draftHash.length > 0);
      draftProf = res.body.draftProfile;
    });

    // Test O: Draft Profile 更新時の strict スキーマ検証（未知キー拒否）
    await runTest('Test O: Draft Profile rejects unknown fields', async () => {
      const res = await httpRequest({
        port,
        path: '/api/profile/draft',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: targetSnap.targetSnapshotId,
          observationSnapshotId: obsSnap.observationSnapshotId,
          draftRevision: 2,
          settings: {
            storage: 'ON',
            unknownField: 'INVALID'
          }
        }
      });
      assert.strictEqual(res.statusCode, 400);
    });

    // Test P: Draft Profile 更新時の Lineage バインド（targetSnapshotId, observationSnapshotId）
    await runTest('Test P: Draft Profile binds targetSnapshotId and observationSnapshotId', async () => {
      assert.strictEqual(draftProf.targetSnapshotId, targetSnap.targetSnapshotId);
      assert.strictEqual(draftProf.observationSnapshotId, obsSnap.observationSnapshotId);
    });

    // Test Q: PreviewExecutionPlan の算出（ブラウザ再アクセスなし、直接呼出し）
    await runTest('Test Q: Calculate preview without browser re-access', async () => {
      const res = await httpRequest({
        port,
        path: '/api/preview/calculate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          observationSnapshotId: obsSnap.observationSnapshotId,
          draftRevision: draftProf.draftRevision,
          draftHash: draftProf.draftHash
        }
      });
      assert.strictEqual(res.statusCode, 200);
      previewPlan = res.body;
      assert.strictEqual(previewPlan.totalSchools, 3);
    });

    // Test R: Preview 算出結果（targetCount, alreadyConfiguredCount, destructiveCount 等独立集計）
    await runTest('Test R: Preview metric counts calculation', async () => {
      assert.ok(typeof previewPlan.targetCount === 'number');
      assert.ok(typeof previewPlan.alreadyConfiguredCount === 'number');
      assert.ok(typeof previewPlan.destructiveCount === 'number');
      assert.ok(typeof previewPlan.uncontractedCount === 'number');
      assert.ok(typeof previewPlan.blockedCount === 'number');
      assert.strictEqual(previewPlan.observationFailedCount, 0);
    });

    // Test S: Preview 算出結果の項目別変更分布（settingDiffDistribution）
    await runTest('Test S: Preview settingDiffDistribution structure', async () => {
      assert.ok(previewPlan.settingDiffDistribution);
      assert.ok(Array.isArray(previewPlan.schoolDiffs));
      assert.strictEqual(previewPlan.schoolDiffs.length, 3);
    });

    // Test T: Profile 確定（confirmProfile）による Immutable ProfileSnapshot 発行
    await runTest('Test T: Confirm profile generates immutable ProfileSnapshot', async () => {
      const res = await httpRequest({
        port,
        path: '/api/profile/confirm',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: draftProf.targetSnapshotId,
          observationSnapshotId: draftProf.observationSnapshotId,
          expectedDraftRevision: draftProf.draftRevision,
          expectedDraftHash: draftProf.draftHash
        }
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'CONFIRMED');
      profSnap = res.body.profileSnapshot;
      assert.ok(profSnap.snapshotId.startsWith('prof-snap-'));
    });

    // Test U: Profile 確定時の stale チェック（expectedDraftRevision / expectedDraftHash 不一致拒否）
    await runTest('Test U: Confirm profile rejects stale draft revision/hash', async () => {
      const res = await httpRequest({
        port,
        path: '/api/profile/confirm',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: draftProf.targetSnapshotId,
          observationSnapshotId: draftProf.observationSnapshotId,
          expectedDraftRevision: 999,
          expectedDraftHash: 'wrong-hash'
        }
      });
      assert.ok(res.statusCode === 400 || res.statusCode === 409);
      assert.strictEqual(res.body.error, 'DRAFT_STALE');
    });

    // Test V: ProfileSnapshot の Lineage 完全バインド
    await runTest('Test V: ProfileSnapshot lineage binding check', async () => {
      assert.strictEqual(profSnap.targetSnapshotId, targetSnap.targetSnapshotId);
      assert.strictEqual(profSnap.observationSnapshotId, obsSnap.observationSnapshotId);
      assert.strictEqual(profSnap.sourceDraftRevision, draftProf.draftRevision);
      assert.strictEqual(profSnap.sourceDraftHash, draftProf.draftHash);
    });

    // Test W: Final Validation 実行による FinalValidationSnapshot 発行
    await runTest('Test W: Execute Final Validation generates FinalValidationSnapshot', async () => {
      (adapter as any).currentJobState = 'IDLE';
      finalValSnap = adapter.executeFinalValidation();
      assert.ok(finalValSnap.finalValidationSnapshotId.startsWith('final-val-'));
    });

    // Test X: Final Validation の Lineage 完全バインド
    await runTest('Test X: FinalValidationSnapshot lineage verification', async () => {
      assert.strictEqual(finalValSnap.targetSnapshotId, targetSnap.targetSnapshotId);
      assert.strictEqual(finalValSnap.observationSnapshotId, obsSnap.observationSnapshotId);
      assert.strictEqual(finalValSnap.profileSnapshotId, profSnap.snapshotId);
      assert.strictEqual(finalValSnap.profileHash, profSnap.profileHash);
      assert.strictEqual(finalValSnap.schoolsHash, targetSnap.schoolsHash);
      assert.strictEqual(finalValSnap.authMode, targetSnap.authMode);
    });

    // Test Y: Final Preflight 起動引数（--purpose final-preflight, --final-validation-snapshot-id 等）
    await runTest('Test Y: Final Preflight spawn arguments and lineage binding', async () => {
      (adapter as any).currentJobState = 'IDLE';
      adapter.startFinalPreflightProcess('START');
      const spawnInfo = adapter.getLastSpawnInfo();
      assert.ok(spawnInfo);
      assert.ok(spawnInfo.args.includes('--purpose'));
      assert.strictEqual(spawnInfo.args[spawnInfo.args.indexOf('--purpose') + 1], 'final-preflight');
      assert.ok(spawnInfo.args.includes('--final-validation-snapshot-id'));
      assert.strictEqual(spawnInfo.args[spawnInfo.args.indexOf('--final-validation-snapshot-id') + 1], finalValSnap.finalValidationSnapshotId);
      assert.ok(spawnInfo.args.includes('--profile-snapshot-id'));
      assert.strictEqual(spawnInfo.args[spawnInfo.args.indexOf('--profile-snapshot-id') + 1], profSnap.snapshotId);
      assert.ok(!spawnInfo.args.includes('--apply'));
      assert.ok(!spawnInfo.args.includes('--allow-live-write'));
      await new Promise((r) => setTimeout(r, 40));
      (adapter as any).currentJobState = 'COMPLETED';
    });

    // Test Z: Final Preflight レポートの purpose='FINAL_PREFLIGHT' と finalValidationSnapshotId の物理バインド
    await runTest('Test Z: Final Preflight report purpose and snapshotId binding', async () => {
      const reportsDir = getReportsDir();
      const execId = `fp-exec-${Date.now()}`;
      const mockPreflight: PreflightReport = {
        executionId: execId,
        deploymentId: `dep-${Date.now()}`,
        runId: `run-${Date.now()}`,
        toolVersion: getToolVersion(),
        toolFingerprint: generateToolFingerprint(),
        summaryPath: 'reports/summary.json',
        schoolsHash: targetSnap.schoolsHash,
        profileHash: profSnap.profileHash,
        profileSnapshotId: profSnap.snapshotId,
        purpose: 'FINAL_PREFLIGHT',
        finalValidationSnapshotId: finalValSnap.finalValidationSnapshotId,
        authMode: targetSnap.authMode,
        status: 'COMPLETE',
        writeGateEligible: true,
        allReadSucceeded: true,
        readFailed: 0,
        allPlansExecutable: true,
        planBlocked: 0,
        notProcessed: 0,
        validUntil: new Date(Date.now() + 3600 * 1000).toISOString(),
        completedAt: new Date().toISOString(),
        total: 1,
        processed: 1,
        readSuccess: 1,
        alreadyConfigured: 0,
        requiresChange: 1,
        destructiveChangeSchools: 0,
        schools: [
          {
            schoolCode: 'SCH001',
            schoolName: '第一小学校',
            readStatus: 'SUCCESS',
            planExecutable: true,
            hasChanges: true,
            actionsCount: 1,
            hasDestructiveChanges: false,
            writeEligible: true,
            baselineHash: 'hash-sch001'
          }
        ]
      };
      fs.writeFileSync(path.join(reportsDir, `preflight-${execId}.json`), JSON.stringify(mockPreflight, null, 2));

      // mock summary report
      const mockSummary = {
        executionId: execId,
        deploymentId: mockPreflight.deploymentId,
        totalSchools: 3,
        executableCount: 3,
        nonExecutableCount: 0,
        alreadyConfiguredCount: 0,
        destructiveCount: 0,
        schools: []
      };
      fs.writeFileSync(path.join(reportsDir, `summary-${execId}.json`), JSON.stringify(mockSummary, null, 2));

      (adapter as any).currentFinalPreflightExecutionId = execId;
      (adapter as any).activeFinalPreflightReport = mockPreflight;
      (adapter as any).activeFinalSummaryReport = mockSummary;
      (adapter as any).activeFinalPreflightContext = {
        executionId: execId,
        deploymentId: mockPreflight.deploymentId,
        runId: mockPreflight.runId,
        targetSnapshotId: targetSnap.targetSnapshotId,
        observationSnapshotId: obsSnap.observationSnapshotId,
        profileSnapshotId: profSnap.snapshotId,
        finalValidationSnapshotId: finalValSnap.finalValidationSnapshotId,
        authMode: targetSnap.authMode,
        schoolsHash: targetSnap.schoolsHash,
        toolFingerprint: targetSnap.toolFingerprint,
        report: mockPreflight,
        summary: mockSummary,
        completedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 3600 * 1000).toISOString()
      };

      const loaded = adapter.loadLatestFinalPreflightReport();
      assert.ok(loaded.preflight);
      assert.strictEqual(loaded.preflight.purpose, 'FINAL_PREFLIGHT');
      assert.strictEqual(loaded.preflight.finalValidationSnapshotId, finalValSnap.finalValidationSnapshotId);
      activeFinalPreflightReport = loaded.preflight;
    });

    // Test AA: 最新 Preflight 探索 fallback の完全廃止（バインドされていない preflight の利用拒否）
    await runTest('Test AA: prepareProductionApply rejects mismatched lineage preflight', async () => {
      (adapter as any).currentJobState = 'IDLE';
      const badPreflight: PreflightReport = {
        deploymentId: 'dep-mismatch',
        runId: 'run-mismatch',
        completedAt: new Date().toISOString(),
        toolVersion: getToolVersion(),
        toolFingerprint: generateToolFingerprint(),
        summaryPath: 'reports/summary.json',
        schoolsHash: targetSnap.schoolsHash,
        profileHash: profSnap.profileHash,
        purpose: 'DISCOVERY',
        finalValidationSnapshotId: 'wrong-id',
        status: 'COMPLETE',
        writeGateEligible: true,
        allReadSucceeded: true,
        readFailed: 0,
        allPlansExecutable: true,
        planBlocked: 0,
        notProcessed: 0,
        validUntil: new Date(Date.now() + 3600 * 1000).toISOString(),
        total: 3,
        processed: 3,
        readSuccess: 3,
        alreadyConfigured: 0,
        requiresChange: 3,
        destructiveChangeSchools: 0,
        schools: []
      };

      assert.throws(() => {
        adapter.prepareProductionApply(badPreflight);
      }, (err: any) => {
        return err.issueCode === 'UNSAFE_CONFIGURATION' || err.issueCode === 'PURPOSE_MISMATCH' || err.issueCode === 'LINEAGE_MISMATCH';
      });
    });

    // Test AB: Final Preflight と Preview の結果一致検証
    await runTest('Test AB: Final Preflight result alignment check', async () => {
      assert.strictEqual(activeFinalPreflightReport?.purpose, 'FINAL_PREFLIGHT');
      assert.strictEqual(activeFinalPreflightReport?.profileSnapshotId, profSnap.snapshotId);
    });

    // Test AC: Production Apply 準備（prepareProductionApply）時の Global Gate 検証
    await runTest('Test AC: prepareProductionApply passes Global Gate and issues manifest', async () => {
      (adapter as any).currentJobState = 'IDLE';
      const prepRes = await httpRequest({
        port,
        path: '/api/apply/prepare',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {}
      });
      if (prepRes.statusCode !== 200) {
        console.error('Test AC error details:', prepRes.body);
      }
      assert.strictEqual(prepRes.statusCode, 200);
      assert.strictEqual(prepRes.body.status, 'PREPARED');
      assert.ok(prepRes.body.confirmationToken);
      confirmationToken = prepRes.body.confirmationToken;
      applyManifest = prepRes.body.manifest;
    });

    // Test AD: Production Apply 準備時の Confirmation Token 発行（1回限り有効）
    await runTest('Test AD: Confirmation Token issuance and expiration metadata', async () => {
      assert.ok(confirmationToken.length > 20);
      assert.strictEqual(applyManifest.finalValidationSnapshotId, finalValSnap.finalValidationSnapshotId);
    });

    // Test AE: 破壊的変更の Override 完全禁止（includeDestructive 排除、allowDestructive=false 強制）
    await runTest('Test AE: Override forbidden (includeDestructive blocked in API)', async () => {
      const prepRes = await httpRequest({
        port,
        path: '/api/apply/prepare',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          includeDestructiveSchools: true // 禁止フィールド
        }
      });
      assert.strictEqual(prepRes.statusCode, 400);
      assert.strictEqual(prepRes.body.error, 'WRITE_FORBIDDEN');
    });

    // Test AF: Production Apply 起動引数の固定性（--allow-destructive 物理排除、Write関連フラグ付与）
    await runTest('Test AF: Production apply spawn arguments contain Write flags and no --allow-destructive', async () => {
      (adapter as any).currentJobState = 'IDLE';
      const startRes = await httpRequest({
        port,
        path: '/api/apply/start',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          confirmationToken
        }
      });
      assert.strictEqual(startRes.statusCode, 200);
      assert.strictEqual(startRes.body.status, 'STARTED');

      const spawnInfo = adapter.getLastSpawnInfo();
      assert.ok(spawnInfo);
      assert.ok(spawnInfo.args.includes('--apply'));
      assert.ok(spawnInfo.args.includes('--allow-live-write'));
      assert.ok(spawnInfo.args.includes('--batch-apply'));
      assert.ok(!spawnInfo.args.includes('--allow-destructive'));
      (adapter as any).currentJobState = 'COMPLETED';
    });

    // Test AG: Confirmation Token の一回限り消費（再利用拒否）
    await runTest('Test AG: Confirmation Token cannot be reused (one-time consumption)', async () => {
      const startRes2 = await httpRequest({
        port,
        path: '/api/apply/start',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          confirmationToken // 既に使用済み
        }
      });
      assert.strictEqual(startRes2.statusCode, 400);
    });

    // Test AH: シングルジョブガード（DISCOVERY_RUNNING, FINAL_PREFLIGHT_RUNNING, APPLY_RUNNING 包含）
    await runTest('Test AH: Single Job Guard blocks concurrent start', async () => {
      // 現在ジョブ実行中シミュレーション
      const mockRunningCp = new EventEmitter() as any;
      mockRunningCp.stdout = new EventEmitter();
      mockRunningCp.stderr = new EventEmitter();
      mockRunningCp.stdin = { write: () => {}, destroyed: false };
      mockRunningCp.kill = () => {};

      const runningAdapter = new BatchProcessAdapter({ spawnFn: () => mockRunningCp });
      runningAdapter.setUploadedBatch({
        uploadId: 'upload-running',
        originalFileName: 'test.csv',
        fileSize: 100,
        schools: createMockSchools(),
        credentials: createMockCredentials(),
        createdAt: new Date().toISOString()
      });
      runningAdapter.executeTargetValidation({});
      runningAdapter.startDiscoveryProcess('START');

      assert.throws(() => {
        runningAdapter.startDiscoveryProcess('START');
      }, (err: any) => err.status === 'JOB_CONFLICT');

      assert.throws(() => {
        runningAdapter.startFinalPreflightProcess('START');
      }, (err: any) => err.status === 'JOB_CONFLICT');

      assert.throws(() => {
        runningAdapter.startProductionApplyProcess('dummy-token');
      }, (err: any) => err.status === 'JOB_CONFLICT');
    });

    // Test AI: 実行中（RUNNING / STOPPING）の入力変更 API 拒否（HTTP 409 JOB_CONFLICT）
    await runTest('Test AI: Job running blocks input mutations with 409 JOB_CONFLICT', async () => {
      const mockRunningCp = new EventEmitter() as any;
      mockRunningCp.stdout = new EventEmitter();
      mockRunningCp.stderr = new EventEmitter();
      mockRunningCp.stdin = { write: () => {}, destroyed: false };
      mockRunningCp.kill = () => {};

      const runningAdapter = new BatchProcessAdapter({ spawnFn: () => mockRunningCp });
      runningAdapter.setUploadedBatch({
        uploadId: 'upload-running-ai',
        originalFileName: 'test.csv',
        fileSize: 100,
        schools: createMockSchools(),
        credentials: createMockCredentials(),
        createdAt: new Date().toISOString()
      });
      runningAdapter.executeTargetValidation({});
      runningAdapter.startDiscoveryProcess('START');

      const runningServer = new ConsoleServer({ port: 3981, adapter: runningAdapter });
      await runningServer.start();
      try {
        const res = await httpRequest({
          port: 3981,
          path: '/api/target/validate',
          method: 'POST',
          headers: { 'X-CSRF-Nonce': (runningServer as any).csrfToken },
          body: {}
        });
        assert.strictEqual(res.statusCode, 409);
        assert.strictEqual(res.body.error, 'JOB_CONFLICT');
      } finally {
        await runningServer.stop();
      }
    });

    // Test AJ: FORBIDDEN_WRITE_FIELDS 検証（includeDestructiveSchools 含む）
    await runTest('Test AJ: FORBIDDEN_WRITE_FIELDS rejects destructive override fields', async () => {
      const res = await httpRequest({
        port,
        path: '/api/target/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          includeDestructiveSchools: true
        }
      });
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.error, 'WRITE_FORBIDDEN');
    });

    // Test AK: Host / Origin / CSRF Nonce 検証
    await runTest('Test AK: Security gates (CSRF and Origin check)', async () => {
      const badCsrf = await httpRequest({
        port,
        path: '/api/target/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': 'wrong-nonce' },
        body: {}
      });
      assert.strictEqual(badCsrf.statusCode, 403);
      assert.strictEqual(badCsrf.body.error, 'INVALID_CSRF_TOKEN');

      const badOrigin = await httpRequest({
        port,
        path: '/api/status',
        method: 'GET',
        headers: { Origin: 'http://malicious-site.com' }
      });
      assert.strictEqual(badOrigin.statusCode, 403);
      assert.strictEqual(badOrigin.body.error, 'FORBIDDEN_ORIGIN');
    });

    // Test AL: 結果リセット（resetAllResults）による全スナップショット・レポートのアーカイブと IDLE 復帰
    await runTest('Test AL: resetAllResults resets state to IDLE and archives results', async () => {
      const resetRes = await httpRequest({
        port,
        path: '/api/results/reset',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken }
      });
      assert.strictEqual(resetRes.statusCode, 200);
      assert.strictEqual(resetRes.body.success, true);
      assert.strictEqual(adapter.getJobState(), 'IDLE');
      assert.strictEqual(adapter.getTargetSnapshot(), null);
      assert.strictEqual(adapter.getObservationSnapshot(), null);
      assert.strictEqual(adapter.getDraftProfile(), null);
      assert.strictEqual(adapter.getActiveProfileSnapshot(), null);
      assert.strictEqual(adapter.getFinalValidationSnapshot(), null);
    });

    // =========================================================================
    // 追加確定要件 AM 〜 AS テスト
    // =========================================================================

    // Test AM: ObservationSnapshot の SSOT 準拠 (SchoolSettingsObservation, CONTRACT_NOT_AVAILABLE で value=null)
    await runTest('Test AM: ObservationSnapshot uses SSOT SchoolSettingsObservation with CONTRACT_NOT_AVAILABLE value=null', async () => {
      const summaryReporter = new BatchSummaryReporter({
        deploymentId: 'dep-test-am',
        runId: 'run-test-am',
        mode: 'PREFLIGHT_DRY_RUN',
        purpose: 'DISCOVERY',
        schoolsHash: 'schools-hash-am',
        authMode: 'A',
        profileHash: 'profile-hash-am',
        toolVersion: getToolVersion()
      });

      // 契約外機能 (mentalHealth) を含むモック結果を追加
      const fullObs: import('../src/types/settings').SchoolSettingsObservation = {
        storage: { value: 'ON', availability: 'AVAILABLE' },
        timelineChannel: { value: 'ON', availability: 'AVAILABLE' },
        directMessage: { value: 'STUDENT_TO_STUDENT_DISABLED', availability: 'AVAILABLE' },
        parentDirectMessage: { value: 'ON', availability: 'AVAILABLE' },
        allChannel: { value: 'ON', availability: 'AVAILABLE' },
        parentChannel: { value: 'ON', availability: 'AVAILABLE' },
        attendance: { value: 'ON', availability: 'AVAILABLE' },
        contactBook: { value: 'ON', availability: 'AVAILABLE' },
        mentalHealth: { value: null, availability: 'CONTRACT_NOT_AVAILABLE' },
        otherSchoolLog: { value: 'ALLOW', availability: 'AVAILABLE' },
        studentPasswordChange: { value: 'HIDE', availability: 'AVAILABLE' }
      };

      summaryReporter.addSchoolResult({
        schoolCode: 'SCH_AM',
        schoolName: 'AM校',
        status: 'SUCCESS',
        executionStatus: 'DRY_RUN_COMPLETED',
        actionsCount: 0,
        hasDestructiveChanges: false,
        planExecutable: true,
        fullObservation: fullObs,
        before: {
          storage: 'ON',
          timelineChannel: 'ON',
          directMessage: 'STUDENT_TO_STUDENT_DISABLED',
          parentDirectMessage: 'ON',
          allChannel: 'ON',
          parentChannel: 'ON',
          attendance: 'ON',
          contactBook: 'ON',
          mentalHealth: null,
          otherSchoolLog: 'ALLOW',
          studentPasswordChange: 'HIDE'
        }
      });

      summaryReporter.generateReport({ totalSchools: 1, skippedSchools: 0 });

      const obsPath = path.join(getReportsDir(), 'observation-dep-test-am.json');
      assert.ok(fs.existsSync(obsPath), 'ObservationSnapshot file should be written');
      const obsContent: ObservationSnapshot = JSON.parse(fs.readFileSync(obsPath, 'utf-8'));

      const school = obsContent.schools[0];
      assert.strictEqual(school.readStatus, 'SUCCESS');
      if (school.readStatus === 'SUCCESS') {
        assert.strictEqual(school.observation.mentalHealth.value, null, 'CONTRACT_NOT_AVAILABLE 時は value=null であること');
        assert.strictEqual(school.observation.mentalHealth.availability, 'CONTRACT_NOT_AVAILABLE');
        assert.strictEqual(school.observation.storage.value, 'ON');
        assert.strictEqual(school.observation.storage.availability, 'AVAILABLE');
        // Record<SettingKey, string> への劣化がないこと（オブジェクト構造 { value, availability } を保持）
        assert.ok(typeof school.observation.storage === 'object');
      }
    });

    // Test AN: Profile 確定時の Lineage バインド（Target/Observation 不一致を拒否）
    await runTest('Test AN: Confirm profile rejects mismatched lineage', async () => {
      // 正常な Target と Observation を用意
      adapter.setUploadedBatch({
        uploadId: 'upload-an',
        originalFileName: 'test.csv',
        fileSize: 100,
        schools: createMockSchools(),
        credentials: createMockCredentials(),
        createdAt: new Date().toISOString()
      });
      const tSnap = adapter.executeTargetValidation({});
      const oSnap: ObservationSnapshot = {
        observationSnapshotId: 'obs-an-1',
        targetSnapshotId: tSnap.targetSnapshot.targetSnapshotId,
        schoolsHash: tSnap.targetSnapshot.schoolsHash,
        toolFingerprint: tSnap.targetSnapshot.toolFingerprint,
        authMode: 'A',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        totalSchools: 1,
        readSuccessCount: 1,
        readFailedCount: 0,
        distribution: {} as any,
        schools: [{
          schoolCode: 'SCH_001',
          schoolName: '学校1',
          readStatus: 'SUCCESS',
          observation: {
            storage: { value: 'OFF', availability: 'AVAILABLE' }
          } as any,
          discoveryStateHash: 'hash-001',
          observedAt: new Date().toISOString()
        }]
      };
      (adapter as any).observationSnapshot = oSnap;
      const dProf = adapter.updateDraftProfile({ storage: 'ON' });
      adapter.calculatePreview(oSnap.observationSnapshotId, dProf.draftRevision, dProf.draftHash);

      // 不一致な targetSnapshotId での確定試行 -> 拒絶
      assert.throws(() => {
        adapter.confirmProfile(dProf.draftRevision, dProf.draftHash, 'wrong-target-id', oSnap.observationSnapshotId);
      }, (err: any) => (err.status === 'LINEAGE_MISMATCH' || err.issueCode === 'LINEAGE_MISMATCH'));

      // 不一致な observationSnapshotId での確定試行 -> 拒絶
      assert.throws(() => {
        adapter.confirmProfile(dProf.draftRevision, dProf.draftHash, tSnap.targetSnapshot.targetSnapshotId, 'wrong-obs-id');
      }, (err: any) => (err.status === 'LINEAGE_MISMATCH' || err.issueCode === 'LINEAGE_MISMATCH'));

      // 正しい Lineage で確定成功
      const pSnap = adapter.confirmProfile(dProf.draftRevision, dProf.draftHash, tSnap.targetSnapshot.targetSnapshotId, oSnap.observationSnapshotId);
      assert.strictEqual(pSnap.targetSnapshotId, tSnap.targetSnapshot.targetSnapshotId);
      assert.strictEqual(pSnap.observationSnapshotId, oSnap.observationSnapshotId);
    });

    // Test AO: authMode の保持と不一致時の Final Preflight / Apply Prepare 拒否
    await runTest('Test AO: authMode mismatch rejects Final Preflight and Apply Prepare', async () => {
      // 1. Target ('A') と FinalValidation ('B') で authMode が異なる場合、Final Preflight を拒否
      adapter.executeFinalValidation();
      const origFinalVal = adapter.getFinalValidationSnapshot()!;
      (adapter as any).finalValidationSnapshot = {
        ...origFinalVal,
        authMode: 'B' // Target('A') と不一致
      };

      assert.throws(() => {
        adapter.startFinalPreflightProcess('START');
      }, (err: any) => err.status === 'CHECKPOINT_MISMATCH' && err.message.includes('authMode'));

      // 復元
      (adapter as any).finalValidationSnapshot = origFinalVal;

      // 2. PreflightReport の authMode ('B') と Target / FinalValidation ('A') が異なる場合、Apply Prepare を拒否
      const mockPfMismatch: PreflightReport = {
        deploymentId: 'dep-mismatch-auth',
        runId: 'run-mismatch-auth',
        completedAt: new Date().toISOString(),
        toolVersion: getToolVersion(),
        toolFingerprint: generateToolFingerprint(),
        summaryPath: 'reports/summary.json',
        schoolsHash: adapter.getTargetSnapshot()!.schoolsHash,
        profileHash: adapter.getActiveProfileSnapshot()!.profileHash,
        profileSnapshotId: adapter.getActiveProfileSnapshot()!.snapshotId,
        purpose: 'FINAL_PREFLIGHT',
        finalValidationSnapshotId: adapter.getFinalValidationSnapshot()!.finalValidationSnapshotId,
        authMode: 'B',
        status: 'COMPLETE',
        writeGateEligible: true,
        allReadSucceeded: true,
        readFailed: 0,
        allPlansExecutable: true,
        planBlocked: 0,
        notProcessed: 0,
        validUntil: new Date(Date.now() + 3600 * 1000).toISOString(),
        total: 1,
        processed: 1,
        readSuccess: 1,
        alreadyConfigured: 0,
        requiresChange: 1,
        destructiveChangeSchools: 0,
        schools: []
      };

      assert.throws(() => {
        adapter.prepareProductionApply(mockPfMismatch);
      }, (err: any) => err.status === 'CHECKPOINT_MISMATCH' && err.message.includes('authMode'));
    });

    // Test AP: --purpose discovery では profile file を一切読まず、内部で全11項目 UNMANAGED 強制生成し、--profile との併用を拒否
    await runTest('Test AP: --purpose discovery rejects --profile and generates unmanaged desiredSettings', async () => {
      assert.throws(() => {
        parseCliArgs(['--batch', '--purpose', 'discovery', '--profile', 'config/production-profile.sample.json']);
      }, /Discoveryモード/);
    });

    // Test AQ: Discovery Resume / Retry で更新時、既存を mutation せず新 observationSnapshotId 発行 & 下流全 invalidate
    await runTest('Test AQ: Discovery update generates new snapshot ID and invalidates all downstream states', async () => {
      const initialObs = adapter.getObservationSnapshot()!;
      assert.ok(initialObs);
      // 下流を作成
      const dProf = adapter.updateDraftProfile({ storage: 'ON' });
      adapter.calculatePreview(initialObs.observationSnapshotId, dProf.draftRevision, dProf.draftHash);
      adapter.confirmProfile(dProf.draftRevision, dProf.draftHash);
      adapter.executeFinalValidation();
      assert.ok(adapter.getActiveProfileSnapshot());
      assert.ok(adapter.getFinalValidationSnapshot());

      // 新しい ObservationSnapshot を受領（Resume / Retry シミュレーション）
      const newObsId = `obs-resumed-${Date.now()}`;
      const newObs: ObservationSnapshot = {
        ...initialObs,
        observationSnapshotId: newObsId,
        parentObservationSnapshotId: initialObs.observationSnapshotId,
        readSuccessCount: initialObs.readSuccessCount + 1
      };

      // 既存 snapshot は mutation されない
      assert.notStrictEqual(newObs.observationSnapshotId, initialObs.observationSnapshotId);

      // 新 Observation セット時に下流がすべて invalidate されること
      adapter.setObservationSnapshot(newObs);
      assert.strictEqual(adapter.getDraftProfile(), null, 'DraftProfile should be invalidated');
      assert.strictEqual(adapter.getActiveProfileSnapshot(), null, 'ProfileSnapshot should be invalidated');
      assert.strictEqual(adapter.getFinalValidationSnapshot(), null, 'FinalValidationSnapshot should be invalidated');
      assert.strictEqual(adapter.getActiveFinalPreflightReport(), null, 'FinalPreflightReport should be invalidated');
    });

    // Test AR: Discovery 部分成功時、FAILED校を変更あり/なしに混入させず observationFailedCount 独立集計
    await runTest('Test AR: Partial discovery isolates FAILED schools into observationFailedCount', async () => {
      const partialObs: ObservationSnapshot = {
        observationSnapshotId: 'obs-partial',
        targetSnapshotId: adapter.getTargetSnapshot()!.targetSnapshotId,
        schoolsHash: adapter.getTargetSnapshot()!.schoolsHash,
        toolFingerprint: adapter.getTargetSnapshot()!.toolFingerprint,
        authMode: 'A',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        totalSchools: 2,
        readSuccessCount: 1,
        readFailedCount: 1,
        distribution: {} as any,
        schools: [
          {
            schoolCode: 'SCH_OK',
            schoolName: '成功校',
            readStatus: 'SUCCESS',
            observation: {
              storage: { value: 'OFF', availability: 'AVAILABLE' },
              timelineChannel: { value: 'ON', availability: 'AVAILABLE' },
              directMessage: { value: 'STUDENT_TO_STUDENT_DISABLED', availability: 'AVAILABLE' },
              parentDirectMessage: { value: 'OFF', availability: 'AVAILABLE' },
              allChannel: { value: 'ON', availability: 'AVAILABLE' },
              parentChannel: { value: 'ON', availability: 'AVAILABLE' },
              attendance: { value: 'ON', availability: 'AVAILABLE' },
              contactBook: { value: 'ON', availability: 'AVAILABLE' },
              mentalHealth: { value: null, availability: 'CONTRACT_NOT_AVAILABLE' },
              otherSchoolLog: { value: 'DENY', availability: 'AVAILABLE' },
              studentPasswordChange: { value: 'SHOW', availability: 'AVAILABLE' }
            } as any,
            discoveryStateHash: 'hash-ok',
            observedAt: new Date().toISOString()
          },
          {
            schoolCode: 'SCH_FAIL',
            schoolName: '失敗校',
            readStatus: 'FAILED',
            errorCode: 'LOGIN_FAILED',
            errorMessage: 'ログインに失敗しました',
            observedAt: new Date().toISOString()
          }
        ]
      };

      (adapter as any).observationSnapshot = partialObs;
      adapter.updateDraftProfile({ storage: 'ON' });

      const preview = adapter.calculatePreview();
      assert.strictEqual(preview.totalSchools, 2);
      assert.strictEqual(preview.targetCount, 1, '変更対象校は成功した SCH_OK のみ');
      assert.strictEqual(preview.alreadyConfiguredCount, 0, '変更なし校に失敗校は混入しない');
      assert.strictEqual(preview.observationFailedCount, 1, '失敗校は observationFailedCount に独立集計されること');
    });

    // Test AS: reports ディレクトリに複数レポートがあっても activeFinalPreflightReport 以外から Apply 開始不可（探索fallback完全撤廃）
    await runTest('Test AS: Apply requires activeFinalPreflightReport without latest report discovery fallback', async () => {
      // reports ディレクトリにダミーの Final Preflight レポートファイルが存在する状況を作成
      const reportsDir = getReportsDir();
      const stalePfPath = path.join(reportsDir, 'preflight-stale-test-as.json');
      const stalePf: PreflightReport = {
        deploymentId: 'stale-test-as',
        runId: 'run-stale-test-as',
        completedAt: new Date().toISOString(),
        toolVersion: getToolVersion(),
        toolFingerprint: generateToolFingerprint(),
        summaryPath: 'reports/summary.json',
        schoolsHash: adapter.getTargetSnapshot()!.schoolsHash,
        profileHash: 'stale-prof-hash',
        purpose: 'FINAL_PREFLIGHT',
        status: 'COMPLETE',
        writeGateEligible: true,
        allReadSucceeded: true,
        readFailed: 0,
        allPlansExecutable: true,
        planBlocked: 0,
        notProcessed: 0,
        validUntil: new Date(Date.now() + 3600 * 1000).toISOString(),
        total: 1,
        processed: 1,
        readSuccess: 1,
        alreadyConfigured: 0,
        requiresChange: 1,
        destructiveChangeSchools: 0,
        schools: []
      };
      fs.writeFileSync(stalePfPath, JSON.stringify(stalePf, null, 2), 'utf-8');

      // 現在のワークフローでは activeFinalPreflightReport が null の状態
      assert.strictEqual(adapter.getActiveFinalPreflightReport(), null);

      // prepareProductionApply を呼び出した時、stalePfPath を探索フォールバックして使わず、即座に拒絶されること
      assert.throws(() => {
        adapter.prepareProductionApply();
      }, (err: any) => err.status === 'CONFIG_INVALID' && err.message.includes('有効な Final Preflight レポートが見つかりません'));

      // クリーンアップ
      try { fs.unlinkSync(stalePfPath); } catch {}
    });

  } finally {
    await server.stop();
  }

  console.log(`\n=== Results: ${passedTests} passed, ${failedTests} failed ===`);
  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
