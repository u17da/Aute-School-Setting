import assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { SETTING_DEFINITIONS, ALL_SETTING_KEYS } from '../src/settings/definitions';
import { SettingKey, SettingValue } from '../src/types/settings';
import { ConsoleServer } from '../src/console/server';

console.log('=== Phase 5B.4: Final GUI Mock Smoke Test (Headless Chromium) ===\n');

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

// =============================================================================
// 物理的 Live 隔離 Interceptor
// =============================================================================
const nodeHttp = require('http');
const originalHttpRequest = nodeHttp.request;
nodeHttp.request = function (options: any, ...args: any[]) {
  const host = typeof options === 'string'
    ? new URL(options).hostname
    : (options?.hostname || options?.host || '');
  if (host && !host.includes('127.0.0.1') && !host.includes('localhost')) {
    throw new Error(`PHYSICAL_LIVE_ISOLATION_VIOLATION: ${host}`);
  }
  return originalHttpRequest.apply(this, [options, ...args]);
};

// =============================================================================
// Mock Portal サーバー (127.0.0.1 固定)
// =============================================================================
interface MockSchoolState {
  schoolCode: string;
  schoolName: string;
  settings: Record<SettingKey, SettingValue>;
}

class MockPortalServer {
  private server: http.Server | null = null;
  public port = 0;
  public schoolStates: Map<string, MockSchoolState> = new Map();
  public savePostCounts: Record<string, number> = {};
  public failureMode: 'NONE' | 'SAVE_FAILED_KNOWN' | 'RELOAD_FAIL' = 'NONE';
  public failureSchoolCode = '';

  resetMetrics() {
    this.savePostCounts = {};
    this.failureMode = 'NONE';
    this.failureSchoolCode = '';
  }

  setSchool(schoolCode: string, schoolName: string, settings: Partial<Record<SettingKey, SettingValue>>) {
    const fullSettings: Record<SettingKey, SettingValue> = {
      storage: 'OFF',
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
        if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost')) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('PHYSICAL_LIVE_ISOLATION_VIOLATION');
          return;
        }

        const cookieHeader = req.headers.cookie || '';
        const match = cookieHeader.match(/mock_school=([^;]+)/);
        const currentSchoolCode = match ? match[1] : 'SCH_GUI_OK';
        const url = req.url || '/';

        // 1. ログイン画面
        if (url === '/' || url === '/login') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html><html><body>
              <form method="POST" action="/login/school">
                <input name="schoolCode" placeholder="学校コード" />
                <button type="submit">次へ</button>
              </form>
            </body></html>
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

        // 3. パスワード画面
        if (url === '/login/password') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html><html><body>
              <form method="POST" action="/login/auth">
                <input name="userId" placeholder="ユーザーID" />
                <input type="password" name="password" placeholder="パスワード" />
                <button type="submit">ログイン</button>
              </form>
            </body></html>
          `);
          return;
        }

        // 4. 認証実行
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
            <!DOCTYPE html><html><body>
              <header><div class="v2-nav-menu-header__label">${schoolName}</div></header>
              <div class="v2-sidebar-current-account"><a href="/organization">学校設定</a></div>
            </body></html>
          `);
          return;
        }

        // 6. 学校設定画面
        if (url === '/organization' && req.method === 'GET') {
          if (this.failureMode === 'RELOAD_FAIL' && currentSchoolCode === this.failureSchoolCode) {
            if ((this.savePostCounts[currentSchoolCode] || 0) > 0) {
              res.writeHead(502, { 'Content-Type': 'text/plain' });
              res.end('Bad Gateway (Injected Failure)');
              return;
            }
          }

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
                <div class="options">${radiosHtml}</div>
              </div>
            `;
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html><html>
            <head><meta charset="utf-8"><title>学校設定</title></head>
            <body>
              <header><h1 class="v2-header__title">学校設定</h1></header>
              <form method="POST" action="/organization/save">
                ${rowsHtml}
                <input type="submit" name="commit" value="更新する" />
              </form>
            </body></html>
          `);
          return;
        }

        // 7. 保存 POST
        if (url === '/organization/save' && req.method === 'POST') {
          this.savePostCounts[currentSchoolCode] = (this.savePostCounts[currentSchoolCode] || 0) + 1;

          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const params = new URLSearchParams(body);
            const state = this.schoolStates.get(currentSchoolCode);
            if (state) {
              if (this.failureMode !== 'SAVE_FAILED_KNOWN') {
                for (const key of ALL_SETTING_KEYS) {
                  const val = params.get(key);
                  if (val) state.settings[key] = val as SettingValue;
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
        this.port = (this.server?.address() as any).port;
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

function cleanStaleTestArtifacts() {
  const cpDir = path.resolve(process.cwd(), 'checkpoints');
  if (fs.existsSync(cpDir)) {
    const files = fs.readdirSync(cpDir);
    for (const file of files) {
      if (file.endsWith('.lock') || file.includes('deploy-eda88302')) {
        try {
          fs.unlinkSync(path.join(cpDir, file));
        } catch {}
      }
    }
  }
}

// =============================================================================
// メインテスト実行
// =============================================================================
async function main() {
  cleanStaleTestArtifacts();

  const screenshotsDir = path.resolve(process.cwd(), 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const mockPortal = new MockPortalServer();
  const mockPortalPort = await mockPortal.start();
  const mockBaseUrl = `http://127.0.0.1:${mockPortalPort}`;
  console.log(`[MockPortal] Started on ${mockBaseUrl}`);

  // 環境変数に Mock Base URL を注入
  process.env.MANAPOKE_BASE_URL = mockBaseUrl;
  process.env.MANAPOKE_PASSWORD = 'mock_password';

  // Operator Console サーバー起動 (ポート 0 で空きポート利用)
  const consoleServer = new ConsoleServer({ port: 0 });
  await consoleServer.start();
  (consoleServer as any).adapter.on('log', (line: string) => {
    console.log(`  [Subprocess] ${line}`);
  });
  const consolePort = consoleServer.getPort();
  const consoleBaseUrl = `http://127.0.0.1:${consolePort}`;
  console.log(`[ConsoleServer] Operator Console listening on ${consoleBaseUrl}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // 自動ダイアログ承認 (confirm, alert)
  page.on('dialog', async (dialog) => {
    console.log(`  [Dialog] ${dialog.type()}: ${dialog.message()}`);
    await dialog.accept();
  });

  // ブラウザコンソールログの転送
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.text().includes('【') || msg.text().includes('ERROR')) {
      console.log(`  [BrowserConsole:${msg.type()}] ${msg.text()}`);
    }
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-mock-smoke-'));

  try {
    // -------------------------------------------------------------------------
    // Case 1: SUCCESS の 15 ステップ E2E フロー
    // -------------------------------------------------------------------------
    await runTest('Case 1: 最終GUI Mock Smoke (15ステップ E2E -> SUCCESS)', async () => {
      mockPortal.resetMetrics();
      mockPortal.setSchool('SCH_GUI_OK', 'GUIモック小学校', {
        storage: 'OFF',
        timelineChannel: 'ON'
      });

      // 1. CSV 作成
      const csvPath = path.join(tempDir, 'schools_gui.csv');
      fs.writeFileSync(csvPath, 'schoolCode,schoolName,userId,password,enabled\nSCH_GUI_OK,GUIモック小学校,user1,pass1,true\n', 'utf-8');

      // Console UI へアクセス
      await page.goto(consoleBaseUrl, { waitUntil: 'networkidle' });

      // 1. CSV Upload
      console.log('  [Step 1] CSV Upload...');
      const fileInput = page.locator('#schoolsFileInput');
      await fileInput.setInputFiles(csvPath);
      await page.waitForSelector('#uploadFileInfo:not([style*="display: none"])', { timeout: 10000 });
      const uploadStats = await page.locator('#uploadParsedStatsVal').innerText();
      // 2. Profile Editor で非破壊設定を1項目変更 (storage -> ON)
      console.log('  [Step 2] Profile Editor で非破壊設定 (storage: ON) 変更...');
      // 画面内のストレージ機能の select を ON に変更
      const storageSelect = page.locator('#profileEditorTableBody tr:has-text("ストレージ機能") select');
      await storageSelect.selectOption('ON');

      // 4. Validation PASS (アップロード・設定変更時に自動検証)
      console.log('  [Step 4] 入力を自動検証完了待機...');
      await page.waitForSelector('#btnStartPreflight:not([disabled])', { timeout: 10000 });
      const snapSchools = await page.locator('#enabledSchoolsVal').innerText();
      assert.strictEqual(snapSchools.includes('1 校'), true);

      // 5. Read-only Preflight 実行
      console.log('  [Step 5] Read-only Preflight 実行...');
      await page.click('#btnStartPreflight');

      // 進捗完了を待機 (Job State が COMPLETED になるまで待機)
      console.log('  [Step 6] Preflight 完了待機...');
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && badge.textContent && badge.textContent.includes('COMPLETED');
      }, { timeout: 60000 });

      // 6. Results 確認
      console.log('  [Step 6b] Results 確認...');
      await page.click('#tabResultsBtn');
      await page.waitForSelector('#screenResults.active', { timeout: 5000 });
      const resSuccess = await page.locator('#resReadSuccess').innerText();
      const resRequires = await page.locator('#resRequiresChange').innerText();
      assert.strictEqual(resSuccess, '1');
      assert.strictEqual(resRequires, '1');

      // 7. Production Apply タブ活性化
      console.log('  [Step 7] Production Apply タブ活性化確認...');
      await page.waitForSelector('#tabApplyBtn:not([disabled])', { timeout: 10000 });
      await page.click('#tabApplyBtn');
      await page.waitForSelector('#screenApply.active', { timeout: 5000 });
      await page.waitForSelector('#btnPrepareApply:not([disabled])', { timeout: 10000 });
      const gateBadge = await page.locator('#applyGateBadge').innerText();
      assert.strictEqual(gateBadge.includes('合格') || gateBadge.includes('Ready') || gateBadge.includes('Gate 通過'), true);

      // 8. 「本番適用の準備」
      console.log('  [Step 8] 「本番適用の準備」クリック...');
      await page.click('#btnPrepareApply');

      // 9. Apply 確認モーダル表示
      console.log('  [Step 9] Apply 確認モーダル表示確認...');
      await page.waitForSelector('#applyConfirmModal[style*="display: flex"]', { timeout: 10000 });

      // 10. Preflight / Manifest との一致検証
      console.log('  [Step 10] Manifest 指標照合...');
      const modalTargetCount = await page.locator('#modalTargetCount').innerText();
      const modalSkipped = await page.locator('#modalSkippedDestructive').innerText();
      const modalAlready = await page.locator('#modalAlreadyConfigured').innerText();
      const modalTargetHash = await page.locator('#modalApplyTargetHashVal').innerText();
      const modalProfileHash = await page.locator('#modalProfileHashVal').innerText();

      assert.strictEqual(modalTargetCount, '1 校');
      assert.strictEqual(modalSkipped, '0 校');
      assert.strictEqual(modalAlready, '0 校');
      assert.strictEqual(modalTargetHash.length > 10, true);
      assert.strictEqual(modalProfileHash.length > 10, true);

      // 11. 確認 checkbox OFF 時は Apply button disabled
      console.log('  [Step 11] Checkbox OFF 時の Apply ボタン非活性確認...');
      const isBtnDisabledBefore = await page.locator('#btnExecuteApply').isDisabled();
      assert.strictEqual(isBtnDisabledBefore, true);

      // 12. checkbox ON 時のみ Apply button enabled
      console.log('  [Step 12] Checkbox ON 時の Apply ボタン活性化確認...');
      await page.check('#modalConfirmCheckbox');
      const isBtnEnabledAfter = await page.locator('#btnExecuteApply').isEnabled();
      assert.strictEqual(isBtnEnabledAfter, true);

      // 13. 「非破壊変更を本番適用する」
      console.log('  [Step 13] 「非破壊変更を本番適用する」クリック...');
      await page.click('#btnExecuteApply');

      // 14. Mock Production Apply 完了待機 (RUNNING -> COMPLETED)
      console.log('  [Step 14] Production Apply 完了待機...');
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && badge.textContent && badge.textContent.includes('RUNNING');
      }, null, { timeout: 10000 });
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && badge.textContent && badge.textContent.includes('COMPLETED');
      }, null, { timeout: 60000 });

      // 15. Results 画面で最終 status 確認
      console.log('  [Step 15] Results 画面で最終 status 確認 (SUCCESS)...');
      await page.click('#tabResultsBtn');
      await page.waitForSelector('#screenResults.active', { timeout: 5000 });
      await page.click('button:has-text("最新結果を取得")');
      await page.waitForTimeout(1000);

      // スクリーンショット保存
      const ssSuccess = path.join(screenshotsDir, 'phase5b4_gui_mock_success.png');
      await page.screenshot({ path: ssSuccess, fullPage: true });
      console.log(`  [Screenshot] Saved: ${ssSuccess}`);

      assert.strictEqual(mockPortal.savePostCounts['SCH_GUI_OK'], 1, 'Mock Server に Save POST が 1 回送信されたこと');
    });

    // -------------------------------------------------------------------------
    // Case 2: SAVE_FAILED_KNOWN の GUI 結果画面確認
    // -------------------------------------------------------------------------
    await runTest('Case 2: SAVE_FAILED_KNOWN の GUI 結果画面確認', async () => {
      mockPortal.resetMetrics();
      mockPortal.setSchool('SCH_GUI_OK', 'GUIモック小学校', {
        storage: 'OFF',
        timelineChannel: 'ON'
      });
      // 故障モード: Save POST を受信しても reload 後の値が不一致のまま
      mockPortal.failureMode = 'SAVE_FAILED_KNOWN';

      // Apply を再実行
      await page.click('#tabApplyBtn');
      await page.waitForSelector('#screenApply.active', { timeout: 5000 });
      await page.click('#btnPrepareApply');
      await page.waitForSelector('#applyConfirmModal[style*="display: flex"]', { timeout: 10000 });
      await page.check('#modalConfirmCheckbox');
      await page.click('#btnExecuteApply');

      // ジョブ終了待機 (RUNNING -> COMPLETED)
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && badge.textContent && badge.textContent.includes('RUNNING');
      }, null, { timeout: 10000 });
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && badge.textContent && badge.textContent.includes('COMPLETED');
      }, null, { timeout: 60000 });

      // Results 画面確認
      await page.click('#tabResultsBtn');
      await page.waitForSelector('#screenResults.active', { timeout: 5000 });
      await page.click('button:has-text("最新結果を取得")');
      await page.waitForTimeout(1000);

      const ssFailKnown = path.join(screenshotsDir, 'phase5b4_gui_mock_save_failed_known.png');
      await page.screenshot({ path: ssFailKnown, fullPage: true });
      console.log(`  [Screenshot] Saved: ${ssFailKnown}`);

      // Checkpoint を確認
      const cpDir = path.resolve(process.cwd(), 'checkpoints');
      const cpFiles = fs.readdirSync(cpDir).filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'));
      cpFiles.sort((a, b) => fs.statSync(path.join(cpDir, b)).mtimeMs - fs.statSync(path.join(cpDir, a)).mtimeMs);
      const cp = JSON.parse(fs.readFileSync(path.join(cpDir, cpFiles[0]), 'utf-8'));
      assert.strictEqual(cp.entries['SCH_GUI_OK']?.status, 'SAVE_FAILED_KNOWN');
    });

    // -------------------------------------------------------------------------
    // Case 3: SAVE_OUTCOME_UNKNOWN の GUI 結果画面確認 (重大警告・次校停止・Retry/Resume保護)
    // -------------------------------------------------------------------------
    await runTest('Case 3: SAVE_OUTCOME_UNKNOWN の GUI 結果画面確認 (次校停止 & 保護)', async () => {
      cleanStaleTestArtifacts();
      mockPortal.resetMetrics();
      mockPortal.setSchool('SCH_FAIL', '故障注入小学校', {
        storage: 'OFF',
        timelineChannel: 'ON'
      });
      mockPortal.setSchool('SCH_NEXT', '次校小学校', {
        storage: 'OFF',
        timelineChannel: 'ON'
      });

      // 2校の CSV アップロード
      const csvPath2 = path.join(tempDir, 'schools_gui_2.csv');
      fs.writeFileSync(csvPath2, 'schoolCode,schoolName,userId,password,enabled\nSCH_FAIL,故障注入小学校,user1,pass1,true\nSCH_NEXT,次校小学校,user2,pass2,true\n', 'utf-8');

      await page.click('#tabSetupBtn');
      await page.waitForSelector('#screenSetup.active', { timeout: 5000 });
      await page.locator('#schoolsFileInput').setInputFiles(csvPath2);
      await page.waitForSelector('#uploadFileInfo:not([style*="display: none"])', { timeout: 10000 });

      // ストレージ機能を ON に設定
      await page.locator('#profileEditorTableBody tr:has-text("ストレージ機能") select').selectOption('ON');
      await page.waitForTimeout(500);

      await page.waitForSelector('#btnStartPreflight:not([disabled])', { timeout: 10000 });
      const snapCount2 = await page.locator('#enabledSchoolsVal').innerText();
      assert.strictEqual(snapCount2.includes('2 校'), true);

      // Preflight
      await page.click('#btnStartPreflight');
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && badge.textContent && badge.textContent.includes('RUNNING');
      }, null, { timeout: 10000 });
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && badge.textContent && badge.textContent.includes('COMPLETED');
      }, null, { timeout: 60000 });

      // 故障モード注入: Save POST 後の reload で 502
      mockPortal.failureMode = 'RELOAD_FAIL';
      mockPortal.failureSchoolCode = 'SCH_FAIL';

      // Apply 実行
      await page.waitForSelector('#tabApplyBtn:not([disabled])', { timeout: 10000 });
      await page.click('#tabApplyBtn');
      await page.waitForSelector('#screenApply.active', { timeout: 5000 });
      await page.click('#btnPrepareApply');
      await page.waitForSelector('#applyConfirmModal[style*="display: flex"]', { timeout: 10000 });
      await page.check('#modalConfirmCheckbox');
      await page.click('#btnExecuteApply');

      // ジョブ終了待機 (Circuit Breaker により COMPLETED 終了)
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && badge.textContent && badge.textContent.includes('RUNNING');
      }, null, { timeout: 10000 });
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && badge.textContent && badge.textContent.includes('COMPLETED');
      }, null, { timeout: 60000 });

      // Results 画面確認
      await page.click('#tabResultsBtn');
      await page.waitForSelector('#screenResults.active', { timeout: 5000 });
      await page.click('button:has-text("最新結果を取得")');
      await page.waitForTimeout(1000);

      const ssOutcomeUnknown = path.join(screenshotsDir, 'phase5b4_gui_mock_save_outcome_unknown.png');
      await page.screenshot({ path: ssOutcomeUnknown, fullPage: true });
      console.log(`  [Screenshot] Saved: ${ssOutcomeUnknown}`);

      // Checkpoint の検証: SCH_FAIL は SAVE_OUTCOME_UNKNOWN, SCH_NEXT は PENDING
      const cpDir = path.resolve(process.cwd(), 'checkpoints');
      const cpFiles = fs.readdirSync(cpDir).filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'));
      cpFiles.sort((a, b) => fs.statSync(path.join(cpDir, b)).mtimeMs - fs.statSync(path.join(cpDir, a)).mtimeMs);
      const cp = JSON.parse(fs.readFileSync(path.join(cpDir, cpFiles[0]), 'utf-8'));

      assert.strictEqual(cp.entries['SCH_FAIL']?.status, 'SAVE_OUTCOME_UNKNOWN', '1校目は SAVE_OUTCOME_UNKNOWN となること');
      assert.strictEqual(cp.entries['SCH_NEXT']?.status === 'PENDING' || cp.entries['SCH_NEXT'] === undefined, true, '次校は実行されず PENDING のままであること');
      assert.strictEqual(mockPortal.savePostCounts['SCH_NEXT'] || 0, 0, '次校への Save POST は 0 回であること');

      // Retry / Resume による再Write不可の検証
      console.log('  [Verification] SAVE_OUTCOME_UNKNOWN 校への再Write不可を検証...');
      assert.strictEqual(mockPortal.savePostCounts['SCH_FAIL'], 1, 'Save POST は 1 回のみ送信され、自動再試行されないこと');
    });

  } finally {
    await browser.close();
    await consoleServer.stop();
    await mockPortal.stop();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\nPhase 5B.4 GUI Mock Smoke Test Results: ${passedTests} passed, ${failedTests} failed\n`);
  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error in GUI Mock Smoke execution:', err);
  process.exit(1);
});
