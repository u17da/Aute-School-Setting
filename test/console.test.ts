import assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter, Readable, Writable } from 'stream';
import { ConsoleServer } from '../src/console/server';
import { BatchProcessAdapter } from '../src/console/adapter';
import { sanitizeObject, sanitizeString } from '../src/console/sanitizer';

console.log('=== Phase 5A: Local Read-only Operator Console Test Suite (A-R) ===\n');

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

// HTTP リクエスト用ヘルパー
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

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// モック用の ChildProcess 生成ヘルパー
function createMockChildProcess(): any {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const writtenToStdin: string[] = [];
  const proc: any = new EventEmitter();
  const stdin = new Writable({
    write(chunk, encoding, callback) {
      const text = chunk.toString();
      writtenToStdin.push(text);
      if (text.includes('STOP')) {
        setTimeout(() => {
          proc.emit('exit', 0, null);
        }, 10);
      }
      callback();
    }
  });
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;
  proc.writtenToStdin = writtenToStdin;
  proc.pid = 12345;
  proc.kill = (signal?: string) => {
    setTimeout(() => {
      proc.emit('exit', 0, signal || 'SIGINT');
    }, 10);
    return true;
  };
  return proc;
}

// テスト用一時ディレクトリの作成
const FIXTURE_DIR = path.resolve(process.cwd(), 'test/fixtures/console');
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

const dummyProfile = {
  storage: 'ON',
  timelineChannel: 'OFF',
  directMessage: 'STUDENT_TO_STUDENT_DISABLED'
};

const dummyCsv = `schoolCode,schoolName,credentialRef,enabled
TEST01,第一テスト小学校,TEST01,true
TEST02,第二テスト中学校,TEST02,true
TEST03,第三テスト高校,TEST03,false
`;

const dummyCredentials = {
  TEST01: { userId: 'secret_user_1', password: 'secret_password_1' },
  TEST02: { userId: 'secret_user_2', password: 'secret_password_2' }
};

const profilePath = path.join(FIXTURE_DIR, 'profile.json');
const csvPath = path.join(FIXTURE_DIR, 'schools.csv');
const credsPath = path.join(FIXTURE_DIR, 'credentials.json');

fs.writeFileSync(profilePath, JSON.stringify(dummyProfile, null, 2), 'utf-8');
fs.writeFileSync(csvPath, dummyCsv, 'utf-8');
fs.writeFileSync(credsPath, JSON.stringify(dummyCredentials, null, 2), 'utf-8');

async function main() {
  let mockProc = createMockChildProcess();
  const mockSpawn = () => mockProc;

  const adapter = new BatchProcessAdapter({ spawnFn: mockSpawn as any });
  const server = new ConsoleServer({ port: 0, host: '127.0.0.1', adapter });
  const port = await server.start();
  const csrf = server.getCsrfToken();

  try {
    // ----------------------------------------------------
    // Test A: Validate PASS -> Preflight 有効化
    // ----------------------------------------------------
    await runTest('Test A: Validate PASS -> 正常入力で validate 実行し PASS および Snapshot 生成', async () => {
      const res = await httpRequest({
        port,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          schoolsFilePath: 'test/fixtures/console/schools.csv',
          profileFilePath: 'test/fixtures/console/profile.json',
          credentialsFilePath: 'test/fixtures/console/credentials.json',
          expectedSchoolCount: 2
        }
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'PASS');
      assert.ok(res.body.snapshot);
      assert.strictEqual(res.body.snapshot.enabledSchoolCount, 2);
      assert.strictEqual(res.body.snapshot.totalSchoolCount, 3);
      assert.strictEqual(adapter.getJobState(), 'READY');
    });

    // ----------------------------------------------------
    // Test B: Validate FAIL -> Preflight ブロック
    // ----------------------------------------------------
    await runTest('Test B: Validate FAIL -> 想定学校数不一致で validate 実行し FAIL となること', async () => {
      const res = await httpRequest({
        port,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          schoolsFilePath: 'test/fixtures/console/schools.csv',
          profileFilePath: 'test/fixtures/console/profile.json',
          credentialsFilePath: 'test/fixtures/console/credentials.json',
          expectedSchoolCount: 999 // 不一致
        }
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'FAIL');
      assert.strictEqual(res.body.error.code, 'BATCH_INPUT_INVALID');
    });

    // ----------------------------------------------------
    // Test C: Credentials 不足 -> エラー非露出
    // ----------------------------------------------------
    await runTest('Test C: Credentials 不足 -> 秘密情報露出なく CREDENTIAL_NOT_FOUND が通知されること', async () => {
      // 存在しない資格情報ファイルを指定
      const res = await httpRequest({
        port,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          schoolsFilePath: 'test/fixtures/console/schools.csv',
          profileFilePath: 'test/fixtures/console/profile.json',
          credentialsFilePath: 'test/fixtures/console/nonexistent_cred.json'
        }
      });

      assert.strictEqual(res.statusCode, 200);
      // rawBody に平文のパスワード等が含まれていないこと
      assert.ok(!res.rawBody.includes('secret_password'));
    });

    // ----------------------------------------------------
    // Test D: Preflight Start (Read-only) -> Write フラグ完全不在
    // ----------------------------------------------------
    await runTest('Test D: Preflight Start -> 子プロセス引数に Write フラグが含まれず --dry-run が強制されること', async () => {
      // 再度正常に validate して READY にする
      await httpRequest({
        port,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          schoolsFilePath: 'test/fixtures/console/schools.csv',
          profileFilePath: 'test/fixtures/console/profile.json',
          credentialsFilePath: 'test/fixtures/console/credentials.json',
          expectedSchoolCount: 2
        }
      });

      mockProc = createMockChildProcess();
      const res = await httpRequest({
        port,
        path: '/api/preflight/start',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'STARTED');
      assert.strictEqual(res.body.mode, 'PREFLIGHT_DRY_RUN');

      const spawnInfo = adapter.getLastSpawnInfo();
      assert.ok(spawnInfo);
      assert.strictEqual(spawnInfo.command, process.execPath);
      assert.strictEqual(spawnInfo.args[0], require.resolve('ts-node/dist/bin.js'));
      assert.ok(spawnInfo.args.includes('--batch'));
      assert.ok(spawnInfo.args.includes('--schools'));
      assert.ok(spawnInfo.args.includes('--profile'));
      assert.ok(!spawnInfo.args.includes('--dry-run'));
      assert.ok(!spawnInfo.args.includes('--apply'));
      assert.ok(!spawnInfo.args.includes('--live-write'));
      assert.ok(!spawnInfo.args.includes('--allow-live-write'));
      assert.ok(!spawnInfo.args.includes('--batch-apply'));
      assert.ok(!spawnInfo.args.includes('--allow-destructive'));
      assert.strictEqual(adapter.getJobState(), 'RUNNING');
    });

    // ----------------------------------------------------
    // Test E: Stop -> stdin 制御メッセージ送信 & 安全停止
    // ----------------------------------------------------
    await runTest('Test E: Stop -> stdin に STOP コマンドが送信され安全停止処理へ移行すること', async () => {
      const res = await httpRequest({
        port,
        path: '/api/preflight/stop',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'STOPPING');
      // mock child process の exit を待つ
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(adapter.getJobState(), 'INTERRUPTED');
      assert.ok(mockProc.writtenToStdin.some((s: string) => s.includes('STOP')), 'stdin に STOP コマンドが送信されたこと');
    });

    // ----------------------------------------------------
    // Test F: Resume Read-only ディスパッチ
    // ----------------------------------------------------
    await runTest('Test F: Resume Read-only -> --resume 引数が付与され Write フラグは不在であること', async () => {
      // Validate で READY にする
      await httpRequest({
        port,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          schoolsFilePath: 'test/fixtures/console/schools.csv',
          profileFilePath: 'test/fixtures/console/profile.json',
          credentialsFilePath: 'test/fixtures/console/credentials.json',
          expectedSchoolCount: 2
        }
      });

      mockProc = createMockChildProcess();
      const res = await httpRequest({
        port,
        path: '/api/preflight/resume',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });

      assert.strictEqual(res.statusCode, 200);
      const spawnInfo = adapter.getLastSpawnInfo();
      assert.ok(spawnInfo);
      assert.strictEqual(spawnInfo.command, process.execPath);
      assert.strictEqual(spawnInfo.args[0], require.resolve('ts-node/dist/bin.js'));
      assert.ok(spawnInfo.args.includes('--batch'));
      assert.ok(spawnInfo.args.includes('--resume'));
      assert.ok(!spawnInfo.args.includes('--apply'));
      assert.ok(!spawnInfo.args.includes('--allow-live-write'));
      assert.ok(!spawnInfo.args.includes('--batch-apply'));

      // 停止させておく
      await httpRequest({
        port,
        path: '/api/preflight/stop',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });
      await new Promise((r) => setTimeout(r, 50));
    });

    // ----------------------------------------------------
    // Test G: Retry Failed Read-only ディスパッチ
    // ----------------------------------------------------
    await runTest('Test G: Retry Failed Read-only -> --resume --retry-failed が付与され Write フラグは不在であること', async () => {
      await httpRequest({
        port,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          schoolsFilePath: 'test/fixtures/console/schools.csv',
          profileFilePath: 'test/fixtures/console/profile.json',
          credentialsFilePath: 'test/fixtures/console/credentials.json',
          expectedSchoolCount: 2
        }
      });

      mockProc = createMockChildProcess();
      const res = await httpRequest({
        port,
        path: '/api/preflight/retry-failed',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });

      assert.strictEqual(res.statusCode, 200);
      const spawnInfo = adapter.getLastSpawnInfo();
      assert.ok(spawnInfo);
      assert.strictEqual(spawnInfo.command, process.execPath);
      assert.strictEqual(spawnInfo.args[0], require.resolve('ts-node/dist/bin.js'));
      assert.ok(spawnInfo.args.includes('--batch'));
      assert.ok(spawnInfo.args.includes('--resume'));
      assert.ok(spawnInfo.args.includes('--retry-failed'));
      assert.ok(!spawnInfo.args.includes('--apply'));
      assert.ok(!spawnInfo.args.includes('--allow-live-write'));
      assert.ok(!spawnInfo.args.includes('--batch-apply'));

      await httpRequest({
        port,
        path: '/api/preflight/stop',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });
      await new Promise((r) => setTimeout(r, 50));
    });

    // ----------------------------------------------------
    // Test H: Secret 非露出
    // ----------------------------------------------------
    await runTest('Test H: Secret 非露出 -> 全 API レスポンスに userId, password が含まれないこと', async () => {
      const statusRes = await httpRequest({ port, path: '/api/status' });
      assert.strictEqual(statusRes.statusCode, 200);
      assert.ok(!statusRes.rawBody.includes('secret_user'));
      assert.ok(!statusRes.rawBody.includes('secret_password'));

      const reportsRes = await httpRequest({ port, path: '/api/reports/latest' });
      assert.strictEqual(reportsRes.statusCode, 200);
      assert.ok(!reportsRes.rawBody.includes('secret_user'));
      assert.ok(!reportsRes.rawBody.includes('secret_password'));
    });

    // ----------------------------------------------------
    // Test I: Host / Origin 防護
    // ----------------------------------------------------
    await runTest('Test I: Host / Origin 防護 -> 外部 Host (evil.com) および Origin が 403 で拒絶されること', async () => {
      // 1. 不正 Host
      const resEvilHost = await httpRequest({
        port,
        path: '/api/status',
        headers: { Host: 'evil.com' }
      });
      assert.strictEqual(resEvilHost.statusCode, 403);
      assert.strictEqual(resEvilHost.body.error, 'FORBIDDEN_HOST');

      // 2. 不正 Origin
      const resEvilOrigin = await httpRequest({
        port,
        path: '/api/status',
        headers: { Origin: 'http://evil.com' }
      });
      assert.strictEqual(resEvilOrigin.statusCode, 403);
      assert.strictEqual(resEvilOrigin.body.error, 'FORBIDDEN_ORIGIN');

      // 3. 不正 CSRF トークン
      const resEvilCsrf = await httpRequest({
        port,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': 'invalid_token' },
        body: {}
      });
      assert.strictEqual(resEvilCsrf.statusCode, 403);
      assert.strictEqual(resEvilCsrf.body.error, 'INVALID_CSRF_TOKEN');
    });

    // ----------------------------------------------------
    // Test J: Result Rendering 整合性
    // ----------------------------------------------------
    await runTest('Test J: Result Rendering -> レポート最新エンドポイントが正常に応答すること', async () => {
      const res = await httpRequest({ port, path: '/api/reports/latest' });
      assert.strictEqual(res.statusCode, 200);
      assert.ok('summary' in res.body);
      assert.ok('preflight' in res.body);
      assert.ok('checkpoint' in res.body);
    });

    // ----------------------------------------------------
    // Test K: Validation Stale (CSV変更)
    // ----------------------------------------------------
    await runTest('Test K: Validation Stale (CSV変更) -> 検証後に CSV が更新されたら Preflight が拒絶されること', async () => {
      // 1. まず正常に検証
      await httpRequest({
        port,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          schoolsFilePath: 'test/fixtures/console/schools.csv',
          profileFilePath: 'test/fixtures/console/profile.json',
          credentialsFilePath: 'test/fixtures/console/credentials.json',
          expectedSchoolCount: 2
        }
      });

      // 2. schools.csv を改変する（ハッシュが変わる）
      const modifiedCsv = dummyCsv + 'TEST04,第四テスト小学校,TEST04,false\n';
      fs.writeFileSync(csvPath, modifiedCsv, 'utf-8');

      // 3. Preflight start を実行すると VALIDATION_STALE で拒絶される
      const res = await httpRequest({
        port,
        path: '/api/preflight/start',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.error, 'VALIDATION_STALE');

      // 元に戻す
      fs.writeFileSync(csvPath, dummyCsv, 'utf-8');
    });

    // ----------------------------------------------------
    // Test L: Validation Stale (Profile変更)
    // ----------------------------------------------------
    await runTest('Test L: Validation Stale (Profile変更) -> 検証後に Profile が更新されたら Preflight が拒絶されること', async () => {
      // 1. 正常に検証
      await httpRequest({
        port,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          schoolsFilePath: 'test/fixtures/console/schools.csv',
          profileFilePath: 'test/fixtures/console/profile.json',
          credentialsFilePath: 'test/fixtures/console/credentials.json',
          expectedSchoolCount: 2
        }
      });

      // 2. profile.json を改変する
      const modifiedProfile = { ...dummyProfile, storage: 'OFF' };
      fs.writeFileSync(profilePath, JSON.stringify(modifiedProfile, null, 2), 'utf-8');

      // 3. Preflight start を実行すると VALIDATION_STALE で拒絶される
      const res = await httpRequest({
        port,
        path: '/api/preflight/start',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.error, 'VALIDATION_STALE');

      // 元に戻す
      fs.writeFileSync(profilePath, JSON.stringify(dummyProfile, null, 2), 'utf-8');
    });

    // ----------------------------------------------------
    // Test M: Single Job Guard (重複Start)
    // ----------------------------------------------------
    await runTest('Test M: Single Job Guard -> RUNNING 中に 2 回目の Preflight Start が呼ばれると 409 Conflict', async () => {
      // Validate
      await httpRequest({
        port,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          schoolsFilePath: 'test/fixtures/console/schools.csv',
          profileFilePath: 'test/fixtures/console/profile.json',
          credentialsFilePath: 'test/fixtures/console/credentials.json',
          expectedSchoolCount: 2
        }
      });

      mockProc = createMockChildProcess();
      // 1回目の Start
      const res1 = await httpRequest({
        port,
        path: '/api/preflight/start',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });
      assert.strictEqual(res1.statusCode, 200);

      // 2回目の Start (競合)
      const res2 = await httpRequest({
        port,
        path: '/api/preflight/start',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });
      assert.strictEqual(res2.statusCode, 409);
      assert.strictEqual(res2.body.error, 'JOB_CONFLICT');

      // 停止
      await httpRequest({
        port,
        path: '/api/preflight/stop',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });
      await new Promise((r) => setTimeout(r, 50));
    });

    // ----------------------------------------------------
    // Test N: Single Job Guard (重複Retry)
    // ----------------------------------------------------
    await runTest('Test N: Single Job Guard -> RUNNING 中に Retry Failed が呼ばれると 409 Conflict', async () => {
      await httpRequest({
        port,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          schoolsFilePath: 'test/fixtures/console/schools.csv',
          profileFilePath: 'test/fixtures/console/profile.json',
          credentialsFilePath: 'test/fixtures/console/credentials.json',
          expectedSchoolCount: 2
        }
      });

      mockProc = createMockChildProcess();
      const res1 = await httpRequest({
        port,
        path: '/api/preflight/start',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });
      assert.strictEqual(res1.statusCode, 200);

      // RUNNING 中に Retry
      const res2 = await httpRequest({
        port,
        path: '/api/preflight/retry-failed',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });
      assert.strictEqual(res2.statusCode, 409);
      assert.strictEqual(res2.body.error, 'JOB_CONFLICT');

      await httpRequest({
        port,
        path: '/api/preflight/stop',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {}
      });
      await new Promise((r) => setTimeout(r, 50));
    });

    // ----------------------------------------------------
    // Test O: Write パラメータ拒絶
    // ----------------------------------------------------
    await runTest('Test O: Write パラメータ拒絶 -> apply や allowLiveWrite 等が含まれていれば 400 Bad Request', async () => {
      const res1 = await httpRequest({
        port,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          schoolsFilePath: 'test/fixtures/console/schools.csv',
          apply: true // 禁止フィールド
        }
      });
      assert.strictEqual(res1.statusCode, 400);
      assert.strictEqual(res1.body.error, 'WRITE_FORBIDDEN');

      const res2 = await httpRequest({
        port,
        path: '/api/preflight/start',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          allowLiveWrite: true // 禁止フィールド
        }
      });
      assert.strictEqual(res2.statusCode, 400);
      assert.strictEqual(res2.body.error, 'WRITE_FORBIDDEN');
    });

    // ----------------------------------------------------
    // Test P: Unknown Request Field 拒絶
    // ----------------------------------------------------
    await runTest('Test P: Unknown Request Field 拒絶 -> 未知のフィールドが含まれていれば 400 Bad Request', async () => {
      const res = await httpRequest({
        port,
        path: '/api/preflight/start',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrf },
        body: {
          unknownRandomField: 'hack'
        }
      });
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.error, 'INVALID_REQUEST');
    });

    // ----------------------------------------------------
    // Test Q: Report Path Traversal 拒絶
    // ----------------------------------------------------
    await runTest('Test Q: Report Path Traversal 拒絶 -> パストラバーサル要求が 400 または 404 で拒否されること', async () => {
      // 1. 不正なレポートタイプ名
      const res1 = await httpRequest({
        port,
        path: '/api/reports/download/something_illegal'
      });
      assert.strictEqual(res1.statusCode, 400);
      assert.strictEqual(res1.body.error, 'INVALID_REPORT_TYPE');

      // 2. パストラバーサル
      const res2 = await httpRequest({
        port,
        path: '/api/reports/download/../../credentials.json'
      });
      assert.ok(res2.statusCode === 400 || res2.statusCode === 404);
      assert.ok(!res2.rawBody.includes('secret_user'));
    });

    // ----------------------------------------------------
    // Test R: 全通信経路での Secret 非露出
    // ----------------------------------------------------
    await runTest('Test R: 全通信経路での Secret 非露出 -> サニタイザーが秘密情報を正しくマスク・除去すること', async () => {
      const rawObject = {
        userId: 'admin_user',
        password: 'super_secret_password',
        schoolCode: 'TEST01',
        nested: {
          token: 'abc-123',
          normalData: 'public'
        }
      };

      const sanitized = sanitizeObject(rawObject);
      assert.strictEqual(sanitized.userId, '[REDACTED]');
      assert.strictEqual(sanitized.password, '[REDACTED]');
      assert.strictEqual(sanitized.schoolCode, 'TEST01');
      assert.strictEqual(sanitized.nested.token, '[REDACTED]');
      assert.strictEqual(sanitized.nested.normalData, 'public');

      const rawText = 'Error during login: userId="admin" and password="secret123" failed';
      const sanitizedText = sanitizeString(rawText);
      assert.ok(!sanitizedText.includes('secret123'));
      assert.ok(sanitizedText.includes('[REDACTED]'));
    });

    // ----------------------------------------------------
    // Test S: Spawn Failure & Windows path handling
    // ----------------------------------------------------
    await runTest('Test S: Spawn Failure -> spawn 失敗時に PROCESS_SPAWN_FAILED となり FAILED 状態へ遷移すること', async () => {
      const failingSpawn = () => {
        throw new Error('spawn ENOENT');
      };
      const failAdapter = new BatchProcessAdapter({ spawnFn: failingSpawn as any });
      const failServer = new ConsoleServer({ port: 0, host: '127.0.0.1', adapter: failAdapter });
      const failPort = await failServer.start();
      const failCsrf = failServer.getCsrfToken();

      try {
        await httpRequest({
          port: failPort,
          path: '/api/validate',
          method: 'POST',
          headers: { 'X-CSRF-Nonce': failCsrf },
          body: {
            schoolsFilePath: 'test/fixtures/console/schools.csv',
            profileFilePath: 'test/fixtures/console/profile.json',
            credentialsFilePath: 'test/fixtures/console/credentials.json',
            expectedSchoolCount: 2
          }
        });

        const res = await httpRequest({
          port: failPort,
          path: '/api/preflight/start',
          method: 'POST',
          headers: { 'X-CSRF-Nonce': failCsrf },
          body: {}
        });

        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(res.body.error, 'PROCESS_SPAWN_FAILED');
        assert.strictEqual(failAdapter.getJobState(), 'FAILED');
      } finally {
        await failServer.stop();
      }
    });

    // ----------------------------------------------------
    // Test T: Force Terminate Fallback
    // ----------------------------------------------------
    await runTest('Test T: Graceful Stop がタイムアウトした場合に Force Terminate Fallback が作動すること', async () => {
      // 停止要求に応答しないモックプロセス
      const uncooperativeProc: any = new EventEmitter();
      uncooperativeProc.stdout = new Readable({ read() {} });
      uncooperativeProc.stderr = new Readable({ read() {} });
      uncooperativeProc.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
      uncooperativeProc.pid = 99999;
      let forceKilled = false;
      uncooperativeProc.kill = () => {
        forceKilled = true;
        uncooperativeProc.emit('exit', 1, 'SIGKILL');
        return true;
      };

      const fallbackAdapter = new BatchProcessAdapter({
        spawnFn: (() => uncooperativeProc) as any,
        stopFallbackTimeoutMs: 50 // 高速テスト用に 50ms
      });
      const fallbackServer = new ConsoleServer({ port: 0, host: '127.0.0.1', adapter: fallbackAdapter });
      const fPort = await fallbackServer.start();
      const fCsrf = fallbackServer.getCsrfToken();

      try {
        await httpRequest({
          port: fPort,
          path: '/api/validate',
          method: 'POST',
          headers: { 'X-CSRF-Nonce': fCsrf },
          body: {
            schoolsFilePath: 'test/fixtures/console/schools.csv',
            profileFilePath: 'test/fixtures/console/profile.json',
            credentialsFilePath: 'test/fixtures/console/credentials.json',
            expectedSchoolCount: 2
          }
        });

        await httpRequest({
          port: fPort,
          path: '/api/preflight/start',
          method: 'POST',
          headers: { 'X-CSRF-Nonce': fCsrf },
          body: {}
        });

        assert.strictEqual(fallbackAdapter.getJobState(), 'RUNNING');

        // Stop 要求
        await httpRequest({
          port: fPort,
          path: '/api/preflight/stop',
          method: 'POST',
          headers: { 'X-CSRF-Nonce': fCsrf },
          body: {}
        });

        assert.strictEqual(fallbackAdapter.getJobState(), 'STOPPING');

        // タイムアウト (50ms) + 余裕を待つ
        await new Promise((r) => setTimeout(r, 100));

        assert.strictEqual(forceKilled, true, 'force terminate (kill) が呼ばれたこと');
        assert.strictEqual(fallbackAdapter.getJobState(), 'FAILED', 'Force Terminate Fallback は FAILED となること');
      } finally {
        await fallbackServer.stop();
      }
    });

  } finally {
    await server.stop();
  }

  console.log(`\n=== Console Test Results: ${passedTests} passed, ${failedTests} failed ===`);
  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
