import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { SchoolConfigFile, AppEnvConfig } from '../types/config';
import { SchoolConfigFileSchema } from './schema';
import { AutomationError } from '../types/errors';

dotenv.config();

export function loadEnvConfig(): AppEnvConfig {
  const authModeRaw = (process.env.AUTH_MODE || 'A').toUpperCase();
  const authMode = authModeRaw === 'B' ? 'B' : 'A';
  const baseUrl = process.env.MANAPOKE_BASE_URL || 'https://ed-cl.com';
  const schoolCode = process.env.MANAPOKE_SCHOOL_CODE || '';
  const userId = process.env.MANAPOKE_USER_ID || '';
  const password = process.env.MANAPOKE_PASSWORD || '';
  const externalIdpTimeoutMs = parseInt(process.env.EXTERNAL_IDP_TIMEOUT_MS || '300000', 10);
  const dryRun = process.env.DRY_RUN !== 'false';
  const allowDestructiveChanges = process.env.ALLOW_DESTRUCTIVE_CHANGES === 'true';
  const headless = process.env.HEADLESS === 'true';
  const slowMoMs = parseInt(process.env.SLOW_MO_MS || '100', 10);
  const defaultTimeoutMs = parseInt(process.env.DEFAULT_TIMEOUT_MS || '30000', 10);

  return {
    authMode,
    baseUrl,
    schoolCode,
    userId,
    password,
    externalIdpTimeoutMs,
    dryRun,
    allowDestructiveChanges,
    headless,
    slowMoMs,
    defaultTimeoutMs
  };
}

export function loadSchoolConfigFile(filePath: string): SchoolConfigFile {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new AutomationError(
      'CONFIG_INVALID',
      `設定ファイルが見つかりません: ${resolvedPath}`,
      { filePath: resolvedPath }
    );
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(resolvedPath, 'utf-8');
  } catch (error: any) {
    throw new AutomationError(
      'CONFIG_INVALID',
      `設定ファイルの読み込みに失敗しました: ${error.message}`,
      { originalError: error.message }
    );
  }

  let parsedJson: any;
  try {
    parsedJson = JSON.parse(rawContent);
  } catch (error: any) {
    throw new AutomationError(
      'CONFIG_INVALID',
      `設定ファイルのJSONパースに失敗しました: ${error.message}`,
      { originalError: error.message }
    );
  }

  try {
    const validated = SchoolConfigFileSchema.parse(parsedJson);
    return validated as SchoolConfigFile;
  } catch (error: any) {
    throw new AutomationError(
      'CONFIG_INVALID',
      `設定ファイルのスキーマ検証に失敗しました: ${error.message}`,
      { originalError: error.message }
    );
  }
}
