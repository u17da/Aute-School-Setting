import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const screenshotsDir = path.resolve('screenshots', 'admin_preview');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const schoolCode = '75996'; // 大阪市立堀川小学校
  const userId = 'gakusyukei_nd26_01@oskedu.jp';
  const password = '20ntt26d';
  const baseUrl = 'https://ed-cl.com';

  console.log(`[検証開始] ブラウザを起動します (headless: true)...`);
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

      // Google 特有の「同意する」「次へ」「続行」画面等の処理
      const confirmBtn = page.locator(
        'button:has-text("同意する"), button:has-text("次へ"), button:has-text("続行"), button:has-text("今すぐ保護"), button:has-text("後で"), button:has-text("キャンセル")'
      ).first();
      if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log(`[ステップ 5.1] Google確認・同意画面を検出: クリックします`);
        await confirmBtn.click();
        await page.waitForTimeout(3000);
      }

      // 「サインインの状態を維持しますか？」
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
    
    // アカウントメニュー展開時のスクショも撮っておく
    await page.screenshot({ path: path.join(screenshotsDir, '00_account_menu.png') });

    // リンクの属性を確認
    const href = await userManageLink.getAttribute('href');
    const target = await userManageLink.getAttribute('target');
    console.log(`[ユーザー管理リンク属性] href=${href}, target=${target}`);

    let userPage = page;
    // 新規タブが開く場合と同一タブで遷移する場合の両方に対応
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
    const userListShotPath = path.join(screenshotsDir, '01_user_management_list.png');
    await userPage.screenshot({ path: userListShotPath });
    console.log(`[スクショ保存] ユーザー一覧: ${userListShotPath}`);

    // 「ユーザー設定」リンク（サイドバー）があるか確認し、あればクリック
    const userSettingsTab = userPage.locator('a:has-text("ユーザー設定"), button:has-text("ユーザー設定"), li:has-text("ユーザー設定")').first();
    if (await userSettingsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log(`[ステップ 10.1] 「ユーザー設定」タブをクリック`);
      await userSettingsTab.click();
      await userPage.waitForTimeout(2000);
    }

    // 「新規」ボタンを探す
    console.log(`[ステップ 11] 「新規」ボタンを探します...`);
    const newBtn = userPage.locator('button:has-text("新規"), a:has-text("新規"), button:has-text("ユーザー作成")').first();
    await newBtn.waitFor({ state: 'visible', timeout: 10000 });
    console.log(`[ステップ 11] 「新規」ボタンをクリック`);
    await newBtn.click();
    await userPage.waitForTimeout(3000);

    // 新規登録画面/モーダルの表示確認
    const modalShotPath = path.join(screenshotsDir, '02_new_user_modal.png');
    await userPage.screenshot({ path: modalShotPath });
    console.log(`[スクショ保存] 新規登録モーダル: ${modalShotPath}`);

    // 役割の選択要素を確認
    console.log(`[ステップ 12] 「役割」選択要素の調査...`);
    const roleSelect = userPage.locator('select[name*="role"], select#role, [name*="role"]').first();

    // フォーム内の全input, select, textarea, buttonを列挙
    const formInputs = await userPage.locator('input, select, textarea').evaluateAll((els) =>
      els.map((e) => ({
        tag: e.tagName,
        type: e.getAttribute('type'),
        name: e.getAttribute('name'),
        id: e.getAttribute('id'),
        placeholder: e.getAttribute('placeholder')
      }))
    );
    console.log(`[検出されたフォーム項目]:`, JSON.stringify(formInputs, null, 2));

    // selectタグがある場合
    if (await roleSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      const options = await roleSelect.locator('option').allTextContents();
      console.log(`[役割 selectの選択肢]:`, options);
    }

    // 画面下部（パスワード・外部認証ID入力部）へスクロールして撮影
    await userPage.locator('#school_member_account_federation_id').scrollIntoViewIfNeeded().catch(() => {});
    await userPage.waitForTimeout(500);
    const bottomShotPath = path.join(screenshotsDir, '03_new_user_modal_bottom.png');
    await userPage.screenshot({ path: bottomShotPath });
    console.log(`[スクショ保存] 新規登録モーダル下部: ${bottomShotPath}`);

    // 「保存」ボタンは絶対に押さない！
    console.log(`[検証完了] 安全のため「保存」ボタンは押さずに終了します。`);

    // 画面全体の高解像度フルスクリーンショット
    const fullShotPath = path.join(screenshotsDir, '04_creation_preview_full.png');
    await userPage.screenshot({ path: fullShotPath, fullPage: true });
    console.log(`[スクショ保存] フル画面: ${fullShotPath}`);


  } catch (err: any) {
    console.error(`[検証エラー]:`, err);
    await page.screenshot({ path: path.join(screenshotsDir, '99_error.png') }).catch(() => {});
  } finally {
    await browser.close();
    console.log(`[ブラウザ終了] 検証が正常に終了しました。`);
  }
}

main().catch(console.error);
