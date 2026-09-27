import * as fs from 'fs';
import * as path from 'path';
import { Page } from 'playwright';
import { logger } from '../logger/logger';
import { getScreenshotsDir } from '../runtime/paths';

export interface ScreenshotSafetyContext {
  authenticationCompleted: boolean;
  schoolVerified: boolean;
  pageType: 'AUTH' | 'HOME' | 'SCHOOL_SETTINGS' | 'UNKNOWN';
}

/**
 * State Check:
 * 過去またはメモリ上の状態として、認証完了・学校名照合・学校設定画面であるか判定
 */
export function canCaptureScreenshot(context?: ScreenshotSafetyContext): boolean {
  if (!context) return false;
  return (
    context.authenticationCompleted === true &&
    context.schoolVerified === true &&
    context.pageType === 'SCHOOL_SETTINGS'
  );
}

/**
 * Live Page Check (指示6 & 指示7):
 * 撮影直前に現在のLive DOMおよびURLを再検証する。
 * Fail Closed 原則に従い、いかなる例外（page closed, timeout, navigation error等）が発生した場合も
 * 撮影不可 (false) として扱う。
 */
export async function validateLivePageSafety(page: Page): Promise<boolean> {
  try {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
      return false;
    }

    const currentUrl = page.url();
    if (!currentUrl) return false;

    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return false;
    }

    // 1. hostname === 'ed-cl.com'
    if (parsed.hostname !== 'ed-cl.com') {
      return false;
    }

    // 2. pathname === '/manage/organization/edit'
    if (parsed.pathname !== '/manage/organization/edit') {
      return false;
    }

    // 3. 学校設定見出しが一意に存在 (count === 1)
    const headingLocator = page.locator(
      '.v2-header__title:has-text("学校設定"), h1:has-text("学校設定"), h2:has-text("学校設定"), .page-title:has-text("学校設定")'
    );
    const headingCount = await headingLocator.count();
    if (headingCount !== 1) {
      return false;
    }

    // 4. user_config_form が存在
    const formLocator = page.locator('#user_config_form, form#user_config_form');
    const formCount = await formLocator.count();
    if (formCount < 1) {
      return false;
    }

    return true;
  } catch {
    // Fail Closed: 判定エラー・例外時は安全のため必ず撮影不可 (false)
    return false;
  }
}

export class ScreenshotManager {
  private screenshotDir: string;

  constructor() {
    this.screenshotDir = getScreenshotsDir();
  }

  async captureStage(
    page: Page,
    stage: '01-before-write' | '02-after-write-reload' | '03-after-restore-reload' | '01-after-login' | '02-school-settings-before' | '03-school-settings-selected' | '04-school-settings-after-reload' | string,
    schoolCode: string
  ): Promise<string> {
    try {
      const fileName = `${stage}-${schoolCode}.png`;
      const filePath = path.join(this.screenshotDir, fileName);
      await page.screenshot({ path: filePath, fullPage: true });
      logger.info(`スクリーンショットを保存しました: ${filePath}`);
      return filePath;
    } catch (err: any) {
      logger.warn(`スクリーンショット保存に失敗しました (${stage}): ${err.message}`);
      return '';
    }
  }

  /**
   * 指示5, 6, 7: State Check AND Live Page Check（Fail Closed）によるエラー時スクリーンショット撮影
   * 
   * 1. State Check:
   *    authenticationCompleted=true && schoolVerified=true && pageType='SCHOOL_SETTINGS'
   * 2. Live Page Check (撮影直前):
   *    hostname === 'ed-cl.com' && pathname === '/manage/organization/edit' &&
   *    学校設定見出しが一意に存在 && user_config_formが存在
   * 
   * 1つでも不一致、またはDOM確認中に例外が発生した場合は撮影をスキップ（0枚）
   */
  async captureError(page: Page, schoolCode: string, safetyContext?: ScreenshotSafetyContext): Promise<string> {
    // 1. State Check
    if (!canCaptureScreenshot(safetyContext)) {
      logger.info(
        `[${schoolCode}] スクリーンショット保存ポリシー(Allow-list State)により撮影をスキップしました (pageType=${safetyContext?.pageType || 'UNKNOWN'}, auth=${safetyContext?.authenticationCompleted}, schoolVerified=${safetyContext?.schoolVerified})`
      );
      return '';
    }

    // 2. Live Page Check (Fail Closed)
    const isLivePageSafe = await validateLivePageSafety(page);
    if (!isLivePageSafe) {
      logger.info(
        `[${schoolCode}] スクリーンショット保存ポリシー(Live Page Check)により撮影をスキップしました (URLまたはDOMが学校設定画面の安全基準を満たしていません / またはページ切断)`
      );
      return '';
    }

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `error-${schoolCode}-${timestamp}.png`;
      const filePath = path.join(this.screenshotDir, fileName);
      await page.screenshot({ path: filePath, fullPage: true });
      logger.error(`エラー時スクリーンショットを保存しました: ${filePath}`);
      return filePath;
    } catch (err: any) {
      logger.warn(`エラー時スクリーンショット保存に失敗しました: ${err.message}`);
      return '';
    }
  }
}

export const screenshotManager = new ScreenshotManager();
