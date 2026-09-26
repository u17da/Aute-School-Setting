import { LoginPage } from '../pages/LoginPage';
import { AppEnvConfig } from '../types/config';

export async function performPasswordLogin(
  loginPage: LoginPage,
  envConfig: AppEnvConfig
): Promise<void> {
  await loginPage.navigateAndSubmitSchoolCode(envConfig.baseUrl, envConfig.schoolCode, 'A');
  await loginPage.loginWithLocalPassword(envConfig.userId, envConfig.password);
}
