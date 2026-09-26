import dotenv from 'dotenv';
import { RawCliOptions, EffectiveExecutionOptions, AppEnvConfig } from '../types/config';
import { AutomationError } from '../types/errors';

dotenv.config();

export function resolveExecutionOptions(
  cliOptions: RawCliOptions,
  envOverride?: Partial<AppEnvConfig>
): EffectiveExecutionOptions {
  // 1. CLI引数のバリデーション: --allow-destructive は --apply が必須
  const rawApply = cliOptions.apply ?? false;
  const rawAllowDestructive = cliOptions.allowDestructive ?? false;
  const rawAllowLiveWrite = cliOptions.allowLiveWrite ?? false;
  const rawBatchApply = cliOptions.batchApply ?? false;

  if (rawAllowDestructive && !rawApply) {
    throw new AutomationError(
      'CLI_ARGUMENT_ERROR',
      'CLI引数エラー: --allow-destructive を指定する場合は、同時に --apply を指定する必要があります (--allow-destructive requires --apply)',
      { cliOptions }
    );
  }

  // 指示1: --allow-live-write は --apply が必須
  if (rawAllowLiveWrite && !rawApply) {
    throw new AutomationError(
      'CLI_ARGUMENT_ERROR',
      'CLI引数エラー: --allow-live-write を指定する場合は、同時に --apply を指定する必要があります (--allow-live-write requires --apply)',
      { cliOptions }
    );
  }

  // --batch-apply は --apply が必須
  if (rawBatchApply && !rawApply) {
    throw new AutomationError(
      'CLI_ARGUMENT_ERROR',
      'CLI引数エラー: --batch-apply を指定する場合は、同時に --apply を指定する必要があります (--batch-apply requires --apply)',
      { cliOptions }
    );
  }

  // 2. 優先順位の解決: CLI明示値 > .env > デフォルト値
  const configFile = cliOptions.configFile || process.env.SCHOOL_CONFIG_FILE || 'config/school.sample.json';

  // authMode
  let authMode: 'A' | 'B' = 'A';
  if (cliOptions.authMode) {
    authMode = cliOptions.authMode.toUpperCase() === 'B' ? 'B' : 'A';
  } else if (envOverride?.authMode) {
    authMode = envOverride.authMode;
  } else {
    authMode = (process.env.AUTH_MODE || 'A').toUpperCase() === 'B' ? 'B' : 'A';
  }

  // headless
  let headless = false;
  if (cliOptions.headless !== undefined) {
    headless = cliOptions.headless;
  } else if (envOverride?.headless !== undefined) {
    headless = envOverride.headless;
  } else {
    headless = process.env.HEADLESS === 'true';
  }

  const slowMoMs = envOverride?.slowMoMs ?? parseInt(process.env.SLOW_MO_MS || '100', 10);
  const defaultTimeoutMs = envOverride?.defaultTimeoutMs ?? parseInt(process.env.DEFAULT_TIMEOUT_MS || '30000', 10);

  return {
    configFile,
    apply: rawApply,
    allowDestructive: rawAllowDestructive,
    allowLiveWrite: rawAllowLiveWrite && rawApply,
    batchApply: rawBatchApply && rawApply,
    authMode,
    headless,
    slowMoMs,
    defaultTimeoutMs
  };
}

export function loadAppEnvConfig(): AppEnvConfig {
  dotenv.config();

  return {
    authMode: (process.env.AUTH_MODE || 'A').toUpperCase() === 'B' ? 'B' : 'A',
    baseUrl: process.env.BASE_URL || 'https://ed-cl.com',
    schoolCode: process.env.SCHOOL_CODE || '',
    userId: process.env.USER_ID || '',
    password: process.env.PASSWORD,
    externalIdpTimeoutMs: parseInt(process.env.EXTERNAL_IDP_TIMEOUT_MS || '60000', 10),
    dryRun: process.env.DRY_RUN !== 'false',
    allowDestructiveChanges: process.env.ALLOW_DESTRUCTIVE_CHANGES === 'true',
    headless: process.env.HEADLESS === 'true',
    slowMoMs: parseInt(process.env.SLOW_MO_MS || '100', 10),
    defaultTimeoutMs: parseInt(process.env.DEFAULT_TIMEOUT_MS || '30000', 10)
  };
}
