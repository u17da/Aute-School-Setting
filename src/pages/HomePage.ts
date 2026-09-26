import { Page } from 'playwright';
import { BasePage } from './BasePage';
import { AutomationError } from '../types/errors';
import { logger } from '../logger/logger';

export class HomePage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * 画面上に表示されている学校名を取得し、正規化（trim + 連続空白を1つに統合）して返す
   * 各候補Locatorについてcountを一意性検証し、1件のみマッチしたLocatorを採用する
   */
  async getDisplayedSchoolName(): Promise<{ schoolName: string; usedLocator: string; count: number }> {
    const candidateSelectors = [
      '.v2-nav-menu-header__label',
      '[data-testid="school-name"]',
      '.school-name',
      '.header-school-name',
      '.sidebar-school-name',
      '[class*="schoolName"]',
      '[class*="SchoolName"]',
      'header .school-title',
      'header [class*="school"]',
      '.user-profile .school-name',
      '.header-organization'
    ];

    for (const selector of candidateSelectors) {
      const locator = this.page.locator(selector);
      const count = await locator.count();

      if (count === 1) {
        const isVisible = await locator.isVisible().catch(() => false);
        if (isVisible) {
          const rawText = await locator.innerText();
          const normalized = rawText.trim().replace(/\s+/g, ' ');
          if (normalized.length > 0) {
            logger.info(`学校名Locator確定: "${selector}" (count=1, 値="${normalized}")`);
            return { schoolName: normalized, usedLocator: selector, count: 1 };
          }
        }
      } else if (count > 1) {
        throw new AutomationError(
          'UI_STRUCTURE_MISMATCH',
          `学校名候補Locator "${selector}" が画面上に複数件 (${count}件) 検出されました。一意に特定できません`,
          { selector, count }
        );
      }
    }

    // 既知のセレクタで見つからない場合、ヘッダー/サイドバー全体の構造から学校名を含む意味的要素を慎重に探索
    const semanticContainers = this.page.locator('header, aside, .header, .sidebar');
    const containerCount = await semanticContainers.count();

    for (let i = 0; i < containerCount; i++) {
      const container = semanticContainers.nth(i);
      const elements = container.locator('p, span, div, h1, h2, h3, a');
      const elCount = await elements.count();

      for (let j = 0; j < elCount; j++) {
        const el = elements.nth(j);
        const text = (await el.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
        if (/.+[小学校|中学校|高校|高等学校|学園|中等教育学校]$/.test(text) && text.length < 50) {
          const isVisible = await el.isVisible().catch(() => false);
          if (isVisible) {
            logger.info(`セマンティック探索により学校名を検出: "${text}"`);
            return { schoolName: text, usedLocator: 'semantic-container-match', count: 1 };
          }
        }
      }
    }

    throw new AutomationError(
      'SCHOOL_MISMATCH',
      'ログイン後の画面から一意な学校名表示要素を取得できませんでした'
    );
  }

  /**
   * 画面上に学校コードが表示されている場合のみ取得（存在しない場合はnullを返す）
   */
  async getDisplayedSchoolCode(): Promise<{ code: string; locator: string } | null> {
    const candidateSelectors = [
      '[data-testid="school-code"]',
      '.school-code',
      '[class*="schoolCode"]',
      '[class*="SchoolCode"]'
    ];

    for (const selector of candidateSelectors) {
      const locator = this.page.locator(selector);
      const count = await locator.count();
      if (count === 1 && (await locator.isVisible().catch(() => false))) {
        const raw = await locator.innerText();
        const code = raw.trim();
        if (code) {
          return { code, locator: selector };
        }
      }
    }
    return null;
  }

  /**
   * ログイン中の学校を厳格に照合する
   */
  async verifySchool(expectedSchoolCode: string, expectedSchoolName: string): Promise<void> {
    const { schoolName: actualName, usedLocator } = await this.getDisplayedSchoolName();
    const normalizedExpected = expectedSchoolName.trim().replace(/\s+/g, ' ');

    logger.info(`学校名照合: 期待値="${normalizedExpected}", 画面値="${actualName}" (Locator: ${usedLocator})`);

    // 完全一致のみ許可（部分一致や推測一致は禁止）
    if (actualName !== normalizedExpected) {
      throw new AutomationError(
        'SCHOOL_MISMATCH',
        `対象学校名が一致しません。設定ファイル: "${normalizedExpected}", 画面実測値: "${actualName}"`,
        { expectedSchoolName: normalizedExpected, actualSchoolName: actualName, usedLocator }
      );
    }

    // 画面からschoolCodeが取得可能な場合のみ照合
    const codeResult = await this.getDisplayedSchoolCode();
    if (codeResult !== null) {
      logger.info(`学校コード照合: 期待値="${expectedSchoolCode}", 画面値="${codeResult.code}" (Locator: ${codeResult.locator})`);
      if (codeResult.code !== expectedSchoolCode.trim()) {
        throw new AutomationError(
          'SCHOOL_MISMATCH',
          `学校コードが一致しません。設定ファイル: "${expectedSchoolCode}", 画面実測値: "${codeResult.code}"`,
          { expectedSchoolCode, actualSchoolCode: codeResult.code }
        );
      }
    } else {
      logger.info('画面上に独立した学校コード表示は確認されませんでした（照合スキップ）');
    }
  }

  /**
   * 左下等のユーザーアイコン/設定メニューから「学校設定」画面へ遷移する
   */
  async navigateToSchoolSettings(): Promise<void> {
    logger.info('設定メニューを開いて「学校設定」へ遷移中...');

    // 左下のアカウント/設定メニュートリガー (.v2-sidebar-current-account, .dropup)
    const trigger = this.page.locator('.v2-sidebar-current-account, .dropup.v2-nav-footer__item').first();

    try {
      await trigger.waitFor({ state: 'attached', timeout: 10000 });
      await trigger.click({ force: true });
      await this.page.waitForTimeout(500); // ドロップアップメニューの描画待機
    } catch (err: any) {
      throw new AutomationError(
        'SETTINGS_MENU_NOT_AVAILABLE',
        `設定メニュートリガーが見つかりませんでした: ${err.message}`
      );
    }

    // ドロップダウンまたはポップアップメニュー内の「学校設定」を探す
    const schoolSettingsItem = this.page.locator(
      'a[href*="/manage/organization/edit"], a:has-text("学校設定")'
    ).first();

    try {
      await schoolSettingsItem.waitFor({ state: 'attached', timeout: 5000 });
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        schoolSettingsItem.click({ force: true })
      ]);
      logger.info('「学校設定」画面への遷移を実行しました');
    } catch (err: any) {
      throw new AutomationError(
        'SETTINGS_MENU_NOT_AVAILABLE',
        '設定メニュー内に「学校設定」項目が存在しません（学校管理者アカウントでない可能性があります）',
        { originalError: err.message }
      );
    }
  }
}
