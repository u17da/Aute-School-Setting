import { chromium } from 'playwright';

async function main() {
  const schoolCode = '75996'; // 大阪市立堀川小学校
  const userId = 'gakusyukei_nd26_01@oskedu.jp';
  const password = '20ntt26d';
  const baseUrl = 'https://ed-cl.com';

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const schoolCodeInput = page.locator('input[placeholder*="学校コード"], input[name*="schoolCode"], input[type="text"]').first();
    await schoolCodeInput.waitFor({ state: 'visible', timeout: 15000 });
    await schoolCodeInput.fill(schoolCode);

    const submitBtn = page.locator('button:has-text("次へ"), button[type="submit"], input[type="submit"]').first();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      submitBtn.click()
    ]);
    await page.waitForTimeout(3000);

    const microsoftButton = page.locator('button:has-text("Microsoft"), a:has-text("Microsoft")').first();
    if (await microsoftButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        microsoftButton.click()
      ]);
      await page.waitForTimeout(3000);
    }

    const idInput = page.locator('input[type="email"], input[type="text"]').first();
    if (await idInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      await idInput.fill(userId);
      const nextBtn = page.locator('#identifierNext button, button:has-text("Next"), button:has-text("次へ"), input[type="submit"]').first();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        nextBtn.click()
      ]);
      await page.waitForTimeout(3000);
    }

    const pwInput = page.locator('input[type="password"]:visible').first();
    if (await pwInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      await pwInput.fill(password);
      const signInBtn = page.locator('#passwordNext button, button:has-text("サインイン"), button:has-text("次へ"), input[type="submit"]').first();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        signInBtn.click()
      ]);
      await page.waitForTimeout(5000);

      const confirmBtn = page.locator('button:has-text("同意する"), button:has-text("次へ"), button:has-text("続行")').first();
      if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(3000);
      }

      const staySignedInBtn = page.locator('input[type="submit"][value*="はい"], button:has-text("はい")').first();
      if (await staySignedInBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
          staySignedInBtn.click()
        ]);
        await page.waitForTimeout(5000);
      }
    }

    // アカウントメニュー -> ユーザー管理
    const accountTrigger = page.locator('.v2-sidebar-current-account, .dropup.v2-nav-footer__item').first();
    await accountTrigger.waitFor({ state: 'visible', timeout: 15000 });
    await accountTrigger.click();
    await page.waitForTimeout(1500);

    const userManageLink = page.getByText('ユーザー管理').first();
    await userManageLink.waitFor({ state: 'visible', timeout: 8000 });

    let userPage = page;
    const pagePromise = context.waitForEvent('page', { timeout: 7000 }).catch(() => null);
    await userManageLink.click();
    const newPage = await pagePromise;
    if (newPage) {
      userPage = newPage;
      await userPage.waitForLoadState('domcontentloaded');
    }

    await userPage.waitForTimeout(3000);

    // 1. 学年設定
    const gradeMenuLink = userPage.locator('a:has-text("学年設定")').first();
    await gradeMenuLink.click();
    await userPage.waitForTimeout(2000);

    const newGradeBtn = userPage.locator('button:has-text("新規"), a:has-text("新規")').first();
    await newGradeBtn.click();
    await userPage.waitForTimeout(1500);

    // select#grade_code の options
    const options = await userPage.locator('select#grade_code option').evaluateAll((opts) =>
      opts.map((o) => ({
        value: (o as HTMLOptionElement).value,
        text: (o as HTMLOptionElement).text
      }))
    );
    console.log('[学年コード オプション一覧]:', JSON.stringify(options, null, 2));

    // カスタムを選択してみる
    await userPage.selectOption('select#grade_code', 'custom');
    await userPage.waitForTimeout(1000);
    const customInputVisible = await userPage.locator('#grade_code_code').isVisible();
    console.log('[カスタム選択時の grade_code_code input 可視状態]:', customInputVisible);

    // キャンセル/閉じる
    await userPage.locator('button:has-text("×"), [aria-label*="close"], button:has-text("キャンセル")').first().click();
    await userPage.waitForTimeout(1500);

    // 2. クラス設定
    const classMenuLink = userPage.locator('a:has-text("クラス設定")').first();
    await classMenuLink.click();
    await userPage.waitForTimeout(2000);

    // 「クラスの追加」をクリックしてみる（保存は絶対にしない）
    const addClassBtn = userPage.locator('button:has-text("クラスの追加")').first();
    await addClassBtn.click();
    await userPage.waitForTimeout(1500);

    // 追加された行の要素構造を調査
    const addedRowInputs = await userPage.locator('table tr, [class*="table"] tr').evaluateAll((rows) =>
      rows.map((r) => {
        const selects = Array.from(r.querySelectorAll('select')).map((s) => ({
          name: s.name,
          id: s.id,
          outer: s.outerHTML.substring(0, 100)
        }));
        const inputs = Array.from(r.querySelectorAll('input')).map((i) => ({
          name: i.name,
          id: i.id,
          type: i.type,
          outer: i.outerHTML.substring(0, 100)
        }));
        const text = (r as HTMLElement).innerText.trim().replace(/\s+/g, ' ');
        return { text, selects, inputs };
      })
    );
    console.log('[クラス追加後のテーブル構造]:', JSON.stringify(addedRowInputs, null, 2));

  } finally {
    await browser.close();
  }
}

main();
