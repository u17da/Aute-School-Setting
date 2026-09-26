import assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { SETTING_DEFINITIONS, ALL_SETTING_KEYS } from '../src/settings/definitions';
import { SettingKey, SettingValue } from '../src/types/settings';
import { generateBaselineHash, generateApplyTargetHash, generateSchoolsHash, generateSettingsHash } from '../src/utils/hash';
import { validateGlobalGateAndBuildManifest } from '../src/console/manifest';
import { PreflightReport, BatchSchoolItem } from '../src/types/batch';

console.log('=== Phase 5B.4: Mock Write E2E & Localhost Verification ===\n');

let passedTests = 0;
let failedTests = 0;

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passedTests++;
  } catch (err: any) {
    console.error(`[FAIL] ${name}:`, err.message || err);
    if (err.stack) {
      console.error(err.stack);
    }
    failedTests++;
  }
}

/**
 * 非同期子プロセス実行 (イベントループをブロックせずMockServerのHTTP処理を維持)
 */
async function execChildProcess(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cp = spawn(
      process.execPath,
      [require.resolve('ts-node/dist/bin.js'), ...args],
      { env, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    cp.stdout?.on('data', (d) => (stdout += d.toString('utf-8')));
    cp.stderr?.on('data', (d) => (stderr += d.toString('utf-8')));
    cp.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

// =============================================================================
// 要件1: 物理的 Live 隔離 (Physical Live Isolation Interceptor)
// =============================================================================
const nodeHttp = require('http');
const blockedExternalRequests: string[] = [];
const originalHttpRequest = nodeHttp.request;

// プロセスレベルで localhost / 127.0.0.1 以外の外部通信（ed-cl.com 等）を物理遮断
nodeHttp.request = function (options: any, ...args: any[]) {
  const host = typeof options === 'string'
    ? new URL(options).hostname
    : (options?.hostname || options?.host || '');
  if (host && !host.includes('127.0.0.1') && !host.includes('localhost')) {
    const errorMsg = `PHYSICAL_LIVE_ISOLATION_VIOLATION: ed-cl.com or external host access attempted: ${host}`;
    blockedExternalRequests.push(host);
    throw new Error(errorMsg);
  }
  return originalHttpRequest.apply(this, [options, ...args]);
};

// =============================================================================
// ローカル Mock サーバー実装 (127.0.0.1 固定)
// =============================================================================
interface MockSchoolState {
  schoolCode: string;
  schoolName: string;
  settings: Record<SettingKey, SettingValue>;
}

class LocalMockServer {
  private server: http.Server | null = null;
  public port = 0;
  public schoolStates: Map<string, MockSchoolState> = new Map();
  public savePostCounts: Record<string, number> = {};
  public receivedRequests: Array<{ method: string; url: string; host: string }> = [];
  public failureMode: 'NONE' | 'RELOAD_FAIL' | 'SAVE_POST_DROP' = 'NONE';
  public failureSchoolCode = '';

  resetMetrics() {
    this.savePostCounts = {};
    this.receivedRequests = [];
    this.failureMode = 'NONE';
    this.failureSchoolCode = '';
  }

  setSchoolState(schoolCode: string, schoolName: string, settings: Partial<Record<SettingKey, SettingValue>>) {
    const fullSettings: Record<SettingKey, SettingValue> = {
      storage: 'ON',
      timelineChannel: 'ON',
      directMessage: 'STUDENT_TO_STUDENT_DISABLED',
      parentDirectMessage: 'ON',
      allChannel: 'ON',
      parentChannel: 'ON',
      attendance: 'ON',
      contactBook: 'ON',
      mentalHealth: 'OFF',
      otherSchoolLog: 'ALLOW',
      studentPasswordChange: 'HIDE',
      ...settings
    };
    this.schoolStates.set(schoolCode, { schoolCode, schoolName, settings: fullSettings });
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const host = req.headers.host || '';
        this.receivedRequests.push({ method: req.method || 'GET', url: req.url || '/', host });

        // 要件1: 外部hostへの通信が届いた場合は即時500かつ記録
        if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost')) {
          blockedExternalRequests.push(host);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('PHYSICAL_LIVE_ISOLATION_VIOLATION');
          return;
        }

        // Cookieから現在の学校コードを取得
        const cookieHeader = req.headers.cookie || '';
        const match = cookieHeader.match(/mock_school=([^;]+)/);
        const currentSchoolCode = match ? match[1] : 'SCH_OK';

        const url = req.url || '/';

        // 1. ログイン画面 (学校コード入力)
        if (url === '/' || url === '/login') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"><title>まなびポケット ログイン</title></head>
            <body>
              <form method="POST" action="/login/school">
                <input name="schoolCode" placeholder="学校コード" />
                <button type="submit">次へ</button>
              </form>
            </body>
            </html>
          `);
          return;
        }

        // 2. 学校コード送信
        if (url === '/login/school' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const params = new URLSearchParams(body);
            const sc = params.get('schoolCode') || currentSchoolCode;
            res.writeHead(302, {
              Location: '/login/password',
              'Set-Cookie': `mock_school=${sc}; Path=/; HttpOnly`
            });
            res.end();
          });
          return;
        }

        // 3. パスワードログイン画面
        if (url === '/login/password') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"><title>ログイン パスワード</title></head>
            <body>
              <form method="POST" action="/login/auth">
                <input name="userId" placeholder="ユーザーID" />
                <input type="password" name="password" placeholder="パスワード" />
                <button type="submit">ログイン</button>
              </form>
            </body>
            </html>
          `);
          return;
        }

        // 4. 認証実行 -> ホーム画面へ
        if (url === '/login/auth' && req.method === 'POST') {
          res.writeHead(302, { Location: '/home' });
          res.end();
          return;
        }

        // 5. ホーム画面
        if (url === '/home') {
          const state = this.schoolStates.get(currentSchoolCode);
          const schoolName = state?.schoolName || 'モックテスト小学校';
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"><title>ホーム画面</title></head>
            <body>
              <header>
                <div class="v2-nav-menu-header__label">${schoolName}</div>
              </header>
              <div class="v2-sidebar-current-account">
                <a href="/organization">学校設定</a>
              </div>
            </body>
            </html>
          `);
          return;
        }

        // 6. 学校設定画面 (GET)
        if (url === '/organization' && req.method === 'GET') {
          // 要件3: 故障注入 (RELOAD_FAIL)
          if (this.failureMode === 'RELOAD_FAIL' && currentSchoolCode === this.failureSchoolCode) {
            // Save POST後の reload 時に 502 / 切断を返す
            if ((this.savePostCounts[currentSchoolCode] || 0) > 0) {
              res.writeHead(502, { 'Content-Type': 'text/plain' });
              res.end('Bad Gateway (Injected Failure)');
              return;
            }
          }

          const state = this.schoolStates.get(currentSchoolCode);
          const settings = state?.settings || ({} as any);

          // 全11項目の設定行を生成
          let rowsHtml = '';
          for (const key of ALL_SETTING_KEYS) {
            const def = SETTING_DEFINITIONS[key];
            const currentVal = settings[key] || def.defaultValue;

            let radiosHtml = '';
            for (const opt of def.options) {
              const isChecked = opt.value === currentVal;
              radiosHtml += `
                <input type="radio" id="${key}_${opt.value}" name="${key}" value="${opt.value}" ${isChecked ? 'checked' : ''} />
                <label for="${key}_${opt.value}">${opt.label}</label>
              `;
            }

            rowsHtml += `
              <div class="setting-row">
                <span class="label">${def.label}</span>
                <div class="options">
                  ${radiosHtml}
                </div>
              </div>
            `;
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"><title>学校設定</title></head>
            <body>
              <header>
                <h1 class="v2-header__title">学校設定</h1>
              </header>
              <form method="POST" action="/organization/save">
                ${rowsHtml}
                <div class="submit-area">
                  <input type="submit" name="commit" value="更新する" />
                </div>
              </form>
            </body>
            </html>
          `);
          return;
        }

        // 7. 学校設定保存 (POST)
        if (url === '/organization/save' && req.method === 'POST') {
          this.savePostCounts[currentSchoolCode] = (this.savePostCounts[currentSchoolCode] || 0) + 1;

          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const params = new URLSearchParams(body);
            const state = this.schoolStates.get(currentSchoolCode);
            if (state) {
              for (const key of ALL_SETTING_KEYS) {
                const val = params.get(key);
                if (val) {
                  state.settings[key] = val as SettingValue;
                }
              }
            }

            res.writeHead(302, { Location: '/organization' });
            res.end();
          });
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address() as any;
        this.port = addr.port;
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// =============================================================================
// テストスイート実行
// =============================================================================
async function main() {
  const mockServer = new LocalMockServer();
  const mockPort = await mockServer.start();
  const mockBaseUrl = `http://127.0.0.1:${mockPort}`;
  console.log(`[MockServer] Started on ${mockBaseUrl}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manapoke-test-5b4-'));

  try {
    // -------------------------------------------------------------------------
    // Test 1: 物理的 Live 隔離の検証 (Physical Live Isolation Verification)
    // -------------------------------------------------------------------------
    await runTest('Test 1: 物理的 Live 隔離 (127.0.0.1 固定 & 外部通信物理遮断)', async () => {
      // 1. baseUrl が 127.0.0.1 であることを確認
      assert.strictEqual(mockBaseUrl.startsWith('http://127.0.0.1:'), true);

      // 2. 外部ホスト (ed-cl.com) へのリクエストが物理的に遮断され例外となることを実証
      let blockedThrown = false;
      try {
        await new Promise((resolve, reject) => {
          const req = http.request('http://ed-cl.com/test', (res) => {
            resolve(res);
          });
          req.on('error', reject);
          req.end();
        });
      } catch (err: any) {
        if (err.message.includes('PHYSICAL_LIVE_ISOLATION_VIOLATION')) {
          blockedThrown = true;
        }
      }
      assert.strictEqual(blockedThrown, true, 'ed-cl.com への外部リクエストがインターセプターにより物理遮断されること');
      assert.strictEqual(blockedExternalRequests.includes('ed-cl.com'), true);

      // 3. Mock Server 側での 127.0.0.1 以外の Host ヘッダー拒絶の確認
      const res = await new Promise<http.IncomingMessage>((resolve) => {
        const req = (originalHttpRequest as any)(
          {
            hostname: '127.0.0.1',
            port: mockPort,
            path: '/',
            method: 'GET',
            headers: { Host: 'ed-cl.com' }
          },
          resolve
        );
        req.end();
      });
      assert.strictEqual(res.statusCode, 500, '外部 Host ヘッダーを含むリクエストは 500 で拒否されること');
    });

    // -------------------------------------------------------------------------
    // Test 2: Apply Target Manifest による実 Child Process 制約 E2E
    // -------------------------------------------------------------------------
    await runTest('Test 2: Apply Target Manifest による実 Child Process 制約 E2E', async () => {
      mockServer.resetMetrics();

      // 4校の設定を用意 (timelineChannel: ON のもとで allChannel: OFF を破壊的変更テストに使用)
      // SCH_OK: 適用対象 (Preflight: storage OFF -> ON, 非破壊, allChannelは最初からOFFで一致)
      mockServer.setSchoolState('SCH_OK', '適用対象小学校', {
        storage: 'OFF',
        allChannel: 'OFF'
      });

      // SCH_DESTRUCTIVE: 破壊的変更校 (Preflight: allChannel ON -> OFF, 破壊的変更)
      mockServer.setSchoolState('SCH_DESTRUCTIVE', '破壊的変更小学校', {
        storage: 'ON',
        allChannel: 'ON'
      });

      // SCH_ALREADY: 変更不要校 (Preflight: すでに期待値と完全一致: storage ON, allChannel OFF)
      mockServer.setSchoolState('SCH_ALREADY', '変更不要小学校', {
        storage: 'ON',
        allChannel: 'OFF'
      });

      // SCH_CHANGED: Baseline不一致校 (Preflight時: storage OFF, allChannel OFF, 後で設定変更)
      mockServer.setSchoolState('SCH_CHANGED', '設定変更検知小学校', {
        storage: 'OFF',
        allChannel: 'OFF'
      });

      // プロファイル: storage=ON, allChannel=OFF (破壊的変更対象), timelineChannel=ON (親設定ONで依存関係充足)
      const profileData = {
        storage: 'ON',
        timelineChannel: 'ON',
        allChannel: 'OFF',
        parentChannel: 'ON',
        directMessage: 'STUDENT_TO_STUDENT_DISABLED',
        parentDirectMessage: 'ON',
        attendance: 'ON',
        contactBook: 'ON',
        mentalHealth: 'OFF',
        otherSchoolLog: 'ALLOW',
        studentPasswordChange: 'HIDE'
      };
      const profilePath = path.join(tempDir, 'profile-test.json');
      fs.writeFileSync(profilePath, JSON.stringify(profileData, null, 2), 'utf-8');

      // CSVファイル作成
      const schoolsCsvPath = path.join(tempDir, 'schools-test.csv');
      const csvContent = [
        'schoolCode,schoolName,userId,password,enabled',
        'SCH_OK,適用対象小学校,user1,pass1,true',
        'SCH_DESTRUCTIVE,破壊的変更小学校,user2,pass2,true',
        'SCH_ALREADY,変更不要小学校,user3,pass3,true',
        'SCH_CHANGED,設定変更検知小学校,user4,pass4,true'
      ].join('\n');
      fs.writeFileSync(schoolsCsvPath, csvContent, 'utf-8');

      // 1. Preflight (Read-only) を子プロセスで実行
      console.log('  [Step 1] Preflight (Read-only) 子プロセスを実行中...');
      const preflightEnv = {
        ...process.env,
        MANAPOKE_BASE_URL: mockBaseUrl,
        MANAPOKE_PASSWORD: 'test_password'
      };

      const pfResult = await execChildProcess(
        [
          '-T',
          'src/index.ts',
          '--batch',
          '--schools', schoolsCsvPath,
          '--profile', profilePath
        ],
        preflightEnv
      );

      assert.strictEqual(pfResult.code, 0, `Preflight child process failed: ${pfResult.stderr || pfResult.stdout}`);

      // 生成された最新 Preflight レポートを取得
      const reportsDir = path.resolve(process.cwd(), 'reports');
      const pfFiles = fs.readdirSync(reportsDir).filter((f) => f.startsWith('preflight-') && f.endsWith('.json'));
      pfFiles.sort((a, b) => fs.statSync(path.join(reportsDir, b)).mtimeMs - fs.statSync(path.join(reportsDir, a)).mtimeMs);
      const latestPfFile = path.join(reportsDir, pfFiles[0]);
      const pfReport: PreflightReport = JSON.parse(fs.readFileSync(latestPfFile, 'utf-8'));

      // Preflight 判定の検証
      const pfOk = pfReport.schools.find((s) => s.schoolCode === 'SCH_OK');
      const pfDestructive = pfReport.schools.find((s) => s.schoolCode === 'SCH_DESTRUCTIVE');
      const pfAlready = pfReport.schools.find((s) => s.schoolCode === 'SCH_ALREADY');
      const pfChanged = pfReport.schools.find((s) => s.schoolCode === 'SCH_CHANGED');

      assert.strictEqual(pfOk?.writeEligible, true);
      assert.strictEqual(pfOk?.hasDestructiveChanges, false);
      assert.strictEqual(pfDestructive?.hasDestructiveChanges, true);
      assert.strictEqual(pfAlready?.actionsCount, 0);
      assert.strictEqual(pfChanged?.writeEligible, true);

      // Preflight時点では Save POST は 0回 (Read-only)
      assert.strictEqual(Object.keys(mockServer.savePostCounts).length, 0, 'Preflight 中に Save POST が発生していないこと');

      // 2. Preflight後に SCH_CHANGED の設定値を勝手に書き換える (Baseline State Change 模擬)
      console.log('  [Step 2] SCH_CHANGED の画面設定をPreflight後に変更 (Baseline State Change 模擬)...');
      mockServer.setSchoolState('SCH_CHANGED', '設定変更検知小学校', {
        storage: 'OFF',
        timelineChannel: 'ON',
        allChannel: 'OFF',
        attendance: 'OFF' // Preflight時(ON)と異なる設定値へ変更
      });

      // 3. Production Apply を実 Child Process で実行 (--apply --allow-live-write --batch-apply)
      console.log('  [Step 3] Production Apply 子プロセスを実行中 (--apply --allow-live-write --batch-apply)...');
      mockServer.resetMetrics();

      const applyEnv = {
        ...process.env,
        MANAPOKE_BASE_URL: mockBaseUrl,
        MANAPOKE_PASSWORD: 'test_password'
      };

      const applyResult = await execChildProcess(
        [
          '-T',
          'src/index.ts',
          '--batch',
          '--apply',
          '--allow-live-write',
          '--batch-apply',
          '--schools', schoolsCsvPath,
          '--profile', profilePath,
          '--preflight-report', latestPfFile
        ],
        applyEnv
      );

      // 4. 最新 Checkpoint を読み取って検証
      const checkpointsDir = path.resolve(process.cwd(), 'checkpoints');
      const cpFiles = fs.readdirSync(checkpointsDir).filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'));
      cpFiles.sort((a, b) => fs.statSync(path.join(checkpointsDir, b)).mtimeMs - fs.statSync(path.join(checkpointsDir, a)).mtimeMs);
      const latestCp = JSON.parse(fs.readFileSync(path.join(checkpointsDir, cpFiles[0]), 'utf-8'));

      // 4校のステータス検証
      const cpOk = latestCp.entries['SCH_OK'];
      const cpDestructive = latestCp.entries['SCH_DESTRUCTIVE'];
      const cpAlready = latestCp.entries['SCH_ALREADY'];
      const cpChanged = latestCp.entries['SCH_CHANGED'];

      console.log('  [Status Results]:');
      console.log(`    SCH_OK: status=${cpOk?.status}`);
      console.log(`    SCH_DESTRUCTIVE: status=${cpDestructive?.status}`);
      console.log(`    SCH_ALREADY: status=${cpAlready?.status}`);
      console.log(`    SCH_CHANGED: status=${cpChanged?.status}`);

      assert.strictEqual(cpOk?.status, 'SUCCESS', '適用対象校は SUCCESS となること');
      assert.strictEqual(cpDestructive?.status, 'SKIPPED_DESTRUCTIVE', '破壊的変更校は SKIPPED_DESTRUCTIVE となること');
      assert.strictEqual(cpAlready?.status, 'SUCCESS_ALREADY_CONFIGURED', '変更不要校は SUCCESS_ALREADY_CONFIGURED となること');
      assert.strictEqual(cpChanged?.status, 'PREFLIGHT_STATE_CHANGED', 'Baseline不一致校は PREFLIGHT_STATE_CHANGED となること');

      // 5. Mock Server 側での Save POST 発生件数の検証
      console.log('  [Save POST Counts]:', mockServer.savePostCounts);
      assert.strictEqual(mockServer.savePostCounts['SCH_OK'], 1, '適用対象校のみ Save POST が 1 回発生すること');
      assert.strictEqual(mockServer.savePostCounts['SCH_DESTRUCTIVE'] || 0, 0, '破壊的変更校の Save POST は 0 回であること');
      assert.strictEqual(mockServer.savePostCounts['SCH_ALREADY'] || 0, 0, '変更不要校の Save POST は 0 回であること');
      assert.strictEqual(mockServer.savePostCounts['SCH_CHANGED'] || 0, 0, 'Baseline不一致校の Save POST は 0 回であること');

      // 6. Save POST が発生した学校集合と Manifest の適用対象集合が完全一致することの検証
      const savedSchoolCodes = Object.keys(mockServer.savePostCounts).filter((k) => mockServer.savePostCounts[k] > 0);
      assert.deepStrictEqual(savedSchoolCodes, ['SCH_OK'], 'Save POST が到達した学校集合は SCH_OK のみであること');
    });

    // -------------------------------------------------------------------------
    // Test 3: SAVE_OUTCOME_UNKNOWN 故障注入 & Circuit Breaker 即停止 E2E
    // -------------------------------------------------------------------------
    await runTest('Test 3: SAVE_OUTCOME_UNKNOWN 故障注入 & Circuit Breaker 即停止 E2E', async () => {
      mockServer.resetMetrics();

      // 2校の設定を用意 (非破壊変更: storage OFF -> ON, timelineChannel: ON で依存関係充足)
      // 1校目: SCH_FAIL_UNKNOWN (Save POST 受信後の reload で 502 を注入)
      mockServer.setSchoolState('SCH_FAIL_UNKNOWN', '故障注入小学校', {
        storage: 'OFF',
        timelineChannel: 'ON'
      });

      // 2校目: SCH_NEXT (次校: Circuit Breaker により物理的に実行されないこと)
      mockServer.setSchoolState('SCH_NEXT', '次校小学校', {
        storage: 'OFF',
        timelineChannel: 'ON'
      });

      mockServer.failureMode = 'RELOAD_FAIL';
      mockServer.failureSchoolCode = 'SCH_FAIL_UNKNOWN';

      const profileData = {
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
      const profilePath = path.join(tempDir, 'profile-fail.json');
      fs.writeFileSync(profilePath, JSON.stringify(profileData, null, 2), 'utf-8');

      const schoolsCsvPath = path.join(tempDir, 'schools-fail.csv');
      const csvContent = [
        'schoolCode,schoolName,userId,password,enabled',
        'SCH_FAIL_UNKNOWN,故障注入小学校,user1,pass1,true',
        'SCH_NEXT,次校小学校,user2,pass2,true'
      ].join('\n');
      fs.writeFileSync(schoolsCsvPath, csvContent, 'utf-8');

      // Preflight 実行
      console.log('  [Step 1] Preflight 実行中 (2校)...');
      const preflightEnv = {
        ...process.env,
        MANAPOKE_BASE_URL: mockBaseUrl,
        MANAPOKE_PASSWORD: 'test_password'
      };
      const pfResult = await execChildProcess(
        [
          '-T',
          'src/index.ts',
          '--batch',
          '--schools', schoolsCsvPath,
          '--profile', profilePath
        ],
        preflightEnv
      );
      assert.strictEqual(pfResult.code, 0);

      const reportsDir = path.resolve(process.cwd(), 'reports');
      const pfFiles = fs.readdirSync(reportsDir).filter((f) => f.startsWith('preflight-') && f.endsWith('.json'));
      pfFiles.sort((a, b) => fs.statSync(path.join(reportsDir, b)).mtimeMs - fs.statSync(path.join(reportsDir, a)).mtimeMs);
      const latestPfFile = path.join(reportsDir, pfFiles[0]);

      // Production Apply 実行 (故障注入発動)
      console.log('  [Step 2] Production Apply 実行中 (故障注入: reload 502)...');
      mockServer.resetMetrics();
      mockServer.failureMode = 'RELOAD_FAIL';
      mockServer.failureSchoolCode = 'SCH_FAIL_UNKNOWN';

      const applyEnv = {
        ...process.env,
        MANAPOKE_BASE_URL: mockBaseUrl,
        MANAPOKE_PASSWORD: 'test_password'
      };

      const applyResult = await execChildProcess(
        [
          '-T',
          'src/index.ts',
          '--batch',
          '--apply',
          '--allow-live-write',
          '--batch-apply',
          '--schools', schoolsCsvPath,
          '--profile', profilePath,
          '--preflight-report', latestPfFile
        ],
        applyEnv
      );

      // Checkpoint を確認
      const checkpointsDir = path.resolve(process.cwd(), 'checkpoints');
      const cpFiles = fs.readdirSync(checkpointsDir).filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'));
      cpFiles.sort((a, b) => fs.statSync(path.join(checkpointsDir, b)).mtimeMs - fs.statSync(path.join(checkpointsDir, a)).mtimeMs);
      const latestCp = JSON.parse(fs.readFileSync(path.join(checkpointsDir, cpFiles[0]), 'utf-8'));

      const cpFail = latestCp.entries['SCH_FAIL_UNKNOWN'];
      const cpNext = latestCp.entries['SCH_NEXT'];

      console.log('  [Failure Test Results]:');
      console.log(`    SCH_FAIL_UNKNOWN: status=${cpFail?.status}`);
      console.log(`    SCH_NEXT: status=${cpNext?.status || 'NOT_STARTED'}`);

      // 1. 当該校が SAVE_OUTCOME_UNKNOWN に分類されること
      assert.strictEqual(cpFail?.status, 'SAVE_OUTCOME_UNKNOWN', '故障校は SAVE_OUTCOME_UNKNOWN となること');

      // 2. 次校の実行が物理的に行われず即座に停止すること (Circuit Breaker)
      assert.strictEqual(cpNext?.status === 'PENDING' || cpNext === undefined, true, '次校 SCH_NEXT は実行されず PENDING のままであること');
      assert.strictEqual(mockServer.savePostCounts['SCH_NEXT'] || 0, 0, '次校への Save POST は 0 回であること');

      // 3. 自動リトライされないこと (Save 再クリック = 0)
      assert.strictEqual(mockServer.savePostCounts['SCH_FAIL_UNKNOWN'], 1, 'Save POST は 1 回のみ送信され、自動再試行されないこと');

      // 4. 再開 (--resume) 実行時に SAVE_OUTCOME_UNKNOWN がスキップ保護されること
      console.log('  [Step 3] Resume 実行によるスキップ保護検証 (--resume)...');
      mockServer.resetMetrics();

      const resumeResult = await execChildProcess(
        [
          '-T',
          'src/index.ts',
          '--batch',
          '--apply',
          '--allow-live-write',
          '--batch-apply',
          '--schools', schoolsCsvPath,
          '--profile', profilePath,
          '--preflight-report', latestPfFile,
          '--resume'
        ],
        applyEnv
      );

      // Resume 実行中にも SCH_FAIL_UNKNOWN への Save POST は発生しない
      assert.strictEqual(mockServer.savePostCounts['SCH_FAIL_UNKNOWN'] || 0, 0, 'Resume 時に SAVE_OUTCOME_UNKNOWN の学校は自動再実行されずスキップされること');
    });

  } finally {
    await mockServer.stop();
    // 一時ディレクトリ削除
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\nPhase 5B.4 Test Results: ${passedTests} passed, ${failedTests} failed\n`);
  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error in test execution:', err);
  process.exit(1);
});
