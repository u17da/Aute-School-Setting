import { Page } from 'playwright';
import { BasePage } from './BasePage';
import { AutomationError } from '../types/errors';
import { AuthObservation, AuthProvider } from '../types/auth';
import { logger } from '../logger/logger';

export class LoginPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * トップ画面へ移動し、学校コードを入力して送信後、認証方式を観測する
   */
  async navigateAndSubmitSchoolCode(
    baseUrl: string,
    schoolCode: string,
    requestedMode: 'A' | 'B'
  ): Promise<AuthObservation> {
    logger.info(`まなびポケット ログイン画面へアクセス中: ${baseUrl}`);
    await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    // 学校コード入力欄を特定
    const schoolCodeInput = this.page.locator(
      'input[placeholder*="学校コード"], input[name*="schoolCode"], input[name*="school_code"], input[id*="schoolCode"], input[type="text"]'
    ).first();

    try {
      await schoolCodeInput.waitFor({ state: 'visible', timeout: 15000 });
      await schoolCodeInput.fill(schoolCode);
      logger.info(`学校コードを入力しました: ${schoolCode}`);
    } catch (err: any) {
      throw new AutomationError(
        'LOGIN_FAILED',
        `学校コード入力欄が見つかりませんでした: ${err.message}`,
        { baseUrl, schoolCode }
      );
    }

    // 「次へ」または送信ボタンを押下
    const submitButton = this.page.locator(
      'button:has-text("次へ"), input[type="submit"], button[type="submit"], button:has-text("ログイン")'
    ).first();

    try {
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        submitButton.click()
      ]);
    } catch (err: any) {
      throw new AutomationError(
        'LOGIN_FAILED',
        `学校コード入力後の送信ボタン押下に失敗しました: ${err.message}`
      );
    }

    // 遷移先のURLやDOMから認証プロバイダーを観測
    return await this.detectAuthProvider(requestedMode);
  }

  /**
   * 遷移先ホストや画面要素から認証プロバイダーを安全に観測
   */
  private async detectAuthProvider(requestedMode: 'A' | 'B'): Promise<AuthObservation> {
    const currentUrl = this.page.url();
    let resolvedProvider: AuthProvider = 'LOCAL';
    let externalIdpDetected = false;
    let detectedRedirectHost: string | undefined;

    try {
      const urlObj = new URL(currentUrl);
      detectedRedirectHost = urlObj.hostname;

      const host = urlObj.hostname.toLowerCase();
      const isMicrosoft =
        host === 'login.microsoftonline.com' ||
        host.endsWith('.login.microsoftonline.com') ||
        host === 'login.live.com' ||
        host.endsWith('.login.live.com');

      const isGoogle =
        host === 'accounts.google.com' ||
        host.endsWith('.accounts.google.com') ||
        host === 'accounts.google.co.jp';

      if (isMicrosoft) {
        resolvedProvider = 'MICROSOFT_ENTRA';
        externalIdpDetected = true;
      } else if (isGoogle) {
        resolvedProvider = 'GOOGLE';
        externalIdpDetected = true;
      } else {
        // まなびポケットドメイン内でも、外部IdPへのボタンが存在するか確認
        const hasExternalButtons = await this.page
          .locator('button:has-text("Microsoft"), button:has-text("Google"), a:has-text("Microsoft"), a:has-text("Google")')
          .first()
          .isVisible({ timeout: 2000 })
          .catch(() => false);

        if (hasExternalButtons || requestedMode === 'B') {
          externalIdpDetected = true;
          resolvedProvider = requestedMode === 'B' ? 'MICROSOFT_ENTRA' : 'UNKNOWN';
        }
      }
    } catch {
      // URLパースエラー時はUNKNOWN
      resolvedProvider = 'UNKNOWN';
    }

    logger.info(
      `認証方式の観測結果: requested=${requestedMode}, resolved=${resolvedProvider}, externalIdpDetected=${externalIdpDetected}`
    );

    return {
      requestedMode,
      resolvedProvider,
      externalIdpDetected,
      detectedRedirectHost
    };
  }

  /**
   * 認証後URL判定（IdP除外かつhome/dashboard等）
   */
  private isAuthenticatedUrl(targetUrl: URL | string): boolean {
    try {
      const u = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
      if (u.hostname.includes('idp')) return false;
      const p = u.pathname;
      return p.includes('home') || p.includes('dashboard') || p.includes('organization') || p === '/';
    } catch {
      return false;
    }
  }

  /**
   * Phase 1: 認証後DOMシグナル検知 (.school-name は除外)
   */
  private async waitForAuthenticatedDomSignal(timeoutMs: number): Promise<'DOM'> {
    const locator = this.page.locator(
      '.v2-header, .v2-nav-menu-header__label, .v2-sidebar-current-account, .v2-sidenav, .dropup.v2-nav-footer__item'
    ).first();
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    logger.info('[AUTH] authenticated DOM signal detected');
    return 'DOM';
  }

  /**
   * Phase 1: 認証後URLシグナル検知 (waitUntil: 'domcontentloaded')
   */
  private async waitForAuthenticatedUrlSignal(timeoutMs: number): Promise<'URL'> {
    await this.page.waitForURL((url) => this.isAuthenticatedUrl(url), {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });
    logger.info(`[AUTH] authenticated URL signal detected: ${this.page.url()}`);
    return 'URL';
  }

  /**
   * 残り待機時間の厳密計算 (deadline超過時は0以下で即座に例外)
   */
  private getRemainingTimeout(deadline: number, phaseName = 'LOGIN_WAIT'): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AutomationError(
        'LOGIN_FAILED',
        `ログイン処理の制限時間を超過しました (フェーズ: ${phaseName}, 現在URL: ${this.page.url()})`,
        { phase: phaseName, currentUrl: this.page.url() }
      );
    }
    return remaining;
  }

  /**
   * Phase 1: 早期成功シグナル待機 (Promise.any)
   */
  private async waitForEarlySuccessSignal(deadline: number): Promise<'DOM' | 'URL'> {
    const startTs = Date.now();
    const timeoutMs = this.getRemainingTimeout(deadline, 'PHASE1_EARLY_SIGNAL');

    try {
      const winner = await Promise.any([
        this.waitForAuthenticatedDomSignal(timeoutMs),
        this.waitForAuthenticatedUrlSignal(timeoutMs)
      ]);
      logger.info(`[AUTH] early success signal detected (${winner}) in ${Date.now() - startTs}ms`);
      return winner;
    } catch (err: any) {
      const elapsedMs = Date.now() - startTs;
      const currentUrl = this.page.url();
      logger.warn(
        `[AUTH] Phase 1 失敗: LOGIN_SIGNAL_TIMEOUT (elapsed: ${elapsedMs}ms, url: ${currentUrl})`
      );
      throw new AutomationError(
        'LOGIN_FAILED',
        `ログイン早期成功シグナル（DOMまたはURL）を検知できませんでした (${timeoutMs}ms経過, 現在URL: ${currentUrl})`,
        { phase: 'LOGIN_SIGNAL_TIMEOUT', currentUrl, elapsedMs }
      );
    }
  }

  /**
   * Phase 2: 認証後画面の厳格検証 (各待機の直前にdeadlineから残時間を再計算)
   */
  async verifyAuthenticatedHome(deadlineOrTimeoutMs = 15000): Promise<void> {
    // 既存の単独呼び出し時はtimeoutMs、loginWithLocalPasswordからは共有deadlineを受け取る
    const deadline = deadlineOrTimeoutMs > 1000000000000 ? deadlineOrTimeoutMs : Date.now() + deadlineOrTimeoutMs;

    logger.info('[AUTH] Verifying authenticated home...');

    // A. Authenticated app shell待機 (認証後固有DOM。※.school-nameは除外)
    const authShellLocator = this.page.locator(
      '.v2-header, .v2-nav-menu-header__label, .v2-sidebar-current-account, .v2-sidenav, .dropup.v2-nav-footer__item'
    ).first();
    try {
      const remainingForShell = this.getRemainingTimeout(deadline, 'PHASE2_APP_SHELL');
      await authShellLocator.waitFor({ state: 'visible', timeout: remainingForShell });
    } catch (err: any) {
      const currentUrl = this.page.url();
      logger.warn(`[AUTH] Phase 2 失敗: AUTHENTICATED_HOME_NOT_CONFIRMED - DOMシェル未出現 (URL: ${currentUrl})`);
      throw new AutomationError(
        'LOGIN_FAILED',
        `認証後画面固有のDOM要素が確認できませんでした (現在URL: ${currentUrl})`,
        { phase: 'AUTHENTICATED_HOME_NOT_CONFIRMED', currentUrl }
      );
    }

    // B. Authenticated URL確認 (短時間待機を含む。直前に残時間を再計算)
    let isAuthUrl = this.isAuthenticatedUrl(this.page.url());
    if (!isAuthUrl) {
      try {
        const remainingForUrl = Math.min(5000, this.getRemainingTimeout(deadline, 'PHASE2_URL'));
        await this.page.waitForURL((url) => this.isAuthenticatedUrl(url), {
          waitUntil: 'domcontentloaded',
          timeout: remainingForUrl
        });
        isAuthUrl = true;
      } catch {
        isAuthUrl = this.isAuthenticatedUrl(this.page.url());
      }
    }
    if (!isAuthUrl) {
      const currentUrl = this.page.url();
      logger.warn(`[AUTH] Phase 2 失敗: AUTHENTICATED_HOME_NOT_CONFIRMED - 想定外URL (URL: ${currentUrl})`);
      throw new AutomationError(
        'LOGIN_FAILED',
        `認証後の想定URLへの遷移が確認できませんでした (現在URL: ${currentUrl})`,
        { phase: 'AUTHENTICATED_HOME_NOT_CONFIRMED', currentUrl }
      );
    }

    // C. Login UI離脱確認 (ログインボタンやパスワード入力欄が非表示であること。直前に残時間を再計算)
    const loginInputs = this.page.locator('input[type="password"]:visible, button:has-text("ログイン"):visible');
    try {
      const remainingForUiClear = Math.min(3000, this.getRemainingTimeout(deadline, 'PHASE2_UI_CLEAR'));
      await loginInputs.waitFor({ state: 'hidden', timeout: remainingForUiClear }).catch(() => {});
    } catch {}
    const hasLoginInputVisible = await loginInputs.first().isVisible().catch(() => false);
    if (hasLoginInputVisible) {
      const currentUrl = this.page.url();
      logger.warn(`[AUTH] Phase 2 失敗: AUTHENTICATED_HOME_NOT_CONFIRMED - ログインフォームが依然として可視 (URL: ${currentUrl})`);
      throw new AutomationError(
        'LOGIN_FAILED',
        `認証後画面の検証に失敗しました: ログイン入力欄が依然として表示されています (現在URL: ${currentUrl})`,
        { phase: 'AUTHENTICATED_HOME_NOT_CONFIRMED', currentUrl }
      );
    }

    logger.info('[AUTH] authenticated home verified');
  }

  /**
   * AUTH_MODE=A: ローカル ID/パスワードによる通常ログイン
   */
  async loginWithLocalPassword(userId: string, password?: string, timeoutMs = 30000): Promise<void> {
    if (!password) {
      throw new AutomationError(
        'LOGIN_FAILED',
        'AUTH_MODE=A ですがパスワードが指定されていません (.envのMANAPOKE_PASSWORDを確認してください)'
      );
    }

    logger.info(`ローカルアカウントでログインを実行中`);
    // ログイン処理全体で1つのdeadlineを共有
    const deadline = Date.now() + timeoutMs;

    let submitCompleted = false;
    try {
      // ユーザーID入力欄
      const userIdInput = this.page.locator(
        'input[placeholder*="ユーザーID"], input[placeholder*="ログインID"], input[name*="loginId"], input[name*="userId"], input[type="text"]'
      ).first();
      await userIdInput.waitFor({ state: 'visible', timeout: Math.min(15000, this.getRemainingTimeout(deadline, 'PRE_SUBMIT_USER_ID')) });
      await userIdInput.fill(userId);

      // パスワード入力欄
      const passwordInput = this.page.locator('input[type="password"]').first();
      await passwordInput.waitFor({ state: 'visible', timeout: Math.min(15000, this.getRemainingTimeout(deadline, 'PRE_SUBMIT_PASSWORD')) });
      await passwordInput.fill(password);

      // ログインボタン押下
      const loginButton = this.page.locator(
        'button:has-text("ログイン"), input[type="submit"][value*="ログイン"], button[type="submit"]'
      ).first();

      submitCompleted = true;
      logger.info('[AUTH] login button clicked');
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: Math.min(15000, this.getRemainingTimeout(deadline, 'SUBMIT_NAVIGATION')) }).catch(() => {}),
        loginButton.click()
      ]);

      // Phase 1: 早期成功シグナル待機 (Promise.any, 共有deadline)
      await this.waitForEarlySuccessSignal(deadline);

      // Phase 2: 認証後画面の厳格検証 (verifyAuthenticatedHome, 共有deadline)
      await this.verifyAuthenticatedHome(deadline);

      logger.info('[AUTH] 認証済みHome画面への到達を確認しました');
    } catch (err: any) {
      if (err instanceof AutomationError) throw err;

      // 指示11, 12: credential submit 後に結果が不明な場合は AUTH_OUTCOME_UNKNOWN
      if (submitCompleted) {
        // 明確なエラーメッセージが画面にあるか確認
        const errorMsgEl = this.page.locator('.alert, .error, .flash, [class*="error"], [class*="alert"]');
        const hasVisibleError = await errorMsgEl.first().isVisible({ timeout: 1000 }).catch(() => false);
        if (hasVisibleError) {
          const msg = (await errorMsgEl.first().innerText().catch(() => '')).trim();
          throw new AutomationError('LOGIN_FAILED', `認証に失敗しました: ${msg || err.message}`);
        }
        throw new AutomationError(
          'AUTH_OUTCOME_UNKNOWN',
          `認証情報送信後に成否を確認できませんでした (タイムアウトまたは切断): ${err.message}`,
          { currentUrl: this.page.url(), originalError: err.message }
        );
      }

      throw new AutomationError(
        'LOGIN_FAILED',
        `ログイン前操作に失敗しました: ${err.message}`
      );
    }
  }

  /**
   * 外部IdP (Google Workspace / Microsoft Entra ID 等) による自動ログイン
   */
  async loginWithExternalIdp(userId: string, password?: string, timeoutMs = 60000): Promise<void> {
    if (!password) {
      logger.info('外部IdP用パスワードが未設定のため、手動認証待機にフォールバックします');
      await this.waitForExternalIdpLogin(timeoutMs);
      return;
    }

    logger.info(`外部IdP画面で自動認証を実行中 (ユーザー: ${userId})`);

    try {
      // 1. メールアドレス / ユーザー名入力欄を特定
      const idInput = this.page.locator(
        '#identifierId, input[name="identifier"], input[type="email"], input[name*="loginfmt"], input[placeholder*="メール"], input[type="text"]:visible'
      ).first();

      await idInput.waitFor({ state: 'visible', timeout: 15000 });
      await idInput.fill(userId);

      // 「次へ」ボタン
      const nextBtn = this.page.locator(
        '#identifierNext button, button:has-text("次へ"), button:has-text("Next"), input[type="submit"]'
      ).first();
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        nextBtn.click()
      ]);

      // 2. パスワード入力欄を特定
      const pwInput = this.page.locator(
        'input[type="password"]:visible, input[name="Passwd"], input[name="password"]'
      ).first();
      await pwInput.waitFor({ state: 'visible', timeout: 15000 });
      await pwInput.fill(password);

      // パスワード送信（次へ / サインイン）
      const pwSubmitBtn = this.page.locator(
        '#passwordNext button, button:has-text("次へ"), button:has-text("Next"), button:has-text("サインイン"), button:has-text("ログイン"), input[type="submit"]'
      ).first();

      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        pwSubmitBtn.click()
      ]);

      // 3. もし「サインインの状態を維持しますか？」(Entra ID) や確認画面が出た場合の処理
      const staySignedInBtn = this.page.locator(
        'input[type="submit"][value*="はい"], button:has-text("はい"), input[type="submit"][value*="Yes"], button:has-text("Yes")'
      ).first();
      if (await staySignedInBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await Promise.all([
          this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
          staySignedInBtn.click()
        ]);
      }

      // 4. まなびポケットへのリダイレクト完了を待機
      await this.waitForLoginSuccess(timeoutMs);
      logger.info('外部IdP自動認証が完了しました');
    } catch (err: any) {
      logger.warn(`外部IdP自動認証中に例外が発生しました: ${err.message}。手動待機にフォールバックします`);
      await this.waitForExternalIdpLogin(timeoutMs);
    }
  }

  /**
   * AUTH_MODE=B または 外部IdP連携時の待機 (Human-in-the-loop / MFA対応)
   */
  async waitForExternalIdpLogin(timeoutMs: number): Promise<void> {
    logger.info(
      `外部IdP認証待機中 (最大 ${Math.round(timeoutMs / 1000)}秒)... 必要に応じてブラウザ上で認証/MFA操作を完了してください`
    );

    try {
      await this.waitForLoginSuccess(timeoutMs);
      logger.info('外部IdPによるログイン完了を検知しました');
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.message?.includes('Timeout')) {
        throw new AutomationError(
          'AUTH_INTERACTION_TIMEOUT',
          `外部IdP認証またはMFA待機がタイムアウトしました (${timeoutMs}ms)`
        );
      }
      throw new AutomationError(
        'LOGIN_FAILED',
        `外部IdPログイン待機中にエラーが発生しました: ${err.message}`
      );
    }
  }

  /**
   * ログイン完了（まなびポケットのホーム画面またはユーザーメニュー出現）を待機
   */
  private async waitForLoginSuccess(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await this.waitForEarlySuccessSignal(deadline);
    await this.verifyAuthenticatedHome(deadline);
  }
}
