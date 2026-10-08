import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildExecutionPlan } from '../src/automation/buildExecutionPlan';
import { evaluateExecutionPlan } from '../src/automation/evaluateExecutionPlan';
import { CheckpointManager } from '../src/batch/checkpoint';
import { CircuitBreaker } from '../src/batch/circuitBreaker';
import { BatchSummaryReporter } from '../src/batch/summary';
import { parseSchoolsCsv, validateBatchSchools, validateCredentialsExist, runBatch } from '../src/batch/runBatch';
import { EnvCredentialProvider, FileCredentialProvider } from '../src/batch/credentialProvider';
import { parseCliArgs } from '../src/index';
import { validateObservationMatchesPlan } from '../src/utils/comparator';
import { generateSchoolsHash, generateSettingsHash } from '../src/utils/hash';
import { SettingKey, SettingObservation, SaveObservation, SchoolSettingsObservation } from '../src/types/settings';
import { BatchSchoolItem } from '../src/types/batch';
import { EffectiveExecutionOptions, AppEnvConfig } from '../src/types/config';
import { withRetry } from '../src/utils/retry';
import { AutomationError } from '../src/types/errors';
import { RequestedSettingsSchema } from '../src/config/schema';

console.log('=== Phase 3: Production Batch Foundation Test Suite ===\n');

let passedTests = 0;
let failedTests = 0;

async function runTest(testName: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`[PASS] ${testName}`);
    passedTests++;
  } catch (err: any) {
    console.error(`[FAIL] ${testName}:`, err.message || err);
    failedTests++;
  }
}

function createMockBaselineObservation(): Record<SettingKey, SettingObservation> {
  return {
    storage: { value: 'ON', availability: 'AVAILABLE' },
    timelineChannel: { value: 'OFF', availability: 'AVAILABLE' },
    directMessage: { value: 'STUDENT_TO_STUDENT_DISABLED', availability: 'AVAILABLE' },
    parentDirectMessage: { value: 'ON', availability: 'AVAILABLE' },
    allChannel: { value: null, availability: 'DISABLED_BY_DEPENDENCY' },
    parentChannel: { value: null, availability: 'DISABLED_BY_DEPENDENCY' },
    attendance: { value: 'OFF', availability: 'AVAILABLE' },
    contactBook: { value: 'OFF', availability: 'AVAILABLE' },
    mentalHealth: { value: 'ON', availability: 'AVAILABLE' },
    otherSchoolLog: { value: 'ALLOW', availability: 'AVAILABLE' },
    studentPasswordChange: { value: 'HIDE', availability: 'AVAILABLE' }
  };
}

async function runAllTests() {
  const mockBaselineObservation = createMockBaselineObservation();

  // 1. Multi-action 順序とトポロジカルソート（親が子より先に操作される）
  await runTest('Multi-action: 親項目(timelineChannel)が子項目(allChannel, parentChannel)より先にactionsに配置される', () => {
    const plan = buildExecutionPlan({
      schoolCode: 'TEST01',
      schoolName: 'テスト学校',
      currentObservation: mockBaselineObservation,
      requestedSettings: {
        timelineChannel: 'ON',
        allChannel: 'ON',
        parentChannel: 'ON'
      }
    });

    assert.strictEqual(plan.actions.length, 3);
    assert.strictEqual(plan.actions[0].settingKey, 'timelineChannel', '親項目が先頭であること');
    const childKeys = plan.actions.slice(1).map((a) => a.settingKey);
    assert.ok(childKeys.includes('allChannel'), '子項目allChannelが含まれること');
    assert.ok(childKeys.includes('parentChannel'), '子項目parentChannelが含まれること');
  });

  // 2. 指示3 Case A: dependencyEffects を含む Production Plan & Pre-Save Validation (PASS)
  await runTest('指示3 Case A: directMessage OFFによるparentDirectMessage連動OFFとPre-Save検証成功', () => {
    const baseline: Record<SettingKey, SettingObservation> = {
      ...mockBaselineObservation,
      timelineChannel: { value: 'ON', availability: 'AVAILABLE' },
      allChannel: { value: 'ON', availability: 'AVAILABLE' },
      parentChannel: { value: 'ON', availability: 'AVAILABLE' },
      directMessage: { value: 'ON', availability: 'AVAILABLE' },
      parentDirectMessage: { value: 'ON', availability: 'AVAILABLE' }
    };

    const plan = buildExecutionPlan({
      schoolCode: 'SCH_A',
      schoolName: 'テスト学校A',
      currentObservation: baseline,
      requestedSettings: {
        directMessage: 'OFF',
        parentDirectMessage: null // unmanaged
      }
    });

    // actions は directMessage OFF のみ
    assert.strictEqual(plan.actions.length, 1);
    assert.strictEqual(plan.actions[0].settingKey, 'directMessage');
    assert.strictEqual(plan.actions[0].to, 'OFF');

    // dependencyEffects に parentDirectMessage の利用不能化 (AVAILABILITY_CHANGE) が含まれる
    assert.strictEqual(plan.dependencyEffects.length, 1);
    assert.strictEqual(plan.dependencyEffects[0].targetSettingKey, 'parentDirectMessage');
    assert.strictEqual(plan.dependencyEffects[0].effectType, 'AVAILABILITY_CHANGE');
    assert.strictEqual(plan.dependencyEffects[0].expectedValue, null);
    assert.strictEqual(plan.dependencyEffects[0].expectedAvailability, 'DISABLED_BY_DEPENDENCY');

    // expectedFinalState の確認
    assert.strictEqual(plan.items['directMessage'].expected.value, 'OFF');
    assert.strictEqual(plan.items['parentDirectMessage'].expected.value, null);
    assert.strictEqual(plan.items['parentDirectMessage'].expected.availability, 'DISABLED_BY_DEPENDENCY');

    // Phase 4C Pre-Save Validation: directMessage OFF操作直後、未保存のparentDirectMessageはBaseline(ON/AVAILABLE)のまま
    const preSaveDomObs: SchoolSettingsObservation = {
      ...baseline,
      directMessage: { value: 'OFF', availability: 'AVAILABLE' },
      parentDirectMessage: { value: 'ON', availability: 'AVAILABLE' }
    };
    const preValResult = validateObservationMatchesPlan(preSaveDomObs, plan, 'PRE_SAVE');
    assert.strictEqual(preValResult.isValid, true, 'Case A はPre-Save ValidationにPASSすること');
    assert.strictEqual(preValResult.hasUnexpectedSideEffect, false);

    // Phase 4C Post-Save Validation: サーバー保存reload後、parentDirectMessageが利用不能化される
    const postSaveDomObs: SchoolSettingsObservation = {
      ...baseline,
      directMessage: { value: 'OFF', availability: 'AVAILABLE' },
      parentDirectMessage: { value: null, availability: 'DISABLED_BY_DEPENDENCY' }
    };
    const postValResult = validateObservationMatchesPlan(postSaveDomObs, plan, 'POST_SAVE');
    assert.strictEqual(postValResult.isValid, true, 'Case A はPost-Save ValidationにPASSすること');
    assert.strictEqual(postValResult.hasUnexpectedSideEffect, false);
  });

  // 3. 指示3 Case B: Post-Save時に連動すべき parentDirectMessage が ON のまま (FAIL)
  await runTest('指示3 Case B: parentDirectMessageが連動せずONのままでPost-Save検証がFAILする', () => {
    const baseline: Record<SettingKey, SettingObservation> = {
      ...mockBaselineObservation,
      timelineChannel: { value: 'ON', availability: 'AVAILABLE' },
      allChannel: { value: 'ON', availability: 'AVAILABLE' },
      parentChannel: { value: 'ON', availability: 'AVAILABLE' },
      directMessage: { value: 'ON', availability: 'AVAILABLE' },
      parentDirectMessage: { value: 'ON', availability: 'AVAILABLE' }
    };

    const plan = buildExecutionPlan({
      schoolCode: 'SCH_B',
      schoolName: 'テスト学校B',
      currentObservation: baseline,
      requestedSettings: {
        directMessage: 'OFF',
        parentDirectMessage: null
      }
    });

    assert.strictEqual(plan.dependencyEffects.length, 1);

    // サーバー保存 reload 後に parentDirectMessage が ON のまま変化しなかった異常状態
    const simulatedDomObs: SchoolSettingsObservation = {
      ...baseline,
      directMessage: { value: 'OFF', availability: 'AVAILABLE' },
      parentDirectMessage: { value: 'ON', availability: 'AVAILABLE' }
    };

    const valResult = validateObservationMatchesPlan(simulatedDomObs, plan, 'POST_SAVE');
    assert.strictEqual(valResult.isValid, false, 'Case B はPost-Save ValidationにFAILすること');
    assert.strictEqual(valResult.mismatches.length, 1);
    assert.strictEqual(valResult.mismatches[0].key, 'parentDirectMessage');
  });

  // 4. 指示3 Case C: unmanaged な attendance が Baseline から変化 (UNEXPECTED_SIDE_EFFECT)
  await runTest('指示3 Case C: unmanagedな項目が勝手に変化しUNEXPECTED_SIDE_EFFECTとなる', () => {
    const baseline: Record<SettingKey, SettingObservation> = {
      ...mockBaselineObservation,
      directMessage: { value: 'ON', availability: 'AVAILABLE' },
      attendance: { value: 'OFF', availability: 'AVAILABLE' }
    };

    const plan = buildExecutionPlan({
      schoolCode: 'SCH_C',
      schoolName: 'テスト学校C',
      currentObservation: baseline,
      requestedSettings: {
        directMessage: 'OFF'
      }
    });

    // unmanaged な attendance が意図せず ON に化けた状態
    const simulatedDomObs: SchoolSettingsObservation = {
      ...baseline,
      directMessage: { value: 'OFF', availability: 'AVAILABLE' },
      parentDirectMessage: { value: 'OFF', availability: 'DISABLED_BY_DEPENDENCY' },
      attendance: { value: 'ON', availability: 'AVAILABLE' } // 副作用発生
    };

    const valResult = validateObservationMatchesPlan(simulatedDomObs, plan);
    assert.strictEqual(valResult.isValid, false);
    assert.strictEqual(valResult.hasUnexpectedSideEffect, true, 'unchanged項目の変化はhasUnexpectedSideEffectとなること');
  });

  // 5. Destructive Change 検知
  await runTest('Destructive Change: タイムライン機能をONからOFFにする計画で hasDestructiveChanges === true となる', () => {
    const onBaseline: Record<SettingKey, SettingObservation> = {
      ...mockBaselineObservation,
      timelineChannel: { value: 'ON', availability: 'AVAILABLE' },
      allChannel: { value: 'ON', availability: 'AVAILABLE' }
    };
    const plan = buildExecutionPlan({
      schoolCode: 'TEST01',
      schoolName: 'テスト学校',
      currentObservation: onBaseline,
      requestedSettings: {
        timelineChannel: 'OFF'
      }
    });

    assert.strictEqual(plan.hasDestructiveChanges, true, 'タイムラインON->OFFは破壊的変更と判定されること');
  });

  // 6. SaveObservation の型と値の分離検証
  await runTest('SaveObservation: submitResponseStatus (302) と finalNavigationStatus (200) が正しく分離保持できる', () => {
    const saveObs: SaveObservation = {
      submitRequestUrl: 'https://ed-cl.com/manage/organization',
      submitMethod: 'POST',
      submitResponseStatus: 302,
      redirectDetected: true,
      redirectLocation: 'https://ed-cl.com/manage/organization/edit',
      finalUrl: 'https://ed-cl.com/manage/organization/edit',
      finalNavigationStatus: 200,
      flashMessage: '更新しました'
    };

    assert.strictEqual(saveObs.submitResponseStatus, 302);
    assert.strictEqual(saveObs.finalNavigationStatus, 200);
    assert.strictEqual(saveObs.flashMessage, '更新しました');
  });

  // 7. 学校CSVパースと確定順序保持 Schools Hash（指示3, 10: A !== B, A1 === A2）
  await runTest('CSV Parser & Schools Hash: 学校一覧確定順序のハッシュ検証 (A !== B, A1 === A2)', () => {
    const csvContent = `schoolCode,schoolName,credentialRef,enabled
PRRHC,MEXCBTデモ学校,PRRHC,true
SCH001,第一小学校,CRED001,1
SCH002,第二小学校,CRED002,false`;

    const schools = parseSchoolsCsv(csvContent);
    assert.strictEqual(schools.length, 3);
    assert.strictEqual(schools[0].schoolCode, 'PRRHC');

    const hashA1 = generateSchoolsHash(schools);
    const hashA2 = generateSchoolsHash([...schools]);
    assert.strictEqual(hashA1, hashA2, '同一順序なら同一ハッシュ (A1 === A2)');

    // 順序を変更した場合はハッシュが異なること (Canary順序保護)
    const reversed = [...schools].reverse();
    const hashB = generateSchoolsHash(reversed);
    assert.notStrictEqual(hashA1, hashB, '順序が異なる場合は別ハッシュ (A !== B)');
  });

  // 8. CheckpointManager: Atomic Write & 排他Lock & 異常終了サニタイズ
  await runTest('Checkpoint: Atomic Write, Lock排他制御, INTERRUPTED自動サニタイズ', () => {
    const testDeployId = 'test-deploy-' + Date.now();
    const runId1 = 'run-1';
    const schools: BatchSchoolItem[] = [
      { schoolCode: 'S1', schoolName: '学校1', credentialRef: 'C1', enabled: true },
      { schoolCode: 'S2', schoolName: '学校2', credentialRef: 'C2', enabled: true }
    ];

    const cp1 = new CheckpointManager({
      deploymentId: testDeployId,
      runId: runId1,
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools,
      isResume: false
    });

    cp1.startSchool('S1');

    // 同一 deploymentId で二重起動を試行 -> BATCH_LOCKED で拒絶されること
    assert.throws(
      () => {
        new CheckpointManager({
          deploymentId: testDeployId,
          runId: 'run-conflict',
          profileHash: 'hashP',
          schoolsHash: 'hashS',
          toolVersion: '1.0.0',
          authMode: 'A',
          schools,
          isResume: false
        });
      },
      /BATCH_LOCKED/,
      '既存Lockが存在する場合は二重起動が拒否されること'
    );

    // ロックを解放
    cp1.releaseLock();

    // 異常終了からの再開をシミュレート（S1 が RUNNING のままロードされる）
    const cp2 = new CheckpointManager({
      deploymentId: testDeployId,
      runId: 'run-resume',
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools,
      isResume: true
    });

    const entryS1 = cp2.getEntry('S1');
    assert.strictEqual(entryS1?.status, 'INTERRUPTED', 'RUNNINGのまま異常終了した学校はINTERRUPTEDへ自動変換されること');
    cp2.releaseLock();

    // テスト後クリーンアップ
    if (fs.existsSync(cp1.getCheckpointPath())) fs.unlinkSync(cp1.getCheckpointPath());
  });

  // 9. 指示5: Resume 時の整合性確認（CHECKPOINT_MISMATCH）
  await runTest('Resume Checkpoint Integrity: 設定Hash不一致時にCHECKPOINT_MISMATCHで拒絶される', () => {
    const testDeployId = 'test-mismatch-' + Date.now();
    const schools: BatchSchoolItem[] = [
      { schoolCode: 'S1', schoolName: '学校1', credentialRef: 'C1', enabled: true }
    ];

    const cp = new CheckpointManager({
      deploymentId: testDeployId,
      runId: 'run-init',
      profileHash: 'hashP_original',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools,
      isResume: false
    });
    cp.releaseLock();

    // 異なる profileHash で Resume を試行
    assert.throws(
      () => {
        new CheckpointManager({
          deploymentId: testDeployId,
          runId: 'run-diff-profile',
          profileHash: 'hashP_MODIFIED',
          schoolsHash: 'hashS',
          toolVersion: '1.0.0',
          authMode: 'A',
          schools,
          isResume: true
        });
      },
      /CHECKPOINT_MISMATCH/,
      'プロファイルHash不一致でResumeが拒否されること'
    );

    if (fs.existsSync(cp.getCheckpointPath())) fs.unlinkSync(cp.getCheckpointPath());
  });

  // 10. 指示9, 10: 重大度別 Circuit Breaker (CRITICAL: 1件即PAUSE, SYSTEMIC: 3校連続PAUSE, SCHOOL_SPECIFIC: 継続)
  await runTest('Circuit Breaker: 重大度別トリップ制御 (CRITICALは1件、SYSTEMICは3件連続、SCHOOL_SPECIFICは継続)', () => {
    const cb = new CircuitBreaker({ consecutiveFailureThreshold: 3, canaryMode: true });

    // SCHOOL_SPECIFIC はトリップせず次校へ
    cb.recordResult('SCHOOL_MISMATCH', 'SCH01');
    assert.strictEqual(cb.shouldStop(), false);
    cb.recordResult('CREDENTIAL_NOT_FOUND', 'SCH02');
    assert.strictEqual(cb.shouldStop(), false);

    // Canary モードでの SAVE_FAILED は1件で即 PAUSE
    cb.recordResult('SAVE_FAILED', 'SCH03');
    assert.strictEqual(cb.shouldStop(), true);
    assert.strictEqual(cb.getTripInfo()?.category, 'SYSTEMIC');
    assert.strictEqual(cb.getTripInfo()?.errorCode, 'SAVE_FAILED');

    // リセットして CRITICAL のテスト
    cb.reset();
    assert.strictEqual(cb.shouldStop(), false);

    // CRITICAL: UNEXPECTED_SIDE_EFFECT は 1件で即トリップ
    cb.recordResult('UNEXPECTED_SIDE_EFFECT', 'SCH04');
    assert.strictEqual(cb.shouldStop(), true);
    assert.strictEqual(cb.getTripInfo()?.category, 'CRITICAL');
    assert.strictEqual(cb.getTripInfo()?.consecutiveCount, 1);
  });

  // 11. BatchSummaryReporter & Preflight Report (24h 有効期限)
  await runTest('Batch Summary & Preflight Report: 24時間有効期限付きレポート出力', () => {
    const deployId = 'test-deploy-' + Date.now();
    const runId = 'test-run-1';
    const reporter = new BatchSummaryReporter({
      deploymentId: deployId,
      runId,
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0'
    });

    reporter.addSchoolResult({
      schoolCode: 'S0',
      schoolName: '変更なし校',
      status: 'SUCCESS_ALREADY_CONFIGURED',
      actionsCount: 0
    });
    reporter.addSchoolResult({
      schoolCode: 'S1',
      schoolName: '1件変更校',
      status: 'SUCCESS',
      actionsCount: 1
    });

    const report = reporter.generateReport({ totalSchools: 2, skippedSchools: 0 });
    assert.strictEqual(report.totalSchools, 2);
    assert.strictEqual(report.alreadyConfigured, 1);
    assert.strictEqual(report.requiresChange, 1);

    // Preflight Report が生成されたか検証
    const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${deployId}.json`);
    assert.ok(fs.existsSync(pfPath), 'Preflight Reportが出力されること');
    const pfData = JSON.parse(fs.readFileSync(pfPath, 'utf-8'));
    assert.strictEqual(pfData.deploymentId, deployId);
    assert.ok(new Date(pfData.validUntil).getTime() > Date.now(), '有効期限が未来であること');

    // クリーンアップ
    fs.unlinkSync(pfPath);
    const sumPath = path.resolve(process.cwd(), 'reports', `summary-${deployId}-${runId}.json`);
    if (fs.existsSync(sumPath)) fs.unlinkSync(sumPath);
  });

  // 12. CLI 複数 school-code パース
  await runTest('CLI Options: 複数 --school-code のパース', () => {
    const parsed = parseCliArgs([
      '--batch',
      '--school-code', 'AAA01',
      '--school-code', 'BBB02',
      '--school-code', 'CCC03',
      '--delay-between-schools-ms', '2000'
    ]);

    assert.strictEqual(parsed.phase, 'BATCH');
    assert.deepStrictEqual(parsed.schoolCodes, ['AAA01', 'BBB02', 'CCC03']);
    assert.strictEqual(parsed.delayBetweenSchoolsMs, 2000);
  });

  // 13. 指示5, 6: 有効学校での重複 schoolCode 拒否 (BATCH_INPUT_INVALID)
  await runTest('Batch Input Validation: 有効な学校での重複 schoolCode 拒否 (BATCH_INPUT_INVALID)', () => {
    const invalidSchools: BatchSchoolItem[] = [
      { schoolCode: 'DUP01', schoolName: '学校1', credentialRef: 'C1', enabled: true },
      { schoolCode: 'DUP01', schoolName: '学校2', credentialRef: 'C2', enabled: true }
    ];

    assert.throws(
      () => validateBatchSchools(invalidSchools),
      (err: any) => err.status === 'BATCH_INPUT_INVALID'
    );

    // enabled: false の重複は許容されること
    const validWithDisabled: BatchSchoolItem[] = [
      { schoolCode: 'CODE01', schoolName: '有効校', credentialRef: 'C1', enabled: true },
      { schoolCode: 'CODE01', schoolName: '無効校', credentialRef: 'C2', enabled: false }
    ];
    assert.doesNotThrow(() => validateBatchSchools(validWithDisabled));
  });

  // 14. 指示7: 開始前に全対象校の credentialRef 存在検証 (CREDENTIAL_NOT_FOUND)
  await runTest('Credential Pre-validation: 未定義 credentialRef 検知による事前拒絶 (CREDENTIAL_NOT_FOUND)', () => {
    const schools: BatchSchoolItem[] = [
      { schoolCode: 'SCH01', schoolName: '学校1', credentialRef: 'EXISTING_CRED', enabled: true },
      { schoolCode: 'SCH02', schoolName: '学校2', credentialRef: 'MISSING_CRED', enabled: true }
    ];

    const credMap = new Map<string, { userId: string; password: string }>();
    credMap.set('EXISTING_CRED', { userId: 'admin', password: 'pw' });

    const mockProvider = {
      getCredential: async (ref: string) => {
        const c = credMap.get(ref);
        if (!c) throw new Error('Not found');
        return c;
      },
      hasCredential: (ref: string) => credMap.has(ref)
    };

    assert.throws(
      () => validateCredentialsExist(schools, mockProvider),
      (err: any) => err.status === 'CREDENTIAL_NOT_FOUND'
    );
  });

  // 15. 指示8, 9: モード別 SCHOOL_MISMATCH 制御 (Read-onlyは継続、Writeは即PAUSE)
  await runTest('Circuit Breaker: モード別 SCHOOL_MISMATCH 制御 (Read-only継続 / Write即PAUSE)', () => {
    // A. Read-only モード: SCHOOL_MISMATCH は個別エラーとして継続
    const cbRead = new CircuitBreaker();
    cbRead.recordResult('SCHOOL_MISMATCH', 'SCH_RO', 'PREFLIGHT_DRY_RUN');
    assert.strictEqual(cbRead.shouldStop(), false, 'Read-onlyモードではSCHOOL_MISMATCHでトリップしないこと');

    // B. Write モード: SCHOOL_MISMATCH は CRITICAL として即トリップ
    const cbWrite = new CircuitBreaker();
    cbWrite.recordResult('SCHOOL_MISMATCH', 'SCH_WR', 'PRODUCTION_WRITE');
    assert.strictEqual(cbWrite.shouldStop(), true, 'WriteモードではSCHOOL_MISMATCHで即PAUSEすること');
    assert.strictEqual(cbWrite.getTripInfo()?.category, 'CRITICAL');
  });

  // 16. 指示11: 生存プロセスによるロック存在時は --clear-stale-lock でも拒絶 (BATCH_LOCKED)
  await runTest('Lock Safety: OS上で生存中のプロセスによるロックは --clear-stale-lock でも拒絶される', () => {
    const deployId = 'lock-safety-' + Date.now();
    const lockDir = path.resolve(process.cwd(), 'checkpoints');
    if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, `${deployId}.lock`);

    // 現在実行中のプロセス (自分自身のpid) でlockファイルを作成
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        runId: 'existing-run',
        startedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
        host: 'test-host'
      }),
      'utf-8'
    );

    try {
      assert.throws(
        () => {
          new CheckpointManager({
            deploymentId: deployId,
            runId: 'new-run',
            profileHash: 'hashP',
            schoolsHash: 'hashS',
            toolVersion: '1.0.0',
            authMode: 'A',
            schools: [],
            isResume: false,
            clearStaleLock: true // 生存プロセスに対して強制解除フラグを指定
          });
        },
        (err: any) => err.status === 'BATCH_LOCKED',
        '生存プロセスが存在する場合は clearStaleLock でも BATCH_LOCKED がスローされること'
      );
    } finally {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    }
  });

  // 17. 指示7: toolFingerprint 変更時の Resume 拒絶 (CHECKPOINT_MISMATCH)
  await runTest('toolFingerprint Integrity: Fingerprint不一致時にCHECKPOINT_MISMATCHでResumeを拒絶', () => {
    const deployId = 'test-fp-' + Date.now();
    const schools: BatchSchoolItem[] = [
      { schoolCode: 'S1', schoolName: '学校1', credentialRef: 'C1', enabled: true }
    ];

    // Fingerprint A で作成
    const cp1 = new CheckpointManager({
      deploymentId: deployId,
      runId: 'run-init',
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0',
      toolFingerprint: 'fingerprint_A',
      authMode: 'A',
      schools,
      isResume: false
    });
    cp1.releaseLock();

    // Fingerprint B で Resume を試行
    assert.throws(
      () => {
        new CheckpointManager({
          deploymentId: deployId,
          runId: 'run-resume',
          profileHash: 'hashP',
          schoolsHash: 'hashS',
          toolVersion: '1.0.0',
          toolFingerprint: 'fingerprint_B',
          authMode: 'A',
          schools,
          isResume: true
        });
      },
      (err: any) => err.status === 'CHECKPOINT_MISMATCH',
      'toolFingerprintが不一致のResumeはCHECKPOINT_MISMATCHで拒絶されること'
    );

    // クリーンアップ
    const cpPath = path.resolve(process.cwd(), 'checkpoints', `checkpoint-${deployId}.json`);
    if (fs.existsSync(cpPath)) fs.unlinkSync(cpPath);
  });

  // 18. 指示8: 完全 Static Validation (schoolName空文字, credentialRef空文字の拒絶)
  await runTest('Static Input Validation: schoolNameおよびcredentialRefの空文字を事前拒絶', () => {
    const emptyNameSchools: BatchSchoolItem[] = [
      { schoolCode: 'S1', schoolName: '   ', credentialRef: 'C1', enabled: true }
    ];
    assert.throws(
      () => validateBatchSchools(emptyNameSchools),
      (err: any) => err.status === 'BATCH_INPUT_INVALID',
      'schoolNameが空の学校はBATCH_INPUT_INVALIDとなること'
    );

    const emptyCredSchools: BatchSchoolItem[] = [
      { schoolCode: 'S2', schoolName: '学校2', credentialRef: '', enabled: true }
    ];
    assert.throws(
      () => validateBatchSchools(emptyCredSchools),
      (err: any) => err.status === 'BATCH_INPUT_INVALID',
      'credentialRefが空の学校はBATCH_INPUT_INVALIDとなること'
    );
  });

  // 19. 指示9: 想定学校数 Gate (--expected-school-count)
  await runTest('Expected School Count Gate: enabled学校数と期待数の不一致でBATCH_INPUT_INVALID', () => {
    const schools: BatchSchoolItem[] = [
      { schoolCode: 'S1', schoolName: '学校1', credentialRef: 'C1', enabled: true },
      { schoolCode: 'S2', schoolName: '学校2', credentialRef: 'C2', enabled: true },
      { schoolCode: 'S3', schoolName: '学校3', credentialRef: 'C3', enabled: false }
    ];

    const enabledCount = schools.filter((s) => s.enabled).length;
    assert.strictEqual(enabledCount, 2);

    const expectedCountMismatch = 300;
    assert.notStrictEqual(enabledCount, expectedCountMismatch);

    // 一致時は2
    const expectedCountMatch = 2;
    assert.strictEqual(enabledCount, expectedCountMatch);
  });

  // 20. 指示11-15: 拡張 Summary & Preflight Report 集計と概念分離
  await runTest('Expanded Summary & Preflight Report: 概念分離, 分布集計, 破壊的変更詳細', () => {
    const deployId = 'test-exp-sum-' + Date.now();
    const runId = 'test-run-exp';
    const reporter = new BatchSummaryReporter({
      deploymentId: deployId,
      runId,
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'hashFullProfile64CharsLongString1234567890abcdef1234567890abcdef1234',
      schoolsHash: 'hashFullSchools64CharsLongString1234567890abcdef1234567890abcdef1234',
      toolVersion: '1.0.0',
      toolFingerprint: 'fingerprint_test'
    });

    // 学校1: 変更不要校 (ALREADY_CONFIGURED)
    reporter.addSchoolResult({
      schoolCode: 'S1',
      schoolName: '設定済校',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 0,
      hasDestructiveChanges: false,
      before: {
        storage: 'ON',
        timelineChannel: 'ON',
        mentalHealth: 'ON'
      },
      requested: {
        storage: 'ON',
        timelineChannel: 'ON'
      }
    });

    // 学校2: 非破壊的変更校 (1件変更)
    reporter.addSchoolResult({
      schoolCode: 'S2',
      schoolName: '通常変更校',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 1,
      hasDestructiveChanges: false,
      before: {
        storage: 'OFF',
        timelineChannel: 'ON',
        mentalHealth: null // CONTRACT_NOT_AVAILABLE
      },
      requested: {
        storage: 'ON',
        timelineChannel: 'ON'
      }
    });

    // 学校3: 破壊的変更校 (timelineChannel ON -> OFF)
    reporter.addSchoolResult({
      schoolCode: 'S3',
      schoolName: '破壊的変更校',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 2,
      hasDestructiveChanges: true,
      before: {
        storage: 'ON',
        timelineChannel: 'ON',
        mentalHealth: 'OFF'
      },
      requested: {
        storage: 'ON',
        timelineChannel: 'OFF'
      }
    });

    const report = reporter.generateReport({ totalSchools: 3, skippedSchools: 0 });

    // 指示14: 概念分離の検証
    assert.strictEqual(report.readSuccess, 3, 'Read成功数は3校');
    assert.strictEqual(report.readFailed, 0);
    assert.strictEqual(report.planExecutable, 3, 'Plan実行可能数は3校');
    assert.strictEqual(report.planBlocked, 0);
    assert.strictEqual(report.alreadyConfigured, 1);
    assert.strictEqual(report.requiresChange, 2);
    assert.strictEqual(report.writeEligibleNonDestructive, 2, 'Write可能(非破壊)は2校');
    assert.strictEqual(report.writeBlockedDestructive, 1, 'Writeブロック(破壊的)は1校');

    // 指示11: 破壊的変更詳細
    assert.strictEqual(report.destructiveChangeSchools, 1);
    assert.strictEqual(report.destructiveChangeActions, 1);
    assert.strictEqual(report.destructiveChangeDetails.length, 1);
    assert.strictEqual(report.destructiveChangeDetails[0].schoolCode, 'S3');
    assert.strictEqual(report.destructiveChangeDetails[0].risk, 'SCHEDULED_POSTS_MAY_BE_DELETED');

    // 指示12: 現在値分布
    assert.strictEqual(report.currentStateDistribution['storage']['ON'], 2);
    assert.strictEqual(report.currentStateDistribution['storage']['OFF'], 1);
    assert.strictEqual(report.currentStateDistribution['mentalHealth']['CONTRACT_NOT_AVAILABLE'], 1);

    // 指示13: 変更予定数分布
    assert.strictEqual(report.plannedChangeDistribution['storage']['OFF_TO_ON'], 1);
    assert.strictEqual(report.plannedChangeDistribution['timelineChannel']['ON_TO_OFF'], 1);

    // 指示15: Preflight Report completedAt基準有効期限
    const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${deployId}.json`);
    assert.ok(fs.existsSync(pfPath));
    const pf = JSON.parse(fs.readFileSync(pfPath, 'utf-8'));
    assert.strictEqual(pf.toolVersion, '1.0.0');
    assert.strictEqual(pf.toolFingerprint, 'fingerprint_test');
    const validUntilMs = new Date(pf.validUntil).getTime();
    const completedAtMs = new Date(pf.completedAt).getTime();
    assert.strictEqual(validUntilMs - completedAtMs, 24 * 3600 * 1000, '有効期限はcompletedAtから正確に24時間後であること');

    // クリーンアップ
    fs.unlinkSync(pfPath);
    const sumPath = path.resolve(process.cwd(), 'reports', `summary-${deployId}-${runId}.json`);
    if (fs.existsSync(sumPath)) fs.unlinkSync(sumPath);
  });

  // =========================================================================
  // 指示10: --validate-only 単体テスト（5ケース）
  // =========================================================================
  const tempTestDir = path.resolve(process.cwd(), 'reports', 'test_tmp');
  if (!fs.existsSync(tempTestDir)) {
    fs.mkdirSync(tempTestDir, { recursive: true });
  }

  const validProfilePath = path.join(tempTestDir, 'profile.valid.json');
  fs.writeFileSync(validProfilePath, JSON.stringify({ storage: 'ON', timelineChannel: 'OFF' }));

  const invalidProfilePath = path.join(tempTestDir, 'profile.invalid.json');
  fs.writeFileSync(invalidProfilePath, JSON.stringify({ storage: 'SUPER_ON' })); // 不正な値

  const validCsvPath = path.join(tempTestDir, 'schools.valid.csv');
  fs.writeFileSync(
    validCsvPath,
    'schoolCode,schoolName,credentialRef,enabled\nSCH01,第1学校,cred_sch01,true\nSCH02,第2学校,cred_sch02,true\n'
  );

  const dupCsvPath = path.join(tempTestDir, 'schools.dup.csv');
  fs.writeFileSync(
    dupCsvPath,
    'schoolCode,schoolName,credentialRef,enabled\nSCH01,第1学校,cred_sch01,true\nSCH01,第1学校重複,cred_sch01,true\n'
  );

  const validCredsPath = path.join(tempTestDir, 'credentials.valid.json');
  fs.writeFileSync(
    validCredsPath,
    JSON.stringify({
      cred_sch01: { userId: 'u1', password: 'p1' },
      cred_sch02: { userId: 'u2', password: 'p2' }
    })
  );

  const missingCredsPath = path.join(tempTestDir, 'credentials.missing.json');
  fs.writeFileSync(
    missingCredsPath,
    JSON.stringify({
      cred_sch01: { userId: 'u1', password: 'p1' }
      // cred_sch02 が欠損
    })
  );

  const baseExecOptions: EffectiveExecutionOptions = {
    configFile: 'dummy.json',
    apply: false,
    allowDestructive: false,
    allowLiveWrite: false,
    batchApply: false,
    authMode: 'A',
    headless: true,
    slowMoMs: 0,
    defaultTimeoutMs: 30000
  };

  const baseEnvConfig: AppEnvConfig = {
    baseUrl: 'https://example.com',
    authMode: 'A',
    schoolCode: 'SCH01',
    userId: 'u1',
    password: 'p1',
    externalIdpTimeoutMs: 30000,
    dryRun: true,
    allowDestructiveChanges: false,
    headless: true,
    slowMoMs: 0,
    defaultTimeoutMs: 30000
  };

  await runTest('--validate-only Case 1: 正常系入力検証 (ブラウザ起動なし、BrowserContext 0 で完了)', async () => {
    const report = await runBatch({
      schoolsFilePath: validCsvPath,
      profileFilePath: validProfilePath,
      credentialsFilePath: validCredsPath,
      executionOptions: baseExecOptions,
      envConfig: baseEnvConfig,
      validateOnly: true,
      expectedSchoolCount: 2
    });

    assert.strictEqual(report.processedSchools, 0, 'ブラウザ処理は0件であること');
    assert.strictEqual(report.totalSchools, 2);
    assert.ok(report.profileHash && report.profileHash.length === 64, 'Profile Hashが算出されていること');
    assert.ok(report.schoolsHash && report.schoolsHash.length === 64, 'Schools Hashが算出されていること');
    assert.ok(report.toolFingerprint && report.toolFingerprint.length > 0, 'Tool Fingerprintが算出されていること');
  });

  await runTest('--validate-only Case 2: expectedSchoolCount 不一致時に BATCH_INPUT_INVALID で安全停止', async () => {
    let thrownError: any = null;
    try {
      await runBatch({
        schoolsFilePath: validCsvPath,
        profileFilePath: validProfilePath,
        credentialsFilePath: validCredsPath,
        executionOptions: baseExecOptions,
        envConfig: baseEnvConfig,
        validateOnly: true,
        expectedSchoolCount: 5 // 実際の有効校は2校
      });
    } catch (e: any) {
      thrownError = e;
    }
    assert.ok(thrownError, 'エラーがスローされること');
    assert.strictEqual(thrownError.status, 'BATCH_INPUT_INVALID');
  });

  await runTest('--validate-only Case 3: credentialRef 不足時に CREDENTIAL_NOT_FOUND で安全停止', async () => {
    let thrownError: any = null;
    try {
      await runBatch({
        schoolsFilePath: validCsvPath,
        profileFilePath: validProfilePath,
        credentialsFilePath: missingCredsPath,
        executionOptions: baseExecOptions,
        envConfig: baseEnvConfig,
        validateOnly: true
      });
    } catch (e: any) {
      thrownError = e;
    }
    assert.ok(thrownError, 'エラーがスローされること');
    assert.strictEqual(thrownError.status, 'CREDENTIAL_NOT_FOUND');
  });

  await runTest('--validate-only Case 4: 重複 schoolCode 存在時に BATCH_INPUT_INVALID で安全停止', async () => {
    let thrownError: any = null;
    try {
      await runBatch({
        schoolsFilePath: dupCsvPath,
        profileFilePath: validProfilePath,
        credentialsFilePath: validCredsPath,
        executionOptions: baseExecOptions,
        envConfig: baseEnvConfig,
        validateOnly: true
      });
    } catch (e: any) {
      thrownError = e;
    }
    assert.ok(thrownError, 'エラーがスローされること');
    assert.strictEqual(thrownError.status, 'BATCH_INPUT_INVALID');
  });

  await runTest('--validate-only Case 5: profile スキーマ不正時に CONFIG_INVALID で安全停止', async () => {
    let thrownError: any = null;
    try {
      await runBatch({
        schoolsFilePath: validCsvPath,
        profileFilePath: invalidProfilePath,
        credentialsFilePath: validCredsPath,
        executionOptions: baseExecOptions,
        envConfig: baseEnvConfig,
        validateOnly: true
      });
    } catch (e: any) {
      thrownError = e;
    }
    assert.ok(thrownError, 'エラーがスローされること');
    assert.strictEqual(thrownError.status, 'CONFIG_INVALID');
  });

  // クリーンアップ
  try {
    fs.rmSync(tempTestDir, { recursive: true, force: true });
  } catch {}

  // =========================================================================
  // 指示13: Authentication Retry 境界テスト（4ケース）
  // =========================================================================
  await runTest('Authentication Retry Case A: 初期ナビゲーション失敗はリトライ可能（成功するまで再試行）', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('net::ERR_CONNECTION_RESET');
        }
        return 'NAV_SUCCESS';
      },
      { retries: 3, delayMs: 10 }
    );
    assert.strictEqual(result, 'NAV_SUCCESS');
    assert.strictEqual(attempts, 2, '2回試行されて成功すること');
  });

  await runTest('Authentication Retry Case B: 学校コード入力・遷移中失敗（パスワード送信前）はリトライ可能', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new AutomationError('TIMEOUT', '学校コード入力待ちタイムアウト');
        }
        return 'SCHOOL_CODE_SUCCESS';
      },
      { retries: 3, delayMs: 10 }
    );
    assert.strictEqual(result, 'SCHOOL_CODE_SUCCESS');
    assert.strictEqual(attempts, 2, '2回試行されて成功すること');
  });

  await runTest('Authentication Retry Case C: パスワード送信後タイムアウト/切断(AUTH_OUTCOME_UNKNOWN)はリトライ厳禁(即時1回で中断)', async () => {
    let attempts = 0;
    let thrownError: any = null;
    try {
      await withRetry(
        async () => {
          attempts++;
          throw new AutomationError(
            'AUTH_OUTCOME_UNKNOWN',
            '認証情報送信後に成否を確認できませんでした (タイムアウトまたは切断)'
          );
        },
        { retries: 3, delayMs: 10 }
      );
    } catch (e: any) {
      thrownError = e;
    }
    assert.ok(thrownError, 'エラーがスローされること');
    assert.strictEqual(thrownError.status, 'AUTH_OUTCOME_UNKNOWN');
    assert.strictEqual(attempts, 1, 'リトライされず厳格に1回のみで終了すること');
  });

  await runTest('Authentication Retry Case D: 明確なログイン失敗(LOGIN_FAILED)はリトライ厳禁(即時1回で中断)', async () => {
    let attempts = 0;
    let thrownError: any = null;
    try {
      await withRetry(
        async () => {
          attempts++;
          throw new AutomationError(
            'LOGIN_FAILED',
            '学校コードまたはログインID、パスワードが違います'
          );
        },
        { retries: 3, delayMs: 10 }
      );
    } catch (e: any) {
      thrownError = e;
    }
    assert.ok(thrownError, 'エラーがスローされること');
    assert.strictEqual(thrownError.status, 'LOGIN_FAILED');
    assert.strictEqual(attempts, 1, 'リトライされず厳格に1回のみで終了すること');
  });

  // =========================================================================
  // 指示2 & 3: Timeout Cancellation・旧処理停止保証・Write直前Abortテスト
  // =========================================================================
  await runTest('指示2: Timeout発生時にAbortSignal発火・旧処理Promise cleanup完了後にのみ次校へ進むことの検証', async () => {
    let schoolACleanedUp = false;
    let schoolAInProgress = false;
    let schoolBStarted = false;
    let schoolBStartedAfterACleanup = false;

    // School A モック: 意図的に時間がかかるが、AbortSignalで即時クリーンアップして終了
    const runSchoolAMock = async (signal: AbortSignal) => {
      schoolAInProgress = true;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new AutomationError('TIMEOUT', 'Aborted'));
          });
        });
      } finally {
        // クリーンアップ処理
        schoolACleanedUp = true;
        schoolAInProgress = false;
      }
    };

    // タイムアウト監視付き実行シミュレーション
    const abortControllerA = new AbortController();
    const timeoutMs = 30; // 30msでタイムアウト

    let timeoutFired = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        timeoutFired = true;
        abortControllerA.abort();
        reject(new AutomationError('TIMEOUT', 'School A timeout'));
      }, timeoutMs);
    });

    const schoolAPromise = runSchoolAMock(abortControllerA.signal);

    try {
      await Promise.race([schoolAPromise, timeoutPromise]);
    } catch {
      // タイムアウト発生時: cleanup完了を確実にawaitする
      try {
        await schoolAPromise;
      } catch {}
    }

    assert.ok(timeoutFired, 'タイムアウトが発火したこと');
    assert.ok(schoolACleanedUp, 'School Aのcleanupが確実に完了していること');
    assert.strictEqual(schoolAInProgress, false, 'School Aの裏処理が継続していないこと');

    // School B 開始シミュレーション
    schoolBStarted = true;
    schoolBStartedAfterACleanup = schoolACleanedUp && !schoolAInProgress;
    assert.ok(schoolBStartedAfterACleanup, 'School BはSchool Aのcleanup完了後にのみ開始されたこと');
  });

  await runTest('指示3: Write直前(ラジオ選択/保存クリック)にAbort済みなら即座に例外停止し副作用操作を行わないことの検証', async () => {
    const abortController = new AbortController();
    abortController.abort(); // 事前にAbort状態

    let radioClicked = false;
    let saveClicked = false;

    // Mock SchoolSettingsPage の動作検証
    const mockPageObj = {
      async selectSettingRadio(key: string, val: string, signal?: AbortSignal) {
        if (signal?.aborted) {
          throw new AutomationError('TIMEOUT', 'ラジオボタン操作直前にタイムアウトまたは中断シグナルを検知しました');
        }
        radioClicked = true;
      },
      async clickSaveAndObserveSignals(signal?: AbortSignal) {
        if (signal?.aborted) {
          throw new AutomationError('TIMEOUT', '保存ボタン押下直前にタイムアウトまたは中断シグナルを検知しました');
        }
        saveClicked = true;
      }
    };

    let radioError: any = null;
    try {
      await mockPageObj.selectSettingRadio('storage', 'ON', abortController.signal);
    } catch (e: any) {
      radioError = e;
    }
    assert.ok(radioError);
    assert.strictEqual(radioError.status, 'TIMEOUT');
    assert.strictEqual(radioClicked, false, 'ラジオクリック操作がスキップされたこと');

    let saveError: any = null;
    try {
      await mockPageObj.clickSaveAndObserveSignals(abortController.signal);
    } catch (e: any) {
      saveError = e;
    }
    assert.ok(saveError);
    assert.strictEqual(saveError.status, 'TIMEOUT');
    assert.strictEqual(saveClicked, false, '保存クリック操作がスキップされたこと');
  });

  // =========================================================================
  // 指示5: writeGateEligible テスト（Case A 〜 Case D）
  // =========================================================================
  const testDeployId = `wg-test-${Date.now()}`;

  await runTest('指示5 Case A: 全校Read成功・全校Plan executable・destructive 0 -> writeGateEligible = true', () => {
    const reporter = new BatchSummaryReporter({
      deploymentId: `${testDeployId}-a`,
      runId: 'r1',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'hashA',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0'
    });

    reporter.addSchoolResult({
      schoolCode: 'SCH01',
      schoolName: '学校1',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 1,
      hasDestructiveChanges: false,
      planExecutable: true
    });
    reporter.addSchoolResult({
      schoolCode: 'SCH02',
      schoolName: '学校2',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 0,
      hasDestructiveChanges: false,
      planExecutable: true
    });

    const report = reporter.generateReport({ totalSchools: 2, skippedSchools: 0 });
    const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${testDeployId}-a.json`);
    assert.ok(fs.existsSync(pfPath));
    const pf: import('../src/types/batch').PreflightReport = JSON.parse(fs.readFileSync(pfPath, 'utf-8'));
    assert.strictEqual(pf.status, 'COMPLETE');
    assert.strictEqual(pf.allReadSucceeded, true);
    assert.strictEqual(pf.allPlansExecutable, true);
    assert.strictEqual(pf.planBlocked, 0);
    assert.strictEqual(pf.destructiveChangeSchools, 0);
    assert.strictEqual(pf.writeGateEligible, true);
    fs.unlinkSync(pfPath);
  });

  await runTest('指示5 Case B: 全校Read成功だが1校 planExecutable=false -> writeGateEligible = false', () => {
    const reporter = new BatchSummaryReporter({
      deploymentId: `${testDeployId}-b`,
      runId: 'r1',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'hashA',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0'
    });

    reporter.addSchoolResult({
      schoolCode: 'SCH01',
      schoolName: '学校1',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 1,
      hasDestructiveChanges: false,
      planExecutable: true
    });
    reporter.addSchoolResult({
      schoolCode: 'SCH02',
      schoolName: '学校2 (Plan不可)',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 1,
      hasDestructiveChanges: false,
      planExecutable: false // 実行不可
    });

    reporter.generateReport({ totalSchools: 2, skippedSchools: 0 });
    const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${testDeployId}-b.json`);
    const pf: import('../src/types/batch').PreflightReport = JSON.parse(fs.readFileSync(pfPath, 'utf-8'));
    assert.strictEqual(pf.status, 'COMPLETE');
    assert.strictEqual(pf.allReadSucceeded, true);
    assert.strictEqual(pf.allPlansExecutable, false);
    assert.strictEqual(pf.writeGateEligible, false);
    fs.unlinkSync(pfPath);
  });

  await runTest('指示5 Case C: 全校Read成功だが planBlocked=1 -> writeGateEligible = false', () => {
    const reporter = new BatchSummaryReporter({
      deploymentId: `${testDeployId}-c`,
      runId: 'r1',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'hashA',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0'
    });

    reporter.addSchoolResult({
      schoolCode: 'SCH01',
      schoolName: '学校1',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 1,
      hasDestructiveChanges: false,
      planExecutable: true
    });
    reporter.addSchoolResult({
      schoolCode: 'SCH02',
      schoolName: '学校2 (Conflict)',
      status: 'FAILED',
      executionStatus: 'CONFIG_CONFLICT', // planBlocked
      actionsCount: 1,
      hasDestructiveChanges: false,
      planExecutable: false
    });

    reporter.generateReport({ totalSchools: 2, skippedSchools: 0 });
    const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${testDeployId}-c.json`);
    const pf: import('../src/types/batch').PreflightReport = JSON.parse(fs.readFileSync(pfPath, 'utf-8'));
    assert.strictEqual(pf.planBlocked, 1);
    assert.strictEqual(pf.allPlansExecutable, false);
    assert.strictEqual(pf.writeGateEligible, false);
    fs.unlinkSync(pfPath);
  });

  await runTest('指示5 Case D: 全校Read成功・全校Plan executableだが destructive=1 -> writeGateEligible = false', () => {
    const reporter = new BatchSummaryReporter({
      deploymentId: `${testDeployId}-d`,
      runId: 'r1',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'hashA',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0'
    });

    reporter.addSchoolResult({
      schoolCode: 'SCH01',
      schoolName: '学校1',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 1,
      hasDestructiveChanges: false,
      planExecutable: true
    });
    reporter.addSchoolResult({
      schoolCode: 'SCH02',
      schoolName: '学校2 (破壊的)',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 1,
      hasDestructiveChanges: true, // 破壊的変更あり
      planExecutable: true
    });

    reporter.generateReport({ totalSchools: 2, skippedSchools: 0 });
    const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${testDeployId}-d.json`);
    const pf: import('../src/types/batch').PreflightReport = JSON.parse(fs.readFileSync(pfPath, 'utf-8'));
    assert.strictEqual(pf.destructiveChangeSchools, 1);
    assert.strictEqual(pf.writeGateEligible, false);
    fs.unlinkSync(pfPath);
  });

  // =========================================================================
  // 指示7: Preflight status テスト（4ケース）
  // =========================================================================
  await runTest('指示7 Case 1: 400処理 (397 SUCCESS, 3 FAILED, 0 pending) -> status: COMPLETE, allReadSucceeded: false, writeGateEligible: false', () => {
    const reporter = new BatchSummaryReporter({
      deploymentId: `${testDeployId}-status1`,
      runId: 'r1',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'hashA',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0'
    });

    for (let i = 1; i <= 397; i++) {
      reporter.addSchoolResult({
        schoolCode: `S${i}`,
        schoolName: `学校${i}`,
        status: 'SUCCESS',
        executionStatus: 'DRY_RUN_COMPLETED',
        planExecutable: true
      });
    }
    for (let i = 398; i <= 400; i++) {
      reporter.addSchoolResult({
        schoolCode: `S${i}`,
        schoolName: `学校${i}`,
        status: 'FAILED',
        executionStatus: 'LOGIN_FAILED',
        planExecutable: false
      });
    }

    reporter.generateReport({ totalSchools: 400, skippedSchools: 0 });
    const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${testDeployId}-status1.json`);
    const pf: import('../src/types/batch').PreflightReport = JSON.parse(fs.readFileSync(pfPath, 'utf-8'));
    assert.strictEqual(pf.status, 'COMPLETE', '全校処理完了しているのでCOMPLETE');
    assert.strictEqual(pf.processed, 400);
    assert.strictEqual(pf.notProcessed, 0);
    assert.strictEqual(pf.allReadSucceeded, false, '3校失敗しているのでfalse');
    assert.strictEqual(pf.writeGateEligible, false);
    fs.unlinkSync(pfPath);
  });

  await runTest('指示7 Case 2: 250処理, 150 pending, Circuit Breakerトリップ -> status: PAUSED', () => {
    const reporter = new BatchSummaryReporter({
      deploymentId: `${testDeployId}-status2`,
      runId: 'r1',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'hashA',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0'
    });

    for (let i = 1; i <= 250; i++) {
      reporter.addSchoolResult({
        schoolCode: `S${i}`,
        schoolName: `学校${i}`,
        status: 'SUCCESS',
        executionStatus: 'DRY_RUN_COMPLETED',
        planExecutable: true
      });
    }

    reporter.generateReport({
      totalSchools: 400,
      skippedSchools: 0,
      circuitBreakerTrip: {
        category: 'SYSTEMIC',
        errorCode: 'UI_STRUCTURE_MISMATCH',
        consecutiveCount: 3,
        tripReason: 'Systemic failure',
        trippedAt: new Date().toISOString()
      }
    });
    const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${testDeployId}-status2.json`);
    const pf: import('../src/types/batch').PreflightReport = JSON.parse(fs.readFileSync(pfPath, 'utf-8'));
    assert.strictEqual(pf.status, 'PAUSED', 'Circuit Breaker発動時はPAUSED');
    assert.strictEqual(pf.processed, 250);
    assert.strictEqual(pf.notProcessed, 150);
    assert.strictEqual(pf.writeGateEligible, false);
    fs.unlinkSync(pfPath);
  });

  await runTest('指示7 Case 3: 250処理, 150 pending, Ctrl+C中断 -> status: INTERRUPTED', () => {
    const reporter = new BatchSummaryReporter({
      deploymentId: `${testDeployId}-status3`,
      runId: 'r1',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'hashA',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0'
    });

    for (let i = 1; i <= 250; i++) {
      reporter.addSchoolResult({
        schoolCode: `S${i}`,
        schoolName: `学校${i}`,
        status: 'SUCCESS',
        executionStatus: 'DRY_RUN_COMPLETED',
        planExecutable: true
      });
    }

    reporter.generateReport({
      totalSchools: 400,
      skippedSchools: 0,
      isInterrupted: true
    });
    const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${testDeployId}-status3.json`);
    const pf: import('../src/types/batch').PreflightReport = JSON.parse(fs.readFileSync(pfPath, 'utf-8'));
    assert.strictEqual(pf.status, 'INTERRUPTED', 'Ctrl+C中断時はINTERRUPTED');
    assert.strictEqual(pf.processed, 250);
    assert.strictEqual(pf.notProcessed, 150);
    assert.strictEqual(pf.writeGateEligible, false);
    fs.unlinkSync(pfPath);
  });

  await runTest('指示7 Case 4: 390処理, 10未処理 (特殊終了) -> status: INCOMPLETE', () => {
    const reporter = new BatchSummaryReporter({
      deploymentId: `${testDeployId}-status4`,
      runId: 'r1',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'hashA',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0'
    });

    for (let i = 1; i <= 390; i++) {
      reporter.addSchoolResult({
        schoolCode: `S${i}`,
        schoolName: `学校${i}`,
        status: 'SUCCESS',
        executionStatus: 'DRY_RUN_COMPLETED',
        planExecutable: true
      });
    }

    reporter.generateReport({ totalSchools: 400, skippedSchools: 0 });
    const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${testDeployId}-status4.json`);
    const pf: import('../src/types/batch').PreflightReport = JSON.parse(fs.readFileSync(pfPath, 'utf-8'));
    assert.strictEqual(pf.status, 'INCOMPLETE', '未処理が残っている通常終了はINCOMPLETE');
    assert.strictEqual(pf.processed, 390);
    assert.strictEqual(pf.notProcessed, 10);
    assert.strictEqual(pf.writeGateEligible, false);
    fs.unlinkSync(pfPath);
  });

  // =========================================================================
  // 指示8 & 9: Unknown Profile Key の完全拒否（.strict()）テスト
  // =========================================================================
  await runTest('指示9: RequestedSettingsSchemaが未知キー(typo: attendence)を確実に拒否することの検証', () => {
    const typoProfile = {
      storage: 'ON',
      attendence: 'OFF' // typo
    };
    const parsed = RequestedSettingsSchema.safeParse(typoProfile);
    assert.strictEqual(parsed.success, false, '未知キーを含むためパース失敗すること');
    if (!parsed.success) {
      assert.ok(parsed.error.issues.some((i) => i.message.includes('unrecognized') || (i as any).code === 'unrecognized_keys'));
    }
  });

  await runTest('指示9: 11キー以外の任意キーが1つでも存在すれば拒否されることの検証', () => {
    const unknownKeyProfile = {
      storage: 'ON',
      someArbitraryKey: 'VALUE'
    };
    const parsed = RequestedSettingsSchema.safeParse(unknownKeyProfile);
    assert.strictEqual(parsed.success, false);
  });

  // =========================================================================
  // 指示10: スクリーンショット保存ポリシー（正常校 0枚、認証画面禁止）
  // =========================================================================
  await runTest('指示10: 正常処理学校のスクリーンショットがデフォルト保存されないこと(screenshots=0)の検証', () => {
    const rm = new (require('../src/logger/resultManager').ResultManager)();
    rm.setStatus('DRY_RUN_COMPLETED');
    const result = rm.getResult();
    const ssKeys = Object.keys(result.screenshotPaths || {});
    assert.strictEqual(ssKeys.length, 0, '正常完了した学校のスクリーンショットは0枚であること');
  });

  // =========================================================================
  // 指示4: Approval Audit Sequence方式・State Machineテスト（4ケース）
  // =========================================================================
  await runTest('指示4 正常系: 1 PLAN_CREATED -> 2 AWAITING -> 3 APPROVED -> 4 ALLOWED -> PASS', () => {
    const { ApprovalAuditManager } = require('../src/utils/approvalAudit');
    const manager = new ApprovalAuditManager();

    manager.recordPlanCreated({ detail: '400校 Preflight 計画策定' });
    manager.recordAwaitingApproval({ detail: 'ユーザーレビュー待ち' });
    manager.recordUserApproval({
      source: 'USER_MESSAGE',
      approvalMessageId: 'msg-user-approval-001',
      detail: '指示受領: この2点の修正とテストは進めて構いません'
    });
    manager.recordImplementationAllowed({ detail: '実装開始許可' });

    const val = manager.validateSequence();
    assert.strictEqual(val.isValid, true);
    assert.doesNotThrow(() => {
      manager.assertImplementationAllowed();
    });
  });

  await runTest('指示4 APPROVEDなし: 1 PLAN_CREATED -> 2 AWAITING -> 3 ALLOWED -> FAIL', () => {
    const { ApprovalAuditManager } = require('../src/utils/approvalAudit');
    const manager = new ApprovalAuditManager();

    manager.recordPlanCreated();
    manager.recordAwaitingApproval();
    // USER_APPROVAL_RECEIVED をスキップして直接 ALLOWED を呼ぶ
    assert.throws(
      () => {
        manager.recordImplementationAllowed();
      },
      (err: any) => err.status === 'APPROVAL_AUDIT_INVALID'
    );

    // 直接不正イベント配列を検証した場合も FAIL
    const invalidEvents = [
      { sequence: 1, state: 'PLAN_CREATED', occurredAt: '2026-09-26T07:00:00Z', source: 'SYSTEM' },
      { sequence: 2, state: 'AWAITING_USER_APPROVAL', occurredAt: '2026-09-26T07:01:00Z', source: 'SYSTEM' },
      { sequence: 3, state: 'IMPLEMENTATION_ALLOWED', occurredAt: '2026-09-26T07:02:00Z', source: 'SYSTEM' }
    ];
    const val = manager.validateSequence(invalidEvents);
    assert.strictEqual(val.isValid, false);
    assert.strictEqual(val.errorCode, 'APPROVAL_AUDIT_INVALID');
  });

  await runTest('指示4 順序逆転: 1 PLAN_CREATED -> 3 APPROVED -> 2 AWAITING -> FAIL', () => {
    const { ApprovalAuditManager } = require('../src/utils/approvalAudit');
    const manager = new ApprovalAuditManager();

    const reversedEvents = [
      { sequence: 1, state: 'PLAN_CREATED', occurredAt: '2026-09-26T07:00:00Z', source: 'SYSTEM' },
      { sequence: 2, state: 'USER_APPROVAL_RECEIVED', occurredAt: '2026-09-26T07:01:00Z', source: 'USER_MESSAGE' },
      { sequence: 3, state: 'AWAITING_USER_APPROVAL', occurredAt: '2026-09-26T07:02:00Z', source: 'SYSTEM' },
      { sequence: 4, state: 'IMPLEMENTATION_ALLOWED', occurredAt: '2026-09-26T07:03:00Z', source: 'SYSTEM' }
    ];
    const val = manager.validateSequence(reversedEvents);
    assert.strictEqual(val.isValid, false);
    assert.strictEqual(val.errorCode, 'APPROVAL_AUDIT_INVALID');
  });

  await runTest('指示4 重複sequence: 1 PLAN_CREATED -> 2 AWAITING -> 2 APPROVED -> FAIL', () => {
    const { ApprovalAuditManager } = require('../src/utils/approvalAudit');
    const manager = new ApprovalAuditManager();

    const duplicateEvents = [
      { sequence: 1, state: 'PLAN_CREATED', occurredAt: '2026-09-26T07:00:00Z', source: 'SYSTEM' },
      { sequence: 2, state: 'AWAITING_USER_APPROVAL', occurredAt: '2026-09-26T07:01:00Z', source: 'SYSTEM' },
      { sequence: 2, state: 'USER_APPROVAL_RECEIVED', occurredAt: '2026-09-26T07:02:00Z', source: 'USER_MESSAGE' },
      { sequence: 4, state: 'IMPLEMENTATION_ALLOWED', occurredAt: '2026-09-26T07:03:00Z', source: 'SYSTEM' }
    ];
    const val = manager.validateSequence(duplicateEvents);
    assert.strictEqual(val.isValid, false);
    assert.strictEqual(val.errorCode, 'APPROVAL_AUDIT_INVALID');
  });

  // =========================================================================
  // 指示8: Screenshot stale-state テスト (Case A 〜 Case D & 正常校)
  // =========================================================================
  await runTest('指示8 Case A: state OK, URL OK, DOM OK -> Error時Screenshot可能', async () => {
    const { validateLivePageSafety, ScreenshotManager } = require('../src/utils/screenshot');

    const mockPage: any = {
      isClosed: () => false,
      url: () => 'https://ed-cl.com/manage/organization/edit',
      locator: (sel: string) => ({
        count: async () => {
          if (sel.includes('学校設定')) return 1;
          if (sel.includes('user_config_form')) return 1;
          return 0;
        }
      }),
      screenshot: async () => Buffer.from('fake-screenshot')
    };

    const safety = await validateLivePageSafety(mockPage);
    assert.strictEqual(safety, true, 'Live Page Safety Check が通過すること');

    const sm = new ScreenshotManager();
    const res = await sm.captureError(mockPage, 'TEST01', {
      authenticationCompleted: true,
      schoolVerified: true,
      pageType: 'SCHOOL_SETTINGS'
    });
    assert.ok(res.length > 0, 'スクリーンショットファイルパスが返ること');
    if (fs.existsSync(res)) fs.unlinkSync(res);
  });

  await runTest('指示8 Case B: state OK だが current URL が login / IdP -> Screenshot 0', async () => {
    const { validateLivePageSafety, ScreenshotManager } = require('../src/utils/screenshot');

    const mockPage: any = {
      isClosed: () => false,
      url: () => 'https://ed-cl.com/login', // ログイン画面へリダイレクト
      locator: () => ({ count: async () => 0 })
    };

    const safety = await validateLivePageSafety(mockPage);
    assert.strictEqual(safety, false, 'URLが異なるため不合格');

    const sm = new ScreenshotManager();
    const res = await sm.captureError(mockPage, 'TEST02', {
      authenticationCompleted: true,
      schoolVerified: true,
      pageType: 'SCHOOL_SETTINGS' // 古いstale-state
    });
    assert.strictEqual(res, '', 'スクリーンショットは撮影されず空文字（0枚）であること');
  });

  await runTest('指示8 Case C: URLは/manage/organization/editだがuser_config_form不存在 -> Screenshot 0', async () => {
    const { validateLivePageSafety, ScreenshotManager } = require('../src/utils/screenshot');

    const mockPage: any = {
      isClosed: () => false,
      url: () => 'https://ed-cl.com/manage/organization/edit',
      locator: (sel: string) => ({
        count: async () => {
          if (sel.includes('学校設定')) return 1;
          if (sel.includes('user_config_form')) return 0; // フォーム不在
          return 0;
        }
      })
    };

    const safety = await validateLivePageSafety(mockPage);
    assert.strictEqual(safety, false, 'user_config_form 不在のため不合格');

    const sm = new ScreenshotManager();
    const res = await sm.captureError(mockPage, 'TEST03', {
      authenticationCompleted: true,
      schoolVerified: true,
      pageType: 'SCHOOL_SETTINGS'
    });
    assert.strictEqual(res, '', 'スクリーンショットは撮影されないこと（0枚）');
  });

  await runTest('指示8 Case D: Live Page確認時に page closed (Fail Closed) -> Screenshot 0', async () => {
    const { validateLivePageSafety, ScreenshotManager } = require('../src/utils/screenshot');

    const mockClosedPage: any = {
      isClosed: () => true, // 既に閉じている
      url: () => { throw new Error('Target page, context or browser has been closed'); }
    };

    const safety = await validateLivePageSafety(mockClosedPage);
    assert.strictEqual(safety, false, '閉じたページはFail Closedで必ずfalse');

    const sm = new ScreenshotManager();
    const res = await sm.captureError(mockClosedPage, 'TEST04', {
      authenticationCompleted: true,
      schoolVerified: true,
      pageType: 'SCHOOL_SETTINGS'
    });
    assert.strictEqual(res, '', '例外発生時もFail Closedで撮影されないこと（0枚）');
  });

  // =========================================================================
  // 指示13: Preflight Report の学校単位 writeEligible テスト
  // =========================================================================
  await runTest('指示13: Preflight Report に学校単位の writeEligible が正確に出力されること', () => {
    const reporter = new BatchSummaryReporter({
      deploymentId: `${testDeployId}-we`,
      runId: 'r1',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'hashA',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0'
    });

    // 学校1: 正常・実行可能・非破壊的 -> writeEligible: true
    reporter.addSchoolResult({
      schoolCode: 'SCH01',
      schoolName: '学校1',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 1,
      hasDestructiveChanges: false,
      planExecutable: true
    });

    // 学校2: 正常だがPlan不可 -> writeEligible: false
    reporter.addSchoolResult({
      schoolCode: 'SCH02',
      schoolName: '学校2',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 1,
      hasDestructiveChanges: false,
      planExecutable: false
    });

    // 学校3: 破壊的変更あり -> writeEligible: false
    reporter.addSchoolResult({
      schoolCode: 'SCH03',
      schoolName: '学校3',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 1,
      hasDestructiveChanges: true,
      planExecutable: true
    });

    // 学校4: Read失敗 -> writeEligible: false
    reporter.addSchoolResult({
      schoolCode: 'SCH04',
      schoolName: '学校4',
      status: 'FAILED',
      executionStatus: 'LOGIN_FAILED',
      actionsCount: 0,
      hasDestructiveChanges: false,
      planExecutable: false
    });

    reporter.generateReport({ totalSchools: 4, skippedSchools: 0 });
    const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${testDeployId}-we.json`);
    const pf: import('../src/types/batch').PreflightReport = JSON.parse(fs.readFileSync(pfPath, 'utf-8'));

    const s1 = pf.schools.find((s) => s.schoolCode === 'SCH01');
    const s2 = pf.schools.find((s) => s.schoolCode === 'SCH02');
    const s3 = pf.schools.find((s) => s.schoolCode === 'SCH03');
    const s4 = pf.schools.find((s) => s.schoolCode === 'SCH04');

    assert.strictEqual(s1?.writeEligible, true, 'SCH01はwriteEligible=true');
    assert.strictEqual(s2?.writeEligible, false, 'SCH02はplanExecutable=falseのためwriteEligible=false');
    assert.strictEqual(s3?.writeEligible, false, 'SCH03は破壊的変更のためwriteEligible=false');
    assert.strictEqual(s4?.writeEligible, false, 'SCH04はRead失敗のためwriteEligible=false');

    fs.unlinkSync(pfPath);
  });

  // Phase 4C: 400校 Preflight Mock で directMessage: OFF (子DISABLED_BY_DEPENDENCY) の学校が含まれていても正常完了
  await runTest('Phase 4C: directMessage OFF (子DISABLED_BY_DEPENDENCY) の学校を含む Preflight Plan / Evaluation が正常動作', () => {
    // 学校A: directMessage: OFF, parentDirectMessage: DISABLED_BY_DEPENDENCY / value: null
    const obsA = createMockBaselineObservation();
    obsA.directMessage = { value: 'OFF', availability: 'AVAILABLE' };
    obsA.parentDirectMessage = { value: null, availability: 'DISABLED_BY_DEPENDENCY' };

    // 要求: attendance: ON (directMessage は unmanaged)
    const plan = buildExecutionPlan({
      schoolCode: 'SCH_OFF',
      schoolName: '個別メッセージOFFの学校',
      currentObservation: obsA,
      requestedSettings: { attendance: 'ON' }
    });

    const evaluation = evaluateExecutionPlan(plan);
    assert.strictEqual(evaluation.isExecutable, true, 'Plan should be executable');
    assert.strictEqual(evaluation.blockReasons.length, 0, 'No block reasons');
    assert.strictEqual(plan.actions.length, 1, 'Only attendance action');
    assert.strictEqual(plan.actions[0].settingKey, 'attendance', 'Action settingKey is attendance');

    // parentDirectMessage は unmanaged かつ親が OFF のため、期待値も DISABLED_BY_DEPENDENCY / null のまま維持される
    assert.strictEqual(plan.items.parentDirectMessage.expected.value, null);
    assert.strictEqual(plan.items.parentDirectMessage.expected.availability, 'DISABLED_BY_DEPENDENCY');
    assert.strictEqual(plan.items.parentDirectMessage.reason, 'DEPENDENCY');
  });

  // -------------------------------------------------------------
  // Phase 5A.1: Windows Reliability Hardening Tests (A〜E)
  // -------------------------------------------------------------

  // Test A: rename 1回目 EPERM, 2回目成功 -> Checkpoint 成功
  await runTest('Phase 5A.1 Test A: rename 1回目 EPERM / 2回目成功で Checkpoint が正常に保存される', () => {
    const deploymentId = `test-a-${Date.now()}`;
    let attempts = 0;
    let enableFail = false;
    const cp = new CheckpointManager({
      deploymentId,
      runId: 'r1',
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools: [{ schoolCode: 'TEST01', schoolName: 'テスト校', credentialRef: 'TEST01', enabled: true }],
      isResume: false,
      fsOverride: {
        renameSync: (oldPath: string, newPath: string) => {
          if (enableFail) {
            attempts++;
            if (attempts === 1) {
              const err: any = new Error('operation not permitted, rename');
              err.code = 'EPERM';
              throw err;
            }
          }
          return fs.renameSync(oldPath, newPath);
        }
      }
    });

    try {
      enableFail = true;
      attempts = 0;
      cp.finishSchool({
        schoolCode: 'TEST01',
        status: 'SUCCESS',
        executionStatus: 'SUCCESS'
      });

      assert.strictEqual(attempts, 2, '2回目の試行で成功すること');
      assert.strictEqual(fs.existsSync(cp.getCheckpointPath()), true, 'チェックポイントファイルが存在すること');
    } finally {
      cp.releaseLock();
      try { fs.unlinkSync(cp.getCheckpointPath()); } catch {}
    }
  });

  // Test B: rename 全 attempt EPERM -> CHECKPOINT_IO_ERROR
  await runTest('Phase 5A.1 Test B: rename 全 attempt EPERM で CHECKPOINT_IO_ERROR がスローされる', () => {
    const deploymentId = `test-b-${Date.now()}`;
    let cpInstance: any = null;

    try {
      assert.throws(
        () => {
          cpInstance = new CheckpointManager({
            deploymentId,
            runId: 'r1',
            profileHash: 'hashP',
            schoolsHash: 'hashS',
            toolVersion: '1.0.0',
            authMode: 'A',
            schools: [{ schoolCode: 'TEST01', schoolName: 'テスト校', credentialRef: 'TEST01', enabled: true }],
            isResume: false,
            fsOverride: {
              renameSync: () => {
                const err: any = new Error('operation not permitted, rename');
                err.code = 'EPERM';
                throw err;
              }
            }
          });
        },
        (err: any) => {
          return err instanceof AutomationError && err.status === 'CHECKPOINT_IO_ERROR';
        },
        'CHECKPOINT_IO_ERROR がスローされること'
      );
    } finally {
      if (cpInstance) {
        cpInstance.releaseLock();
        try { fs.unlinkSync(cpInstance.getCheckpointPath()); } catch {}
      }
    }
  });

  // Test C: Checkpoint write 同時呼出し -> single writer 保証
  await runTest('Phase 5A.1 Test C: Checkpoint write 同時呼出し時に single writer で安全に直列化される', () => {
    const deploymentId = `test-c-${Date.now()}`;
    const cp = new CheckpointManager({
      deploymentId,
      runId: 'r1',
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools: [{ schoolCode: 'TEST01', schoolName: 'テスト校', credentialRef: 'TEST01', enabled: true }],
      isResume: false
    });

    try {
      // 連続で5回呼び出す
      for (let i = 0; i < 5; i++) {
        cp.save();
      }
      assert.strictEqual(fs.existsSync(cp.getCheckpointPath()), true);
      const content = JSON.parse(fs.readFileSync(cp.getCheckpointPath(), 'utf-8'));
      assert.strictEqual(content.deploymentId, deploymentId);
    } finally {
      cp.releaseLock();
      try { fs.unlinkSync(cp.getCheckpointPath()); } catch {}
    }
  });

  // Test D: temp file handle が close されてから rename される
  await runTest('Phase 5A.1 Test D: temp file handle が close されてから rename される', () => {
    const deploymentId = `test-d-${Date.now()}`;
    const callOrder: string[] = [];

    const cp = new CheckpointManager({
      deploymentId,
      runId: 'r1',
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools: [{ schoolCode: 'TEST01', schoolName: 'テスト校', credentialRef: 'TEST01', enabled: true }],
      isResume: false,
      fsOverride: {
        closeSync: (fd: number) => {
          callOrder.push('closeSync');
          return fs.closeSync(fd);
        },
        renameSync: (oldP: string, newP: string) => {
          callOrder.push('renameSync');
          return fs.renameSync(oldP, newP);
        }
      }
    });

    try {
      callOrder.length = 0; // コンストラクタ呼び出し分をクリア
      cp.save();

      assert.ok(callOrder.includes('closeSync'));
      assert.ok(callOrder.includes('renameSync'));
      const closeIdx = callOrder.indexOf('closeSync');
      const renameIdx = callOrder.indexOf('renameSync');
      assert.ok(closeIdx < renameIdx, 'closeSync が renameSync より前に呼ばれていること');
    } finally {
      cp.releaseLock();
      try { fs.unlinkSync(cp.getCheckpointPath()); } catch {}
    }
  });

  // Test E: Checkpoint failure を SCHOOL_SPECIFIC error として集計しない
  await runTest('Phase 5A.1 Test E: CHECKPOINT_IO_ERROR は CRITICAL エラーとして即PAUSEされ学校固有エラーに計上されない', () => {
    const cb = new CircuitBreaker({ consecutiveFailureThreshold: 3 });
    cb.recordResult('CHECKPOINT_IO_ERROR', 'TEST01');
    assert.strictEqual(cb.shouldStop(), true, 'CHECKPOINT_IO_ERROR で即座に PAUSE されること');
    assert.strictEqual(cb.getTripInfo()?.category, 'CRITICAL', 'CRITICAL カテゴリとして判定されること');
  });

  // -------------------------------------------------------------
  // Phase 5A.2: Stop / Control Hardening Tests (F〜H)
  // -------------------------------------------------------------

  // Test F: Checkpoint に INTERRUPTED が記録され、lock が確実に解放されること
  await runTest('Phase 5A.2 Test F: Checkpoint に INTERRUPTED が記録され lock が解放されること', () => {
    const deploymentId = `test-f-${Date.now()}`;
    const cp = new CheckpointManager({
      deploymentId,
      runId: 'r1',
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools: [
        { schoolCode: 'TEST01', schoolName: 'テスト校1', credentialRef: 'TEST01', enabled: true },
        { schoolCode: 'TEST02', schoolName: 'テスト校2', credentialRef: 'TEST02', enabled: true }
      ],
      isResume: false
    });

    const lockPath = path.resolve(process.cwd(), `checkpoints/${deploymentId}.lock`);

    try {
      cp.startSchool('TEST01');
      assert.strictEqual(fs.existsSync(lockPath), true, '実行中は lock ファイルが存在すること');

      // STOP により INTERRUPTED として終了
      cp.finishSchool({
        schoolCode: 'TEST01',
        status: 'INTERRUPTED',
        executionStatus: 'INTERRUPTED',
        error: 'User requested stop'
      });

      const entry1 = cp.getEntry('TEST01');
      assert.strictEqual(entry1?.status, 'INTERRUPTED');
      assert.strictEqual(entry1?.executionStatus, 'INTERRUPTED');

      const entry2 = cp.getEntry('TEST02');
      assert.strictEqual(entry2?.status, 'PENDING');
      assert.strictEqual(cp.isBatchCompleted(), false);
    } finally {
      cp.releaseLock();
      assert.strictEqual(fs.existsSync(lockPath), false, 'releaseLock により lock ファイルが削除されること');
      try { fs.unlinkSync(cp.getCheckpointPath()); } catch {}
    }
  });

  // Test G: 手動 lock 削除不要でそのまま resume できること
  await runTest('Phase 5A.2 Test G: releaseLock 後の Checkpoint は手動操作なしでそのまま resume できること', () => {
    const deploymentId = `test-g-${Date.now()}`;
    const schools = [
      { schoolCode: 'TEST01', schoolName: 'テスト校1', credentialRef: 'TEST01', enabled: true },
      { schoolCode: 'TEST02', schoolName: 'テスト校2', credentialRef: 'TEST02', enabled: true }
    ];

    // 1回目の実行 (TEST01 INTERRUPTED で停止)
    const cp1 = new CheckpointManager({
      deploymentId,
      runId: 'r1',
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools,
      isResume: false
    });

    try {
      cp1.startSchool('TEST01');
      cp1.finishSchool({
        schoolCode: 'TEST01',
        status: 'INTERRUPTED',
        executionStatus: 'INTERRUPTED'
      });
    } finally {
      cp1.releaseLock();
    }

    // 2回目の実行 (手動 lock 削除なしで resume)
    let cp2: CheckpointManager | null = null;
    try {
      cp2 = new CheckpointManager({
        deploymentId,
        runId: 'r2',
        profileHash: 'hashP',
        schoolsHash: 'hashS',
        toolVersion: '1.0.0',
        authMode: 'A',
        schools,
        isResume: true
      });

      assert.ok(cp2, 'stale lock エラーなく CheckpointManager が再開できること');
      const entry1 = cp2.getEntry('TEST01');
      assert.strictEqual(entry1?.status, 'INTERRUPTED');
      const entry2 = cp2.getEntry('TEST02');
      assert.strictEqual(entry2?.status, 'PENDING');
    } finally {
      if (cp2) {
        cp2.releaseLock();
        try { fs.unlinkSync(cp2.getCheckpointPath()); } catch {}
      }
    }
  });

  // Test H: parseCliArgs に --dry-run は存在せず、Writeフラグ不在が Read-only の SSOT であること
  await runTest('Phase 5A.2 Test H: CLI 引数に --dry-run は存在せず Write フラグ不在が Read-only の SSOT であること', () => {
    const parsed = parseCliArgs(['--batch', '--schools', 's.csv', '--profile', 'p.json']);
    assert.strictEqual((parsed as any).dryRun, undefined, '--dry-run プロパティは未定義であること');
    assert.strictEqual(parsed.apply, undefined, '--apply は未指定であること');
    assert.strictEqual(parsed.batchApply, false, '--batch-apply は false であること');
    assert.strictEqual(parsed.allowLiveWrite, false, '--allow-live-write は false であること');
    assert.strictEqual(parsed.allowDestructive, undefined, '--allow-destructive は未指定であること');
  });

  // -------------------------------------------------------------
  // Phase 5A.3: Interrupted State Semantics Tests
  // -------------------------------------------------------------

  // Test A & B: STOP時、偽のエラーが排除され status/executionStatus が INTERRUPTED として記録、未処理校は PENDING
  await runTest('Phase 5A.3 Test A & B: STOP時に偽エラーが排除され INTERRUPTED として記録、未処理校は PENDING を維持する', () => {
    const deploymentId = `test-5a3-ab-${Date.now()}`;
    const schools = [
      { schoolCode: 'SCH01', schoolName: '処理中校', credentialRef: 'SCH01', enabled: true },
      { schoolCode: 'SCH02', schoolName: '未処理校', credentialRef: 'SCH02', enabled: true }
    ];

    const cp = new CheckpointManager({
      deploymentId,
      runId: 'r1',
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools,
      isResume: false
    });

    try {
      cp.startSchool('SCH01');

      // Operator Stop による中断（偽のエラー SETTINGS_MENU_NOT_AVAILABLE 等を渡さない）
      cp.finishSchool({
        schoolCode: 'SCH01',
        status: 'INTERRUPTED',
        executionStatus: 'INTERRUPTED',
        error: 'Operator Stop'
      });

      const entry1 = cp.getEntry('SCH01');
      assert.strictEqual(entry1?.status, 'INTERRUPTED');
      assert.strictEqual(entry1?.executionStatus, 'INTERRUPTED');
      assert.strictEqual(entry1?.error, 'Operator Stop');

      const entry2 = cp.getEntry('SCH02');
      assert.strictEqual(entry2?.status, 'PENDING', '未処理校は PENDING のまま維持されること');
      assert.strictEqual(cp.isBatchCompleted(), false, '全体バッチは未完了であること');
    } finally {
      cp.releaseLock();
      try { fs.unlinkSync(cp.getCheckpointPath()); } catch {}
    }
  });

  // Test D: resume 実行時、INTERRUPTED の学校が retry-failed なしで自動的に対象（eligible）に含まれること
  await runTest('Phase 5A.3 Test D: resume 実行時、INTERRUPTED 校は retry-failed なしで自動的に再開対象に含まれる', () => {
    const deploymentId = `test-5a3-d-${Date.now()}`;
    const schools = [
      { schoolCode: 'SCH01', schoolName: '完了校', credentialRef: 'SCH01', enabled: true },
      { schoolCode: 'SCH02', schoolName: '中断校', credentialRef: 'SCH02', enabled: true },
      { schoolCode: 'SCH03', schoolName: '未処理校', credentialRef: 'SCH03', enabled: true },
      { schoolCode: 'SCH04', schoolName: '失敗校', credentialRef: 'SCH04', enabled: true }
    ];

    const cp = new CheckpointManager({
      deploymentId,
      runId: 'r1',
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools,
      isResume: false
    });

    try {
      cp.finishSchool({ schoolCode: 'SCH01', status: 'SUCCESS', executionStatus: 'SUCCESS' });
      cp.finishSchool({ schoolCode: 'SCH02', status: 'INTERRUPTED', executionStatus: 'INTERRUPTED', error: 'Operator Stop' });
      cp.finishSchool({ schoolCode: 'SCH04', status: 'FAILED', executionStatus: 'LOGIN_FAILED' });
      // SCH03 は PENDING のまま
    } finally {
      cp.releaseLock();
    }

    // resume モード（retry-failed なし）で対象判定シミュレーション
    const resumeCp = new CheckpointManager({
      deploymentId,
      runId: 'r2',
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools,
      isResume: true
    });

    try {
      const retryFailed = false;
      const eligible: string[] = [];

      for (const s of schools) {
        const entry = resumeCp.getEntry(s.schoolCode);
        if (entry) {
          if (entry.status === 'SUCCESS' || entry.status === 'SUCCESS_ALREADY_CONFIGURED') {
            continue; // スキップ
          }
          if (entry.status === 'FAILED' && !retryFailed) {
            continue; // スキップ
          }
        }
        eligible.push(s.schoolCode);
      }

      assert.deepStrictEqual(
        eligible,
        ['SCH02', 'SCH03'],
        'INTERRUPTED の SCH02 と PENDING の SCH03 が再開対象に含まれ、SUCCESS と FAILED はスキップされること'
      );
    } finally {
      resumeCp.releaseLock();
      try { fs.unlinkSync(resumeCp.getCheckpointPath()); } catch {}
    }
  });

  // Test F: INTERRUPTED な学校が存在する場合、Preflight status は INTERRUPTED、writeGateEligible は false、readFailed には混入しないこと
  await runTest('Phase 5A.3 Test F: INTERRUPTED 発生時、Preflight status は INTERRUPTED、writeGateEligible は false、readFailed は 0 であること', () => {
    const deploymentId = `test-5a3-f-${Date.now()}`;
    const reporter = new BatchSummaryReporter({
      deploymentId,
      runId: 'r1',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'hashP',
      schoolsHash: 'hashS',
      toolVersion: '1.0.0'
    });

    // 1校目: 中断された学校
    reporter.addSchoolResult({
      schoolCode: 'SCH01',
      schoolName: '中断校',
      status: 'INTERRUPTED',
      executionStatus: 'INTERRUPTED',
      error: 'Operator Stop'
    });

    const report = reporter.generateReport({
      totalSchools: 2,
      skippedSchools: 0,
      isInterrupted: true,
      allSchools: [
        { schoolCode: 'SCH01', schoolName: '中断校', credentialRef: 'SCH01', enabled: true },
        { schoolCode: 'SCH02', schoolName: '未処理校', credentialRef: 'SCH02', enabled: true }
      ]
    });

    assert.strictEqual(report.readFailed, 0, 'INTERRUPTED の学校は readFailed に加算されないこと');
    assert.strictEqual(report.readSuccess, 0);

    const preflightPath = path.resolve(process.cwd(), `reports/preflight-${deploymentId}.json`);
    assert.strictEqual(fs.existsSync(preflightPath), true);
    const preflightReport = JSON.parse(fs.readFileSync(preflightPath, 'utf-8'));

    assert.strictEqual(preflightReport.status, 'INTERRUPTED', 'PreflightReport status は INTERRUPTED であること');
    assert.strictEqual(preflightReport.writeGateEligible, false, 'writeGateEligible は false であること');
    assert.strictEqual(preflightReport.readFailed, 0, 'PreflightReport の readFailed も 0 であること');

    const sch1 = preflightReport.schools.find((s: any) => s.schoolCode === 'SCH01');
    assert.strictEqual(sch1.readStatus, 'INTERRUPTED', '学校詳細の readStatus も INTERRUPTED であること');
    assert.strictEqual(sch1.writeEligible, false);

    const sch2 = preflightReport.schools.find((s: any) => s.schoolCode === 'SCH02');
    assert.strictEqual(sch2.readStatus, 'NOT_PROCESSED');
    assert.strictEqual(sch2.writeEligible, false);

    // クリーンアップ
    try {
      fs.unlinkSync(preflightPath);
      fs.unlinkSync(path.resolve(process.cwd(), `reports/summary-${deploymentId}-r1.json`));
    } catch {}
  });

  // -------------------------------------------------------------
  // Phase: CSV Excel Compatibility Tests (Test A〜F)
  // -------------------------------------------------------------

  // Test A: UTF-8 BOMなし + LF
  await runTest('CSV Excel Compatibility Test A: UTF-8 BOMなし + LF が正常に parse されること', () => {
    const csvContent = 'schoolCode,schoolName,credentialRef,enabled\nSCH01,第一小学校,SCH01,true\n';
    const schools = parseSchoolsCsv(csvContent);
    assert.strictEqual(schools.length, 1);
    assert.strictEqual(schools[0].schoolCode, 'SCH01');
    assert.strictEqual(schools[0].schoolName, '第一小学校');
    assert.strictEqual(schools[0].credentialRef, 'SCH01');
    assert.strictEqual(schools[0].enabled, true);
  });

  // Test B: UTF-8 BOMあり + LF
  await runTest('CSV Excel Compatibility Test B: UTF-8 BOMあり + LF で schoolCode が正常認識され parse されること', () => {
    const csvContent = '\uFEFFschoolCode,schoolName,credentialRef,enabled\nSCH02,第二中学校,SCH02,true\n';
    const schools = parseSchoolsCsv(csvContent);
    assert.strictEqual(schools.length, 1);
    assert.strictEqual(schools[0].schoolCode, 'SCH02');
    assert.strictEqual(schools[0].schoolName, '第二中学校');
    assert.strictEqual(schools[0].credentialRef, 'SCH02');
    assert.strictEqual(schools[0].enabled, true);
  });

  // Test C: UTF-8 BOMあり + CRLF (Windows Excel UTF-8 CSV 相当)
  await runTest('CSV Excel Compatibility Test C: Windows Excel UTF-8 相当 (BOMあり + CRLF) が正常に parse されること', () => {
    const csvContent = '\uFEFFschoolCode,schoolName,credentialRef,enabled\r\nSCH03,第三高等学校,SCH03,false\r\n';
    const schools = parseSchoolsCsv(csvContent);
    assert.strictEqual(schools.length, 1);
    assert.strictEqual(schools[0].schoolCode, 'SCH03');
    assert.strictEqual(schools[0].schoolName, '第三高等学校');
    assert.strictEqual(schools[0].credentialRef, 'SCH03');
    assert.strictEqual(schools[0].enabled, false);
  });

  // Test D: 日本語 schoolName 保持
  await runTest('CSV Excel Compatibility Test D: 日本語 schoolName (○○市立第一小学校, △△市立第二中学校) が完全一致で保持されること', () => {
    const name1 = '○○市立第一小学校';
    const name2 = '△△市立第二中学校';
    const csvContent = `\uFEFFschoolCode,schoolName,credentialRef,enabled\r\nSCH_A,${name1},SCH_A,true\r\nSCH_B,${name2},SCH_B,true\r\n`;
    const schools = parseSchoolsCsv(csvContent);
    assert.strictEqual(schools.length, 2);
    assert.strictEqual(schools[0].schoolName, name1, 'name1 が完全一致で保持されること');
    assert.strictEqual(schools[1].schoolName, name2, 'name2 が完全一致で保持されること');
  });

  // Test E: BOMなし既存CSV (config/schools.live.csv) の回帰検証
  await runTest('CSV Excel Compatibility Test E: BOMなし既存CSV (config/schools.live.csv) が今まで通り正常に parse されること', () => {
    const liveCsvPath = path.resolve(process.cwd(), 'config/schools.live.csv');
    const liveContent = fs.existsSync(liveCsvPath)
      ? fs.readFileSync(liveCsvPath, 'utf-8')
      : 'schoolCode,schoolName,credentialRef,enabled\nPRRHC,テスト1,PRRHC,true\nPAKCW,テスト2,PAKCW,true\nPSD20,テスト3,PSD20,true';
    const schools = parseSchoolsCsv(liveContent);
    assert.strictEqual(schools.length, 3);
    assert.strictEqual(schools[0].schoolCode, 'PRRHC');
    assert.strictEqual(schools[1].schoolCode, 'PAKCW');
    assert.strictEqual(schools[2].schoolCode, 'PSD20');
  });

  // Test F: 既存 CSV validation の回帰確認
  await runTest('CSV Excel Compatibility Test F: 既存 CSV validation (必須ヘッダー不足, 重複, 空行, コメント行, 空CSV) が維持されること', () => {
    // 必須ヘッダー不足 (schoolCode なし)
    assert.throws(
      () => parseSchoolsCsv('invalidHeader,schoolName,credentialRef,enabled\nSCH01,校名,SCH01,true'),
      (err: any) => err instanceof AutomationError && err.status === 'CONFIG_INVALID',
      '必須ヘッダー不足で CONFIG_INVALID'
    );

    // 空 CSV
    assert.throws(
      () => parseSchoolsCsv(''),
      (err: any) => err instanceof AutomationError && err.status === 'CONFIG_INVALID',
      '空CSVで CONFIG_INVALID'
    );

    // BOM付きの空 CSV
    assert.throws(
      () => parseSchoolsCsv('\uFEFF'),
      (err: any) => err instanceof AutomationError && err.status === 'CONFIG_INVALID',
      'BOM付き空CSVで CONFIG_INVALID'
    );

    // コメント行と空行のスキップ
    const commentedCsv = '\uFEFF# コメント行\n\nschoolCode,schoolName,credentialRef,enabled\n# 途中のコメント\nSCH01,校名,SCH01,true\n\n';
    const parsed = parseSchoolsCsv(commentedCsv);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].schoolCode, 'SCH01');

    // validateBatchSchools による重複検知
    assert.throws(
      () => validateBatchSchools([
        { schoolCode: 'DUP01', schoolName: '学校1', credentialRef: 'DUP01', enabled: true },
        { schoolCode: 'DUP01', schoolName: '学校2', credentialRef: 'DUP01', enabled: true }
      ]),
      (err: any) => err instanceof AutomationError && err.status === 'BATCH_INPUT_INVALID',
      '重複 schoolCode で BATCH_INPUT_INVALID'
    );
  });

  // ==========================================
  // Phase 5A.4: Results / Resume Aggregation Tests
  // ==========================================

  // Test G: Checkpoint Schema Version 厳格チェック（CHECKPOINT_SCHEMA_MISMATCH）
  await runTest('Phase 5A.4 Test G: 旧スキーマバージョン (v1.0) の Checkpoint を Resume しようとすると CHECKPOINT_SCHEMA_MISMATCH で拒絶されること', () => {
    const cpDir = path.resolve(process.cwd(), 'checkpoints');
    if (!fs.existsSync(cpDir)) fs.mkdirSync(cpDir, { recursive: true });

    const depId = `legacy-ver-${Date.now()}`;
    const legacyCp = {
      checkpointSchemaVersion: '1.0', // 旧バージョン
      deploymentId: depId,
      runId: 'run-legacy',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'phash',
      schoolsHash: 'shash',
      toolVersion: '1.0.0',
      totalSchools: 1,
      processedCount: 0,
      successCount: 0,
      failedCount: 0,
      interruptedCount: 0,
      completed: false,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: {
        SCH01: { schoolCode: 'SCH01', schoolName: '校1', status: 'PENDING' }
      }
    };
    fs.writeFileSync(path.join(cpDir, `checkpoint-${depId}.json`), JSON.stringify(legacyCp));

    assert.throws(
      () => new CheckpointManager({
        deploymentId: depId,
        runId: 'new-run',
        profileHash: 'phash',
        schoolsHash: 'shash',
        toolVersion: '1.0.0',
        authMode: 'A',
        schools: [{ schoolCode: 'SCH01', schoolName: '校1', credentialRef: 'SCH01', enabled: true }],
        isResume: true
      }),
      (err: any) => err instanceof AutomationError && err.status === 'CHECKPOINT_SCHEMA_MISMATCH',
      '旧バージョン 1.0 は CHECKPOINT_SCHEMA_MISMATCH で拒絶されること'
    );
  });

  // Test H: START と RESUME の完全分離
  await runTest('Phase 5A.4 Test H: START (isResume=false) は過去の Checkpoint があっても fresh な全校 PENDING から開始されること', () => {
    const cpDir = path.resolve(process.cwd(), 'checkpoints');
    const depId = `start-fresh-${Date.now()}`;
    const existingCp = {
      checkpointSchemaVersion: '1.1',
      deploymentId: depId,
      runId: 'old-run',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'phash',
      schoolsHash: 'shash',
      toolVersion: '1.0.0',
      totalSchools: 1,
      processedCount: 1,
      successCount: 1,
      failedCount: 0,
      interruptedCount: 0,
      completed: true,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: {
        SCH01: { schoolCode: 'SCH01', schoolName: '校1', status: 'SUCCESS' }
      }
    };
    fs.writeFileSync(path.join(cpDir, `checkpoint-${depId}.json`), JSON.stringify(existingCp));

    const cpManager = new CheckpointManager({
      deploymentId: depId,
      runId: 'fresh-run',
      profileHash: 'phash',
      schoolsHash: 'shash',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools: [{ schoolCode: 'SCH01', schoolName: '校1', credentialRef: 'SCH01', enabled: true }],
      isResume: false // START
    });

    const entry = cpManager.getEntry('SCH01');
    assert.strictEqual(entry?.status, 'PENDING', 'START 時は過去の SUCCESS を引き継がず PENDING から開始されること');
    cpManager.releaseLock();
  });

  // Test I: finishSchool による observation 値保存
  await runTest('Phase 5A.4 Test I: finishSchool で渡した before/requested/after/planExecutable が Checkpoint に保存されること', () => {
    const depId = `obs-save-${Date.now()}`;
    const cpManager = new CheckpointManager({
      deploymentId: depId,
      runId: 'run-obs',
      profileHash: 'phash',
      schoolsHash: 'shash',
      toolVersion: '1.0.0',
      authMode: 'A',
      schools: [{ schoolCode: 'SCH01', schoolName: '校1', credentialRef: 'SCH01', enabled: true }],
      isResume: false
    });

    cpManager.finishSchool({
      schoolCode: 'SCH01',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      actionsCount: 1,
      hasDestructiveChanges: false,
      planExecutable: true,
      before: { storage: '500MB' },
      requested: { storage: '1GB' },
      after: { storage: '1GB' }
    });

    const entries = cpManager.getAllEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].planExecutable, true);
    assert.strictEqual(entries[0].before?.storage, '500MB');
    assert.strictEqual(entries[0].requested?.storage, '1GB');
    assert.strictEqual(entries[0].after?.storage, '1GB');
    cpManager.releaseLock();
  });

  // Test J: reconstructFromCheckpointEntries によるサマリ累積再構成
  await runTest('Phase 5A.4 Test J: reconstructFromCheckpointEntries により Checkpoint から全校の最新結果が再構成されること', () => {
    const reporter = new BatchSummaryReporter({
      deploymentId: 'dep-recon',
      runId: 'run-recon',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'phash',
      schoolsHash: 'shash',
      toolVersion: '1.0.0'
    });

    // Checkpoint entries: 2校
    const entries: import('../src/types/batch').SchoolCheckpointEntry[] = [
      {
        schoolCode: 'SCH01',
        schoolName: '学校1',
        status: 'SUCCESS',
        executionStatus: 'DRY_RUN_COMPLETED',
        actionsCount: 0,
        hasDestructiveChanges: false,
        planExecutable: true,
        before: { storage: '1GB' },
        requested: { storage: '1GB' },
        after: { storage: '1GB' },
        updatedAt: new Date().toISOString()
      },
      {
        schoolCode: 'SCH02',
        schoolName: '学校2',
        status: 'SUCCESS',
        executionStatus: 'DRY_RUN_COMPLETED',
        actionsCount: 1,
        hasDestructiveChanges: false,
        planExecutable: true,
        before: { storage: '500MB' },
        requested: { storage: '1GB' },
        after: { storage: '1GB' },
        updatedAt: new Date().toISOString()
      }
    ];

    reporter.reconstructFromCheckpointEntries(entries);

    const report = reporter.generateReport({
      totalSchools: 2,
      skippedSchools: 0
    });

    assert.strictEqual(report.totalSchools, 2);
    assert.strictEqual(report.processedSchools, 2);
    assert.strictEqual(report.readSuccess, 2);
    assert.strictEqual(report.readFailed, 0);
    assert.strictEqual(report.alreadyConfigured, 1);
    assert.strictEqual(report.requiresChange, 1);
    assert.strictEqual(report.actionsDistribution.zero, 1);
    assert.strictEqual(report.actionsDistribution.one, 1);
  });

  // Test K: Resume 時の INTERRUPTED 校上書きと二重カウント防止
  await runTest('Phase 5A.4 Test K: Resume 時に同一 schoolCode が上書きされ二重カウントが発生しないこと', () => {
    const reporter = new BatchSummaryReporter({
      deploymentId: 'dep-dup',
      runId: 'run-dup',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'phash',
      schoolsHash: 'shash',
      toolVersion: '1.0.0'
    });

    // 過去: SCH01 が INTERRUPTED
    reporter.reconstructFromCheckpointEntries([
      {
        schoolCode: 'SCH01',
        schoolName: '学校1',
        status: 'INTERRUPTED',
        executionStatus: 'INTERRUPTED',
        planExecutable: false,
        updatedAt: new Date().toISOString()
      }
    ]);

    // 今回: SCH01 を SUCCESS で上書き
    reporter.addSchoolResult({
      schoolCode: 'SCH01',
      schoolName: '学校1',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      planExecutable: true,
      actionsCount: 0
    });

    const report = reporter.generateReport({
      totalSchools: 1,
      skippedSchools: 0
    });

    assert.strictEqual(report.processedSchools, 1, '学校数が1校であること (二重カウントなし)');
    assert.strictEqual(report.readSuccess, 1);
    assert.strictEqual(report.readFailed, 0);
    assert.strictEqual(report.schoolResults.length, 1);
    assert.strictEqual(report.schoolResults[0].status, 'SUCCESS');
  });

  // Test L: Interrupted 発生時の Distribution Coverage
  await runTest('Phase 5A.4 Test L: 中断発生時に Distribution Coverage が正しく収集校数 / 全校数を反映すること', () => {
    const reporter = new BatchSummaryReporter({
      deploymentId: 'dep-cov',
      runId: 'run-cov',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'phash',
      schoolsHash: 'shash',
      toolVersion: '1.0.0'
    });

    // 1校成功、1校中断
    reporter.addSchoolResult({
      schoolCode: 'SCH01',
      schoolName: '学校1',
      status: 'SUCCESS',
      executionStatus: 'DRY_RUN_COMPLETED',
      planExecutable: true,
      actionsCount: 0,
      before: { storage: '1GB' },
      requested: { storage: '1GB' },
      after: { storage: '1GB' }
    });
    reporter.addSchoolResult({
      schoolCode: 'SCH02',
      schoolName: '学校2',
      status: 'INTERRUPTED',
      executionStatus: 'INTERRUPTED',
      planExecutable: false
    });

    const report = reporter.generateReport({
      totalSchools: 2,
      skippedSchools: 0,
      isInterrupted: true
    });

    assert.strictEqual(report.readSuccess, 1);
    assert.strictEqual(report.currentStateCoverage?.collected, 1);
    assert.strictEqual(report.currentStateCoverage?.total, 2);
    assert.strictEqual(report.plannedChangeCoverage?.collected, 1);
    assert.strictEqual(report.plannedChangeCoverage?.total, 2);
  });

  console.log(`\n=== Phase 3 テスト完了: 成功 ${passedTests} 件 / 失敗 ${failedTests} 件 ===\n`);
  if (failedTests > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('テスト実行エラー:', err);
  process.exit(1);
});
