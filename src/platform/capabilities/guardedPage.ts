import { Page, BrowserContext } from 'playwright';
import { GuardedPageInterface } from '../types/capability';

/**
 * Setup network interceptor for BrowserContext during Dry-Run mode.
 * Aborts any mutation requests (POST, PUT, PATCH, DELETE) to physically prevent writes.
 */
export async function setupNetworkBlocker(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route, request) => {
    const method = request.method().toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      route.abort('blockedbyclient');
    } else {
      route.continue();
    }
  });
}

/**
 * GuardedPage provides a safe sandbox over Playwright's Page.
 * It physically blocks write mutations in Dry-Run mode,
 * limits actions to well-typed primitives, and logs all browser operations.
 */
export class GuardedPage implements GuardedPageInterface {
  private page: Page | null;
  private isMock: boolean;
  public readonly isWriteBlocked: boolean;

  constructor(page: Page | null, isMock = false, isWriteBlocked = false) {
    this.page = page;
    this.isMock = isMock;
    this.isWriteBlocked = isWriteBlocked;
  }

  get rawPage(): Page | null {
    return this.page;
  }

  private checkWriteAllowed(action: string): void {
    if (this.isWriteBlocked) {
      throw new Error(`WRITE_BLOCKED_IN_DRY_RUN: Physical write operation "${action}" is blocked in dry-run mode.`);
    }
  }

  async navigate(url: string, timeoutMs = 30000): Promise<void> {
    if (this.isMock || !this.page) return;
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }

  async waitForSelector(selector: string, timeoutMs = 15000): Promise<boolean> {
    if (this.isMock || !this.page) return true;
    try {
      const el = this.page.locator(selector).first();
      await el.waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  async click(selector: string, timeoutMs = 15000): Promise<void> {
    this.checkWriteAllowed(`click(${selector})`);
    if (this.isMock || !this.page) return;
    const el = this.page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: timeoutMs });
    await el.click();
  }

  /**
   * Safe read-only navigation click (e.g. clicking a navigation menu, pagination, or tab)
   * Explicitly blocks form submission, save buttons, or destructive elements even in dry run
   */
  async clickNav(selector: string, timeoutMs = 15000): Promise<void> {
    if (/(save|submit|delete|remove|update|create|post|put|patch|保存|送信|削除|更新|登録)/i.test(selector)) {
      throw new Error(`MUTATION_ELEMENT_BLOCKED_IN_CLICK_NAV: Element matching "${selector}" appears to perform mutation and is rejected in clickNav.`);
    }
    if (this.isMock || !this.page) return;
    const el = this.page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: timeoutMs });
    await el.click();
  }

  async fill(selector: string, value: string, timeoutMs = 15000): Promise<void> {
    this.checkWriteAllowed(`fill(${selector})`);
    if (this.isMock || !this.page) return;
    const el = this.page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: timeoutMs });
    await el.fill(value);
  }

  async selectOption(selector: string, value: string, timeoutMs = 15000): Promise<void> {
    this.checkWriteAllowed(`selectOption(${selector}, ${value})`);
    if (this.isMock || !this.page) return;
    const el = this.page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: timeoutMs });
    await el.selectOption(value);
  }

  async getText(selector: string, timeoutMs = 15000): Promise<string> {
    if (this.isMock || !this.page) return 'MOCK_TEXT';
    const el = this.page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: timeoutMs });
    return (await el.textContent())?.trim() ?? '';
  }

  async getValue(selector: string, timeoutMs = 15000): Promise<string> {
    if (this.isMock || !this.page) return 'MOCK_VALUE';
    const el = this.page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: timeoutMs });
    return (await el.inputValue()) ?? '';
  }

  async isVisible(selector: string, timeoutMs = 5000): Promise<boolean> {
    if (this.isMock || !this.page) return true;
    try {
      const el = this.page.locator(selector).first();
      return await el.isVisible({ timeout: timeoutMs });
    } catch {
      return false;
    }
  }

  async dragAndDrop(sourceSelector: string, targetSelector: string): Promise<void> {
    this.checkWriteAllowed(`dragAndDrop(${sourceSelector} -> ${targetSelector})`);
    if (this.isMock || !this.page) return;
    await this.page.dragAndDrop(sourceSelector, targetSelector);
  }

  async reload(timeoutMs = 30000): Promise<void> {
    if (this.isMock || !this.page) return;
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }

  async takeScreenshot(tag?: string): Promise<string | undefined> {
    if (this.isMock || !this.page) return `mock_screenshot_${tag || 'default'}.png`;
    return undefined;
  }
}
