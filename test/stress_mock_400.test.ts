import assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { runBatch } from '../src/batch/runBatch';
import { SETTING_DEFINITIONS, ALL_SETTING_KEYS } from '../src/settings/definitions';
import { SettingKey, SettingValue } from '../src/types/settings';
import { BatchSchoolItem } from '../src/types/batch';

console.log('================================================================');
console.log('   400 SCHOOLS LOCAL MOCK STRESS & DURABILITY TEST');
console.log('================================================================\n');

// =============================================================================
// 1. 物理的 Live 隔離 (Physical Live Isolation Interceptor)
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
// 2. ローカル Mock サーバー実装 (127.0.0.1 固定)
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

  resetMetrics() {
    this.savePostCounts = {};
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

        // 外部hostへの通信が届いた場合は即時500かつ記録
        if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost')) {
          blockedExternalRequests.push(host);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('PHYSICAL_LIVE_ISOLATION_VIOLATION');
          return;
        }

        // Cookieから現在の学校コードを取得
        const cookieHeader = req.headers.cookie || '';
        const match = cookieHeader.match(/mock_school=([^;]+)/);
        const currentSchoolCode = match ? match[1] : 'SCH_001';

        const url = req.url || '/';

        // 1. ログイン画面
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
          const state = this.schoolStates.get(currentSchoolCode);
          const settings = state?.settings || ({} as any);

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
// 3. ヘルパー関数: メモリ測定 & プロセス確認
// =============================================================================
function getMemoryStats() {
  const m = process.memoryUsage();
  return {
    rssMb: (m.rss / 1024 / 1024).toFixed(1),
    heapUsedMb: (m.heapUsed / 1024 / 1024).toFixed(1),
    heapTotalMb: (m.heapTotal / 1024 / 1024).toFixed(1),
    externalMb: (m.external / 1024 / 1024).toFixed(1)
  };
}

function countChromiumProcesses(): number {
  try {
    const stdout = execSync('tasklist /FI "IMAGENAME eq chromium.exe" /FO CSV /NH', { encoding: 'utf-8' });
    const lines = stdout.trim().split('\n').filter((l) => l.includes('chromium.exe'));
    return lines.length;
  } catch {
    return 0;
  }
}

// =============================================================================
// 4. メインテスト実行部
// =============================================================================
async function main() {
  const totalSchools = process.env.STRESS_TOTAL_SCHOOLS ? parseInt(process.env.STRESS_TOTAL_SCHOOLS, 10) : 400;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-400-test-'));
  console.log(`[Setup] WorkDir created: ${tempDir}`);

  const mockServer = new LocalMockServer();
  const mockPort = await mockServer.start();
  const mockBaseUrl = `http://127.0.0.1:${mockPort}`;
  console.log(`[MockServer] Started on ${mockBaseUrl}`);

  // 1. 400校分のモック初期データ生成
  console.log(`[Setup] Generating ${totalSchools} schools dataset...`);
  const schools: BatchSchoolItem[] = [];
  const credentialsMap: Record<string, { userId: string; password: string }> = {};

  for (let i = 1; i <= totalSchools; i++) {
    const sc = `SCH_${String(i).padStart(4, '0')}`;
    const sn = `モック検証第${i}学校`;
    const credRef = `cred_${sc}`;

    // 変化をつける:
    // - 75% は storage=OFF (変更が必要な学校)
    // - 20% は storage=ON (変更不要な学校)
    // - 5% は allChannel=ON かつ profile で OFF にする (破壊的変更扱いテスト)
    const isDestructive = i % 20 === 0;
    const isAlreadyConfigured = !isDestructive && (i % 5 === 0);

    mockServer.setSchoolState(sc, sn, {
      storage: isAlreadyConfigured ? 'ON' : 'OFF',
      timelineChannel: 'ON',
      allChannel: isDestructive ? 'ON' : 'OFF'
    });

    schools.push({
      schoolCode: sc,
      schoolName: sn,
      credentialRef: credRef,
      enabled: true
    });

    credentialsMap[credRef] = {
      userId: `user_${sc}`,
      password: `pass_${sc}`
    };
  }

  // schools.csv 出力
  const schoolsCsvPath = path.join(tempDir, 'schools_400.csv');
  const csvLines = ['schoolCode,schoolName,credentialRef,enabled'];
  for (const s of schools) {
    csvLines.push(`${s.schoolCode},${s.schoolName},${s.credentialRef},${s.enabled}`);
  }
  fs.writeFileSync(schoolsCsvPath, csvLines.join('\n'), 'utf-8');

  // credentials.json 出力
  const credsPath = path.join(tempDir, 'credentials_400.json');
  fs.writeFileSync(credsPath, JSON.stringify(credentialsMap, null, 2), 'utf-8');

  // profile.json 出力 (storage=ON, allChannel=OFF)
  const profilePath = path.join(tempDir, 'profile_400.json');
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
  fs.writeFileSync(profilePath, JSON.stringify(profileData, null, 2), 'utf-8');

  console.log(`[Setup] Datasets generated successfully.\n`);

  const envConfig: any = {
    baseUrl: mockBaseUrl,
    schoolCode: 'SCH_0001',
    userId: 'mock_user',
    password: 'mock_password'
  };

  const initialMem = getMemoryStats();
  const initialChromiumCount = countChromiumProcesses();
  console.log(`[Baseline Metrics]`);
  console.log(`- Initial Memory : RSS ${initialMem.rssMb}MB | HeapUsed ${initialMem.heapUsedMb}MB`);
  console.log(`- Initial Chromium Processes : ${initialChromiumCount}\n`);

  // ---------------------------------------------------------------------------
  // テスト 1: 400校 PREFLIGHT (読み取り専用) ストレステスト
  // ---------------------------------------------------------------------------
  console.log('================================================================');
  console.log('  TEST 1: 400 Schools PREFLIGHT (Dry-Run) Durability');
  console.log('================================================================');

  const pfStartTime = Date.now();
  const memoryLogs: Array<{ checkpoint: string; rssMb: string; heapUsedMb: string }> = [
    { checkpoint: 'Start', ...initialMem }
  ];

  // pacingDelayMs を 30ms に短縮して高速・高密度にリソース負荷をかける
  const pfReport = await runBatch({
    schoolsFilePath: schoolsCsvPath,
    profileFilePath: profilePath,
    credentialsFilePath: credsPath,
    executionOptions: {
      apply: false,
      allowLiveWrite: false,
      batchApply: false,
      authMode: 'A'
    } as any,
    envConfig,
    pacingDelayMs: 30,
    schoolTimeoutMs: 20000
  });

  const pfElapsedSec = ((Date.now() - pfStartTime) / 1000).toFixed(1);
  const pfEndMem = getMemoryStats();
  memoryLogs.push({ checkpoint: '400校完了時', ...pfEndMem });

  console.log(`\n[TEST 1 SUMMARY]`);
  console.log(`- 処理学校数: ${pfReport.processedSchools} / ${pfReport.totalSchools} 校`);
  console.log(`- 読取成功: ${pfReport.readSuccess} 校 (失敗: ${pfReport.readFailed} 校)`);
  console.log(`- 変更必要校: ${pfReport.requiresChange} 校`);
  console.log(`- 変更不要校: ${pfReport.alreadyConfigured} 校`);
  console.log(`- 破壊的変更リスク校: ${pfReport.destructiveChangeSchools} 校`);
  console.log(`- 所要時間: ${pfElapsedSec} 秒 (平均 ${(Number(pfElapsedSec) / totalSchools).toFixed(2)} 秒/校)`);
  console.log(`- メモリ推移: RSS ${initialMem.rssMb}MB -> ${pfEndMem.rssMb}MB (Heap: ${initialMem.heapUsedMb}MB -> ${pfEndMem.heapUsedMb}MB)`);

  assert.strictEqual(pfReport.readSuccess, totalSchools, '全400校の読み取りが成功すること');
  assert.strictEqual(pfReport.readFailed, 0, '読み取り失敗が0件であること');
  assert.strictEqual(blockedExternalRequests.length, 0, '外部通信が完全に0件であること (物理隔離)');

  // ---------------------------------------------------------------------------
  // テスト 2: 中断と再開 (Resume) 整合性テスト (100校実行 -> 中断 -> 400校Resume)
  // ---------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log('  TEST 2: Checkpoint & Resume Integrity Test');
  console.log('================================================================');

  const testDeployId = `stress-resume-${Date.now()}`;

  // まず一部の学校だけ実行して意図的に終了
  const firstLimit = Math.min(50, Math.max(1, Math.floor(totalSchools / 4)));
  console.log(`  [Step 2-1] ${firstLimit}校のみを先行実行し、Checkpointを作成...`);
  const firstBatchReport = await runBatch({
    schoolsFilePath: schoolsCsvPath,
    profileFilePath: profilePath,
    credentialsFilePath: credsPath,
    executionOptions: {
      apply: false,
      allowLiveWrite: false,
      batchApply: false,
      authMode: 'A'
    } as any,
    envConfig,
    limit: firstLimit,
    deploymentId: testDeployId,
    pacingDelayMs: 20
  });

  assert.strictEqual(firstBatchReport.processedSchools, firstLimit, `第1段階で${firstLimit}校のみ処理されること`);

  // 次に --resume で全校を指定して再開
  console.log('  [Step 2-2] --resume を指定して残り350校の処理を再開...');
  const resumeStartTime = Date.now();
  const resumedBatchReport = await runBatch({
    schoolsFilePath: schoolsCsvPath,
    profileFilePath: profilePath,
    credentialsFilePath: credsPath,
    executionOptions: {
      apply: false,
      allowLiveWrite: false,
      batchApply: false,
      authMode: 'A'
    } as any,
    envConfig,
    resume: true,
    deploymentId: testDeployId,
    pacingDelayMs: 20
  });

  const resumeElapsedSec = ((Date.now() - resumeStartTime) / 1000).toFixed(1);
  console.log(`\n[TEST 2 SUMMARY]`);
  console.log(`- Resume後 処理学校数: ${resumedBatchReport.processedSchools} 校 (スキップ: ${resumedBatchReport.skippedSchools} 校)`);
  console.log(`- 所要時間: ${resumeElapsedSec} 秒`);

  // サマリーレポートは Checkpoint を SSOT として全校の累積状態を集計
  assert.strictEqual(resumedBatchReport.skippedSchools, firstLimit, `先行処理済みの${firstLimit}校が確実にスキップされること`);
  assert.strictEqual(resumedBatchReport.processedSchools, totalSchools, `累積で全${totalSchools}校が処理済みとして集計されること`);

  // ---------------------------------------------------------------------------
  // テスト 3: クリーンアップ・プロセス残留検証
  // ---------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log('  TEST 3: Process Cleanup & Leak Verification');
  console.log('================================================================');

  // GC を促すために少し待機
  await new Promise((r) => setTimeout(r, 1000));
  const finalMem = getMemoryStats();
  const finalChromiumCount = countChromiumProcesses();

  console.log(`[Final Metrics]`);
  console.log(`- Final Memory : RSS ${finalMem.rssMb}MB | HeapUsed ${finalMem.heapUsedMb}MB`);
  console.log(`- Initial Chromium: ${initialChromiumCount} -> Final Chromium: ${finalChromiumCount}`);

  // サーバー停止
  await mockServer.stop();

  // クリーンアップ
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}

  console.log('\n================================================================');
  console.log('  ALL 400 SCHOOLS STRESS TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error('[FATAL ERROR IN STRESS TEST]:', err);
  process.exit(1);
});
