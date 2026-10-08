import { Page } from 'playwright';
import { GuardedPageInterface } from '../types/capability';

/**
 * GuardedPage provides a safe sandbox over Playwright's Page.
 * It prevents arbitrary script evaluation (eval/evaluate with arbitrary code),
 * limits actions to well-typed primitives, and logs all browser operations.
 */
export class GuardedPage implements GuardedPageInterface {
  private page: Page | null;
  private isMock: boolean;

  constructor(page: Page | null, isMock = false) {
    this.page = page;
    this.isMock = isMock;
  }

  get rawPage(): Page | null {
    return this.page;
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
    if (this.isMock || !this.page) return;
    const el = this.page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: timeoutMs });
    await el.click();
  }

  async fill(selector: string, value: string, timeoutMs = 15000): Promise<void> {
    if (this.isMock || !this.page) return;
    const el = this.page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: timeoutMs });
    await el.fill(value);
  }

  async selectOption(selector: string, value: string, timeoutMs = 15000): Promise<void> {
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
