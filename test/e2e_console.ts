import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, Page, Download } from 'playwright';

console.log('=== Phase 5A.4: Web UI End-to-End Smoke Test (Headful Playwright) ===\n');

const SCREENSHOT_DIR = path.resolve(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// 監視メトリクス
const metrics = {
  consoleErrors: [] as string[],
  pageErrors: [] as string[],
  networkErrors: [] as { url: string; status: number }[],
  handledDialogs: [] as { type: string; message: string }[]
};

function getCheckpointForDeployment(deploymentId: string): any | null {
  const filePath = path.resolve(process.cwd(), 'checkpoints', `checkpoint-${deploymentId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function runE2E() {
  const deploymentId = 'deploy-221212fc-d9735e21';

  // 事前クリーンアップ (fresh START を保証)
  const cpPath = path.resolve(process.cwd(), 'checkpoints', `checkpoint-${deploymentId}.json`);
  const lockPath = path.resolve(process.cwd(), 'checkpoints', `${deploymentId}.lock`);
  const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${deploymentId}.json`);
  if (fs.existsSync(cpPath)) fs.unlinkSync(cpPath);
  if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  if (fs.existsSync(pfPath)) fs.unlinkSync(pfPath);

  const reportsDir = path.resolve(process.cwd(), 'reports');
  if (fs.existsSync(reportsDir)) {
    for (const f of fs.readdirSync(reportsDir)) {
      if (f.startsWith(`summary-${deploymentId}-`)) {
        fs.unlinkSync(path.join(reportsDir, f));
      }
    }
  }

  // 1. 実ブラウザ起動 (headless: false)
  console.log('[Step 1] 実ブラウザ (Chromium, headless: false) 起動中...');
  const browser = await chromium.launch({
    headless: false,
    slowMo: 100 // UI の挙動を目視確認しやすいよう適度なウェイト
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  // DevTools エラー監視 (localhost:3000)
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      console.error(`  [Browser Console Error]: ${text}`);
      metrics.consoleErrors.push(text);
    }
  });

  page.on('pageerror', (err) => {
    console.error(`  [Browser Page Error]: ${err.message}`);
    metrics.pageErrors.push(err.message);
  });

  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('127.0.0.1:3000') || url.includes('localhost:3000')) {
      if (res.status() >= 400) {
        console.warn(`  [Localhost HTTP Error]: ${res.status()} ${url}`);
        metrics.networkErrors.push({ url, status: res.status() });
      }
    }
  });

  // Native Confirm Dialog ハンドラ
  page.on('dialog', async (dialog) => {
    const msg = dialog.message();
    console.log(`  [Native Dialog]: ${dialog.type()} - "${msg.replace(/\n/g, ' ')}"`);
    metrics.handledDialogs.push({ type: dialog.type(), message: msg });
    await dialog.accept();
  });

  try {
    // ==========================================
    // シナリオ 1: 初期表示検証
    // ==========================================
    console.log('\n--- シナリオ 1: 初期表示 & DevTools 監視 ---');
    await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-initial.png') });

    // 初期要素確認
    const headerTitle = await page.locator('.header-title h1').textContent();
    assert.ok(headerTitle?.includes('学校設定 一括変更 Operator Console'), 'Header title matches');
    const badgeText = await page.locator('#jobStateBadge').textContent();
    assert.ok(
      ['IDLE', 'READY', 'INTERRUPTED', 'COMPLETED'].includes(badgeText?.trim() || ''),
      `Initial jobStateBadge is valid state (actual: ${badgeText})`
    );

    assert.strictEqual(metrics.consoleErrors.length, 0, '初期ロード時 Console Error は 0 件');
    assert.strictEqual(metrics.pageErrors.length, 0, '初期ロード時 Page Error は 0 件');
    console.log('  -> 初期表示正常確認完了 (01-initial.png 保存)');

    // ==========================================
    // シナリオ 2: Validation UI 操作
    // ==========================================
    console.log('\n--- シナリオ 2: Validation UI 操作 ---');
    await page.click('#btnValidate');

    // Validation 完了待機
    await page.waitForSelector('#validationAlert:not([style*="display: none"])', { timeout: 10000 });
    const alertText = await page.locator('#validationAlert').textContent();
    assert.ok(alertText?.includes('入力検証に合格しました'), `Validation alert: ${alertText}`);

    // UI 上の検証結果確認
    const enabledSchools = await page.locator('#enabledSchoolsVal').textContent();
    assert.strictEqual(enabledSchools?.trim(), '3 校 / 全 3 校');
    const schoolsFile = await page.locator('#schoolsFileVal').textContent();
    assert.strictEqual(schoolsFile?.trim(), 'config/schools.live.csv');
    const credResolved = await page.locator('#credResolvedVal').textContent();
    assert.ok(credResolved?.includes('3 / 3 解決完了'));

    // Profile 11 項目テーブル確認
    const profileRows = await page.locator('#profileItemsBody tr').count();
    assert.strictEqual(profileRows, 11, 'Profile 設定項目が 11 行表示されていること');

    // Preflight 開始ボタンが活性化されたこと
    const isStartDisabled = await page.locator('#btnStartPreflight').isDisabled();
    assert.strictEqual(isStartDisabled, false, 'Preflight 開始ボタンが活性化していること');

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-validation-pass.png') });
    console.log('  -> Validation UI 正常確認完了 (02-validation-pass.png 保存)');

    // ==========================================
    // シナリオ 3: 通常 3 校 Preflight UI 実行 & 進捗監視
    // ==========================================
    console.log('\n--- シナリオ 3: 通常 3 校 Preflight UI 実行 & 進捗監視 ---');
    await page.click('#btnStartPreflight');

    // Progress 画面への遷移と RUNNING 状態待機
    await page.waitForSelector('#screenProgress.active', { timeout: 5000 });
    await page.waitForFunction(() => document.getElementById('jobStateBadge')?.textContent?.trim() === 'RUNNING', { timeout: 5000 });
    console.log('  -> RUNNING 状態確認 (進捗監視開始)');

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-running.png') });

    // 全 3 校完了 (COMPLETED) まで待機
    console.log('  -> 3校処理完了まで待機中 (最大 180 秒)...');
    await page.waitForFunction(
      () => document.getElementById('jobStateBadge')?.textContent?.trim() === 'COMPLETED',
      { timeout: 180000, polling: 1000 }
    );
    console.log('  -> 全校完了検知 (jobState = COMPLETED)');

    // ==========================================
    // シナリオ 4: Final Results DOM & 各種分布の完全性検証
    // ==========================================
    console.log('\n--- シナリオ 4: Final Results DOM & 各種分布の完全性検証 ---');
    await page.click('#tabResultsBtn');
    await page.waitForSelector('#screenResults.active', { timeout: 5000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-completed-results.png') });

    // DOM 値の厳密アサート
    const total = await page.locator('#resTotal').textContent();
    const readSuccess = await page.locator('#resReadSuccess').textContent();
    const readFailed = await page.locator('#resReadFailed').textContent();
    const reqChange = await page.locator('#resRequiresChange').textContent();
    const destructive = await page.locator('#resDestructiveSchools').textContent();
    const writeEligible = await page.locator('#resWriteEligible').textContent();

    assert.strictEqual(total?.trim(), '3', 'Total = 3');
    assert.strictEqual(readSuccess?.trim(), '3', 'Read Success = 3');
    assert.strictEqual(readFailed?.trim(), '0', 'Read Failed = 0');
    assert.strictEqual(reqChange?.trim(), '3', 'Requires Change = 3');
    assert.strictEqual(destructive?.trim(), '3', 'Destructive = 3');
    assert.strictEqual(writeEligible?.trim(), '0', 'Write Eligible = 0 (破壊的変更安全ガード)');

    // Actions Distribution
    const dist3Plus = await page.locator('#dist3Plus').textContent();
    assert.strictEqual(dist3Plus?.trim(), '3 校', 'Actions 3+ = 3 校');

    // 11 項目テーブル行数確認 (空や N/A ではないこと)
    const currentTableRows = await page.locator('#currentStateTableBody tr').count();
    assert.strictEqual(currentTableRows, 11, 'Current State Distribution 表が 11 行存在すること');
    const plannedTableRows = await page.locator('#plannedChangeTableBody tr').count();
    assert.strictEqual(plannedTableRows, 11, 'Planned Change Distribution 表が 11 行存在すること');

    const firstCurrentRow = await page.locator('#currentStateTableBody tr').first().textContent();
    assert.ok(!firstCurrentRow?.includes('データなし') && !firstCurrentRow?.includes('N/A'), 'Current State 表に実データが入っていること');

    console.log('  -> Final Results DOM 完全性確認完了 (04-completed-results.png 保存)');

    // ==========================================
    // シナリオ 5: Stop UI 操作 & Interrupted Results 検証
    // ==========================================
    console.log('\n--- シナリオ 5: Stop UI 操作 & Interrupted Results 検証 ---');
    // 再度 fresh START を監視するため、前回の完了 Checkpoint をクリア
    const oldCp = path.resolve(process.cwd(), 'checkpoints', `checkpoint-${deploymentId}.json`);
    if (fs.existsSync(oldCp)) fs.unlinkSync(oldCp);

    // 再度 Validation を経て Preflight を開始
    await page.click('#tabSetupBtn');
    await page.click('#btnValidate');
    await page.waitForSelector('#validationAlert:not([style*="display: none"])', { timeout: 10000 });
    await page.click('#btnStartPreflight');
    await page.waitForSelector('#screenProgress.active', { timeout: 5000 });

    // 2校完了 (PRRHC & PAKCW) かつ 3校目処理中を監視して「安全に停止」ボタンをクリック
    console.log('  -> 2校完了を検知するまで進捗監視中...');
    const stopMonitorStart = Date.now();
    let stopTriggered = false;

    while (Date.now() - stopMonitorStart < 180000) {
      const cp = getCheckpointForDeployment(deploymentId);
      if (cp && cp.entries) {
        const prrhcStatus = cp.entries['PRRHC']?.status;
        const pakcwStatus = cp.entries['PAKCW']?.status;
        const is2Done =
          (prrhcStatus === 'SUCCESS' || prrhcStatus === 'SUCCESS_ALREADY_CONFIGURED') &&
          (pakcwStatus === 'SUCCESS' || pakcwStatus === 'SUCCESS_ALREADY_CONFIGURED');

        if (is2Done) {
          console.log(`  -> 2校完了検知 (PRRHC: ${prrhcStatus}, PAKCW: ${pakcwStatus})！画面上の「安全に停止」ボタンをクリックします...`);
          await page.click('#btnStopPreflight');
          stopTriggered = true;
          break;
        }
      }
      await page.waitForTimeout(1000);
    }
    assert.ok(stopTriggered, '停止条件 (2校完了) が時間内に検知できませんでした');

    // STOPPING -> INTERRUPTED 待機
    console.log('  -> INTERRUPTED 完了待機中...');
    await page.waitForFunction(
      () => document.getElementById('jobStateBadge')?.textContent?.trim() === 'INTERRUPTED',
      { timeout: 30000 }
    );
    console.log('  -> 安全停止完了 (jobState = INTERRUPTED)');

    // Results 画面へ移動し、「最新結果を取得」をクリック
    await page.click('#tabResultsBtn');
    await page.click('button:has-text("最新結果を取得")');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-interrupted-results.png') });

    // Interrupted DOM 検証
    const intTotal = await page.locator('#resTotal').textContent();
    const intSuccess = await page.locator('#resReadSuccess').textContent();
    const intFailed = await page.locator('#resReadFailed').textContent();

    assert.strictEqual(intTotal?.trim(), '3', 'Interrupted Total = 3');
    assert.strictEqual(intSuccess?.trim(), '2', 'Interrupted Read Success = 2');
    assert.strictEqual(intFailed?.trim(), '0', 'Interrupted Read Failed = 0 (偽FAILEDなし)');

    console.log('  -> Interrupted Results DOM 正常確認完了 (05-interrupted-results.png 保存)');

    // ==========================================
    // シナリオ 6: Resume UI 操作 & 累積集計検証
    // ==========================================
    console.log('\n--- シナリオ 6: Resume UI 操作 & 累積集計検証 ---');
    await page.click('#btnResumePreflight');

    // Progress 画面への遷移と完了待機
    await page.waitForSelector('#screenProgress.active', { timeout: 5000 });
    console.log('  -> Resume 完了まで待機中 (最大 180 秒)...');
    await page.waitForFunction(
      () => document.getElementById('jobStateBadge')?.textContent?.trim() === 'COMPLETED',
      { timeout: 180000, polling: 1000 }
    );
    console.log('  -> Resume 完了 (jobState = COMPLETED)');

    // Results タブ確認
    await page.click('#tabResultsBtn');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '06-resumed-results.png') });

    const resTotal = await page.locator('#resTotal').textContent();
    const resSuccess = await page.locator('#resReadSuccess').textContent();
    const resFailed = await page.locator('#resReadFailed').textContent();
    const resDist3Plus = await page.locator('#dist3Plus').textContent();

    assert.strictEqual(resTotal?.trim(), '3', 'Resumed Total = 3');
    assert.strictEqual(resSuccess?.trim(), '3', 'Resumed Read Success = 3');
    assert.strictEqual(resFailed?.trim(), '0', 'Resumed Read Failed = 0');
    assert.strictEqual(resDist3Plus?.trim(), '3 校', 'Actions Distribution 3+ = 3校 (二重カウントなし)');

    console.log('  -> Resume 累積集計 DOM 正常確認完了 (06-resumed-results.png 保存)');

    // ==========================================
    // シナリオ 7: Refresh & Persistence 検証
    // ==========================================
    console.log('\n--- シナリオ 7: Refresh & Persistence 検証 ---');
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#tabResultsBtn');
    await page.click('button:has-text("最新結果を取得")');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07-reload-results.png') });

    const reloadTotal = await page.locator('#resTotal').textContent();
    const reloadSuccess = await page.locator('#resReadSuccess').textContent();
    assert.strictEqual(reloadTotal?.trim(), '3', 'Reload後 Total = 3');
    assert.strictEqual(reloadSuccess?.trim(), '3', 'Reload後 Success = 3');
    console.log('  -> ブラウザ再読み込み後も結果保持確認完了 (07-reload-results.png 保存)');

    // ==========================================
    // シナリオ 8: Web UI からの Report Download 検証
    // ==========================================
    console.log('\n--- シナリオ 8: Web UI からの Report Download 検証 ---');
    const downloads: { type: string; filename: string; content: any }[] = [];

    // Summary ダウンロード
    const [downloadSummary] = await Promise.all([
      page.waitForEvent('download'),
      page.click('a[href="/api/reports/download/summary"]')
    ]);
    const summaryPath = await downloadSummary.path();
    assert.ok(summaryPath, 'Summary download succeeded');
    const summaryContent = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
    downloads.push({ type: 'summary', filename: downloadSummary.suggestedFilename(), content: summaryContent });

    // Preflight ダウンロード
    const [downloadPreflight] = await Promise.all([
      page.waitForEvent('download'),
      page.click('a[href="/api/reports/download/preflight"]')
    ]);
    const pfPathDownloaded = await downloadPreflight.path();
    assert.ok(pfPathDownloaded, 'Preflight download succeeded');
    const pfContent = JSON.parse(fs.readFileSync(pfPathDownloaded, 'utf-8'));
    downloads.push({ type: 'preflight', filename: downloadPreflight.suggestedFilename(), content: pfContent });

    // Checkpoint ダウンロード
    const [downloadCheckpoint] = await Promise.all([
      page.waitForEvent('download'),
      page.click('a[href="/api/reports/download/checkpoint"]')
    ]);
    const cpPathDownloaded = await downloadCheckpoint.path();
    assert.ok(cpPathDownloaded, 'Checkpoint download succeeded');
    const cpContent = JSON.parse(fs.readFileSync(cpPathDownloaded, 'utf-8'));
    downloads.push({ type: 'checkpoint', filename: downloadCheckpoint.suggestedFilename(), content: cpContent });

    // 各ダウンロードファイルの秘密情報非露出チェック
    for (const d of downloads) {
      const jsonStr = JSON.stringify(d.content);
      assert.ok(!jsonStr.includes('password') || jsonStr.includes('"password":null') || jsonStr.includes('***'), `${d.type} に平文パスワードが含まれないこと`);
      assert.ok(!jsonStr.includes('admin123') && !jsonStr.includes('SecretPass'), `${d.type} に平文秘密情報が含まれないこと`);
      console.log(`  -> ${d.type} ダウンロード成功: ${d.filename} (平文秘密情報なし確認)`);
    }

    // ==========================================
    // シナリオ 9: DevTools エラー & 総合検証
    // ==========================================
    console.log('\n--- シナリオ 9: DevTools エラー集計 ---');
    console.log(`  Console Errors: ${metrics.consoleErrors.length}`);
    console.log(`  Page Errors: ${metrics.pageErrors.length}`);
    console.log(`  Localhost HTTP Errors: ${metrics.networkErrors.length}`);
    console.log(`  Handled Dialogs: ${metrics.handledDialogs.length}`);

    assert.strictEqual(metrics.consoleErrors.length, 0, 'Console Error が 0 件であること');
    assert.strictEqual(metrics.pageErrors.length, 0, 'Page Error が 0 件であること');
    assert.strictEqual(metrics.networkErrors.length, 0, 'Localhost HTTP Error (4xx/5xx) が 0 件であること');

    console.log('\n=== WEB UI END-TO-END SMOKE TEST SUCCESSFUL! ===\n');

  } finally {
    await browser.close();
  }
}

runE2E().catch((err) => {
  console.error('\n[FATAL] Web UI E2E Smoke Test Failed:', err);
  process.exit(1);
});
