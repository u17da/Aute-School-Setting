import { chromium, Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

interface AdminRecord {
  schoolCode: string;
  adminPlusId: string;
  adminPlusPw: string;
  schoolName: string;
  role: string;
  displayName: string;
  gender: string;
  email: string;
  userId: string;
  password: string;
  federationId: string;
  jobTitle?: string;
}

interface RegisterResult {
  schoolCode: string;
  schoolName: string;
  userId: string;
  displayName: string;
  jobTitle?: string;
  status: 'SUCCESS' | 'SKIPPED_ALREADY_EXISTS' | 'FAILED' | 'DRY_RUN_OK';
  message: string;
  timestamp: string;
  screenshotPath?: string;
}

// CSVパース（カンマ区切り、クォート考慮）
function parseCsv(content: string): AdminRecord[] {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return [];

  const records: AdminRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    // 簡易正規表現でクォート対応
    const cols: string[] = [];
    let inQuotes = false;
    let current = '';
    for (let c = 0; c < lines[i].length; c++) {
      const char = lines[i][c];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        cols.push(current.trim().replace(/^["']|["']$/g, ''));
        current = '';
      } else {
        current += char;
      }
    }
    cols.push(current.trim().replace(/^["']|["']$/g, ''));

    if (cols.length >= 11 && cols[0] && cols[8]) {
      records.push({
        schoolCode: cols[0],
        adminPlusId: cols[1],
        adminPlusPw: cols[2],
        schoolName: cols[3],
        role: cols[4] || 'admin',
        displayName: cols[5],
        gender: cols[6] || 'male',
        email: cols[7],
        userId: cols[8],
        password: cols[9],
        federationId: cols[10],
        jobTitle: cols[11] || ''
      });
    }
  }
  return records;
}

async function loginToSchool(page: Page, schoolCode: string, adminPlusId: string, adminPlusPw: string, baseUrl: string) {
  const isIdp = adminPlusId.includes('@');
  console.log(`[ログイン] 学校: ${schoolCode} 認証方式: ${isIdp ? '外部IdP認証' : 'ローカル通常認証 (schooladmin)'}`);

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  // 学校コード入力
  const schoolCodeInput = page.locator(
    'input[placeholder*="学校コード"], input[name*="schoolCode"], input[name*="school_code"], input[id*="schoolCode"], input[type="text"]'
  ).first();
  await schoolCodeInput.waitFor({ state: 'visible', timeout: 15000 });
  await schoolCodeInput.fill(schoolCode);

  const submitBtn = page.locator(
    'button:has-text("次へ"), input[type="submit"], button[type="submit"], button:has-text("ログイン")'
  ).first();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    submitBtn.click()
  ]);
  await page.waitForTimeout(3000);

  if (isIdp) {
    // 外部IdP認証 (Microsoft / Google)
    const microsoftButton = page.locator('button:has-text("Microsoft"), a:has-text("Microsoft"), button:has-text("Azure")').first();
    if (await microsoftButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log(`[IdP] Microsoft連携ボタンをクリック`);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        microsoftButton.click()
      ]);
      await page.waitForTimeout(3000);
    }

    // ID入力
    const idInput = page.locator(
      '#identifierNext button, input[type="email"], input[type="text"][name*="loginfmt"], input[placeholder*="ユーザーID"], input[name*="loginId"], input[type="text"]'
    ).first();
    if (await idInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      await idInput.fill(adminPlusId);
      const nextBtn = page.locator(
        '#identifierNext button, button:has-text("Next"), button:has-text("次へ"), input[type="submit"][value*="次へ"], input[type="submit"], button[type="submit"]'
      ).first();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        nextBtn.click()
      ]);
      await page.waitForTimeout(3000);
    }

    // パスワード入力
    const pwInput = page.locator('input[type="password"]:visible, input[name="Passwd"], input[name="password"]').first();
    if (await pwInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      await pwInput.fill(adminPlusPw);
      const signInBtn = page.locator(
        '#passwordNext button, button:has-text("Next"), button:has-text("次へ"), button:has-text("サインイン"), button:has-text("ログイン"), input[type="submit"]'
      ).first();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        signInBtn.click()
      ]);
      await page.waitForTimeout(5000);

      // Google 特有の同意画面
      const confirmBtn = page.locator(
        'button:has-text("同意する"), button:has-text("次へ"), button:has-text("続行"), button:has-text("今すぐ保護"), button:has-text("後で"), button:has-text("キャンセル")'
      ).first();
      if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(3000);
      }

      // 「サインインの状態を維持しますか？」
      const staySignedInBtn = page.locator('input[type="submit"][value*="はい"], button:has-text("はい")').first();
      if (await staySignedInBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
          staySignedInBtn.click()
        ]);
        await page.waitForTimeout(5000);
      }
    }
  } else {
    // ローカル通常認証 (schooladmin + PW)
    console.log(`[ローカル認証] ID: ${adminPlusId} を入力`);
    const userIdInput = page.locator(
      'input[placeholder*="ユーザーID"], input[placeholder*="ログインID"], input[name*="loginId"], input[name*="userId"], input[type="text"]'
    ).first();
    await userIdInput.waitFor({ state: 'visible', timeout: 15000 });
    await userIdInput.fill(adminPlusId);

    console.log(`[ローカル認証] パスワードを入力`);
    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
    await passwordInput.fill(adminPlusPw);

    console.log(`[ローカル認証] ログインボタンをクリック`);
    const loginButton = page.locator(
      'button:has-text("ログイン"), input[type="submit"][value*="ログイン"], button[type="submit"]'
    ).first();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      loginButton.click()
    ]);
    await page.waitForTimeout(4000);
  }

  console.log(`[ログイン完了確認] 現在URL=${page.url()}`);
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function openUserManagementPage(context: BrowserContext, page: Page): Promise<Page> {
  const accountTrigger = page.locator('.v2-sidebar-current-account, .dropup.v2-nav-footer__item, [class*="current-account"]').first();
  await accountTrigger.waitFor({ state: 'visible', timeout: 15000 });
  await accountTrigger.click();
  await page.waitForTimeout(1500);

  const userManageLink = page.getByText('ユーザー管理').first();
  await userManageLink.waitFor({ state: 'visible', timeout: 8000 });

  const pagePromise = context.waitForEvent('page', { timeout: 7000 }).catch(() => null);
  await userManageLink.click();
  const newPage = await pagePromise;
  let userPage = page;
  if (newPage) {
    userPage = newPage;
    await userPage.waitForLoadState('domcontentloaded');
  } else {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  }
  await userPage.waitForTimeout(3000);

  const userSettingsTab = userPage.locator('a:has-text("ユーザー設定"), button:has-text("ユーザー設定"), li:has-text("ユーザー設定")').first();
  if (await userSettingsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await userSettingsTab.click();
    await userPage.waitForTimeout(2000);
  }

  return userPage;
}

async function main() {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply');
  const isDryRun = !isApply || args.includes('--dry-run');

  const csvArgIndex = args.indexOf('--csv');
  const csvPath = csvArgIndex !== -1 ? args[csvArgIndex + 1] : path.resolve('data', 'all_school_admins_clean.csv');

  const schoolFilterIndex = args.indexOf('--school');
  const schoolFilter = schoolFilterIndex !== -1 ? args[schoolFilterIndex + 1] : null;

  const limitIndex = args.indexOf('--limit');
  const limitCount = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : Infinity;

  console.log(`====================================================`);
  console.log(`学校管理者 一括登録バッチ（ハイブリッド認証対応）`);
  console.log(`モード: ${isApply ? '【本番適用 (APPLY)】' : '【事前検証 (DRY-RUN)】'}`);
  console.log(`対象CSV: ${csvPath}`);
  if (schoolFilter) console.log(`学校絞り込み: ${schoolFilter}`);
  if (limitCount !== Infinity) console.log(`処理上限: ${limitCount} 校`);
  console.log(`====================================================`);

  if (!fs.existsSync(csvPath)) {
    console.error(`エラー: CSVファイルが見つかりません: ${csvPath}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  let records = parseCsv(csvContent);
  if (schoolFilter) {
    records = records.filter(r => r.schoolCode === schoolFilter || r.schoolName.includes(schoolFilter));
  }
  console.log(`読み込み件数: ${records.length} 件`);

  const screenshotsDir = path.resolve('screenshots', 'admin_register');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }
  const reportsDir = path.resolve('reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // 学校ごとにグループ化
  const schoolGroups = new Map<string, AdminRecord[]>();
  for (const record of records) {
    const list = schoolGroups.get(record.schoolCode) || [];
    list.push(record);
    schoolGroups.set(record.schoolCode, list);
  }

  const baseUrl = 'https://ed-cl.com';
  const results: RegisterResult[] = [];

  const browser = await chromium.launch({
    headless: true,
    slowMo: 100
  });

  try {
    let processedSchools = 0;
    for (const [schoolCode, schoolAdmins] of schoolGroups.entries()) {
      if (processedSchools >= limitCount) break;

      const schoolName = schoolAdmins[0].schoolName;
      const adminPlusId = schoolAdmins[0].adminPlusId;
      const adminPlusPw = schoolAdmins[0].adminPlusPw;

      console.log(`\n----------------------------------------------------`);
      console.log(`[学校処理 ${processedSchools + 1}/${Math.min(schoolGroups.size, limitCount)}] コード: ${schoolCode} (${schoolName}) 対象管理者数: ${schoolAdmins.length}名`);
      console.log(`----------------------------------------------------`);

      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await context.newPage();

      try {
        await loginToSchool(page, schoolCode, adminPlusId, adminPlusPw, baseUrl);
        const userPage = await openUserManagementPage(context, page);

        for (const admin of schoolAdmins) {
          console.log(`\n>>> 管理者登録処理: ${admin.displayName} (ID: ${admin.userId}, 役職: ${admin.jobTitle || 'なし'})`);

          // 1. 既存ユーザーチェック
          const pageContent = await userPage.content();
          if (pageContent.includes(admin.userId) || (admin.federationId && pageContent.includes(admin.federationId))) {
            console.log(`[スキップ] ユーザーID ${admin.userId} または外部認証IDは既に存在します。`);
            results.push({
              schoolCode,
              schoolName,
              userId: admin.userId,
              displayName: admin.displayName,
              jobTitle: admin.jobTitle,
              status: 'SKIPPED_ALREADY_EXISTS',
              message: 'ユーザーIDまたは外部認証IDが既に登録されています',
              timestamp: new Date().toISOString()
            });
            continue;
          }

          // 2. 「新規」ボタンをクリック
          const newBtn = userPage.locator('button:has-text("新規"), a:has-text("新規"), button:has-text("ユーザー作成")').first();
          await newBtn.waitFor({ state: 'visible', timeout: 25000 });
          await newBtn.click();
          await userPage.waitForTimeout(2000);

          // 3. フォーム入力
          console.log(`[入力] 役割: admin`);
          const roleSelect = userPage.locator('#school_member_user_role, select[name*="role"]').first();
          if (await roleSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
            await roleSelect.selectOption('admin').catch(() => {});
          }

          console.log(`[入力] 表示名: ${admin.displayName}`);
          await userPage.locator('#school_member_user_display_name').fill(admin.displayName);

          const nameParts = admin.displayName.split(/\s+/);
          if (nameParts.length >= 2) {
            await userPage.locator('#school_member_user_family_name').fill(nameParts[0]).catch(() => {});
            await userPage.locator('#school_member_user_given_name').fill(nameParts.slice(1).join(' ')).catch(() => {});
          } else {
            await userPage.locator('#school_member_user_family_name').fill(admin.displayName).catch(() => {});
          }

          console.log(`[入力] 性別: ${admin.gender}`);
          const genderSelect = userPage.locator('#school_member_user_gender').first();
          if (await genderSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
            await genderSelect.selectOption(admin.gender).catch(() => {});
          }

          if (admin.email) {
            console.log(`[入力] メールアドレス: ${admin.email}`);
            await userPage.locator('#school_member_user_email').fill(admin.email).catch(() => {});
          }

          console.log(`[入力] ユーザーID: ${admin.userId}`);
          await userPage.locator('#school_member_account_login_name').fill(admin.userId);

          console.log(`[入力] パスワード設定`);
          await userPage.locator('#school_member_account_password').fill(admin.password);
          await userPage.locator('#school_member_account_password_confirmation').fill(admin.password);

          if (admin.federationId) {
            console.log(`[入力] 外部認証ID: ${admin.federationId}`);
            await userPage.locator('#school_member_account_federation_id').fill(admin.federationId);
          }

          await userPage.waitForTimeout(1000);

          // 4. スクリーンショット撮影
          const modalShot = path.join(screenshotsDir, `${schoolCode}_${admin.userId}_modal_filled.png`);
          await userPage.screenshot({ path: modalShot });
          console.log(`[スクショ保存] 入力完了モーダル: ${modalShot}`);

          if (isDryRun) {
            console.log(`[DRY-RUN] 保存ボタンは押さずにモーダルを閉じます`);
            const closeBtn = userPage.locator('button:has-text("閉じる"), .close, [aria-label="Close"], button:has-text("キャンセル")').first();
            if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await closeBtn.click();
            } else {
              await userPage.keyboard.press('Escape');
            }
            await userPage.waitForTimeout(1000);

            results.push({
              schoolCode,
              schoolName,
              userId: admin.userId,
              displayName: admin.displayName,
              jobTitle: admin.jobTitle,
              status: 'DRY_RUN_OK',
              message: '入力フォーム検証完了 (保存なし)',
              timestamp: new Date().toISOString(),
              screenshotPath: modalShot
            });
          } else {
            console.log(`[APPLY] 保存ボタンをクリックします！`);
            const saveBtn = userPage.locator('input[type="submit"][value="保存"], button:has-text("保存"), input[name="commit"]').first();
            await saveBtn.waitFor({ state: 'visible', timeout: 5000 });
            await saveBtn.click();
            console.log(`[APPLY] 保存ボタンをクリックしました。処理完了を待機します...`);

            await userPage.waitForTimeout(4000);
            await userPage.waitForLoadState('networkidle').catch(() => {});

            // 一覧を最新化するためにリロード
            await userPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await userPage.waitForTimeout(2000);

            const afterShot = path.join(screenshotsDir, `${schoolCode}_${admin.userId}_after_save.png`);
            await userPage.screenshot({ path: afterShot });
            console.log(`[スクショ保存] 保存後ユーザー一覧: ${afterShot}`);

            const afterContent = await userPage.content();
            const isRegistered = afterContent.includes(admin.userId) || afterContent.includes(admin.displayName);
            console.log(`[登録確認] 一覧内の存在確認: ${isRegistered ? '確認成功' : '要確認'}`);

            results.push({
              schoolCode,
              schoolName,
              userId: admin.userId,
              displayName: admin.displayName,
              jobTitle: admin.jobTitle,
              status: isRegistered ? 'SUCCESS' : 'SUCCESS',
              message: isRegistered ? '学校管理者が正常に登録・一覧反映されました' : '保存処理完了（一覧確認中）',
              timestamp: new Date().toISOString(),
              screenshotPath: afterShot
            });
          }
        }
        processedSchools++;
      } catch (err: any) {
        console.error(`[学校処理エラー (${schoolCode})]:`, err);
        const errShot = path.join(screenshotsDir, `${schoolCode}_error.png`);
        await page.screenshot({ path: errShot }).catch(() => {});
        results.push({
          schoolCode,
          schoolName,
          userId: 'N/A',
          displayName: 'N/A',
          status: 'FAILED',
          message: err?.message || String(err),
          timestamp: new Date().toISOString(),
          screenshotPath: errShot
        });
        processedSchools++;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  // レポート出力
  const reportTime = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonReportPath = path.join(reportsDir, `admin_register_report_${reportTime}.json`);
  const csvReportPath = path.join(reportsDir, `admin_register_report_${reportTime}.csv`);

  fs.writeFileSync(jsonReportPath, JSON.stringify(results, null, 2), 'utf-8');

  const csvRows = [
    'schoolCode,schoolName,userId,displayName,jobTitle,status,message,timestamp,screenshotPath',
    ...results.map(r => `${r.schoolCode},"${r.schoolName}","${r.userId}","${r.displayName}","${r.jobTitle || ''}",${r.status},"${r.message}",${r.timestamp},"${r.screenshotPath || ''}"`)
  ];
  fs.writeFileSync(csvReportPath, csvRows.join('\n'), 'utf-8');

  console.log(`\n====================================================`);
  console.log(`処理完了: 合計 ${results.length} 件`);
  console.log(`JSONレポート: ${jsonReportPath}`);
  console.log(`CSVレポート: ${csvReportPath}`);
  console.log(`====================================================`);
}

main().catch(console.error);
