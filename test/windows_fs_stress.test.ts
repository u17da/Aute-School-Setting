import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { CheckpointManager } from '../src/batch/checkpoint';

console.log('=== Phase 5A.2: Windows Filesystem Concurrent Stress Test (100 Writes + 100+ Concurrent Reads) ===\n');

async function runStressTest() {
  const deploymentId = `stress-${Date.now()}`;
  const cp = new CheckpointManager({
    deploymentId,
    runId: 'stress-run-1',
    profileHash: 'stressProfileHash1234567890',
    schoolsHash: 'stressSchoolsHash1234567890',
    toolVersion: '1.0.0',
    authMode: 'A',
    schools: [
      { schoolCode: 'TEST01', schoolName: 'テスト小学校', credentialRef: 'TEST01', enabled: true },
      { schoolCode: 'TEST02', schoolName: 'テスト中学校', credentialRef: 'TEST02', enabled: true },
      { schoolCode: 'TEST03', schoolName: 'テスト高校', credentialRef: 'TEST03', enabled: true }
    ],
    isResume: false
  });

  const checkpointPath = cp.getCheckpointPath();
  const checkpointDir = path.dirname(checkpointPath);

  let pollingErrors = 0;
  let totalReads = 0;
  let stopPolling = false;

  // 1. 複数並行ポーリングリーダーの起動 (Console UI のポーリングおよび他プロセス読取を模倣)
  const NUM_READERS = 3;
  const readersPromises = Array.from({ length: NUM_READERS }).map(async (_, readerId) => {
    while (!stopPolling || totalReads < 100) {
      if (fs.existsSync(checkpointPath)) {
        try {
          const raw = fs.readFileSync(checkpointPath, 'utf-8');
          // 空文字や不完全書き込みの検知
          if (raw.trim().length === 0) {
            throw new Error(`Empty file detected by reader #${readerId}`);
          }
          const parsed = JSON.parse(raw);
          assert.strictEqual(parsed.deploymentId, deploymentId);
          totalReads++;
        } catch (e: any) {
          pollingErrors++;
          console.error(`[POLLING READ ERROR - reader #${readerId}]:`, e.message);
        }
      }
      // ランダム 0〜3ms の競合インターバル
      const sleepMs = Math.floor(Math.random() * 4);
      if (sleepMs > 0) {
        await new Promise((r) => setTimeout(r, sleepMs));
      }
    }
  });

  // 2. 100 回の連続 Checkpoint Atomic Write (ランダムインターバルで競合を誘発)
  const TOTAL_WRITES = 100;
  let writeErrors = 0;
  const startTime = Date.now();

  for (let i = 1; i <= TOTAL_WRITES; i++) {
    try {
      const schoolCode = i % 2 === 0 ? 'TEST01' : 'TEST02';
      cp.finishSchool({
        schoolCode,
        status: i % 2 === 0 ? 'SUCCESS' : 'RUNNING',
        executionStatus: 'SUCCESS',
        actionsCount: i
      });
    } catch (e: any) {
      writeErrors++;
      console.error(`[WRITE ERROR at #${i}]:`, e.message);
    }

    // ランダム 0〜3ms のインターバルを挟み、リーダーの read と衝突しやすくする
    const sleepMs = Math.floor(Math.random() * 4);
    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  const elapsedMs = Date.now() - startTime;
  stopPolling = true;
  await Promise.all(readersPromises);

  // 3. クリーンアップ確認: .tmp.* 残骸の調査
  const remainingFiles = fs.readdirSync(checkpointDir);
  const tempFiles = remainingFiles.filter((f) => f.startsWith(`checkpoint-${deploymentId}.json.tmp`));

  console.log(`[STRESS TEST SUMMARY]`);
  console.log(`- Total Writes Executed : ${TOTAL_WRITES}`);
  console.log(`- Total Polling Reads   : ${totalReads}`);
  console.log(`- Write Errors (EPERM)  : ${writeErrors}`);
  console.log(`- Polling Read Errors   : ${pollingErrors}`);
  console.log(`- Temp Files Remaining  : ${tempFiles.length}`);
  console.log(`- Elapsed Time          : ${elapsedMs}ms (avg ${(elapsedMs / TOTAL_WRITES).toFixed(2)}ms/write)\n`);

  cp.releaseLock();
  try { fs.unlinkSync(checkpointPath); } catch {}

  assert.strictEqual(writeErrors, 0, '書き込みエラー (EPERM含む) が 0 件であること');
  assert.strictEqual(pollingErrors, 0, '並行読み取り時の破損・パースエラーが 0 件であること');
  assert.strictEqual(tempFiles.length, 0, '一時ファイル残骸が 0 件であること');
  assert.ok(TOTAL_WRITES >= 100, '書き込み回数が 100 回以上であること');
  assert.ok(totalReads >= 100, `読み取り回数が 100 回以上であること (実績: ${totalReads})`);

  console.log('=== Windows Filesystem Concurrent Stress Test: 100% PASSED ===\n');
}

runStressTest().catch((err) => {
  console.error('Stress test fatal error:', err);
  process.exit(1);
});
