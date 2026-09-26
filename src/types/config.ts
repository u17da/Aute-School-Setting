import { SettingValueMap } from './settings';

export interface SchoolTarget {
  schoolCode: string;
  schoolName: string;
}

export type RequestedSettings = {
  [K in keyof SettingValueMap]?: SettingValueMap[K] | null;
};

export interface SchoolConfigFile {
  school: SchoolTarget;
  settings: RequestedSettings;
}

// 実行開始時に一度だけ確定される有効実行オプション（SSOT）
export interface EffectiveExecutionOptions {
  configFile: string;
  apply: boolean;            // true の場合のみ書き込み実行（デフォルト: false）
  allowDestructive: boolean; // true の場合のみ破壊的変更を許可（デフォルト: false）
  allowLiveWrite: boolean;   // true の場合のみ実環境へのWriteを許可（デフォルト: false）
  batchApply: boolean;       // true の場合のみBatchでの書き込みを許可（デフォルト: false）
  authMode: 'A' | 'B';
  headless: boolean;
  slowMoMs: number;
  defaultTimeoutMs: number;
}

// CLI引数の生入力
export interface RawCliOptions {
  configFile?: string;
  apply?: boolean;
  allowDestructive?: boolean;
  allowLiveWrite?: boolean;
  batchApply?: boolean;
  authMode?: string;
  headless?: boolean;
}

export interface AppEnvConfig {
  authMode: 'A' | 'B';
  baseUrl: string;
  schoolCode: string;
  userId: string;
  password?: string;
  externalIdpTimeoutMs: number;
  dryRun: boolean;
  allowDestructiveChanges: boolean;
  headless: boolean;
  slowMoMs: number;
  defaultTimeoutMs: number;
}
