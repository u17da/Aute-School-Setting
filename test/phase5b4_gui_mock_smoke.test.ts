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

  page.on('response', (res) => {
    if (res.status() >= 400) {
      console.log(`  [HTTP:${res.status()}] ${res.url()}`);
    }
  });

  page.on('dialog', async (dialog) => {
    console.log(`  [BROWSER_DIALOG] ${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-mock-smoke-'));

  try {
    // -------------------------------------------------------------------------
    // Case 1: Phase 6A 6ステップ E2E -> SUCCESS
    // -------------------------------------------------------------------------
    await runTest('Case 1: Phase 6A GUI 6ステップ E2E (Target -> Observe -> Decide -> Preview -> Apply -> Result)', async () => {
      mockPortal.resetMetrics();
      mockPortal.setSchool('SCH_GUI_OK', 'GUIモック小学校', {
        storage: 'OFF',
        timelineChannel: 'ON'
      });

      // 1. CSV 作成
      const csvPath = path.join(tempDir, 'schools_gui.csv');
      fs.writeFileSync(csvPath, 'schoolCode,schoolName,userId,password,enabled\nSCH_GUI_OK,GUIモック小学校,user1,pass1,true\n', 'utf-8');

      // Console UI へアクセス
      await page.goto(consoleBaseUrl, { waitUntil: 'domcontentloaded' });

      // STEP 1: Target - CSV Upload & Validate
      console.log('  [STEP 1] Target: CSV Upload & Validate...');
      const fileInput = page.locator('#schoolsFileInput');
      await fileInput.setInputFiles(csvPath);
      await page.waitForSelector('#uploadFileInfo:not([style*="display: none"])', { timeout: 10000 });

      await page.click('#targetValidateBtn');
      await page.waitForSelector('#targetSnapshotBox:not([style*="display: none"])', { timeout: 10000 });
      await page.waitForFunction(() => {
        const el = document.getElementById('targetSchoolsCountVal');
        return el && el.textContent && el.textContent.includes('校');
      }, null, { timeout: 10000 });
      const snapCount = await page.locator('#targetSchoolsCountVal').innerText();
      assert.ok(snapCount.replace(/\s+/g, '').includes('1校'), `Expected snapCount to include '1校', received: '${snapCount}'`);

      // STEP 2: Observe - Discovery
      console.log('  [STEP 2] Observe: Discovery 実行...');
      await page.click('#tabObserveBtn');
      await page.waitForSelector('#screenObserve.active', { timeout: 5000 });
      await page.click('#discoveryStartBtn');

      // Discovery 完了待機
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && (badge.textContent?.includes('COMPLETED') || badge.textContent?.includes('完了') || badge.getAttribute('data-state') === 'COMPLETED');
      }, null, { timeout: 60000 });

      await page.waitForSelector('#observationResultBox:not([style*="display: none"])', { timeout: 5000 });
      const obsCount = await page.locator('#obsTotalSchoolsVal').innerText();
      assert.strictEqual(obsCount, '1');

      // STEP 3: Decide - Draft Profile 編集 (storage: ON)
      console.log('  [STEP 3] Decide: Profile Editor で非破壊設定 (storage: ON) 指定...');
      await page.click('#tabDecideBtn');
      await page.waitForSelector('#screenDecide.active', { timeout: 5000 });
      await page.selectOption('select[data-key="storage"]', 'ON');

      // STEP 4: Preview 算出
      console.log('  [STEP 4] Preview 算出...');
      await page.click('#calculatePreviewBtn');
      await page.waitForFunction(() => {
        const el = document.getElementById('previewTargetVal');
        return el && el.textContent && el.textContent.replace(/\s+/g, '').includes('1校');
      }, null, { timeout: 10000 });
      const prevTarget = await page.locator('#previewTargetVal').innerText();
      assert.ok(prevTarget.replace(/\s+/g, '').includes('1校'), `Expected prevTarget to include '1校', received: '${prevTarget}'`);

      // Profile 確定
      console.log('  [STEP 4b] Profile 確定...');
      await page.click('#profileConfirmBtn');
      await page.waitForSelector('#finalPreflightSection:not([style*="display: none"])', { timeout: 10000 });

      // Final Preflight 実行
      console.log('  [STEP 4c] Final Preflight 完了待機...');
      const pfBtn = page.locator('#finalPreflightStartBtn');
      if (await pfBtn.count() > 0 && await pfBtn.isVisible()) {
        await pfBtn.click();
      }
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && (badge.textContent?.includes('COMPLETED') || badge.textContent?.includes('完了') || badge.getAttribute('data-state') === 'COMPLETED');
      }, null, { timeout: 60000 });

      // STEP 5: Apply
      console.log('  [STEP 5] Production Apply 準備...');
      await page.click('#tabApplyBtn');
      await page.waitForSelector('#screenApply.active', { timeout: 5000 });
      const prepBtn = page.locator('#applyPrepareBtn');
      if (await prepBtn.count() > 0 && await prepBtn.isVisible()) {
        await prepBtn.click();
      }
      await page.waitForSelector('#applyPreparedBox:not([style*="display: none"])', { timeout: 10000 });

      const applyTargetCount = await page.locator('#applyTargetCountVal').innerText();
      assert.ok(applyTargetCount.replace(/\s+/g, '').includes('1校'), `Expected applyTargetCount to include '1校', received: '${applyTargetCount}'`);

      console.log('  [STEP 5b] 本番適用モーダル表示 & 実行...');
      await page.click('#applyExecuteBtn');
      await page.waitForSelector('#applyConfirmModal[style*="display: flex"]', { timeout: 10000 });
      await page.click('#modalApplyStartBtn');

      // ジョブ完了待機 (RUNNING -> COMPLETED)
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && (badge.textContent?.includes('RUNNING') || badge.textContent?.includes('中') || badge.getAttribute('data-state') === 'RUNNING');
      }, null, { timeout: 10000 });
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && (badge.textContent?.includes('COMPLETED') || badge.textContent?.includes('完了') || badge.getAttribute('data-state') === 'COMPLETED');
      }, null, { timeout: 60000 });

      // STEP 6: Result 確認
      console.log('  [STEP 6] Result 確認...');
      await page.click('#tabResultBtn');
      await page.waitForSelector('#screenResult.active', { timeout: 5000 });
      await page.waitForTimeout(1000);
      await page.waitForFunction(() => {
        const body = document.getElementById('resultSchoolsBody');
        return body && body.innerText && body.innerText.includes('SCH_GUI_OK');
      }, null, { timeout: 15000 });

      // スクリーンショット保存
      const ssSuccess = path.join(screenshotsDir, 'phase6a_gui_mock_success.png');
      await page.screenshot({ path: ssSuccess, fullPage: true });
      console.log(`  [Screenshot] Saved: ${ssSuccess}`);

      // GUI 画面上の成功数およびテーブル表示の検証 (要件 18: Case A)
      const successCountText = await page.locator('#resultSuccessVal').innerText();
      assert.strictEqual(successCountText.trim(), '1', '設定変更成功数が 1 と表示されること');
      const tableText = await page.locator('#resultSchoolsBody').innerText();
      assert.ok(tableText.includes('SCH_GUI_OK'), '学校別テーブルに SCH_GUI_OK が表示されること');
      assert.ok(tableText.includes('成功'), 'ステータスバッジが成功と表示されること');

      assert.strictEqual(mockPortal.savePostCounts['SCH_GUI_OK'], 1, 'Mock Server に Save POST が 1 回送信されたこと');
    });

    // -------------------------------------------------------------------------
    // Case 2: SAVE_FAILED_KNOWN の GUI 結果確認
    // -------------------------------------------------------------------------
    await runTest('Case 2: SAVE_FAILED_KNOWN の GUI 結果確認', async () => {
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
      const prepBtn2 = page.locator('#applyPrepareBtn');
      if (await prepBtn2.count() > 0 && await prepBtn2.isVisible()) {
        await prepBtn2.click();
      }
      await page.waitForSelector('#applyPreparedBox:not([style*="display: none"])', { timeout: 10000 });
      await page.click('#applyExecuteBtn');
      await page.waitForSelector('#applyConfirmModal[style*="display: flex"]', { timeout: 10000 });
      await page.click('#modalApplyStartBtn');

      // ジョブ終了待機 (RUNNING -> COMPLETED)
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && (badge.textContent?.includes('RUNNING') || badge.textContent?.includes('中') || badge.getAttribute('data-state') === 'RUNNING');
      }, null, { timeout: 10000 });
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && (badge.textContent?.includes('COMPLETED') || badge.textContent?.includes('完了') || badge.getAttribute('data-state') === 'COMPLETED');
      }, null, { timeout: 60000 });

      // Results 画面確認
      await page.click('#tabResultBtn');
      await page.waitForSelector('#screenResult.active', { timeout: 5000 });
      await page.waitForTimeout(1000);

      const ssFailKnown = path.join(screenshotsDir, 'phase6a_gui_mock_save_failed_known.png');
      await page.screenshot({ path: ssFailKnown, fullPage: true });
      console.log(`  [Screenshot] Saved: ${ssFailKnown}`);

      // Checkpoint を確認
      const cpDir = path.resolve(process.cwd(), 'checkpoints');
      const cpFiles = fs.readdirSync(cpDir).filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'));
      cpFiles.sort((a, b) => fs.statSync(path.join(cpDir, b)).mtimeMs - fs.statSync(path.join(cpDir, a)).mtimeMs);
      const cpFile = cpFiles.find((f) => {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(cpDir, f), 'utf-8'));
          return content.entries && content.entries['SCH_GUI_OK'] !== undefined;
        } catch { return false; }
      }) || cpFiles[0];
      const cp = JSON.parse(fs.readFileSync(path.join(cpDir, cpFile), 'utf-8'));
      assert.strictEqual(cp.entries['SCH_GUI_OK']?.status, 'SAVE_FAILED_KNOWN');
    });

    // -------------------------------------------------------------------------
    // Case 3: SAVE_OUTCOME_UNKNOWN の GUI 結果画面確認 (次校停止 & 保護)
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

      // STEP 1: Target
      await page.click('#tabTargetBtn');
      await page.waitForTimeout(500);
      await page.waitForSelector('#screenTarget.active', { timeout: 5000 });
      await page.locator('#schoolsFileInput').setInputFiles(csvPath2);
      await page.waitForTimeout(500);
      await page.waitForSelector('#uploadFileInfo:not([style*="display: none"])', { timeout: 10000 });
      await page.locator('#targetValidateBtn').scrollIntoViewIfNeeded();
      await page.click('#targetValidateBtn');
      await page.waitForSelector('#targetSnapshotBox:not([style*="display: none"])', { timeout: 10000 });
      await page.waitForFunction(() => {
        const el = document.getElementById('targetSchoolsCountVal');
        return el && el.textContent && el.textContent.includes('校');
      }, null, { timeout: 10000 });

      // STEP 2: Observe
      await page.click('#tabObserveBtn');
      await page.waitForSelector('#screenObserve.active', { timeout: 5000 });
      await page.click('#discoveryStartBtn');
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && (badge.textContent?.includes('COMPLETED') || badge.textContent?.includes('完了') || badge.getAttribute('data-state') === 'COMPLETED');
      }, null, { timeout: 60000 });

      // STEP 3: Decide
      await page.click('#tabDecideBtn');
      await page.waitForSelector('#screenDecide.active', { timeout: 5000 });
      await page.selectOption('select[data-key="storage"]', 'ON');

      // STEP 4: Preview & Final Preflight
      await page.click('#calculatePreviewBtn');
      await page.waitForFunction(() => {
        const el = document.getElementById('previewTargetVal');
        return el && el.textContent && !el.textContent.includes('0校') && !el.textContent.includes('0 校');
      }, null, { timeout: 10000 });
      await page.click('#profileConfirmBtn');
      await page.waitForSelector('#finalPreflightSection:not([style*="display: none"])', { timeout: 10000 });

      const pfBtn3 = page.locator('#finalPreflightStartBtn');
      if (await pfBtn3.count() > 0 && await pfBtn3.isVisible()) {
        await pfBtn3.click();
      }
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && (badge.textContent?.includes('COMPLETED') || badge.textContent?.includes('完了') || badge.getAttribute('data-state') === 'COMPLETED');
      }, null, { timeout: 60000 });

      // 故障モード注入: Save POST 後の reload で 502
      mockPortal.failureMode = 'RELOAD_FAIL';
      mockPortal.failureSchoolCode = 'SCH_FAIL';

      // STEP 5: Apply
      await page.click('#tabApplyBtn');
      await page.waitForSelector('#screenApply.active', { timeout: 5000 });
      const prepBtn3 = page.locator('#applyPrepareBtn');
      if (await prepBtn3.count() > 0 && await prepBtn3.isVisible()) {
        await prepBtn3.click();
      }
      await page.waitForSelector('#applyPreparedBox:not([style*="display: none"])', { timeout: 10000 });
      await page.click('#applyExecuteBtn');
      await page.waitForSelector('#applyConfirmModal[style*="display: flex"]', { timeout: 10000 });
      await page.click('#modalApplyStartBtn');

      // ジョブ終了待機 (Circuit Breaker により COMPLETED 終了)
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && (badge.textContent?.includes('RUNNING') || badge.textContent?.includes('中') || badge.getAttribute('data-state') === 'RUNNING');
      }, null, { timeout: 10000 });
      await page.waitForFunction(() => {
        const badge = document.getElementById('jobStateBadge');
        return badge && (badge.textContent?.includes('COMPLETED') || badge.textContent?.includes('完了') || badge.getAttribute('data-state') === 'COMPLETED');
      }, null, { timeout: 60000 });

      // STEP 6: Results 画面確認
      await page.click('#tabResultBtn');
      await page.waitForSelector('#screenResult.active', { timeout: 5000 });
      await page.waitForTimeout(1000);
      await page.waitForFunction(() => {
        const body = document.getElementById('resultSchoolsBody');
        return body && body.innerText && body.innerText.includes('SCH_FAIL');
      }, null, { timeout: 15000 });

      const ssOutcomeUnknown = path.join(screenshotsDir, 'phase6a_gui_mock_save_outcome_unknown.png');
      await page.screenshot({ path: ssOutcomeUnknown, fullPage: true });
      console.log(`  [Screenshot] Saved: ${ssOutcomeUnknown}`);

      // GUI 画面上の要確認カードおよび未処理カード、テーブル表示の検証 (要件 18: Case B)
      const unknownCountText = await page.locator('#resultOutcomeUnknownVal').innerText();
      assert.ok(Number(unknownCountText.trim()) >= 1, '要手動確認が 1 以上と表示されること');
      const notProcessedText = await page.locator('#resultNotProcessedVal').innerText();
      assert.strictEqual(notProcessedText.trim(), '1', '未処理校が 1 と表示されること');
      const tableText3 = await page.locator('#resultSchoolsBody').innerText();
      assert.ok(tableText3.includes('SCH_FAIL'), '学校別テーブルに SCH_FAIL が表示されること');
      assert.ok(tableText3.includes('SCH_NEXT'), '学校別テーブルに SCH_NEXT が表示されること');
      assert.ok(tableText3.includes('要手動確認') || tableText3.includes('保存結果を確定できません'), 'SCH_FAIL の要手動確認が表示されること');
      assert.ok(tableText3.includes('未処理'), 'SCH_NEXT が未処理と表示されること');

      // Checkpoint の検証: SCH_FAIL は SAVE_OUTCOME_UNKNOWN, SCH_NEXT は PENDING
      const cpDir = path.resolve(process.cwd(), 'checkpoints');
      const cpFiles = fs.readdirSync(cpDir).filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'));
      cpFiles.sort((a, b) => fs.statSync(path.join(cpDir, b)).mtimeMs - fs.statSync(path.join(cpDir, a)).mtimeMs);
      const cpFile = cpFiles.find((f) => {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(cpDir, f), 'utf-8'));
          return content.entries && content.entries['SCH_FAIL'] !== undefined;
        } catch { return false; }
      }) || cpFiles[0];
      const cp = JSON.parse(fs.readFileSync(path.join(cpDir, cpFile), 'utf-8'));

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
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error in GUI Mock Smoke execution:', err);
  process.exit(1);
});
