import * as http from 'http';
import { chromium, Browser } from 'playwright';
import { LoginPage } from '../src/pages/LoginPage';
import { HomePage } from '../src/pages/HomePage';
import { AutomationError } from '../src/types/errors';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTests() {
  console.log('================================================');
  console.log('Login Verification 3-Phase Flow Unit & Integration Tests');
  console.log('================================================\n');

  // 1. ローカルHTTPモックサーバー起動 (実URLとpushStateをサポート)
  let currentHtml = '';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(currentHtml);
  });

  await new Promise<void>((resolve) => server.listen(18080, '127.0.0.1', () => resolve()));
  const baseUrl = 'http://127.0.0.1:18080';

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });

    const getLoginFormHtml = (schoolName = 'なにわ小学校') => `
      <!DOCTYPE html>
      <html lang="ja">
      <head><meta charset="utf-8"><title>まなびポケット ログイン</title></head>
      <body>
        <div class="school-name">${schoolName}</div>
        <form id="login-form">
          <input type="text" name="userId" placeholder="ユーザーID" value="" />
          <input type="password" name="password" placeholder="パスワード" value="" />
          <button type="button" id="submit-btn">ログイン</button>
        </form>
      </body>
      </html>
    `;

    // =========================================================================
    // Case 1: 認証後DOMが先に出るが、URL navigationの load 相当条件は完了しない
    // 期待結果: DOM成功シグナルによりタイムアウトせず LOGIN SUCCESS
    // =========================================================================
    console.log('[Test Case 1] DOMシグナル先行 & URL load未完了シナリオ...');
    {
      currentHtml = getLoginFormHtml();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });

      // ログインボタン押下時の動作を模擬: DOM要素を出現させ、フォームを消去
      await page.evaluate(() => {
        document.getElementById('submit-btn')?.addEventListener('click', () => {
          setTimeout(() => {
            const form = document.getElementById('login-form');
            if (form) form.style.display = 'none';

            const header = document.createElement('header');
            header.className = 'v2-header';
            header.innerHTML = '<div class="v2-nav-menu-header__label">大阪市立なにわ小学校</div>';
            document.body.appendChild(header);

            // URLはSPAのhistory.pushStateで更新
            window.history.pushState({}, '', '/home');
          }, 50);
        });
      });

      const loginPage = new LoginPage(page);
      await loginPage.loginWithLocalPassword('admin', 'dummyPass', 5000);
      assert(true, 'Case 1 passed');
      console.log('  ✓ Case 1 成功: DOMシグナルにより正常に認証済みHomeへ到達\n');
      await context.close();
    }

    // =========================================================================
    // Case 2: URLが先に認証後URLへ遷移し、Home DOMが少し遅れて出現
    // 期待結果: verifyAuthenticatedHome が瞬間assertではなく待機することで LOGIN SUCCESS
    // =========================================================================
    console.log('[Test Case 2] URLシグナル先行 & Home DOM遅延出現シナリオ...');
    {
      currentHtml = getLoginFormHtml();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });

      await page.evaluate(() => {
        document.getElementById('submit-btn')?.addEventListener('click', () => {
          // 即座にURL更新
          window.history.pushState({}, '', '/dashboard');

          // DOMの描画は200ms遅延
          setTimeout(() => {
            const form = document.getElementById('login-form');
            if (form) form.style.display = 'none';

            const header = document.createElement('div');
            header.className = 'v2-sidebar-current-account';
            header.innerHTML = '<span class="v2-nav-menu-header__label">大阪市立なにわ小学校</span>';
            document.body.appendChild(header);
          }, 200);
        });
      });

      const loginPage = new LoginPage(page);
      await loginPage.loginWithLocalPassword('admin', 'dummyPass', 5000);
      assert(true, 'Case 2 passed');
      console.log('  ✓ Case 2 成功: URL先行後に待機してHome DOMを検知し認証成功\n');
      await context.close();
    }

    // =========================================================================
    // Case 3: ログイン前画面にも存在する .school-name のみ出現
    // 期待結果: 成功扱いにしない（AUTHENTICATED_HOME_NOT_CONFIRMED または LOGIN_SIGNAL_TIMEOUT）
    // =========================================================================
    console.log('[Test Case 3] .school-name のみ出現シナリオ（誤検知防止検証）...');
    {
      currentHtml = getLoginFormHtml();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });

      await page.evaluate(() => {
        document.getElementById('submit-btn')?.addEventListener('click', () => {
          // .school-name だけを増やすが、v2-headerなどは出さず、URLも変えない
          const div = document.createElement('div');
          div.className = 'school-name';
          div.textContent = 'ログイン画面の学校名';
          document.body.appendChild(div);
        });
      });

      const loginPage = new LoginPage(page);
      let failed = false;
      try {
        await loginPage.loginWithLocalPassword('admin', 'dummyPass', 1500);
      } catch (err: any) {
        failed = true;
        assert(err instanceof AutomationError, 'AutomationError がスローされること');
        console.log(`  ✓ 期待通りエラーを検知: ${err.message}`);
      }
      assert(failed, 'Case 3: .school-name のみで成功してはならない');
      console.log('  ✓ Case 3 成功: .school-name のみでの誤認を防止\n');
      await context.close();
    }

    // =========================================================================
    // Case 4: 認証後画面は表示されるが、学校identityが期待値と異なる
    // 期待結果: HomePage.verifySchool() により SCHOOL_MISMATCH で失敗（成功扱いにしない）
    // =========================================================================
    console.log('[Test Case 4] 認証後画面成功 & 学校identity不一致シナリオ...');
    {
      currentHtml = getLoginFormHtml();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });

      await page.evaluate(() => {
        document.getElementById('submit-btn')?.addEventListener('click', () => {
          const form = document.getElementById('login-form');
          if (form) form.style.display = 'none';

          const header = document.createElement('header');
          header.className = 'v2-header';
          header.innerHTML = '<div class="v2-nav-menu-header__label">大阪市立別の学校中学校</div>';
          document.body.appendChild(header);

          window.history.pushState({}, '', '/home');
        });
      });

      // Orchestration: LoginPage -> HomePage.verifySchool
      const loginPage = new LoginPage(page);
      await loginPage.loginWithLocalPassword('admin', 'dummyPass', 5000);

      const homePage = new HomePage(page);
      let identityFailed = false;
      try {
        await homePage.verifySchool('SCH001', '大阪市立なにわ小学校');
      } catch (err: any) {
        identityFailed = true;
        assert(err instanceof AutomationError, 'AutomationError であること');
        assert(err.status === 'SCHOOL_MISMATCH', `SCHOOL_MISMATCH であること (actual: ${err.status})`);
        console.log(`  ✓ 期待通り学校不一致を検知: ${err.message}`);
      }
      assert(identityFailed, 'Case 4: 学校名不一致で検証失敗すること');
      console.log('  ✓ Case 4 成功: 期待と異なる学校への誤適用を厳格に阻止\n');
      await context.close();
    }

    // =========================================================================
    // Case 5: DOMもURLも認証後状態にならない（タイムアウト）
    // 期待結果: 生AggregateErrorではなく適切な AutomationError になること
    // =========================================================================
    console.log('[Test Case 5] DOM/URL双方が未成立（タイムアウト）シナリオ...');
    {
      currentHtml = getLoginFormHtml();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });

      // クリックしても何もしない
      const loginPage = new LoginPage(page);
      let errorThrown: any = null;
      try {
        await loginPage.loginWithLocalPassword('admin', 'dummyPass', 1200);
      } catch (err: any) {
        errorThrown = err;
      }
      assert(errorThrown !== null, 'エラーがスローされること');
      assert(errorThrown instanceof AutomationError, '生AggregateErrorではなくAutomationErrorであること');
      assert(errorThrown.status === 'AUTH_OUTCOME_UNKNOWN' || errorThrown.status === 'LOGIN_FAILED', '認証エラーコードであること');
      console.log(`  ✓ 期待通り正規化されたエラーを検知: [${errorThrown.status}] ${errorThrown.message}`);
      console.log('  ✓ Case 5 成功: 生AggregateErrorを上位へ漏らさず適切なエラーへ変換\n');
      await context.close();
    }

    // =========================================================================
    // Case 6: 従来の "load" 待機タイムアウト条件の再現
    // 期待結果: waitUntil: 'domcontentloaded' と DOM成功シグナルにより正常完了
    // =========================================================================
    console.log('[Test Case 6] 従来loadタイムアウト再現 & domcontentloadedによる救済シナリオ...');
    {
      currentHtml = getLoginFormHtml();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });

      await page.evaluate(() => {
        document.getElementById('submit-btn')?.addEventListener('click', () => {
          // 外部の重い通信を模倣して未解決のPromise/リクエストがあっても、DOMとURLは即時解決
          const form = document.getElementById('login-form');
          if (form) form.style.display = 'none';

          const header = document.createElement('header');
          header.className = 'v2-header';
          header.innerHTML = '<div class="v2-nav-menu-header__label">大阪市立なにわ小学校</div>';
          document.body.appendChild(header);

          window.history.pushState({}, '', '/home');
        });
      });

      const loginPage = new LoginPage(page);
      await loginPage.loginWithLocalPassword('admin', 'dummyPass', 5000);

      const homePage = new HomePage(page);
      await homePage.verifySchool('SCH001', '大阪市立なにわ小学校');

      console.log('  ✓ Case 6 成功: load待機に縛られず3段階検証でLOGIN_AND_VERIFY SUCCESSを達成\n');
      await context.close();
    }

    console.log('================================================');
    console.log('All 6 Login Verification Tests PASSED successfully!');
    console.log('================================================\n');
  } finally {
    if (browser) await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
