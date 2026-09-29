import { chromium } from 'playwright';

async function test() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  console.log('Navigating to login...');
  await page.goto('https://ed-cl.com');

  await page.fill('input[placeholder*="学校コード"], input[type="text"]', '26762');
  await page.click('button:has-text("次へ"), input[type="submit"]');
  await page.waitForTimeout(2000);

  await page.fill('input[type="text"]:visible', 'schooladmin');
  await page.fill('input[type="password"]:visible', 'hfEYGj44');
  await page.click('input[type="submit"][value*="ログイン"], button:has-text("ログイン")');
  await page.waitForTimeout(5000);

  // 左下 (x: 35, y: 860) をクリック
  console.log('Clicking bottom-left account area...');
  await page.mouse.click(35, 860);
  await page.waitForTimeout(2000);

  const pagePromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await page.locator('a:has-text("ユーザー管理"), li:has-text("ユーザー管理")').first().click();
  const userPage = await pagePromise;
  console.log('User page opened:', !!userPage);
  if (userPage) {
    await userPage.waitForLoadState('domcontentloaded');
    console.log('User page URL:', userPage.url());

    const gradeLink = userPage.locator('a:has-text("学年設定"), li:has-text("学年設定")').first();
    await gradeLink.waitFor({ state: 'visible', timeout: 10000 });
    console.log('Grade link visible!');
    await gradeLink.click();
    await userPage.waitForTimeout(2000);
    await userPage.screenshot({ path: 'screenshots/debug_grade_opened.png', animations: 'disabled', timeout: 10000 });
    console.log('Grade page screenshot taken!');
  }

  await browser.close();
}

test().catch(console.error);
