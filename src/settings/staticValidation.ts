import { SchoolConfigFile, EffectiveExecutionOptions } from '../types/config';
import { AutomationError } from '../types/errors';

/**
 * ブラウザを起動する前に実行可能な静的バリデーション
 */
export function validateConfigStatic(
  config: SchoolConfigFile,
  options: EffectiveExecutionOptions
): void {
  const { settings } = config;

  // 1. タイムライン・チャンネル機能 (OFF) と 子機能 (ON) の論理矛盾
  if (settings.timelineChannel === 'OFF') {
    if (settings.allChannel === 'ON') {
      throw new AutomationError(
        'CONFIG_CONFLICT',
        '設定競合: タイムライン・チャンネル機能がOFFに指定されている場合、全体チャンネル機能をONに指定することはできません',
        { timelineChannel: 'OFF', allChannel: 'ON' }
      );
    }
    if (settings.parentChannel === 'ON') {
      throw new AutomationError(
        'CONFIG_CONFLICT',
        '設定競合: タイムライン・チャンネル機能がOFFに指定されている場合、保護者チャンネル機能をONに指定することはできません',
        { timelineChannel: 'OFF', parentChannel: 'ON' }
      );
    }
  }

  // 2. 個別メッセージ機能 (OFF) と 保護者との個別メッセージ (ON) の論理矛盾
  if (settings.directMessage === 'OFF') {
    if (settings.parentDirectMessage === 'ON') {
      throw new AutomationError(
        'CONFIG_CONFLICT',
        '設定競合: 個別メッセージ機能がOFFに指定されている場合、保護者との個別メッセージをONに指定することはできません',
        { directMessage: 'OFF', parentDirectMessage: 'ON' }
      );
    }
  }

  // 3. 外部IdP連携時のパスワード変更表示 (SHOW) 禁止 (EffectiveExecutionOptions.authModeを参照)
  if (options.authMode === 'B') {
    if (settings.studentPasswordChange === 'SHOW') {
      throw new AutomationError(
        'UNSAFE_CONFIGURATION',
        '危険な設定: 外部IdP連携(AUTH_MODE=B)を利用している場合、児童・生徒へパスワード変更を表示することはできません (外部IdP側で管理するため)',
        { authMode: 'B', studentPasswordChange: 'SHOW' }
      );
    }
  }
}
