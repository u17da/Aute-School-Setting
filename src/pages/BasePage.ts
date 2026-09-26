import { Page } from 'playwright';

export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  async waitForUrl(urlOrPattern: string | RegExp, timeoutMs = 30000): Promise<void> {
    await this.page.waitForURL(urlOrPattern, { timeout: timeoutMs });
  }

  async waitForNetworkIdle(timeoutMs = 10000): Promise<void> {
    try {
      await this.page.waitForLoadState('networkidle', { timeout: timeoutMs });
    } catch {
      // タイムアウトしても処理を継続できる場合があるため警告ログ等の扱い
    }
  }

  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
  }
}
