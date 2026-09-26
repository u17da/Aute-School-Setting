import { chromium } from 'playwright';
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { ConsoleServer } from '../src/console/server';
import { BatchProcessAdapter } from '../src/console/adapter';

async function runBrowserE2E() {
  console.log('=== Browser E2E: Localhost CSV Upload & Validation UI ===\n');

  const adapter = new BatchProcessAdapter();
  const server = new ConsoleServer({ port: 0, adapter });
  const port = await server.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  const metrics = {
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    networkErrors: [] as { url: string; status: number }[]
  };

  // テスト用の一時 1本化 CSV を作成 (BOM + CRLF, カンマ・クォート入り)
  const testCsvContent =
    '\uFEFFschoolCode,schoolName,userId,password,enabled\r\n' +
    'PRRHC,"MEXCBTデモ学校,特別室",user_prrhc,"pass,word!1",true\r\n' +
    'PAKCW,まなホーダイデモ学校,user_pakcw,pass2,true\r\n' +
    'PSD20,コンテンツデモ学校,user_psd20,pass3,true\r\n';

  const tmpCsvPath = path.resolve(process.cwd(), 'temp_test_unified.csv');
  fs.writeFileSync(tmpCsvPath, testCsvContent, 'utf-8');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error(`  [Browser Console Error]: ${msg.text()}`);
      metrics.consoleErrors.push(msg.text());
    }
  });

  page.on('pageerror', (err) => {
    console.error(`  [Browser Page Error]: ${err.message}`);
    metrics.pageErrors.push(err.message);
  });

  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('127.0.0.1') || url.includes('localhost')) {
      if (res.status() >= 400 && !url.includes('favicon.ico')) {
        console.warn(`  [Localhost HTTP Error]: ${res.status()} ${url}`);
        metrics.networkErrors.push({ url, status: res.status() });
      }
    }
  });

  try {
    // 1. ページロード
    console.log('[Step 1] Operator Console ページロード...');
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // 2. Upload コンテナの初期表示確認 (1本化確認)
    console.log('[Step 2] CSV アップロードゾーンが初期表示されていることを確認...');
    const uploadVisible = await page.locator('#uploadContainer').isVisible();
    assert.strictEqual(uploadVisible, true, 'Upload コンテナが初期状態で表示されていること');

    // 3. ファイル選択 (本物の 1本化 CSV config/schools.live.csv をインポート)
    const targetCsvPath = path.resolve(process.cwd(), 'config/schools.live.csv');
    console.log('[Step 3] 1本化 CSV (config/schools.live.csv) をインポート...');
    await page.setInputFiles('#schoolsFileInput', targetCsvPath);

    // 4. ファイル情報・安全 Preview 確認
    await page.waitForSelector('#uploadFileInfo:not([style*="display: none"])', { timeout: 5000 });
    const fileNameText = await page.locator('#uploadFileNameVal').textContent();
    assert.strictEqual(fileNameText?.trim(), 'schools.live.csv');
    console.log(`  -> ファイル名表示確認: ${fileNameText}`);

    // Preview テーブルに 3 行存在し、パスワードが露出していないこと
    const previewRows = await page.locator('#uploadPreviewBody tr').count();
    assert.strictEqual(previewRows, 3, 'Preview に 3 行表示されていること');
    const previewText = await page.locator('#uploadPreviewBody').textContent();
    assert.ok(!previewText?.toLowerCase().includes('password'), 'DOM に password 列が含まれないこと');
    assert.ok(!previewText?.includes('schooladmin'), 'DOM に userId が含まれないこと');
    console.log('  -> 安全 Preview 表示確認 (秘密情報非露出)');

    // 5. 想定有効学校数 Gate テスト
    console.log('[Step 4] 想定有効学校数に 3 を入力...');
    await page.fill('#inputExpectedSchoolCount', '3');
    await page.waitForTimeout(300);
    const badgeText = await page.locator('#expectedMatchBadge').textContent();
    console.log(`  -> Gate バッジ表示: ${badgeText}`);

    // 6. 「入力を検証」をクリック
    console.log('[Step 5] 「入力を検証」を実行...');
    await page.click('#btnValidate');

    // Validation PASS 待機
    await page.waitForSelector('#validationAlert:not([style*="display: none"])', { timeout: 10000 });
    const alertText = await page.locator('#validationAlert').textContent();
    assert.ok(alertText?.includes('入力検証に合格しました'), `Validation alert: ${alertText}`);
    console.log(`  -> 検証合格確認: ${alertText?.trim()}`);

    // MATCH バッジ確認
    const finalBadgeText = await page.locator('#expectedMatchBadge').textContent();
    assert.ok(finalBadgeText?.includes('MATCH (3校)'), `Gate バッジが MATCH (3校) であること: ${finalBadgeText}`);

    // Preflight 開始ボタンが活性化されたこと (ただしクリックはしない = 要件16)
    const isStartDisabled = await page.locator('#btnStartPreflight').isDisabled();
    assert.strictEqual(isStartDisabled, false, 'Preflight 開始ボタンが活性化していること');
    console.log('  -> Preflight 開始ボタン活性化確認 (実 Preflight は未起動)');

    // 7. Results タブ確認 (RESULTS_STALE バナーの表示確認)
    console.log('[Step 6] 「Preflight 結果サマリー」タブへ移動...');
    await page.click('#tabResultsBtn');
    await page.waitForTimeout(500);

    const staleAlertVisible = await page.locator('#resultsStaleAlertBox').isVisible();
    console.log(`  -> RESULTS_STALE アラート表示確認: visible=${staleAlertVisible}`);
    if (staleAlertVisible) {
      const staleText = await page.locator('#resultsStaleAlertBox').textContent();
      assert.ok(staleText?.includes('RESULTS_STALE'), 'RESULTS_STALE のテキストが含まれること');
    }

    // 8. エラーカウント検証
    assert.strictEqual(metrics.consoleErrors.length, 0, 'Browser Console Errors = 0');
    assert.strictEqual(metrics.pageErrors.length, 0, 'Browser Page Errors = 0');
    assert.strictEqual(metrics.networkErrors.length, 0, 'Localhost HTTP 4xx/5xx = 0');

    console.log('\n=== Browser E2E: ALL ASSERTIONS PASSED! ===');
  } finally {
    if (fs.existsSync(tmpCsvPath)) fs.unlinkSync(tmpCsvPath);
    await browser.close();
    await server.stop();
  }
}

runBrowserE2E().catch((err) => {
  console.error('Browser E2E failed:', err);
  process.exit(1);
});
