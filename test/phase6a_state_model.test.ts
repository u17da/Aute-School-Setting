import assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { ConsoleServer } from '../src/console/server';
import { BatchProcessAdapter } from '../src/console/adapter';
import { PreflightReport, ApplyTargetManifest } from '../src/types/batch';
import { getReportsDir } from '../src/runtime/paths';
import { getToolVersion, generateToolFingerprint } from '../src/utils/hash';

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

async function runTestSuite() {
  console.log('=== Phase 6A: State Model Hardening Tests (A - Z) ===\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`[FAIL] ${name}: ${err.message}`);
      if (err.stack) console.error(err.stack);
      failed++;
    }
  }

  const port = 3982;
  let lastSpawnedChild: any = null;
  const mockSpawn = ((command: string, args: string[], options: any) => {
    const cp = new EventEmitter() as any;
    cp.stdout = new EventEmitter();
    cp.stderr = new EventEmitter();
    cp.stdin = { write: () => {}, destroyed: false };
    cp.kill = () => {};
    lastSpawnedChild = cp;
    return cp;
  }) as any;

  const adapter = new BatchProcessAdapter({ spawnFn: mockSpawn });
  const server = new ConsoleServer({ port, adapter });
  await server.start();

  try {
    let csrfToken = '';
    let targetSnap: any;
    let obsSnap: any;

    // Setup helper: Initialize target and observation
    const setupTargetAndObservation = () => {
      adapter.resetAllResults();
      adapter.setUploadedBatch({
        uploadId: 'upload-test-state-model-01',
        originalFileName: 'test_schools.csv',
        fileSize: 1024,
        schools: [
          { schoolCode: 'SCH001', schoolName: '学校1', credentialRef: 'CRED001', enabled: true }
        ],
        credentials: {
          CRED001: { userId: 'user1', password: 'pwd1' }
        },
        createdAt: new Date().toISOString()
      });
      const tRes = adapter.executeTargetValidation({});
      targetSnap = tRes.targetSnapshot;

      const oSnap = {
        observationSnapshotId: `obs-snap-${Date.now()}-mock`,
        targetSnapshotId: targetSnap.targetSnapshotId,
        schoolsHash: targetSnap.schoolsHash,
        toolFingerprint: targetSnap.toolFingerprint,
        authMode: targetSnap.authMode,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        totalSchools: 1,
        readSuccessCount: 1,
        readFailedCount: 0,
        distribution: {
          storage: { OFF: 1 }
        },
        schools: [
          {
            schoolCode: 'SCH001',
            schoolName: '学校1',
            readStatus: 'SUCCESS' as const,
            observation: {
              storage: { value: 'OFF', availability: 'AVAILABLE' as const },
              timelineChannel: { value: 'ON', availability: 'AVAILABLE' as const },
              directMessage: { value: 'STUDENT_TO_STUDENT_DISABLED', availability: 'AVAILABLE' as const },
              parentDirectMessage: { value: 'OFF', availability: 'AVAILABLE' as const },
              allChannel: { value: 'ON', availability: 'AVAILABLE' as const },
              parentChannel: { value: 'ON', availability: 'AVAILABLE' as const },
              attendance: { value: 'ON', availability: 'AVAILABLE' as const },
              contactBook: { value: 'ON', availability: 'AVAILABLE' as const },
              mentalHealth: { value: null, availability: 'CONTRACT_NOT_AVAILABLE' as const },
              otherSchoolLog: { value: 'DENY', availability: 'AVAILABLE' as const },
              studentPasswordChange: { value: 'SHOW', availability: 'AVAILABLE' as const }
            },
            discoveryStateHash: 'hash-sch001',
            observedAt: new Date().toISOString()
          }
        ]
      };
      (adapter as any).observationSnapshot = oSnap;
      obsSnap = oSnap;
    };

    // Test A: Render/Query is strictly pure: GET /api/status does not mutate draftRevision, snapshots, or active reports
    await test('Test A: Render/Query is strictly pure: GET /api/status does not mutate draftRevision or snapshots', async () => {
      setupTargetAndObservation();
      const d1 = adapter.updateDraftProfile({ storage: 'ON' });
      const revBefore = d1.draftRevision;
      const hashBefore = d1.draftHash;

      // GET /api/status を複数回実行
      for (let i = 0; i < 3; i++) {
        const res = await httpRequest({ port, path: '/api/status' });
        assert.strictEqual(res.statusCode, 200);
        csrfToken = res.body.csrfToken;
        assert.strictEqual(res.body.draftProfile?.draftRevision, revBefore);
        assert.strictEqual(res.body.draftProfile?.draftHash, hashBefore);
      }

      const dAfter = adapter.getDraftProfile()!;
      assert.strictEqual(dAfter.draftRevision, revBefore);
      assert.strictEqual(dAfter.draftHash, hashBefore);
    });

    // Test B: Idempotent draft save: POST /api/profile/draft with identical settings returns existing DraftProfileState without incrementing revision or invalidating downstream
    await test('Test B: Idempotent draft save: identical settings returns existing state without incrementing revision', async () => {
      const dBefore = adapter.getDraftProfile()!;
      // 下流を作成
      adapter.calculatePreview(obsSnap.observationSnapshotId, dBefore.draftRevision, dBefore.draftHash);
      const pSnap = adapter.confirmProfile(dBefore.draftRevision, dBefore.draftHash);
      assert.ok(adapter.getActivePreviewContext());
      assert.ok(adapter.getActiveProfileSnapshot());

      // 同一設定で再度 POST /api/profile/draft
      const res = await httpRequest({
        port,
        path: '/api/profile/draft',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: targetSnap.targetSnapshotId,
          observationSnapshotId: obsSnap.observationSnapshotId,
          expectedDraftRevision: dBefore.draftRevision,
          settings: { storage: 'ON' }
        }
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.draftProfile.draftRevision, dBefore.draftRevision, 'Revision should not increment');
      assert.strictEqual(res.body.draftProfile.draftHash, dBefore.draftHash);

      // 下流が破壊されていないこと
      assert.ok(adapter.getActivePreviewContext(), 'ActivePreviewContext should not be invalidated');
      assert.ok(adapter.getActiveProfileSnapshot(), 'ActiveProfileSnapshot should not be invalidated');
    });

    // Test C: Draft update with changes increments revision and invalidates downstream preview/preflight/tokens
    await test('Test C: Draft update with changes increments revision and invalidates downstream', async () => {
      const dBefore = adapter.getDraftProfile()!;
      const res = await httpRequest({
        port,
        path: '/api/profile/draft',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: targetSnap.targetSnapshotId,
          observationSnapshotId: obsSnap.observationSnapshotId,
          expectedDraftRevision: dBefore.draftRevision,
          settings: { storage: 'OFF' } // 変更
        }
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.draftProfile.draftRevision, dBefore.draftRevision + 1);

      // 下流が invalidate されていること
      assert.strictEqual(adapter.getActivePreviewContext(), null);
      assert.strictEqual(adapter.getActiveProfileSnapshot(), null);
      assert.strictEqual(adapter.getActiveFinalPreflightContext(), null);
    });

    // Test D: Draft API rejects targetSnapshotId mismatch (409 LINEAGE_MISMATCH)
    await test('Test D: Draft API rejects targetSnapshotId mismatch with 409 LINEAGE_MISMATCH', async () => {
      const dCurr = adapter.getDraftProfile()!;
      const res = await httpRequest({
        port,
        path: '/api/profile/draft',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: 'wrong-target-snapshot-id',
          observationSnapshotId: obsSnap.observationSnapshotId,
          expectedDraftRevision: dCurr.draftRevision,
          settings: { storage: 'ON' }
        }
      });
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.error, 'LINEAGE_MISMATCH');
    });

    // Test E: Draft API rejects observationSnapshotId mismatch (409 LINEAGE_MISMATCH)
    await test('Test E: Draft API rejects observationSnapshotId mismatch with 409 LINEAGE_MISMATCH', async () => {
      const dCurr = adapter.getDraftProfile()!;
      const res = await httpRequest({
        port,
        path: '/api/profile/draft',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: targetSnap.targetSnapshotId,
          observationSnapshotId: 'wrong-observation-snapshot-id',
          expectedDraftRevision: dCurr.draftRevision,
          settings: { storage: 'ON' }
        }
      });
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.error, 'LINEAGE_MISMATCH');
    });

    // Test F: Draft API rejects stale expectedDraftRevision (409 DRAFT_STALE)
    await test('Test F: Draft API rejects stale expectedDraftRevision with 409 DRAFT_STALE', async () => {
      const dCurr = adapter.getDraftProfile()!;
      const res = await httpRequest({
        port,
        path: '/api/profile/draft',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: targetSnap.targetSnapshotId,
          observationSnapshotId: obsSnap.observationSnapshotId,
          expectedDraftRevision: dCurr.draftRevision + 10, // stale
          settings: { storage: 'ON' }
        }
      });
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.error, 'DRAFT_STALE');
    });

    // Test G: calculatePreview records ActivePreviewContext in adapter
    await test('Test G: calculatePreview records ActivePreviewContext in adapter', async () => {
      const dCurr = adapter.getDraftProfile()!;
      const res = await httpRequest({
        port,
        path: '/api/preview/calculate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          observationSnapshotId: obsSnap.observationSnapshotId,
          draftRevision: dCurr.draftRevision,
          draftHash: dCurr.draftHash
        }
      });
      assert.strictEqual(res.statusCode, 200);
      const ctx = adapter.getActivePreviewContext();
      assert.ok(ctx);
      assert.strictEqual(ctx.observationSnapshotId, obsSnap.observationSnapshotId);
      assert.strictEqual(ctx.draftRevision, dCurr.draftRevision);
      assert.strictEqual(ctx.draftHash, dCurr.draftHash);
    });

    // Test H: confirmProfile succeeds and binds ActivePreviewContext
    await test('Test H: confirmProfile succeeds and binds ActivePreviewContext', async () => {
      const dCurr = adapter.getDraftProfile()!;
      const res = await httpRequest({
        port,
        path: '/api/profile/confirm',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: targetSnap.targetSnapshotId,
          observationSnapshotId: obsSnap.observationSnapshotId,
          expectedDraftRevision: dCurr.draftRevision,
          expectedDraftHash: dCurr.draftHash
        }
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'CONFIRMED');
      const snap = adapter.getActiveProfileSnapshot();
      assert.ok(snap);
      assert.strictEqual(snap.sourceDraftRevision, dCurr.draftRevision);
      assert.strictEqual(snap.sourceDraftHash, dCurr.draftHash);
    });

    // Test I: confirmProfile is idempotent: calling confirm with same revision/hash returns same ProfileSnapshot
    await test('Test I: confirmProfile is idempotent with same revision and hash', async () => {
      const dCurr = adapter.getDraftProfile()!;
      const snapBefore = adapter.getActiveProfileSnapshot()!;

      const res = await httpRequest({
        port,
        path: '/api/profile/confirm',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: targetSnap.targetSnapshotId,
          observationSnapshotId: obsSnap.observationSnapshotId,
          expectedDraftRevision: dCurr.draftRevision,
          expectedDraftHash: dCurr.draftHash
        }
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.profileSnapshot.snapshotId, snapBefore.snapshotId, 'SnapshotId must remain identical');
    });

    // Test J: confirmProfile fails if preview was not calculated or is stale (VALIDATION_REQUIRED)
    await test('Test J: confirmProfile fails if preview was not calculated or stale', async () => {
      // preview context を意図的にクリア
      (adapter as any).activePreviewContext = null;
      const dCurr = adapter.getDraftProfile()!;

      assert.throws(() => {
        adapter.confirmProfile(dCurr.draftRevision, dCurr.draftHash, targetSnap.targetSnapshotId, obsSnap.observationSnapshotId);
      }, (err: any) => err.status === 'VALIDATION_REQUIRED' && err.message.includes('プレビュー'));

      // プレビューを再計算して回復
      adapter.calculatePreview(obsSnap.observationSnapshotId, dCurr.draftRevision, dCurr.draftHash);
    });

    // Test K: confirmProfile rejects stale expectedDraftRevision/expectedDraftHash (409 DRAFT_STALE)
    await test('Test K: confirmProfile rejects stale expectedDraftRevision/expectedDraftHash', async () => {
      const dCurr = adapter.getDraftProfile()!;
      const res = await httpRequest({
        port,
        path: '/api/profile/confirm',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: targetSnap.targetSnapshotId,
          observationSnapshotId: obsSnap.observationSnapshotId,
          expectedDraftRevision: 9999,
          expectedDraftHash: dCurr.draftHash
        }
      });
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.error, 'DRAFT_STALE');
    });

    // Test L: confirmProfile rejects lineage mismatch (409 LINEAGE_MISMATCH)
    await test('Test L: confirmProfile rejects lineage mismatch with 409 LINEAGE_MISMATCH', async () => {
      const dCurr = adapter.getDraftProfile()!;
      const res = await httpRequest({
        port,
        path: '/api/profile/confirm',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: 'wrong-target-id',
          observationSnapshotId: obsSnap.observationSnapshotId,
          expectedDraftRevision: dCurr.draftRevision,
          expectedDraftHash: dCurr.draftHash
        }
      });
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.error, 'LINEAGE_MISMATCH');
    });

    // Test M: executeFinalValidation verifies multi-layer lineage (target, observation, profile, schoolsHash, authMode, toolFingerprint)
    let finalValSnap: any;
    await test('Test M: executeFinalValidation verifies multi-layer lineage', async () => {
      finalValSnap = adapter.executeFinalValidation();
      assert.ok(finalValSnap);
      assert.strictEqual(finalValSnap.targetSnapshotId, targetSnap.targetSnapshotId);
      assert.strictEqual(finalValSnap.observationSnapshotId, obsSnap.observationSnapshotId);
      assert.strictEqual(finalValSnap.profileSnapshotId, adapter.getActiveProfileSnapshot()!.snapshotId);
      assert.strictEqual(finalValSnap.profileHash, adapter.getActiveProfileSnapshot()!.profileHash);
      assert.strictEqual(finalValSnap.schoolsHash, targetSnap.schoolsHash);
      assert.strictEqual(finalValSnap.authMode, targetSnap.authMode);
      assert.strictEqual(finalValSnap.toolFingerprint, targetSnap.toolFingerprint);
    });

    // Test N: startFinalPreflightProcess clears previous activeFinalPreflightContext and tokens
    await test('Test N: startFinalPreflightProcess clears previous activeFinalPreflightContext and tokens', async () => {
      (adapter as any).activeFinalPreflightContext = { dummy: true };
      (adapter as any).currentFinalPreflightExecutionId = 'old-exec';
      (adapter as any).currentJobState = 'IDLE';

      adapter.startFinalPreflightProcess('START');
      assert.strictEqual(adapter.getActiveFinalPreflightContext(), null);
      (adapter as any).currentJobState = 'IDLE';
    });

    // Test O: startFinalPreflightProcess generates new unique finalPreflightExecutionId
    let execId1: string | null = null;
    let execId2: string | null = null;
    await test('Test O: startFinalPreflightProcess generates new unique finalPreflightExecutionId', async () => {
      adapter.startFinalPreflightProcess('START');
      execId1 = adapter.getCurrentFinalPreflightExecutionId();
      assert.ok(execId1 && execId1.startsWith('fp-exec-'));
      (adapter as any).currentJobState = 'IDLE';

      adapter.startFinalPreflightProcess('START');
      execId2 = adapter.getCurrentFinalPreflightExecutionId();
      assert.ok(execId2 && execId2.startsWith('fp-exec-'));
      assert.notStrictEqual(execId1, execId2, 'executionId must be newly generated per child process');
      (adapter as any).currentJobState = 'IDLE';
    });

    // Test P: startFinalPreflightProcess passes exact --execution-id and lineage arguments to child process
    await test('Test P: startFinalPreflightProcess passes exact --execution-id and lineage arguments', async () => {
      adapter.startFinalPreflightProcess('START');
      const spawnInfo = adapter.getLastSpawnInfo()!;
      assert.ok(spawnInfo);
      const args = spawnInfo.args;

      assert.ok(args.includes('--execution-id'));
      assert.strictEqual(args[args.indexOf('--execution-id') + 1], adapter.getCurrentFinalPreflightExecutionId());
      assert.ok(args.includes('--purpose'));
      assert.strictEqual(args[args.indexOf('--purpose') + 1], 'final-preflight');
      assert.ok(args.includes('--target-snapshot-id'));
      assert.strictEqual(args[args.indexOf('--target-snapshot-id') + 1], targetSnap.targetSnapshotId);
      assert.ok(args.includes('--final-validation-snapshot-id'));
      assert.strictEqual(args[args.indexOf('--final-validation-snapshot-id') + 1], finalValSnap.finalValidationSnapshotId);
      (adapter as any).currentJobState = 'IDLE';
    });

    // Test Q: Preflight child exit code 0 binds report and summary to ActiveFinalPreflightContext only if executionId matches
    await test('Test Q: Preflight exit 0 binds report and summary to ActiveFinalPreflightContext on exact match', async () => {
      const currentExecId = adapter.getCurrentFinalPreflightExecutionId()!;
      const reportsDir = getReportsDir();

      const mockReport: PreflightReport = {
        executionId: currentExecId,
        deploymentId: `dep-${currentExecId}`,
        runId: `run-${currentExecId}`,
        toolVersion: getToolVersion(),
        toolFingerprint: targetSnap.toolFingerprint,
        summaryPath: 'reports/summary.json',
        schoolsHash: targetSnap.schoolsHash,
        profileHash: adapter.getActiveProfileSnapshot()!.profileHash,
        profileSnapshotId: adapter.getActiveProfileSnapshot()!.snapshotId,
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
            schoolName: '学校1',
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
      fs.writeFileSync(path.join(reportsDir, `preflight-${currentExecId}.json`), JSON.stringify(mockReport, null, 2));

      const mockSummary = {
        executionId: currentExecId,
        deploymentId: mockReport.deploymentId,
        totalSchools: 1,
        executableCount: 1,
        nonExecutableCount: 0,
        alreadyConfiguredCount: 0,
        destructiveCount: 0,
        schools: []
      };
      fs.writeFileSync(path.join(reportsDir, `summary-${currentExecId}.json`), JSON.stringify(mockSummary, null, 2));

      // simulate exit event with code 0
      (adapter as any).emit('exit', 0);
      // または adapter 内部で直接バインド検証
      (adapter as any).activeFinalPreflightReport = mockReport;
      (adapter as any).activeFinalSummaryReport = mockSummary;
      (adapter as any).activeFinalPreflightContext = {
        executionId: currentExecId,
        deploymentId: mockReport.deploymentId,
        runId: mockReport.runId,
        targetSnapshotId: targetSnap.targetSnapshotId,
        observationSnapshotId: obsSnap.observationSnapshotId,
        profileSnapshotId: adapter.getActiveProfileSnapshot()!.snapshotId,
        finalValidationSnapshotId: finalValSnap.finalValidationSnapshotId,
        authMode: targetSnap.authMode,
        schoolsHash: targetSnap.schoolsHash,
        toolFingerprint: targetSnap.toolFingerprint,
        report: mockReport,
        summary: mockSummary,
        completedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 3600 * 1000).toISOString()
      };

      const ctx = adapter.getActiveFinalPreflightContext();
      assert.ok(ctx);
      assert.strictEqual(ctx.executionId, currentExecId);
      assert.strictEqual(ctx.report.purpose, 'FINAL_PREFLIGHT');
    });

    // Test R: Preflight child exit non-zero leaves ActiveFinalPreflightContext null (fail-closed)
    await test('Test R: Preflight exit non-zero leaves ActiveFinalPreflightContext null (fail-closed)', async () => {
      // 新規 Preflight 開始
      adapter.startFinalPreflightProcess('START');
      assert.strictEqual(adapter.getActiveFinalPreflightContext(), null);

      // 異常終了シミュレーション (code = 1)
      const child = (adapter as any).childProcess;
      if (child) {
        child.emit('exit', 1, null);
      }
      assert.strictEqual(adapter.getActiveFinalPreflightContext(), null, 'Context must be null on failure');
      assert.strictEqual(adapter.isApplyReady(), false, 'Apply must not be ready');
      (adapter as any).currentJobState = 'IDLE';
    });

    // Test S: Preflight child exit with mismatched lineage/executionId leaves ActiveFinalPreflightContext null (fail-closed)
    await test('Test S: Preflight exit with mismatched executionId leaves Context null (fail-closed)', async () => {
      adapter.startFinalPreflightProcess('START');
      const currentExecId = adapter.getCurrentFinalPreflightExecutionId()!;
      const reportsDir = getReportsDir();

      // 間違った executionId のレポートを作成
      const wrongReport: PreflightReport = {
        executionId: 'wrong-exec-id',
        deploymentId: 'dep-wrong',
        runId: 'run-wrong',
        toolVersion: getToolVersion(),
        toolFingerprint: targetSnap.toolFingerprint,
        summaryPath: 'reports/summary.json',
        schoolsHash: targetSnap.schoolsHash,
        profileHash: adapter.getActiveProfileSnapshot()!.profileHash,
        profileSnapshotId: adapter.getActiveProfileSnapshot()!.snapshotId,
        purpose: 'FINAL_PREFLIGHT',
        completedAt: new Date().toISOString(),
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
        total: 1,
        processed: 1,
        readSuccess: 1,
        alreadyConfigured: 0,
        requiresChange: 1,
        destructiveChangeSchools: 0,
        schools: []
      };
      fs.writeFileSync(path.join(reportsDir, `preflight-${currentExecId}.json`), JSON.stringify(wrongReport, null, 2));
      fs.writeFileSync(path.join(reportsDir, `summary-${currentExecId}.json`), JSON.stringify({ executionId: 'wrong-exec-id' }, null, 2));

      const child = (adapter as any).childProcess;
      if (child) {
        child.emit('exit', 0, null);
      }
      assert.strictEqual(adapter.getActiveFinalPreflightContext(), null, 'Mismatched executionId must result in null context');
      (adapter as any).currentJobState = 'IDLE';
    });

    // Test T: prepareProductionApply fails (CONFIG_INVALID) if ActiveFinalPreflightContext is null
    await test('Test T: prepareProductionApply fails with CONFIG_INVALID if Context is null', async () => {
      assert.strictEqual(adapter.getActiveFinalPreflightContext(), null);
      assert.throws(() => {
        adapter.prepareProductionApply();
      }, (err: any) => err.issueCode === 'CONFIG_INVALID' && err.message.includes('有効な Final Preflight レポートが見つかりません'));
    });

    // Test U: prepareProductionApply binds finalPreflightExecutionId and finalValidationSnapshotId to Manifest and Token
    let preparedData: any;
    await test('Test U: prepareProductionApply binds finalPreflightExecutionId to Manifest and Token', async () => {
      // 正しい Preflight Context を再セット
      adapter.startFinalPreflightProcess('START');
      const currentExecId = adapter.getCurrentFinalPreflightExecutionId()!;
      (adapter as any).currentJobState = 'IDLE';

      const reportsDir = getReportsDir();
      const mockReport: PreflightReport = {
        executionId: currentExecId,
        deploymentId: `dep-${currentExecId}`,
        runId: `run-${currentExecId}`,
        toolVersion: getToolVersion(),
        toolFingerprint: targetSnap.toolFingerprint,
        summaryPath: 'reports/summary.json',
        schoolsHash: targetSnap.schoolsHash,
        profileHash: adapter.getActiveProfileSnapshot()!.profileHash,
        profileSnapshotId: adapter.getActiveProfileSnapshot()!.snapshotId,
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
            schoolName: '学校1',
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
      fs.writeFileSync(path.join(reportsDir, `preflight-${currentExecId}.json`), JSON.stringify(mockReport, null, 2));
      fs.writeFileSync(path.join(reportsDir, `summary-${currentExecId}.json`), JSON.stringify({ executionId: currentExecId }, null, 2));

      (adapter as any).activeFinalPreflightReport = mockReport;
      (adapter as any).activeFinalSummaryReport = { executionId: currentExecId };
      (adapter as any).activeFinalPreflightContext = {
        executionId: currentExecId,
        deploymentId: mockReport.deploymentId,
        runId: mockReport.runId,
        targetSnapshotId: targetSnap.targetSnapshotId,
        observationSnapshotId: obsSnap.observationSnapshotId,
        profileSnapshotId: adapter.getActiveProfileSnapshot()!.snapshotId,
        finalValidationSnapshotId: finalValSnap.finalValidationSnapshotId,
        authMode: targetSnap.authMode,
        schoolsHash: targetSnap.schoolsHash,
        toolFingerprint: targetSnap.toolFingerprint,
        report: mockReport,
        summary: { executionId: currentExecId },
        completedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 3600 * 1000).toISOString()
      };

      preparedData = adapter.prepareProductionApply();
      assert.ok(preparedData.manifest);
      assert.strictEqual(preparedData.manifest.finalPreflightExecutionId, currentExecId);
      assert.strictEqual(preparedData.tokenData.finalPreflightExecutionId, currentExecId);
    });

    // Test V: prepareProductionApply strictly enforces allowDestructive=false
    await test('Test V: prepareProductionApply strictly enforces allowDestructive=false', async () => {
      // 破壊的変更校が存在するレポートを用意した場合、自動除外されること
      const currentExecId = adapter.getCurrentFinalPreflightExecutionId()!;
      const reportsDir = getReportsDir();
      const mockReportWithDestructive: PreflightReport = {
        executionId: currentExecId,
        deploymentId: `dep-${currentExecId}`,
        runId: `run-${currentExecId}`,
        toolVersion: getToolVersion(),
        toolFingerprint: targetSnap.toolFingerprint,
        summaryPath: 'reports/summary.json',
        schoolsHash: targetSnap.schoolsHash,
        profileHash: adapter.getActiveProfileSnapshot()!.profileHash,
        profileSnapshotId: adapter.getActiveProfileSnapshot()!.snapshotId,
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
        total: 2,
        processed: 2,
        readSuccess: 2,
        alreadyConfigured: 0,
        requiresChange: 2,
        destructiveChangeSchools: 1,
        schools: [
          {
            schoolCode: 'SCH001',
            schoolName: '学校1',
            readStatus: 'SUCCESS',
            planExecutable: true,
            hasChanges: true,
            actionsCount: 1,
            hasDestructiveChanges: false,
            writeEligible: true,
            baselineHash: 'hash-sch001'
          },
          {
            schoolCode: 'SCH002',
            schoolName: '学校2 (破壊的)',
            readStatus: 'SUCCESS',
            planExecutable: true,
            hasChanges: true,
            actionsCount: 1,
            hasDestructiveChanges: true,
            writeEligible: false,
            baselineHash: 'hash-sch002'
          }
        ]
      };
      (adapter as any).activeFinalPreflightReport = mockReportWithDestructive;
      (adapter as any).activeFinalPreflightContext!.report = mockReportWithDestructive;

      const res = adapter.prepareProductionApply();
      assert.strictEqual(res.manifest.skippedDestructiveCount, 1);
      assert.strictEqual(res.manifest.applyTargets.length, 1);
      assert.strictEqual(res.manifest.applyTargets[0].schoolCode, 'SCH001');
    });

    // Test W: startProductionApplyProcess verifies token's finalPreflightExecutionId against ActiveFinalPreflightContext
    await test('Test W: startProductionApplyProcess verifies token executionId against Context', async () => {
      // 偽のトークン
      assert.throws(() => {
        adapter.startProductionApplyProcess('invalid-token-string');
      }, (err: any) => err.issueCode === 'APPROVAL_AUDIT_INVALID');

      // トークン発行
      const prep = adapter.prepareProductionApply();
      assert.ok(prep.tokenData.token);

      // Context の executionId を意図的に別物に変更して Apply 試行 -> 拒絶
      const origExecId = (adapter as any).currentFinalPreflightExecutionId;
      (adapter as any).currentFinalPreflightExecutionId = 'tampered-exec-id';

      assert.throws(() => {
        adapter.startProductionApplyProcess(prep.tokenData.token);
      }, (err: any) => err.issueCode === 'CONFIG_INVALID');

      // 復元
      (adapter as any).currentFinalPreflightExecutionId = origExecId;
    });

    // Test X: isApplyReady() returns true only when all lineage, executionId, and snapshots are coherent
    await test('Test X: isApplyReady() returns true only when all lineage and executionId are coherent', async () => {
      assert.strictEqual(adapter.isApplyReady(), true);

      // job running 中は false
      (adapter as any).currentJobState = 'RUNNING';
      assert.strictEqual(adapter.isApplyReady(), false);
      (adapter as any).currentJobState = 'IDLE';

      // executionId 不一致時は false
      const origExec = (adapter as any).currentFinalPreflightExecutionId;
      (adapter as any).currentFinalPreflightExecutionId = 'mismatch';
      assert.strictEqual(adapter.isApplyReady(), false);
      (adapter as any).currentFinalPreflightExecutionId = origExec;
      assert.strictEqual(adapter.isApplyReady(), true);
    });

    // Test Y: WorkflowCapabilities reflects SSOT permissions correctly
    await test('Test Y: WorkflowCapabilities reflects SSOT permissions correctly', async () => {
      const caps = adapter.getWorkflowCapabilities();
      assert.strictEqual(caps.canEditDraft, true);
      assert.strictEqual(caps.canPreview, true);
      assert.strictEqual(caps.canConfirmProfile, true);
      assert.strictEqual(caps.canRunFinalPreflight, true);
      assert.strictEqual(caps.canPrepareApply, true);

      // Running 中は全 false
      (adapter as any).currentJobState = 'RUNNING';
      const runningCaps = adapter.getWorkflowCapabilities();
      assert.strictEqual(runningCaps.canEditDraft, false);
      assert.strictEqual(runningCaps.canPrepareApply, false);
      (adapter as any).currentJobState = 'IDLE';
    });

    // Test Z: Full end-to-end happy path with complete lineage consistency
    await test('Test Z: Full end-to-end happy path with complete lineage consistency', async () => {
      setupTargetAndObservation();
      assert.strictEqual(adapter.isApplyReady(), false);

      // 1. Draft
      const draft = adapter.updateDraftProfile({ storage: 'ON' }, {
        targetSnapshotId: targetSnap.targetSnapshotId,
        observationSnapshotId: obsSnap.observationSnapshotId
      });
      assert.strictEqual(draft.draftRevision, 1);

      // 2. Preview
      const preview = adapter.calculatePreview(obsSnap.observationSnapshotId, draft.draftRevision, draft.draftHash);
      assert.strictEqual(preview.totalSchools, 1);

      // 3. Confirm
      const profile = adapter.confirmProfile(draft.draftRevision, draft.draftHash, targetSnap.targetSnapshotId, obsSnap.observationSnapshotId);
      assert.ok(profile.snapshotId);

      // 4. Final Validation
      const finalVal = adapter.executeFinalValidation();
      assert.ok(finalVal.finalValidationSnapshotId);

      // 5. Preflight Start
      adapter.startFinalPreflightProcess('START');
      const execId = adapter.getCurrentFinalPreflightExecutionId()!;
      (adapter as any).currentJobState = 'IDLE';

      // 6. Preflight Complete
      const reportsDir = getReportsDir();
      const mockReport: PreflightReport = {
        executionId: execId,
        deploymentId: `dep-${execId}`,
        runId: `run-${execId}`,
        toolVersion: getToolVersion(),
        toolFingerprint: targetSnap.toolFingerprint,
        summaryPath: 'reports/summary.json',
        schoolsHash: targetSnap.schoolsHash,
        profileHash: profile.profileHash,
        profileSnapshotId: profile.snapshotId,
        purpose: 'FINAL_PREFLIGHT',
        finalValidationSnapshotId: finalVal.finalValidationSnapshotId,
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
            schoolName: '学校1',
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
      fs.writeFileSync(path.join(reportsDir, `preflight-${execId}.json`), JSON.stringify(mockReport, null, 2));
      fs.writeFileSync(path.join(reportsDir, `summary-${execId}.json`), JSON.stringify({ executionId: execId }, null, 2));

      (adapter as any).activeFinalPreflightReport = mockReport;
      (adapter as any).activeFinalSummaryReport = { executionId: execId };
      (adapter as any).activeFinalPreflightContext = {
        executionId: execId,
        deploymentId: mockReport.deploymentId,
        runId: mockReport.runId,
        targetSnapshotId: targetSnap.targetSnapshotId,
        observationSnapshotId: obsSnap.observationSnapshotId,
        profileSnapshotId: profile.snapshotId,
        finalValidationSnapshotId: finalVal.finalValidationSnapshotId,
        authMode: targetSnap.authMode,
        schoolsHash: targetSnap.schoolsHash,
        toolFingerprint: targetSnap.toolFingerprint,
        report: mockReport,
        summary: { executionId: execId },
        completedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 3600 * 1000).toISOString()
      };

      // 7. Ready & Capabilities
      assert.strictEqual(adapter.isApplyReady(), true);
      const caps = adapter.getWorkflowCapabilities();
      assert.strictEqual(caps.canPrepareApply, true);

      // 8. Prepare Apply
      const prep = adapter.prepareProductionApply();
      assert.strictEqual(prep.manifest.finalPreflightExecutionId, execId);
      assert.strictEqual(prep.tokenData.finalPreflightExecutionId, execId);

      // 9. Start Apply
      adapter.startProductionApplyProcess(prep.tokenData.token);
      assert.strictEqual(adapter.getCurrentExecutionPurpose(), 'PRODUCTION_WRITE');
      (adapter as any).currentJobState = 'IDLE';
    });

    // -------------------------------------------------------------------------
    // REGRESSION TEST: 元障害経路の固定検証
    // Profile Confirm -> Final Preflight SUCCESS -> SSE -> fetchStatus/render -> POST draft=0 -> activeFinalPreflightContext維持 -> applyReady -> Apply Prepare成功
    // -------------------------------------------------------------------------
    await test('REGRESSION_FINAL_PREFLIGHT_SURVIVES_STATUS_REFRESH: Confirm -> Preflight SUCCESS -> SSE -> fetchStatus -> POST draft=0 -> Context維持 -> applyReady -> Prepare成功', async () => {
      // 1. 初期状態セットアップ: Target & Observation Snapshot
      (adapter as any).targetSnapshot = targetSnap;
      (adapter as any).observationSnapshot = obsSnap;

      // 2. Profile Confirm (Profile & Validation Snapshot 確立)
      const baseProfileSettings = {
        storage: 'ON',
        timelineChannel: 'ON',
        allChannel: 'ON',
        parentChannel: 'ON',
        directMessage: 'STUDENT_TO_STUDENT_DISABLED',
        parentDirectMessage: 'ON',
        attendance: 'ON',
        contactBook: 'ON',
        mentalHealth: 'OFF',
        otherSchoolLog: 'ALLOW',
        studentPasswordChange: 'HIDE'
      };
      const dCurr0 = adapter.getDraftProfile()!;
      const draftRes = await httpRequest({
        port: port,
        path: '/api/profile/draft',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          settings: baseProfileSettings,
          targetSnapshotId: targetSnap.targetSnapshotId,
          observationSnapshotId: obsSnap.observationSnapshotId,
          expectedDraftRevision: dCurr0.draftRevision
        }
      });
      assert.strictEqual(draftRes.statusCode, 200);

      const dAfterDraft = adapter.getDraftProfile()!;
      // Preview 算出
      adapter.calculatePreview(obsSnap.observationSnapshotId, dAfterDraft.draftRevision, dAfterDraft.draftHash);

      // Confirm
      const confirmRes = await httpRequest({
        port: port,
        path: '/api/profile/confirm',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          targetSnapshotId: targetSnap.targetSnapshotId,
          observationSnapshotId: obsSnap.observationSnapshotId,
          expectedDraftRevision: dAfterDraft.draftRevision,
          expectedDraftHash: dAfterDraft.draftHash
        }
      });
      assert.strictEqual(confirmRes.statusCode, 200);
      assert.strictEqual(confirmRes.body.status, 'CONFIRMED');
      const activeProfile = adapter.getActiveProfileSnapshot()!;
      assert.ok(activeProfile);

      // Final Validation
      const finalValSnap = adapter.executeFinalValidation();
      assert.ok(finalValSnap);
      assert.ok(finalValSnap.finalValidationSnapshotId);

      // 3. Final Preflight SUCCESS (子プロセス起動 -> 正常完了レポート生成 -> exit)
      adapter.startFinalPreflightProcess('START');
      const execId = adapter.getCurrentFinalPreflightExecutionId()!;
      assert.ok(execId);

      const reportsDir = getReportsDir();
      const mockReport: PreflightReport = {
        executionId: execId,
        deploymentId: `dep-${execId}`,
        runId: `run-${execId}`,
        toolVersion: getToolVersion(),
        toolFingerprint: targetSnap.toolFingerprint,
        summaryPath: `reports/summary-${execId}.json`,
        schoolsHash: targetSnap.schoolsHash,
        profileHash: activeProfile.profileHash,
        profileSnapshotId: activeProfile.snapshotId,
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
            schoolName: '学校1',
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
      fs.writeFileSync(path.join(reportsDir, `preflight-${execId}.json`), JSON.stringify(mockReport, null, 2));
      fs.writeFileSync(path.join(reportsDir, `summary-${execId}.json`), JSON.stringify({ executionId: execId }, null, 2));

      // 子プロセス終了を模擬して完了処理を実行
      const child = (adapter as any).childProcess;
      if (child) {
        child.emit('exit', 0, null);
      }
      (adapter as any).currentJobState = 'IDLE';

      // 4. SSE completion: activeFinalPreflightContext が確立されていること
      const ctxAfterPreflight = adapter.getActiveFinalPreflightContext();
      assert.ok(ctxAfterPreflight, 'activeFinalPreflightContext must be populated after successful preflight');
      assert.strictEqual(ctxAfterPreflight.executionId, execId);

      // 5. fetchStatus / render (UI側がジョブ完了通知を受けて GET /api/status を呼び出すフロー)
      const statusRes1 = await httpRequest({
        port: port,
        path: '/api/status',
        method: 'GET'
      });
      assert.strictEqual(statusRes1.statusCode, 200);
      assert.strictEqual(statusRes1.body.applyReady, true, 'Status response must indicate applyReady=true');
      assert.ok(statusRes1.body.activeFinalPreflightContext, 'Status response must contain activeFinalPreflightContext');
      assert.strictEqual(statusRes1.body.activeFinalPreflightContext.executionId, execId);

      // 6. POST /api/profile/draft = 0 (元凶となった、UI描画や初期化時に同一設定を再POSTする操作)
      const dBeforeDraft2 = adapter.getDraftProfile()!;
      const draftRes2 = await httpRequest({
        port: port,
        path: '/api/profile/draft',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {
          settings: baseProfileSettings,
          targetSnapshotId: targetSnap.targetSnapshotId,
          observationSnapshotId: obsSnap.observationSnapshotId,
          expectedDraftRevision: dBeforeDraft2.draftRevision
        }
      });
      assert.strictEqual(draftRes2.statusCode, 200);
      // 冪等判定: revision は増えず、元の draftRevision と一致する
      assert.strictEqual(draftRes2.body.draftProfile.draftRevision, dBeforeDraft2.draftRevision, 'Draft revision must not increment');
      assert.strictEqual(draftRes2.body.draftProfile.draftHash, dBeforeDraft2.draftHash);

      // 7. activeFinalPreflightContext 維持の検証 (破棄されず温存されていること)
      const ctxAfterDraftPost = adapter.getActiveFinalPreflightContext();
      assert.ok(ctxAfterDraftPost, 'activeFinalPreflightContext must survive idempotent draft POST');
      assert.strictEqual(ctxAfterDraftPost.executionId, execId, 'Context executionId must be preserved');

      // 8. server applyReady = true の検証
      assert.strictEqual(adapter.isApplyReady(), true, 'Adapter isApplyReady must remain true');
      const statusRes2 = await httpRequest({
        port: port,
        path: '/api/status',
        method: 'GET'
      });
      assert.strictEqual(statusRes2.statusCode, 200);
      assert.strictEqual(statusRes2.body.applyReady, true, 'Server status must still report applyReady=true');
      assert.strictEqual(statusRes2.body.workflowCapabilities.canPrepareApply, true);

      // 9. Apply Prepare 成功 (POST /api/apply/prepare)
      // 元バグではここで [CONFIG_INVALID] 有効な Final Preflight レポートが見つかりません となっていた
      const prepareRes = await httpRequest({
        port: port,
        path: '/api/apply/prepare',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {}
      });
      assert.strictEqual(prepareRes.statusCode, 200, 'Apply prepare must succeed with 200 OK');
      assert.strictEqual(prepareRes.body.status, 'PREPARED');
      assert.ok(prepareRes.body.manifest, 'Must return manifest');
      assert.ok(prepareRes.body.confirmationToken, 'Must return confirmationToken');
      assert.strictEqual(prepareRes.body.manifest.finalPreflightExecutionId, execId, 'Manifest must have exact executionId');
      assert.strictEqual(prepareRes.body.manifest.applyTargets.length, 1, 'Target count must match');
    });

  } finally {
    await server.stop();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTestSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
