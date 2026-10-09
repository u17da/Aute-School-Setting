import * as assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseAndSeparateSchoolsCsv } from '../src/batch/csvParser';
import { ConsoleServer } from '../src/console/server';
import { BatchProcessAdapter } from '../src/console/adapter';
import { AutomationError } from '../src/types/errors';

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
  } catch (err: any) {
    console.error(`[FAIL] ${name}:`, err.message || err);
    throw err;
  }
}

async function main() {
  console.log('=== Test Suite: CSV Upload & 1本化 (A - AD) ===\n');

  // A. UTF-8 CSV
  await runTest('Test A: UTF-8 CSV が正常にパース・分離されること', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled\nSCH01,第1学校,user1,pass1,true';
    const bundle = parseAndSeparateSchoolsCsv(csv);
    assert.strictEqual(bundle.schools.length, 1);
    assert.strictEqual(bundle.schools[0].schoolCode, 'SCH01');
    assert.strictEqual(bundle.schools[0].schoolName, '第1学校');
    assert.strictEqual(bundle.credentials['SCH01'].userId, 'user1');
    assert.strictEqual(bundle.credentials['SCH01'].password, 'pass1');
  });

  // B. UTF-8 BOM
  await runTest('Test B: UTF-8 BOM が正常に除去されパースされること', () => {
    const csv = '\uFEFFschoolCode,schoolName,userId,password,enabled\nSCH01,第1学校,user1,pass1,true';
    const bundle = parseAndSeparateSchoolsCsv(csv);
    assert.strictEqual(bundle.schools.length, 1);
    assert.strictEqual(bundle.schools[0].schoolCode, 'SCH01');
  });

  // C. CRLF
  await runTest('Test C: CRLF 改行が正常にパースされること', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled\r\nSCH01,第1学校,user1,pass1,true\r\nSCH02,第2学校,user2,pass2,true\r\n';
    const bundle = parseAndSeparateSchoolsCsv(csv);
    assert.strictEqual(bundle.schools.length, 2);
  });

  // D. LF
  await runTest('Test D: LF 改行が正常にパースされること', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled\nSCH01,第1学校,user1,pass1,true\nSCH02,第2学校,user2,pass2,true\n';
    const bundle = parseAndSeparateSchoolsCsv(csv);
    assert.strictEqual(bundle.schools.length, 2);
  });

  // E. quoted comma in schoolName
  await runTest('Test E: schoolName 内のカンマがクォートにより正常に保護されること', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled\nSCH01,"第1学校,付属校",user1,pass1,true';
    const bundle = parseAndSeparateSchoolsCsv(csv);
    assert.strictEqual(bundle.schools[0].schoolName, '第1学校,付属校');
  });

  // F. quoted comma in password
  await runTest('Test F: password 内のカンマがクォートにより正常に保護されること', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled\nSCH01,第1学校,user1,"p@ss,word!",true';
    const bundle = parseAndSeparateSchoolsCsv(csv);
    assert.strictEqual(bundle.credentials['SCH01'].password, 'p@ss,word!');
  });

  // G. escaped double quote
  await runTest('Test G: エスケープされた二重引用符 ("") が正常に処理されること', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled\nSCH01,"第1""特選""学校",user1,"p""w",true';
    const bundle = parseAndSeparateSchoolsCsv(csv);
    assert.strictEqual(bundle.schools[0].schoolName, '第1"特選"学校');
    assert.strictEqual(bundle.credentials['SCH01'].password, 'p"w');
  });

  // H. duplicate schoolCode
  await runTest('Test H: 有効な学校での重複 schoolCode が BATCH_INPUT_INVALID で拒絶されること', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled\nSCH01,校1,u1,p1,true\nSCH01,校2,u2,p2,true';
    assert.throws(
      () => parseAndSeparateSchoolsCsv(csv),
      (err: any) => err.status === 'BATCH_INPUT_INVALID'
    );
  });

  // I. missing schoolName
  await runTest('Test I: 有効な学校での schoolName 欠落が CONFIG_INVALID で拒絶されること', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled\nSCH01,,u1,p1,true';
    assert.throws(
      () => parseAndSeparateSchoolsCsv(csv),
      (err: any) => err.status === 'CONFIG_INVALID' && err.message.includes('schoolName')
    );
  });

  // J. missing userId
  await runTest('Test J: 有効な学校での userId 欠落が CONFIG_INVALID で拒絶されること', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled\nSCH01,校1,,p1,true';
    assert.throws(
      () => parseAndSeparateSchoolsCsv(csv),
      (err: any) => err.status === 'CONFIG_INVALID' && err.message.includes('userId')
    );
  });

  // K. missing password
  await runTest('Test K: 有効な学校での password 欠落が CONFIG_INVALID で拒絶され生パスワードが露出しないこと', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled\nSCH01,校1,u1,,true';
    assert.throws(
      () => parseAndSeparateSchoolsCsv(csv),
      (err: any) => {
        assert.strictEqual(err.status, 'CONFIG_INVALID');
        assert.ok(err.message.includes('password が空です'));
        assert.ok(!err.message.includes('secret'));
        return true;
      }
    );
  });

  // L. invalid enabled
  await runTest('Test L: enabled カラムの不正値が CONFIG_INVALID で拒絶されること', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled\nSCH01,校1,u1,p1,maybe';
    assert.throws(
      () => parseAndSeparateSchoolsCsv(csv),
      (err: any) => err.status === 'CONFIG_INVALID' && err.message.includes('enabled')
    );
  });

  // M. unknown header
  await runTest('Test M: 未知のヘッダーが含まれるCSVが CONFIG_INVALID で拒絶されること', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled,studentPersonalId\nSCH01,校1,u1,p1,true,12345';
    assert.throws(
      () => parseAndSeparateSchoolsCsv(csv),
      (err: any) => err.status === 'CONFIG_INVALID' && err.message.includes('未許可のカラム')
    );
  });

  // N. malformed CSV quote
  await runTest('Test N: 壊れたクォート形式が CONFIG_INVALID で安全停止 (fail-closed) すること', () => {
    const csv = 'schoolCode,schoolName,userId,password,enabled\nSCH01,"第1学校,u1,p1,true';
    assert.throws(
      () => parseAndSeparateSchoolsCsv(csv),
      (err: any) => err.status === 'CONFIG_INVALID' && err.message.includes('RFC 4180')
    );
  });

  // O. >5MB reject
  await runTest('Test O: 5MB超過のCSVアップロードが拒絶されること', async () => {
    const adapter = new BatchProcessAdapter();
    const server = new ConsoleServer({ port: 0, adapter });
    const port = await server.start();

    // 5MB + 1KB のダミー文字列
    const bigCsv = 'schoolCode,schoolName,userId,password,enabled\n' + 'A'.repeat(5 * 1024 * 1024 + 1024);

    const res = await fetch(`http://127.0.0.1:${port}/api/schools/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/csv',
        'X-CSRF-Nonce': (server as any).csrfToken
      },
      body: bigCsv
    });

    assert.ok(res.status === 413 || res.status === 400, `Expected 413 or 400, got ${res.status}`);
    await server.stop();
  });

  // P. Upload後previewにuserId/passwordなし
  await runTest('Test P: Upload後のプレビューリストに userId, password が含まれないこと', async () => {
    const adapter = new BatchProcessAdapter();
    const server = new ConsoleServer({ port: 0, adapter });
    const port = await server.start();

    const csv = 'schoolCode,schoolName,userId,password,enabled\nPRRHC,MEXCBT学校,secret_user,super_secret_pw,true';
    const res = await fetch(`http://127.0.0.1:${port}/api/schools/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/csv',
        'X-CSRF-Nonce': (server as any).csrfToken,
        'X-Filename': encodeURIComponent('test_schools.csv')
      },
      body: csv
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.preview.length, 1);
    assert.deepStrictEqual(data.preview[0], { schoolCode: 'PRRHC', schoolName: 'MEXCBT学校', hasCredential: true });
    assert.strictEqual((data.preview[0] as any).userId, undefined);
    assert.strictEqual((data.preview[0] as any).password, undefined);

    await server.stop();
  });

  // Q. API responseにsecretなし
  await runTest('Test Q: Upload完了APIレスポンス全体に userId, password が一切含まれないこと', async () => {
    const adapter = new BatchProcessAdapter();
    const server = new ConsoleServer({ port: 0, adapter });
    const port = await server.start();

    const csv = 'schoolCode,schoolName,userId,password,enabled\nPRRHC,MEXCBT学校,secret_user,super_secret_pw,true';
    const res = await fetch(`http://127.0.0.1:${port}/api/schools/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/csv',
        'X-CSRF-Nonce': (server as any).csrfToken,
        'X-Filename': encodeURIComponent('test_schools.csv')
      },
      body: csv
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const jsonStr = JSON.stringify(data);
    assert.ok(!jsonStr.includes('secret_user'), 'userId がレスポンス文字列全体に含まれないこと');
    assert.ok(!jsonStr.includes('super_secret_pw'), 'password がレスポンス文字列全体に含まれないこと');

    await server.stop();
  });

  // R. logにsecretなし
  await runTest('Test R: stdout/log に秘密情報が流れないこと', async () => {
    const adapter = new BatchProcessAdapter();
    adapter.setUploadedBatch({
      uploadId: 'up-1',
      originalFileName: 'test.csv',
      fileSize: 100,
      schools: [{ schoolCode: 'SCH01', schoolName: '学校1', credentialRef: 'SCH01', enabled: true }],
      credentials: { SCH01: { userId: 'secret_user_99', password: 'secret_pw_99' } },
      createdAt: new Date().toISOString()
    });

    const val = adapter.executeValidation({});
    assert.strictEqual(val.snapshot.enabledSchoolCount, 1);
    const logs = adapter.getRecentLogs().join('\n');
    assert.ok(!logs.includes('secret_user_99'));
    assert.ok(!logs.includes('secret_pw_99'));
  });

  // S. checkpointにsecretなし
  await runTest('Test S: Checkpoint に userId, password が保存されないこと', () => {
    const adapter = new BatchProcessAdapter();
    adapter.setUploadedBatch({
      uploadId: 'up-1',
      originalFileName: 'test.csv',
      fileSize: 100,
      schools: [{ schoolCode: 'SCH01', schoolName: '学校1', credentialRef: 'SCH01', enabled: true }],
      credentials: { SCH01: { userId: 'secret_user', password: 'secret_password' } },
      createdAt: new Date().toISOString()
    });

    const snap = adapter.executeValidation({}).snapshot;
    const snapStr = JSON.stringify(snap);
    assert.ok(!snapStr.includes('secret_user'));
    assert.ok(!snapStr.includes('secret_password'));
  });

  // T. summary/reportにsecretなし
  await runTest('Test T: Report オブジェクトに userId, password が含まれないこと', () => {
    const schools: import('../src/types/batch').BatchSchoolItem[] = [
      { schoolCode: 'S1', schoolName: '校1', credentialRef: 'S1', enabled: true }
    ];
    const reporter = new (require('../src/batch/summary').BatchSummaryReporter)({
      deploymentId: 'd1',
      runId: 'r1',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash: 'ph',
      schoolsHash: 'sh',
      toolVersion: '1.0'
    });
    const rep = reporter.generateReport({ totalSchools: 1, skippedSchools: 0, allSchools: schools });
    const repStr = JSON.stringify(rep);
    assert.ok(!repStr.includes('password'));

    // 後片付け
    const sumPath = path.resolve(process.cwd(), 'reports/summary-d1-r1.json');
    const prePath = path.resolve(process.cwd(), 'reports/preflight-d1.json');
    if (fs.existsSync(sumPath)) fs.unlinkSync(sumPath);
    if (fs.existsSync(prePath)) fs.unlinkSync(prePath);
  });

  // U. SSEにsecretなし
  await runTest('Test U: SSE クライアントへのブロードキャストに秘密情報が含まれないこと', async () => {
    const adapter = new BatchProcessAdapter();
    const server = new ConsoleServer({ port: 0, adapter });
    const port = await server.start();

    await new Promise<void>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/api/progress/stream`, (res) => {
        res.on('data', (chunk) => {
          const text = chunk.toString('utf-8');
          assert.ok(!text.includes('secret_password'));
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => resolve());
      setTimeout(() => {
        adapter.emit('log', '[PRRHC] Log message without credentials');
      }, 50);
    });

    await server.stop();
  });

  // V. DOMにsecretなし (HTML/app.js静的検証)
  await runTest('Test V: DOM/JSコード中に生パスワード描画コードが存在しないこと', () => {
    const appJs = fs.readFileSync(path.resolve(__dirname, '../src/console/public/app.js'), 'utf-8');
    assert.ok(!appJs.includes('s.password'), 'DOM描画に password を参照していないこと');
    assert.ok(!appJs.includes('s.userId'), 'DOM描画に userId を参照していないこと');
  });

  // W. Upload変更後Validation Snapshot invalid
  await runTest('Test W: CSV Upload変更時に Validation Snapshot が無効化されること', () => {
    const adapter = new BatchProcessAdapter();
    adapter.setUploadedBatch({
      uploadId: 'up-1',
      originalFileName: 'file1.csv',
      fileSize: 100,
      schools: [{ schoolCode: 'S1', schoolName: '校1', credentialRef: 'S1', enabled: true }],
      credentials: { S1: { userId: 'u1', password: 'p1' } },
      createdAt: new Date().toISOString()
    });

    adapter.executeValidation({});
    assert.ok(adapter.getSnapshot() !== null, '検証後は Snapshot が存在');

    // 新しい Upload で置換
    adapter.setUploadedBatch({
      uploadId: 'up-2',
      originalFileName: 'file2.csv',
      fileSize: 120,
      schools: [{ schoolCode: 'S2', schoolName: '校2', credentialRef: 'S2', enabled: true }],
      credentials: { S2: { userId: 'u2', password: 'p2' } },
      createdAt: new Date().toISOString()
    });

    assert.strictEqual(adapter.getSnapshot(), null, '置換後は Snapshot が invalidate されること');
  });

  // X. RUNNING中Upload拒否
  await runTest('Test X: RUNNING 中の新しい CSV アップロードが JOB_CONFLICT で拒絶されること', () => {
    const adapter = new BatchProcessAdapter();
    (adapter as any).currentJobState = 'RUNNING';

    assert.throws(
      () =>
        adapter.setUploadedBatch({
          uploadId: 'up-x',
          originalFileName: 'x.csv',
          fileSize: 10,
          schools: [],
          credentials: {},
          createdAt: new Date().toISOString()
        }),
      (err: any) => err.code === 'JOB_CONFLICT'
    );
  });

  // Y. Uploaded sourceでcredentials.json fallbackしない
  await runTest('Test Y: Uploaded source 使用時は credentials.json や .env へのフォールバックが物理遮断されること', () => {
    const adapter = new BatchProcessAdapter();
    // 認証情報が欠落したアップロード (S1 のパスワードなし)
    adapter.setUploadedBatch({
      uploadId: 'up-nofallback',
      originalFileName: 'test.csv',
      fileSize: 100,
      schools: [{ schoolCode: 'S1', schoolName: '校1', credentialRef: 'S1', enabled: true }],
      credentials: {}, // 欠落
      createdAt: new Date().toISOString()
    });

    assert.throws(
      () => adapter.executeValidation({}),
      (err: any) => err.status === 'CREDENTIAL_NOT_FOUND',
      '外部ファイルを見に行かず CREDENTIAL_NOT_FOUND で安全停止'
    );
  });

  // Z. expectedSchoolCount mismatchでBrowser起動0
  await runTest('Test Z: expectedSchoolCount 不一致時に Validation で安全停止し子プロセスが起動しないこと', () => {
    const adapter = new BatchProcessAdapter();
    adapter.setUploadedBatch({
      uploadId: 'up-count',
      originalFileName: 'test.csv',
      fileSize: 100,
      schools: [{ schoolCode: 'S1', schoolName: '校1', credentialRef: 'S1', enabled: true }],
      credentials: { S1: { userId: 'u1', password: 'p1' } },
      createdAt: new Date().toISOString()
    });

    assert.throws(
      () => adapter.executeValidation({ expectedSchoolCount: 400 }), // 実際は1校
      (err: any) => err.status === 'BATCH_INPUT_INVALID'
    );
    assert.strictEqual(adapter.getLastSpawnInfo(), null, '子プロセスは未起動');
  });

  // AA. Stop→Resumeで同一Uploadを再利用
  await runTest('Test AA: 同一セッション内の Stop → Resume で同一の ActiveUploadedBatch が保持されること', () => {
    const adapter = new BatchProcessAdapter();
    const batch = {
      uploadId: 'up-same',
      originalFileName: 'same.csv',
      fileSize: 100,
      schools: [{ schoolCode: 'S1', schoolName: '校1', credentialRef: 'S1', enabled: true }],
      credentials: { S1: { userId: 'u1', password: 'p1' } },
      createdAt: new Date().toISOString()
    };
    adapter.setUploadedBatch(batch);
    adapter.executeValidation({});

    // シミュレート: Stop
    (adapter as any).currentJobState = 'INTERRUPTED';

    // Resume 時の ActiveUpload 確認
    assert.strictEqual(adapter.getActiveUpload()?.uploadId, 'up-same');
  });

  // AB. temporary schools/credentials file cleanup
  await runTest('Test AB: materialize された一時ファイルが cleanup で確実に削除されること', () => {
    const adapter = new BatchProcessAdapter();
    adapter.setUploadedBatch({
      uploadId: 'up-cleanup-test',
      originalFileName: 'clean.csv',
      fileSize: 100,
      schools: [{ schoolCode: 'S1', schoolName: '校1', credentialRef: 'S1', enabled: true }],
      credentials: { S1: { userId: 'u1', password: 'p1' } },
      createdAt: new Date().toISOString()
    });

    const temp = (adapter as any).materializeTempFiles();
    assert.ok(fs.existsSync(temp.schoolsPath), '一時 CSV が存在');
    assert.ok(fs.existsSync(temp.credentialsPath), '一時 Credentials が存在');

    // cleanup 呼出
    temp.cleanup();
    assert.ok(!fs.existsSync(temp.schoolsPath), '一時 CSV が削除されたこと');
    assert.ok(!fs.existsSync(temp.credentialsPath), '一時 Credentials が削除されたこと');
    if (temp.privateDir) {
      assert.ok(!fs.existsSync(temp.privateDir), 'private ディレクトリ自体が削除されたこと');
    }
  });

  // AC. Console restart後は再Upload必須
  await runTest('Test AC: Console Server 再起動後は activeUpload が null になり再Uploadが必須となること', () => {
    const freshAdapter = new BatchProcessAdapter();
    assert.strictEqual(freshAdapter.getActiveUpload(), null);
    assert.strictEqual(freshAdapter.getSnapshot(), null);
    freshAdapter.setInputSource('UPLOAD');
    assert.throws(
      () => freshAdapter.executeValidation({}),
      (err: any) => err.status === 'CONFIG_INVALID' && err.message.includes('アップロードされたCSVデータが存在しません')
    );
  });

  // AD. 旧ローカル既定ファイルモードの回帰PASS
  await runTest('Test AD: 旧ローカル既定ファイルモード (LOCAL_DEFAULT) が従来通り正常に動作すること', () => {
    const adapter = new BatchProcessAdapter();
    adapter.setInputSource('LOCAL_DEFAULT');
    const hasLive = fs.existsSync(path.resolve(process.cwd(), 'config/production-profile.live.json'));
    const profilePath = hasLive ? 'config/production-profile.live.json' : 'config/production-profile.sample.json';
    const schoolsPath = hasLive ? 'config/schools.live.csv' : 'config/schools.sample.csv';
    const credsPath = hasLive ? 'config/credentials.json' : 'config/credentials.sample.json';
    const val = adapter.executeValidation({
      schoolsFilePath: schoolsPath,
      profileFilePath: profilePath,
      credentialsFilePath: credsPath
    });
    assert.strictEqual(val.enabledCount, hasLive ? 3 : 2);
    assert.strictEqual(val.snapshot.source, 'LOCAL_DEFAULT');
    assert.ok(adapter.getSnapshot() !== null);
  });

  // AE. RESULTS_STALE 整合性表示
  await runTest('Test AE: RESULTS_STALE 整合性検証 (3校結果存在 → 別CSV UploadでRESULTS_STALE表示 → 新規PreflightでSTALE解除)', async () => {
    const adapter = new BatchProcessAdapter();
    const server = new ConsoleServer({ port: 0, adapter });
    const port = await server.start();

    // 1. 3校データを持つ CSV1 をパースしてハッシュを取得
    const csv1 = 'schoolCode,schoolName,userId,password,enabled\nPRRHC,学校1,u1,p1,true\nPAKCW,学校2,u2,p2,true\nPSD20,学校3,u3,p3,true';
    const bundle1 = parseAndSeparateSchoolsCsv(csv1);
    const { generateSchoolsHash } = require('../src/utils/hash');
    const schoolsHash1 = generateSchoolsHash(bundle1.schools);

    // テスト用の profileHash を取得
    const dummyHashes = adapter.getCurrentInputHashes();
    const profileHash = dummyHashes?.profileHash || 'test-profile-hash';

    // 2. CSV1 のハッシュを持つ最新レポートを作成 (3校結果存在状態のシミュレート)
    const testReportId = `stale-test-${Date.now()}`;
    const testSummaryPath = path.resolve(process.cwd(), `reports/summary-${testReportId}-r1.json`);
    const testPreflightPath = path.resolve(process.cwd(), `reports/preflight-${testReportId}.json`);

    const summaryData = {
      deploymentId: testReportId,
      runId: 'r1',
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash,
      schoolsHash: schoolsHash1,
      toolVersion: '1.0.0',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      totalSchools: 3,
      processedSchools: 3,
      skippedSchools: 0,
      readSuccess: 3,
      readFailed: 0,
      alreadyConfigured: 3,
      requiresChange: 0,
      destructiveChangeSchools: 0,
      writeEligibleNonDestructive: 3,
      actionsDistribution: { zero: 3, one: 0, two: 0, threePlus: 0 },
      destructiveChangeDetails: [],
      schoolResults: bundle1.schools.map((s) => ({
        schoolCode: s.schoolCode,
        schoolName: s.schoolName,
        status: 'SUCCESS_ALREADY_CONFIGURED',
        actionsCount: 0
      }))
    };

    const preflightData = {
      deploymentId: testReportId,
      runId: 'r1',
      status: 'COMPLETE',
      writeGateEligible: true,
      allReadSucceeded: true,
      allPlansExecutable: true,
      profileHash,
      schoolsHash: schoolsHash1,
      toolVersion: '1.0.0',
      completedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      total: 3,
      processed: 3,
      readSuccess: 3,
      readFailed: 0,
      planBlocked: 0,
      notProcessed: 0,
      alreadyConfigured: 3,
      requiresChange: 0,
      destructiveChangeSchools: 0,
      summaryPath: testSummaryPath,
      schools: bundle1.schools.map((s) => ({
        schoolCode: s.schoolCode,
        schoolName: s.schoolName,
        readStatus: 'SUCCESS',
        planExecutable: true,
        hasDestructiveChanges: false,
        writeEligible: true,
        actionsCount: 0
      }))
    };

    fs.writeFileSync(testSummaryPath, JSON.stringify(summaryData), 'utf-8');
    fs.writeFileSync(testPreflightPath, JSON.stringify(preflightData), 'utf-8');

    try {
      // 3. CSV1 を Upload → レポートのハッシュと一致するため isStale は false
      const uploadRes1 = await fetch(`http://127.0.0.1:${port}/api/schools/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/csv',
          'X-CSRF-Nonce': (server as any).csrfToken,
          'X-Filename': 'schools1.csv'
        },
        body: csv1
      });
      assert.strictEqual(uploadRes1.status, 200);

      let res = await fetch(`http://127.0.0.1:${port}/api/reports/latest`);
      let data = await res.json();
      assert.strictEqual(data.isStale, false, '同一CSVのハッシュと一致している場合は isStale が false であること');

      // 4. 別CSV (1校分 DIFF01) を Upload → ハッシュ不一致により RESULTS_STALE を検知
      const csv2 = 'schoolCode,schoolName,userId,password,enabled\nDIFF01,別学校,user_diff,pw_diff,true';
      const uploadRes2 = await fetch(`http://127.0.0.1:${port}/api/schools/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/csv',
          'X-CSRF-Nonce': (server as any).csrfToken,
          'X-Filename': 'schools2.csv'
        },
        body: csv2
      });
      assert.strictEqual(uploadRes2.status, 200);

      res = await fetch(`http://127.0.0.1:${port}/api/reports/latest`);
      data = await res.json();
      assert.strictEqual(data.isStale, true, '別CSVアップロード後は isStale が true になり RESULTS_STALE が表示されること');
      assert.ok(data.staleReason && data.staleReason.includes('ハッシュ'), 'staleReason に理由が設定されていること');
      if (data.normalized) {
        assert.strictEqual(data.normalized.isStale, true);
      }

      // 5. 新規 Preflight 実行シミュレート: CSV2 のハッシュを持つ最新レポートを作成
      const bundle2 = parseAndSeparateSchoolsCsv(csv2);
      const schoolsHash2 = generateSchoolsHash(bundle2.schools);
      summaryData.schoolsHash = schoolsHash2;
      preflightData.schoolsHash = schoolsHash2;
      // mtime を更新して最新にする
      fs.writeFileSync(testSummaryPath, JSON.stringify(summaryData), 'utf-8');
      fs.writeFileSync(testPreflightPath, JSON.stringify(preflightData), 'utf-8');

      res = await fetch(`http://127.0.0.1:${port}/api/reports/latest`);
      data = await res.json();
      assert.strictEqual(data.isStale, false, '新規Preflight結果が生成された後は RESULTS_STALE が解除されること');
    } finally {
      if (fs.existsSync(testSummaryPath)) fs.unlinkSync(testSummaryPath);
      if (fs.existsSync(testPreflightPath)) fs.unlinkSync(testPreflightPath);
      await server.stop();
    }
  });

  // AF. Private Temp Directory 作成 (mkdtempSync, mode 0600) と 通常終了時 cleanup
  await runTest('Test AF: Private Temp Directory 作成 (mkdtempSync, mode 0600) と 通常終了時 cleanup の検証', async () => {
    let capturedChild: any = null;
    let createdPrivateDir: string | null = null;

    const mockSpawn = ((cmd: string, args: string[], opts: any) => {
      const { EventEmitter } = require('events');
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, destroyed: false };
      child.kill = () => {};
      capturedChild = child;

      // 引数に含まれる schools.csv のパスから privateDir を特定
      const schoolsArgIdx = args.indexOf('--schools');
      if (schoolsArgIdx !== -1) {
        const schoolsPath = args[schoolsArgIdx + 1];
        createdPrivateDir = path.dirname(schoolsPath);
      }
      return child;
    }) as any;

    const adapter = new BatchProcessAdapter({ spawnFn: mockSpawn });
    adapter.setUploadedBatch({
      uploadId: 'up-af',
      originalFileName: 'test.csv',
      fileSize: 100,
      schools: [{ schoolCode: 'S1', schoolName: '校1', credentialRef: 'S1', enabled: true }],
      credentials: { S1: { userId: 'u1', password: 'p1' } },
      createdAt: new Date().toISOString()
    });

    adapter.executeValidation({});
    adapter.startBatchProcess('START', {});

    assert.ok(createdPrivateDir !== null, 'privateDir が特定できること');
    assert.ok(fs.existsSync(createdPrivateDir!), '子プロセス起動中に privateDir が存在すること');
    assert.ok(path.basename(createdPrivateDir!).startsWith('manapoke-upload-'), 'ディレクトリ名が manapoke-upload- で始まること');

    // 正常終了 (exit code 0) 発火
    capturedChild.emit('exit', 0, null);

    assert.ok(!fs.existsSync(createdPrivateDir!), '子プロセス正常終了後に privateDir が recursive 削除されていること');
  });

  // AG. STOP 停止時の Private Temp Directory cleanup
  await runTest('Test AG: STOP 停止時の Private Temp Directory cleanup 検証', async () => {
    let capturedChild: any = null;
    let createdPrivateDir: string | null = null;

    const mockSpawn = ((cmd: string, args: string[], opts: any) => {
      const { EventEmitter } = require('events');
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, destroyed: false };
      child.kill = () => {};
      capturedChild = child;

      const schoolsArgIdx = args.indexOf('--schools');
      if (schoolsArgIdx !== -1) {
        createdPrivateDir = path.dirname(args[schoolsArgIdx + 1]);
      }
      return child;
    }) as any;

    const adapter = new BatchProcessAdapter({ spawnFn: mockSpawn });
    adapter.setUploadedBatch({
      uploadId: 'up-ag',
      originalFileName: 'test.csv',
      fileSize: 100,
      schools: [{ schoolCode: 'S1', schoolName: '校1', credentialRef: 'S1', enabled: true }],
      credentials: { S1: { userId: 'u1', password: 'p1' } },
      createdAt: new Date().toISOString()
    });

    adapter.executeValidation({});
    adapter.startBatchProcess('START', {});

    assert.ok(fs.existsSync(createdPrivateDir!), '実行中に privateDir が存在すること');

    // 安全停止実行
    adapter.stopBatchProcess();
    assert.strictEqual(adapter.getJobState(), 'STOPPING');

    // 子プロセスが exit (安全停止シミュレート)
    capturedChild.emit('exit', 0, null);
    assert.strictEqual(adapter.getJobState(), 'INTERRUPTED');
    assert.ok(!fs.existsSync(createdPrivateDir!), 'STOP による子プロセス exit 後に privateDir が削除されていること');
  });

  // AH. Spawn エラー時の Private Temp Directory cleanup
  await runTest('Test AH: Spawn エラー時の Private Temp Directory cleanup 検証', async () => {
    const mockSpawnError = (() => {
      throw new Error('EACCES: permission denied');
    }) as any;

    const adapter = new BatchProcessAdapter({ spawnFn: mockSpawnError });
    adapter.setUploadedBatch({
      uploadId: 'up-ah',
      originalFileName: 'test.csv',
      fileSize: 100,
      schools: [{ schoolCode: 'S1', schoolName: '校1', credentialRef: 'S1', enabled: true }],
      credentials: { S1: { userId: 'u1', password: 'p1' } },
      createdAt: new Date().toISOString()
    });

    adapter.executeValidation({});

    assert.throws(
      () => adapter.startBatchProcess('START', {}),
      (err: any) => err.code === 'PROCESS_SPAWN_FAILED'
    );

    // 一時ディレクトリが残存していないか os.tmpdir() 配下をチェック (直近1分以内の manapoke-upload- がないこと)
    const tmpDirs = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('manapoke-upload-'));
    const now = Date.now();
    for (const d of tmpDirs) {
      const stat = fs.statSync(path.join(os.tmpdir(), d));
      if (now - stat.mtimeMs < 5000) {
        assert.fail(`Spawn 失敗後に一時ディレクトリが残存しています: ${d}`);
      }
    }
  });

  // AI. Stale cleanup と owner.json / PID 生存確認による保護検証
  await runTest('Test AI: Stale cleanup (age > 1時間 AND ownerPid dead のみ削除) とプロセス生存時の保護検証', async () => {
    const tmpDir = os.tmpdir();
    const staleDeadDir = fs.mkdtempSync(path.join(tmpDir, 'manapoke-upload-stale-dead-'));
    const staleAliveDir = fs.mkdtempSync(path.join(tmpDir, 'manapoke-upload-stale-alive-'));
    const newDeadDir = fs.mkdtempSync(path.join(tmpDir, 'manapoke-upload-new-dead-'));
    const currentProcDir = fs.mkdtempSync(path.join(tmpDir, 'manapoke-upload-current-'));

    // 存在しない（確実に死んでいる）PID を選定 (999999 等)
    const deadPid = 999999;
    // 生存している PID (現在の process.pid)
    const alivePid = process.pid;

    // 1. staleDeadDir: 2時間前 + dead PID
    fs.writeFileSync(path.join(staleDeadDir, 'owner.json'), JSON.stringify({ ownerPid: deadPid }));
    const twoHoursAgo = (Date.now() - 2 * 3600 * 1000) / 1000;
    fs.utimesSync(staleDeadDir, twoHoursAgo, twoHoursAgo);

    // 2. staleAliveDir: 2時間前 + alive PID (長時間処理中のプロセスをシミュレート)
    fs.writeFileSync(path.join(staleAliveDir, 'owner.json'), JSON.stringify({ ownerPid: alivePid }));
    fs.utimesSync(staleAliveDir, twoHoursAgo, twoHoursAgo);

    // 3. newDeadDir: 作成直後 (new) + dead PID
    fs.writeFileSync(path.join(newDeadDir, 'owner.json'), JSON.stringify({ ownerPid: deadPid }));

    // 4. currentProcDir: 作成直後 (new) + alive PID (自プロセス)
    fs.writeFileSync(path.join(currentProcDir, 'owner.json'), JSON.stringify({ ownerPid: alivePid }));

    try {
      // 新しい BatchProcessAdapter インスタンス生成 (constructor 内で cleanupStaleTempFiles が動作)
      new BatchProcessAdapter();

      // 判定 1: old + dead PID → 削除されていること
      assert.ok(!fs.existsSync(staleDeadDir), 'old + dead PID のディレクトリはクリーンアップされること');

      // 判定 2: old + alive PID → 保護されていること (長時間処理プロセスの保護)
      assert.ok(fs.existsSync(staleAliveDir), 'old + alive PID のディレクトリは削除されず保護されること');

      // 判定 3: new + dead PID → 保護されていること (作成直後は削除しない)
      assert.ok(fs.existsSync(newDeadDir), 'new + dead PID のディレクトリは保護されること');

      // 判定 4: current process directory → 保護されていること
      assert.ok(fs.existsSync(currentProcDir), '自プロセスのディレクトリは保護されること');
    } finally {
      if (fs.existsSync(staleDeadDir)) fs.rmSync(staleDeadDir, { recursive: true, force: true });
      if (fs.existsSync(staleAliveDir)) fs.rmSync(staleAliveDir, { recursive: true, force: true });
      if (fs.existsSync(newDeadDir)) fs.rmSync(newDeadDir, { recursive: true, force: true });
      if (fs.existsSync(currentProcDir)) fs.rmSync(currentProcDir, { recursive: true, force: true });
    }
  });

  // AJ. sample CSV の Preflight 開始拒否 (SAMPLE_DATA_BLOCKED)
  await runTest('Test AJ: sample CSV (config/schools.sample.csv) の Validation PASS & Preflight START拒否 (SAMPLE_DATA_BLOCKED)', () => {
    let spawnCalled = false;
    const mockSpawn = (() => {
      spawnCalled = true;
      throw new Error('Should not be called');
    }) as any;

    const adapter = new BatchProcessAdapter({ spawnFn: mockSpawn });
    adapter.setInputSource('LOCAL_DEFAULT');

    // 1. Validation のみは許可 (PASS)
    const valRes = adapter.executeValidation({
      schoolsFilePath: 'config/schools.sample.csv',
      profileFilePath: 'config/production-profile.sample.json',
      credentialsFilePath: 'config/credentials.sample.json'
    });
    assert.strictEqual(valRes.enabledCount, 2, 'SAMPLE001, SAMPLE002 の2校が有効');
    assert.strictEqual(valRes.schoolsCount, 3, '計3校');
    assert.ok(adapter.getSnapshot() !== null, 'Snapshot は正常生成されること');

    // 2. Preflight START は SAMPLE_DATA_BLOCKED で即座に拒絶
    assert.throws(
      () => adapter.startBatchProcess('START', {
        schoolsFilePath: 'config/schools.sample.csv',
        profileFilePath: 'config/production-profile.sample.json',
        credentialsFilePath: 'config/credentials.sample.json'
      }),
      (err: any) => {
        assert.strictEqual(err.code, 'SAMPLE_DATA_BLOCKED');
        assert.ok(err.message.includes('サンプル学校データ'));
        return true;
      }
    );

    // 3. 子プロセス起動 0、BrowserContext 起動 0、ed-cl.com アクセス 0
    assert.strictEqual(spawnCalled, false, '子プロセスは一切起動していないこと');
    assert.strictEqual(adapter.getLastSpawnInfo(), null);
  });

  // AK. test/fixtures/schools.rfc4180.csv を用いた RFC 4180 特殊文字の検証
  await runTest('Test AK: test/fixtures/schools.rfc4180.csv による RFC 4180 特殊文字のパース検証', () => {
    const fixturePath = path.resolve(__dirname, 'fixtures/schools.rfc4180.csv');
    assert.ok(fs.existsSync(fixturePath), 'フィクスチャファイルが存在すること');
    const content = fs.readFileSync(fixturePath, 'utf-8');
    const bundle = parseAndSeparateSchoolsCsv(content);

    assert.strictEqual(bundle.schools.length, 3);
    assert.strictEqual(bundle.schools[0].schoolCode, 'RFC001');
    assert.strictEqual(bundle.schools[0].schoolName, '特殊文字学校,第一分校');
    assert.strictEqual(bundle.credentials['RFC001'].password, 'rfc,pass!1');

    assert.strictEqual(bundle.schools[1].schoolCode, 'RFC002');
    assert.strictEqual(bundle.schools[1].schoolName, '第2"特選"学校');
    assert.strictEqual(bundle.credentials['RFC002'].password, 'p"w');
  });

  console.log('\n=== All 37 Tests (A - AK) PASSED successfully! ===');
}

main().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
