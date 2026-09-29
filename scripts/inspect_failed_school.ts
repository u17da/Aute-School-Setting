import { chromium } from 'playwright';

async function test() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  console.log('Logging in to 56233 (長吉東小学校)...');
  await page.goto('https://ed-cl.com');
  await page.fill('input[placeholder*="学校コード"], input[type="text"]', '56233');
  await page.click('button:has-text("次へ"), input[type="submit"]');
  await page.waitForTimeout(2000);

  await page.fill('input[type="text"]:visible', 'schooladmin');
  await page.fill('input[type="password"]:visible', '34RpY3JL');
  await page.click('input[type="submit"][value*="ログイン"], button:has-text("ログイン")');
  await page.waitForTimeout(5000);

  // ユーザー管理へ
  await page.mouse.click(35, 860);
  await page.waitForTimeout(1500);

  const pagePromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await page.locator('a:has-text("ユーザー管理"), li:has-text("ユーザー管理")').first().click();
  const userPage = await pagePromise;
  if (!userPage) {
    console.log('Failed to open userPage');
    await browser.close();
    return;
  }

  await userPage.waitForLoadState('domcontentloaded');
  await userPage.waitForTimeout(2000);

  // 学年設定へ
  const gradeMenuLink = userPage.locator('a:has-text("学年設定"), li:has-text("学年設定")').first();
  await gradeMenuLink.click();
  await userPage.waitForTimeout(3000);

  await userPage.screenshot({ path: 'screenshots/debug_56233_grades.png', animations: 'disabled' });
  console.log('Screenshot of grades taken!');

  // クラス設定へも行ってみる
  const classMenuLink = userPage.locator('a:has-text("クラス設定"), li:has-text("クラス設定")').first();
  await classMenuLink.click();
  await userPage.waitForTimeout(3000);

  await userPage.screenshot({ path: 'screenshots/debug_56233_classes.png', animations: 'disabled' });
  console.log('Screenshot of classes taken!');

  await browser.close();
}

test().catch(console.error);
