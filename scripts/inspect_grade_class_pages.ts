import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const screenshotsDir = path.resolve('screenshots', 'grade_class_inspection');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const schoolCode = '75996'; // 大阪市立堀川小学校
  const userId = 'gakusyukei_nd26_01@oskedu.jp';
  const password = '20ntt26d';
  const baseUrl = 'https://ed-cl.com';

  console.log(`[調査開始] ブラウザを起動します (headless: true)...`);
  const browser = await chromium.launch({
    headless: true,
    slowMo: 100
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();

  try {
    console.log(`[ステップ 1] まなびポケット トップ画面へアクセス: ${baseUrl}`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    console.log(`[ステップ 2] 学校コード入力: ${schoolCode}`);
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

    // Microsoft連携ボタンがあるか
    const microsoftButton = page.locator('button:has-text("Microsoft"), a:has-text("Microsoft"), button:has-text("Azure")').first();
    if (await microsoftButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log(`[ステップ 3] Microsoft連携ボタンをクリック`);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        microsoftButton.click()
      ]);
      await page.waitForTimeout(3000);
    }

    // ID入力
    const idInput = page.locator(
      'input[type="email"], input[type="text"][name*="loginfmt"], input[placeholder*="ユーザーID"], input[name*="loginId"], input[type="text"]'
    ).first();
    if (await idInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      console.log(`[ステップ 4] ID入力: ${userId}`);
      await idInput.fill(userId);
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
      console.log(`[ステップ 5] パスワード入力`);
      await pwInput.fill(password);
      const signInBtn = page.locator(
        '#passwordNext button, button:has-text("Next"), button:has-text("次へ"), button:has-text("サインイン"), button:has-text("ログイン"), input[type="submit"]'
      ).first();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        signInBtn.click()
      ]);
      await page.waitForTimeout(5000);

      const confirmBtn = page.locator(
        'button:has-text("同意する"), button:has-text("次へ"), button:has-text("続行"), button:has-text("今すぐ保護"), button:has-text("後で"), button:has-text("キャンセル")'
      ).first();
      if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log(`[ステップ 5.1] Google確認・同意画面: クリック`);
        await confirmBtn.click();
        await page.waitForTimeout(3000);
      }

      const staySignedInBtn = page.locator('input[type="submit"][value*="はい"], button:has-text("はい")').first();
      if (await staySignedInBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log(`[ステップ 6] サインイン維持確認: 「はい」をクリック`);
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
          staySignedInBtn.click()
        ]);
        await page.waitForTimeout(5000);
      }
    }

    console.log(`[ステップ 7] ログイン完了確認: 現在URL=${page.url()}`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // アカウントメニューを開く
    const accountTrigger = page.locator('.v2-sidebar-current-account, .dropup.v2-nav-footer__item, [class*="current-account"]').first();
    await accountTrigger.waitFor({ state: 'visible', timeout: 15000 });
    console.log(`[ステップ 8] アカウントメニューをクリック`);
    await accountTrigger.click();
    await page.waitForTimeout(1500);

    // 「ユーザー管理」をクリック
    console.log(`[ステップ 9] 「ユーザー管理」をクリック`);
    const userManageLink = page.getByText('ユーザー管理').first();
    await userManageLink.waitFor({ state: 'visible', timeout: 8000 });

    let userPage = page;
    const pagePromise = context.waitForEvent('page', { timeout: 7000 }).catch(() => null);
    await userManageLink.click();
    const newPage = await pagePromise;
    if (newPage) {
      console.log(`[新規タブ検出] ユーザー管理画面が別タブで開きました`);
      userPage = newPage;
      await userPage.waitForLoadState('domcontentloaded');
    } else {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }

    await userPage.waitForTimeout(3000);
    console.log(`[ステップ 10] ユーザー管理画面到達: ${userPage.url()}`);

    // --- 学年設定画面の調査 ---
    console.log(`\n========================================`);
    console.log(`[調査] 学年設定画面の確認`);
    console.log(`========================================`);
    const gradeMenuLink = userPage.locator('a:has-text("学年設定"), li:has-text("学年設定")').first();
    await gradeMenuLink.waitFor({ state: 'visible', timeout: 8000 });
    await gradeMenuLink.click();
    await userPage.waitForTimeout(3000);

    const gradeShotPath = path.join(screenshotsDir, '01_grade_settings.png');
    await userPage.screenshot({ path: gradeShotPath });
    console.log(`[スクショ保存] 学年設定画面: ${gradeShotPath}`);

    // テーブル内のテキスト一覧を取得
    const gradeRows = await userPage.locator('table tr, [class*="row"], [class*="item"]').evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).innerText.trim().replace(/\s+/g, ' ')).filter((t) => t.length > 0)
    );
    console.log(`[学年設定 画面テキスト/行一覧] (件数: ${gradeRows.length}):`);
    gradeRows.slice(0, 15).forEach((r, idx) => console.log(`  Row ${idx}: ${r}`));

    // 「新規」ボタンの調査
    const newGradeBtn = userPage.locator('button:has-text("新規"), a:has-text("新規")').first();
    const newGradeVisible = await newGradeBtn.isVisible().catch(() => false);
    console.log(`[学年設定 「新規」ボタン検出]: ${newGradeVisible}`);

    if (newGradeVisible) {
      console.log(`[学年設定 「新規」ボタンをクリックしてモーダルを調査]`);
      await newGradeBtn.click();
      await userPage.waitForTimeout(2000);

      const modalShotPath = path.join(screenshotsDir, '02_grade_modal.png');
      await userPage.screenshot({ path: modalShotPath });
      console.log(`[スクショ保存] 学年新規登録モーダル: ${modalShotPath}`);

      const inputs = await userPage.locator('input, select, [role="combobox"]').evaluateAll((els) =>
        els.map((e) => ({
          tagName: e.tagName,
          id: e.id,
          name: (e as HTMLInputElement).name,
          type: (e as HTMLInputElement).type,
          placeholder: (e as HTMLInputElement).placeholder,
          outerHTML: e.outerHTML.substring(0, 150)
        }))
      );
      console.log(`[学年新規登録 フォーム入力要素]:`, JSON.stringify(inputs, null, 2));

      // 閉じる/キャンセルボタンまたは「×」
      const closeBtn = userPage.locator('button:has-text("キャンセル"), [aria-label*="close"], [class*="close"], button:has-text("×")').first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
        await userPage.waitForTimeout(1500);
      }
    }

    // --- クラス設定画面の調査 ---
    console.log(`\n========================================`);
    console.log(`[調査] クラス設定画面の確認`);
    console.log(`========================================`);
    const classMenuLink = userPage.locator('a:has-text("クラス設定"), li:has-text("クラス設定")').first();
    await classMenuLink.waitFor({ state: 'visible', timeout: 8000 });
    await classMenuLink.click();
    await userPage.waitForTimeout(3000);

    const classShotPath = path.join(screenshotsDir, '03_class_settings.png');
    await userPage.screenshot({ path: classShotPath });
    console.log(`[スクショ保存] クラス設定画面: ${classShotPath}`);

    const classRows = await userPage.locator('table tr, [class*="row"]').evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).innerText.trim().replace(/\s+/g, ' ')).filter((t) => t.length > 0)
    );
    console.log(`[クラス設定 画面テキスト/行一覧] (件数: ${classRows.length}):`);
    classRows.slice(0, 15).forEach((r, idx) => console.log(`  Row ${idx}: ${r}`));

    // クラス追加ボタン
    const addClassBtn = userPage.locator('button:has-text("クラスの追加"), button:has-text("追加"), a:has-text("クラスの追加")').first();
    const addClassVisible = await addClassBtn.isVisible().catch(() => false);
    console.log(`[クラス設定 「クラスの追加」ボタン検出]: ${addClassVisible}`);

    console.log(`\n調査完了！`);
  } catch (err) {
    console.error(`調査中エラー発生:`, err);
  } finally {
    await browser.close();
  }
}

main();
