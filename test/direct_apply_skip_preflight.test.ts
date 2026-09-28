import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { BatchProcessAdapter } from '../src/console/adapter';
import { ConsoleServer } from '../src/console/server';
import { validateGlobalGateAndBuildManifest } from '../src/console/manifest';
import { ObservationSnapshot, ProfileSnapshot, ValidationSnapshot } from '../src/console/types';

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, msg: string) {
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
  console.log('=== [DIRECT APPLY] Skip Final Preflight & Direct Production Apply Tests ===\n');

  // 1. モックデータの準備
  const mockProfile: ProfileSnapshot = {
    snapshotId: 'prof-snap-direct',
    sourceDraftRevision: 1,
    sourceDraftHash: 'hash-draft-direct',
    requestedSettings: {
      storage: null,
      timelineChannel: null,
      directMessage: null,
      parentDirectMessage: null,
      allChannel: 'OFF', // 破壊的変更（予約投稿削除リスク）
      parentChannel: 'OFF', // 破壊的変更
      attendance: null,
      contactBook: null,
      mentalHealth: null,
      otherSchoolLog: null,
      studentPasswordChange: null
    },
    profileHash: 'hash-prof-direct',
    createdAt: new Date().toISOString()
  };

  const mockValidation: ValidationSnapshot = {
    profileHash: 'hash-prof-direct',
    schoolsHash: 'schools-hash-direct',
    toolVersion: '1.0.0',
    toolFingerprint: 'tf-direct',
    totalSchoolCount: 2,
    enabledSchoolCount: 2,
    resolvedCredentialsCount: 2,
    validatedAt: new Date().toISOString()
  };

  const mockObservation: ObservationSnapshot = {
    observationSnapshotId: 'obs-snap-direct',
    targetSnapshotId: 'tgt-snap-direct',
    schoolsHash: 'schools-hash-direct',
    toolFingerprint: 'tf-direct',
    authMode: 'A',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    totalSchools: 2,
    readSuccessCount: 2,
    readFailedCount: 0,
    distribution: {} as any,
    schools: [
      {
        schoolCode: 'SCH001',
        schoolName: '第1小学校',
        readStatus: 'SUCCESS',
        discoveryStateHash: 'dsh-001',
        observedAt: new Date().toISOString(),
        observation: {
          allChannel: { value: 'ON', availability: 'AVAILABLE' },
          parentChannel: { value: 'ON', availability: 'AVAILABLE' }
        } as any
      },
      {
        schoolCode: 'SCH002',
        schoolName: '第2小学校',
        readStatus: 'SUCCESS',
        discoveryStateHash: 'dsh-002',
        observedAt: new Date().toISOString(),
        observation: {
          allChannel: { value: 'ON', availability: 'AVAILABLE' },
          parentChannel: { value: 'ON', availability: 'AVAILABLE' }
        } as any
      }
    ]
  };

  // --- Case 1: validateGlobalGateAndBuildManifest (Direct Mode) ---
  console.log('--- Case 1: validateGlobalGateAndBuildManifest in Direct Mode ---');
  // allowDestructive=false の場合は破壊的変更がスキップされ、対象0校で CONFIG_INVALID
  let caughtError: any = null;
  try {
    validateGlobalGateAndBuildManifest({
      preflightReport: null,
      observationSnapshot: mockObservation,
      activeProfileSnapshot: mockProfile,
      currentValidationSnapshot: mockValidation,
      allowDestructive: false,
      directApply: true
    });
  } catch (err: any) {
    caughtError = err;
  }
  assert(caughtError !== null, 'Direct apply blocks when allowDestructive=false and all schools are destructive');
  assert((caughtError?.issueCode || caughtError?.status) === 'CONFIG_INVALID', `Error code is CONFIG_INVALID, got ${caughtError?.issueCode || caughtError?.status}`);

  // allowDestructive=true の場合は全校が対象となり Manifest が生成される
  const manifest = validateGlobalGateAndBuildManifest({
    preflightReport: null,
    observationSnapshot: mockObservation,
    activeProfileSnapshot: mockProfile,
    currentValidationSnapshot: mockValidation,
    allowDestructive: true,
    directApply: true
  });

  assert(manifest.directApply === true, 'manifest.directApply is true');
  assert(manifest.applyTargets.length === 2, `applyTargets length is 2, got ${manifest.applyTargets.length}`);
  assert(manifest.skippedDestructiveCount === 0, `skippedDestructiveCount is 0, got ${manifest.skippedDestructiveCount}`);
  assert(manifest.allowDestructive === true, 'manifest.allowDestructive is true');
  assert(manifest.preflightId.startsWith('direct-'), `preflightId starts with direct-, got ${manifest.preflightId}`);

  // --- Case 2: Adapter prepareProductionApply in Direct Mode ---
  console.log('\n--- Case 2: Adapter prepareProductionApply (No Preflight Report) ---');
  const adapter = new BatchProcessAdapter();
  (adapter as any).activeProfileSnapshot = mockProfile;
  (adapter as any).observationSnapshot = mockObservation;
  (adapter as any).currentSnapshot = mockValidation;
  (adapter as any).activeFinalPreflightReport = null; // Preflight レポートなし！

  const prepared = adapter.prepareProductionApply(undefined, undefined, true, true);
  assert(Boolean(prepared.tokenData.token), 'Confirmation token issued');
  assert(prepared.manifest.directApply === true, 'manifest.directApply is true');
  assert(prepared.tokenData.directApply === true, 'tokenData.directApply is true');
  assert(prepared.tokenData.allowDestructive === true, 'tokenData.allowDestructive is true');

  // --- Case 3: API Endpoint (POST /api/apply/prepare with directApply) ---
  console.log('\n--- Case 3: Server API Integration (directApply: true) ---');
  const server = new ConsoleServer({ adapter, port: 3095 });
  await server.start();
  const csrf = server.getCsrfToken();

  try {
    const res = await fetch('http://127.0.0.1:3095/api/apply/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-nonce': csrf
      },
      body: JSON.stringify({ allowDestructive: true, directApply: true })
    });

    const data: any = await res.json();
    assert(res.status === 200, `Prepare with directApply returns 200, got ${res.status}`);
    assert(data.status === 'PREPARED', `Status is PREPARED, got ${data.status}`);
    assert(data.directApply === true, `Response includes directApply: true`);
    assert(data.targetCount === 2, `targetCount is 2, got ${data.targetCount}`);
  } finally {
    server.stop();
  }

  // --- Case 4: Process Spawn Boundary (No --preflight-report in args) ---
  console.log('\n--- Case 4: Subprocess Execution Args (Direct Mode) ---');
  let capturedArgs: string[] = [];
  (adapter as any).spawnChildInternal = (args: string[]) => {
    capturedArgs = args;
  };

  adapter.startProductionApplyProcess(prepared.tokenData.token);
  assert(capturedArgs.includes('--apply'), 'Child process has --apply');
  assert(capturedArgs.includes('--allow-live-write'), 'Child process has --allow-live-write');
  assert(capturedArgs.includes('--allow-destructive'), 'Child process has --allow-destructive');
  assert(!capturedArgs.includes('--preflight-report'), 'Child process DOES NOT contain --preflight-report in direct mode');

  // --- Case 5: UI Elements Check ---
  console.log('\n--- Case 5: UI Elements & Script Consistency Check ---');
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../src/console/public/index.html'), 'utf-8');
  const appJs = fs.readFileSync(path.resolve(__dirname, '../src/console/public/app.js'), 'utf-8');

  assert(indexHtml.includes('id="profileDirectApplyBtn"'), 'index.html has profileDirectApplyBtn');
  assert(appJs.includes('function confirmProfileAndGoToApply'), 'app.js includes confirmProfileAndGoToApply');
  assert(appJs.includes('directApply: isDirect'), 'app.js passes directApply in prepare call');

  console.log(`\n======================================================`);
  console.log(`Direct Apply Tests: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log(`======================================================\n`);
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
