import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import * as assert from 'assert';
import * as dotenv from 'dotenv';
import { ConsoleServer } from '../src/console/server';

dotenv.config();

async function main() {
  console.log('=== Phase 5B.5: Live Canary 1-School Execution (PAKCW) ===');
  console.log('Target School: PAKCW (まなホーダイデモ学校)');
  console.log('Target Setting: studentPasswordChange (HIDE -> SHOW)');
  console.log('Base URL:', process.env.MANAPOKE_BASE_URL || 'https://ed-cl.com');

  const screenshotsDir = path.resolve(process.cwd(), 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  // 1. Operator Console サーバー起動 (実環境設定)
  const consoleServer = new ConsoleServer({ port: 0 });
  await consoleServer.start();
  const consolePort = consoleServer.getPort();
  const consoleBaseUrl = `http://127.0.0.1:${consolePort}`;
  console.log(`[ConsoleServer] Operator Console listening on ${consoleBaseUrl}`);

  // 子プロセスの stdout/stderr を中継
  consoleServer.adapter.on('log', (line) => {
    console.log(`  [Subprocess] ${line}`);
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // 自動ダイアログ承認
  page.on('dialog', async (dialog) => {
    console.log(`  [Dialog] ${dialog.type()}: ${dialog.message()}`);
    await dialog.accept();
  });

  // ブラウザコンソールログ転送
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.text().includes('【') || msg.text().includes('ERROR')) {
      console.log(`  [BrowserConsole:${msg.type()}] ${msg.text()}`);
    }
  });

  try {
    // -------------------------------------------------------------------------
    // Step 1: Console UI アクセス & CSV アップロード (PAKCW 1校のみ)
    // -------------------------------------------------------------------------
    console.log('\n[Step 1] Operator Console UI へアクセス & CSV アップロード...');
    await page.goto(consoleBaseUrl, { waitUntil: 'networkidle' });

    const csvPath = path.resolve(process.cwd(), 'config/schools.live-canary-pakcw.csv');
    assert.strictEqual(fs.existsSync(csvPath), true, 'config/schools.live-canary-pakcw.csv が存在すること');

    const fileInput = page.locator('#schoolsFileInput');
    await fileInput.setInputFiles(csvPath);
    await page.waitForSelector('#uploadFileInfo:not([style*="display: none"])', { timeout: 10000 });

    const uploadStats = await page.locator('#uploadParsedStatsVal').innerText();
    console.log(`  Upload Stats: ${uploadStats}`);
    assert.strictEqual(uploadStats.includes('1 校'), true, '有効学校数が 1 校であること');

    // -------------------------------------------------------------------------
    // Step 2: expectedSchoolCount 入力 (1) & Profile Editor 設定
    // -------------------------------------------------------------------------
    console.log('\n[Step 2] expectedSchoolCount 入力 (1) & studentPasswordChange: SHOW 設定...');
    await page.fill('#inputExpectedSchoolCount', '1');

    // 「全項目維持」または全項目 UNMANAGED から、studentPasswordChange のみ SHOW に変更
    // まず念のため全項目を UNMANAGED にリセット
    const selects = await page.locator('#profileEditorTableBody select').all();
    for (const sel of selects) {
      await sel.selectOption('__UNMANAGED__');
    }
    await page.waitForTimeout(300);

    // 児童・生徒へパスワード変更を表示 (studentPasswordChange) を SHOW に設定
    const targetSelect = page.locator('tr:has-text("児童・生徒へパスワード変更を表示") select');
    await targetSelect.selectOption('SHOW');
    await page.waitForTimeout(500);

    // -------------------------------------------------------------------------
    // Step 3: 入力検証 (--validate-only)
    // -------------------------------------------------------------------------
    console.log('\n[Step 3] 入力を検証 (--validate-only)...');
    await page.click('#btnValidate');
    await page.waitForSelector('#validationAlert.alert-success', { timeout: 10000 });
    await page.waitForSelector('#btnStartPreflight:not([disabled])', { timeout: 10000 });

    const snapCount = await page.locator('#enabledSchoolsVal').innerText();
    console.log(`  Validated Schools: ${snapCount}`);
    assert.strictEqual(snapCount.includes('1 校'), true);

    // -------------------------------------------------------------------------
    // Step 4: Read-only Preflight 実行 & 完了待機
    // -------------------------------------------------------------------------
    console.log('\n[Step 4] Read-only Preflight 実行...');
    await page.click('#btnStartPreflight');

    console.log('  Preflight 完了待機中 (RUNNING -> COMPLETED)...');
    await page.waitForFunction(() => {
      const badge = document.getElementById('jobStateBadge');
      return badge && badge.textContent && badge.textContent.includes('RUNNING');
    }, null, { timeout: 10000 });
    await page.waitForFunction(() => {
      const badge = document.getElementById('jobStateBadge');
      return badge && badge.textContent && badge.textContent.includes('COMPLETED');
    }, null, { timeout: 120000 });
    console.log('  Preflight 完了検知！');

    // -------------------------------------------------------------------------
    // Step 5: Results 画面確認 & 厳格な Gate 条件照合
    // -------------------------------------------------------------------------
    console.log('\n[Step 5] Preflight 結果確認 & Gate 条件の厳格照合...');
    await page.click('#tabResultsBtn');
    await page.waitForSelector('#screenResults.active', { timeout: 5000 });
    await page.click('button:has-text("最新結果を取得")');
    await page.waitForTimeout(1000);

    // 最新 Preflight レポートの取得
    const reportsDir = path.resolve(process.cwd(), 'reports');
    const pfFiles = fs.readdirSync(reportsDir).filter((f) => f.startsWith('preflight-') && f.endsWith('.json'));
    pfFiles.sort((a, b) => fs.statSync(path.join(reportsDir, b)).mtimeMs - fs.statSync(path.join(reportsDir, a)).mtimeMs);
    const latestPf = JSON.parse(fs.readFileSync(path.join(reportsDir, pfFiles[0]), 'utf-8'));

    console.log('  [Preflight Report Summary]:');
    console.log(`    Total Schools: ${latestPf.total}`);
    console.log(`    Read Success: ${latestPf.readSuccess}`);
    console.log(`    Read Failed: ${latestPf.readFailed}`);
    console.log(`    Requires Change: ${latestPf.requiresChange}`);
    console.log(`    Destructive Schools: ${latestPf.destructiveChangeSchools}`);
    console.log(`    Plan Blocked: ${latestPf.planBlocked}`);
    console.log(`    Write Gate Eligible: ${latestPf.writeGateEligible}`);

    const targetSchool = latestPf.schools?.[0];
    assert.strictEqual(targetSchool?.schoolCode, 'PAKCW', '対象校コードが PAKCW であること');
    assert.strictEqual(latestPf.total, 1, '対象学校数が 1 であること');
    assert.strictEqual(latestPf.readFailed, 0, 'readFailed が 0 であること');
    assert.strictEqual(latestPf.planBlocked, 0, 'planBlocked が 0 であること');
    assert.strictEqual(latestPf.destructiveChangeSchools, 0, 'hasDestructiveChanges が false (0校) であること');
    assert.strictEqual(latestPf.requiresChange, 1, 'Requires Change が 1 であること');
    assert.strictEqual(latestPf.writeGateEligible, true, 'Write Gate が合格 (true) であること');
    assert.strictEqual(targetSchool?.writeEligible, true, '対象校の writeEligible が true であること');

    // 最新 Summary レポートから plannedActions の詳細を取得
    const summaryFiles = fs.readdirSync(reportsDir).filter((f) => f.startsWith('summary-') && f.endsWith('.json'));
    summaryFiles.sort((a, b) => fs.statSync(path.join(reportsDir, b)).mtimeMs - fs.statSync(path.join(reportsDir, a)).mtimeMs);
    const latestSummary = JSON.parse(fs.readFileSync(path.join(reportsDir, summaryFiles[0]), 'utf-8'));
    const summarySchool = latestSummary.schoolResults?.[0];

    // ExecutionPlan の確認
    assert.strictEqual(targetSchool?.actionsCount, 1, 'targetSchool.actionsCount が 1 であること');
    assert.strictEqual(summarySchool?.actionsCount, 1, 'summarySchool.actionsCount が 1 であること');
    assert.strictEqual(summarySchool?.before?.studentPasswordChange, 'HIDE', 'Before が HIDE であること');
    assert.strictEqual(summarySchool?.requested?.studentPasswordChange, 'SHOW', 'Requested が SHOW であること');

    // 個別ログから ExecutionPlan の actions を詳細確認
    const logsDir = path.resolve(process.cwd(), 'logs');
    const resultFiles = fs.readdirSync(logsDir).filter((f) => f.startsWith('result-PAKCW-') && f.endsWith('.json'));
    resultFiles.sort((a, b) => fs.statSync(path.join(logsDir, b)).mtimeMs - fs.statSync(path.join(logsDir, a)).mtimeMs);
    const latestResult = JSON.parse(fs.readFileSync(path.join(logsDir, resultFiles[0]), 'utf-8'));
    const actions = latestResult.executionPlan?.actions || [];
    console.log('    Actions count:', actions.length);
    console.log('    Actions detail:', actions);
    assert.strictEqual(actions.length, 1, 'actions.length が厳格に 1 であること');
    assert.strictEqual(actions[0].settingKey, 'studentPasswordChange', 'Action 対象が studentPasswordChange であること');
    assert.strictEqual(actions[0].from, 'HIDE', '変更元が HIDE であること');
    assert.strictEqual(actions[0].to, 'SHOW', '変更先が SHOW であること');

    // UI 上の Gate バッジ確認
    await page.waitForSelector('#tabApplyBtn:not([disabled])', { timeout: 10000 });
    await page.click('#tabApplyBtn');
    await page.waitForSelector('#screenApply.active', { timeout: 5000 });

    const gateBadge = await page.locator('#applyGateBadge').innerText();
    console.log(`  Gate Badge: ${gateBadge}`);
    assert.strictEqual(gateBadge.includes('合格') || gateBadge.includes('Eligible'), true, 'Global Gate が合格であること');

    // -------------------------------------------------------------------------
    // Step 6: Production Apply 準備 (Prepare) & モーダル確認
    // -------------------------------------------------------------------------
    console.log('\n[Step 6] Production Apply 準備 (Prepare) & 確認モーダル...');
    await page.click('#btnPrepareApply');
    await page.waitForSelector('#applyConfirmModal[style*="display: flex"]', { timeout: 10000 });

    const modalTargetCount = await page.locator('#modalTargetCount').innerText();
    const modalSkipped = await page.locator('#modalSkippedDestructive').innerText();
    const modalAlready = await page.locator('#modalAlreadyConfigured').innerText();
    const modalTargetHash = await page.locator('#modalApplyTargetHashVal').innerText();
    const modalProfileHash = await page.locator('#modalProfileHashVal').innerText();

    console.log(`  Modal Target Count: ${modalTargetCount}`);
    console.log(`  Modal Skipped Destructive: ${modalSkipped}`);
    console.log(`  Modal Already Configured: ${modalAlready}`);
    console.log(`  Modal ApplyTargetHash: ${modalTargetHash}`);
    console.log(`  Modal ProfileHash: ${modalProfileHash}`);

    assert.strictEqual(modalTargetCount, '1 校');
    assert.strictEqual(modalSkipped, '0 校');
    assert.strictEqual(modalAlready, '0 校');
    assert.strictEqual(modalTargetHash.length > 10, true);
    assert.strictEqual(modalProfileHash.length > 10, true);

    // チェックボックス ON
    console.log('  チェックボックスを ON にして本番適用を承認...');
    await page.check('#modalConfirmCheckbox');
    await page.waitForTimeout(500);

    // -------------------------------------------------------------------------
    // Step 7: Production Apply 実行 (Save POST 最大1回)
    // -------------------------------------------------------------------------
    console.log('\n[Step 7] 「非破壊変更を本番適用する」をクリック (Production Apply 実行)...');
    await page.click('#btnExecuteApply');

    console.log('  Production Apply 実行中 (RUNNING -> COMPLETED)...');
    await page.waitForFunction(() => {
      const badge = document.getElementById('jobStateBadge');
      return badge && badge.textContent && badge.textContent.includes('RUNNING');
    }, null, { timeout: 10000 });
    await page.waitForFunction(() => {
      const badge = document.getElementById('jobStateBadge');
      return badge && badge.textContent && badge.textContent.includes('COMPLETED');
    }, null, { timeout: 120000 });
    console.log('  Production Apply 完了検知！');

    // -------------------------------------------------------------------------
    // Step 8: Canary 結果確認 & スクリーンショット保存
    // -------------------------------------------------------------------------
    console.log('\n[Step 8] Canary 実行結果の確認...');
    await page.click('#tabResultsBtn');
    await page.waitForSelector('#screenResults.active', { timeout: 5000 });
    await page.click('button:has-text("最新結果を取得")');
    await page.waitForTimeout(1000);

    // スクリーンショット保存
    const ssPath = path.join(screenshotsDir, 'phase5b5_live_canary_pakcw_result.png');
    await page.screenshot({ path: ssPath, fullPage: true });
    console.log(`  [Screenshot Saved]: ${ssPath}`);

    // 最新 Checkpoint を確認
    const cpDir = path.resolve(process.cwd(), 'checkpoints');
    const cpFiles = fs.readdirSync(cpDir).filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'));
    cpFiles.sort((a, b) => fs.statSync(path.join(cpDir, b)).mtimeMs - fs.statSync(path.join(cpDir, a)).mtimeMs);
    const latestCp = JSON.parse(fs.readFileSync(path.join(cpDir, cpFiles[0]), 'utf-8'));

    const pakcwEntry = latestCp.entries['PAKCW'];
    console.log('\n================================================================');
    console.log('                   LIVE CANARY RESULT: PAKCW                    ');
    console.log('================================================================');
    console.log(`  School Code:      PAKCW`);
    console.log(`  Status:           ${pakcwEntry?.status}`);
    console.log(`  Execution Status: ${pakcwEntry?.executionStatus}`);
    console.log(`  Error:            ${pakcwEntry?.error || 'None'}`);
    console.log('================================================================\n');

    if (pakcwEntry?.status === 'SUCCESS' || pakcwEntry?.status === 'SUCCESS_RECOVERED') {
      console.log('✓【CANARY SUCCESS】PAKCW に対する非破壊変更 (studentPasswordChange: SHOW) の適用が正常に完了しました！');
    } else if (pakcwEntry?.status === 'SAVE_FAILED_KNOWN' || pakcwEntry?.status === 'SAVE_OUTCOME_UNKNOWN') {
      console.error(`✗【CANARY FAILED/UNKNOWN】${pakcwEntry?.status} が検知されたため、即時停止します (再実行禁止)`);
      process.exit(1);
    } else {
      console.error(`✗【UNEXPECTED STATUS】予期せぬステータス: ${pakcwEntry?.status}`);
      process.exit(1);
    }

  } finally {
    await browser.close();
    await consoleServer.stop();
  }
}

main().catch((err) => {
  console.error('Fatal error during Live Canary execution:', err);
  process.exit(1);
});
