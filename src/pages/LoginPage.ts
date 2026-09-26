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
   * AUTH_MODE=A: ローカル ID/パスワードによる通常ログイン
   */
  async loginWithLocalPassword(userId: string, password?: string): Promise<void> {
    if (!password) {
      throw new AutomationError(
        'LOGIN_FAILED',
        'AUTH_MODE=A ですがパスワードが指定されていません (.envのMANAPOKE_PASSWORDを確認してください)'
      );
    }

    logger.info(`ローカルアカウントでログインを実行中`);

    let submitCompleted = false;
    try {
      // ユーザーID入力欄
      const userIdInput = this.page.locator(
        'input[placeholder*="ユーザーID"], input[placeholder*="ログインID"], input[name*="loginId"], input[name*="userId"], input[type="text"]'
      ).first();
      await userIdInput.waitFor({ state: 'visible', timeout: 15000 });
      await userIdInput.fill(userId);

      // パスワード入力欄
      const passwordInput = this.page.locator('input[type="password"]').first();
      await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
      await passwordInput.fill(password);

      // ログインボタン押下
      const loginButton = this.page.locator(
        'button:has-text("ログイン"), input[type="submit"][value*="ログイン"], button[type="submit"]'
      ).first();

      submitCompleted = true;
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        loginButton.click()
      ]);

      await this.waitForLoginSuccess();
      logger.info('ログイン完了を検知しました');
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
          `認証情報送信後に成否を確認できませんでした (タイムアウトまたは切断): ${err.message}`
        );
      }

      throw new AutomationError(
        'LOGIN_FAILED',
        `ログイン前操作に失敗しました: ${err.message}`
      );
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
    // ログイン完了判定インジケーター（実画面で確認された.v2-sidebar-current-account、.v2-header、.v2-nav-menu-header__label等）
    // ※.school-name はログイン画面（IdP側）にも存在するため、成功インジケーターとしては除外
    const successIndicator = this.page.locator(
      '.v2-sidebar-current-account, .v2-header, .v2-nav-menu-header__label, .v2-sidenav, [aria-label*="ユーザー"], .user-icon, .dropup.v2-nav-footer__item'
    ).first();

    await Promise.race([
      successIndicator.waitFor({ state: 'visible', timeout: timeoutMs }),
      this.page.waitForURL((url) => !url.hostname.includes('idp') && (url.pathname.includes('home') || url.pathname.includes('dashboard') || url.pathname.includes('organization') || url.pathname === '/'), { timeout: timeoutMs })
    ]);
  }
}
