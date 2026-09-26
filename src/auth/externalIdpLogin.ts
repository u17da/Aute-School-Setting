import { LoginPage } from '../pages/LoginPage';
import { AppEnvConfig } from '../types/config';

export async function performExternalIdpLogin(
  loginPage: LoginPage,
  envConfig: AppEnvConfig
): Promise<void> {
  await loginPage.navigateAndSubmitSchoolCode(envConfig.baseUrl, envConfig.schoolCode, 'B');
  await loginPage.waitForExternalIdpLogin(envConfig.externalIdpTimeoutMs);
}
