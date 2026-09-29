import { chromium } from 'playwright';
import * as path from 'path';

async function main() {
  const schoolCode = '75996';
  const userId = 'gakusyukei_nd26_01@oskedu.jp';
  const password = '20ntt26d';
  const baseUrl = 'https://ed-cl.com';

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const schoolCodeInput = page.locator('input[placeholder*="学校コード"], input[type="text"]').first();
    await schoolCodeInput.fill(schoolCode);

    const submitBtn = page.locator('button:has-text("次へ"), button[type="submit"]').first();
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}), submitBtn.click()]);
    await page.waitForTimeout(3000);

    const microsoftButton = page.locator('button:has-text("Microsoft"), a:has-text("Microsoft")').first();
    if (await microsoftButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await Promise.all([page.waitForNavigation().catch(() => {}), microsoftButton.click()]);
      await page.waitForTimeout(3000);
    }

    const idInput = page.locator('input[type="email"], input[type="text"]').first();
    if (await idInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      await idInput.fill(userId);
      const nextBtn = page.locator('#identifierNext button, button:has-text("Next"), button:has-text("次へ")').first();
      await Promise.all([page.waitForNavigation().catch(() => {}), nextBtn.click()]);
      await page.waitForTimeout(3000);
    }

    const pwInput = page.locator('input[type="password"]:visible').first();
    if (await pwInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      await pwInput.fill(password);
      const signInBtn = page.locator('#passwordNext button, button:has-text("サインイン")').first();
      await Promise.all([page.waitForNavigation().catch(() => {}), signInBtn.click()]);
      await page.waitForTimeout(5000);

      const confirmBtn = page.locator('button:has-text("同意する"), button:has-text("次へ")').first();
      if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(3000);
      }
      const staySignedInBtn = page.locator('input[type="submit"][value*="はい"], button:has-text("はい")').first();
      if (await staySignedInBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await Promise.all([page.waitForNavigation().catch(() => {}), staySignedInBtn.click()]);
        await page.waitForTimeout(5000);
      }
    }

    // ユーザー管理画面
    const accountTrigger = page.locator('.v2-sidebar-current-account, .dropup.v2-nav-footer__item').first();
    await accountTrigger.waitFor({ state: 'visible', timeout: 15000 });
    await accountTrigger.click();
    await page.waitForTimeout(1500);

    const userManageLink = page.getByText('ユーザー管理').first();
    const pagePromise = context.waitForEvent('page', { timeout: 7000 }).catch(() => null);
    await userManageLink.click();
    const newPage = await pagePromise;
    const userPage = newPage || page;
    await userPage.waitForLoadState('domcontentloaded');
    await userPage.waitForTimeout(3000);

    // クラス設定
    const classMenuLink = userPage.locator('a:has-text("クラス設定")').first();
    await classMenuLink.click();
    await userPage.waitForTimeout(2000);

    console.log('[クラス設定] 到達。クラスの追加ボタンをクリック...');
    const addBtn = userPage.locator('button:has-text("クラスの追加"), a:has-text("クラスの追加")').first();
    await addBtn.click();
    await userPage.waitForTimeout(2000);

    // スクリーンショット保存
    await userPage.screenshot({ path: path.resolve('screenshots', 'debug_class_add_after_click.png') });
    console.log('[スクショ保存] debug_class_add_after_click.png');

    // 画面内の input, select の全要素
    const elements = await userPage.locator('main table, table, form').first().evaluate((el) => {
      const inputs = Array.from(el.querySelectorAll('input, select')).map((e) => ({
        tagName: e.tagName,
        id: e.id,
        name: (e as HTMLInputElement).name,
        type: (e as HTMLInputElement).type,
        value: (e as HTMLInputElement).value,
        outerHTML: e.outerHTML.substring(0, 150)
      }));
      const rows = Array.from(el.querySelectorAll('tr')).map((r) => ({
        text: (r as HTMLElement).innerText.trim().replace(/\s+/g, ' '),
        html: r.innerHTML.substring(0, 200)
      }));
      return { inputs, rows };
    });

    console.log('[テーブル内要素]:', JSON.stringify(elements, null, 2));

  } finally {
    await browser.close();
  }
}

main();
