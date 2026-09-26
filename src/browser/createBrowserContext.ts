import { Browser, BrowserContext } from 'playwright';
import { AppEnvConfig } from '../types/config';

export async function createSchoolBrowserContext(
  browser: Browser,
  envConfig: AppEnvConfig
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    ignoreHTTPSErrors: true
  });

  context.setDefaultTimeout(envConfig.defaultTimeoutMs);
  return context;
}
