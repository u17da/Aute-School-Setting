import { Page } from 'playwright';
import { LoginPage } from '../pages/LoginPage';
import { AppEnvConfig } from '../types/config';
import { performPasswordLogin } from './passwordLogin';
import { performExternalIdpLogin } from './externalIdpLogin';

export async function login(page: Page, envConfig: AppEnvConfig): Promise<void> {
  const loginPage = new LoginPage(page);
  if (envConfig.authMode === 'B') {
    await performExternalIdpLogin(loginPage, envConfig);
  } else {
    await performPasswordLogin(loginPage, envConfig);
  }
}
