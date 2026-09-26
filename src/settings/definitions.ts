import { SettingKey, SettingDefinition, SettingValue } from '../types/settings';

export const SETTING_DEFINITIONS: Record<SettingKey, SettingDefinition> = {
  storage: {
    key: 'storage',
    label: 'ストレージ機能',
    options: [
      { label: 'ON', value: 'ON' },
      { label: 'OFF', value: 'OFF' },
      { label: '先生のみ', value: 'TEACHERS_ONLY' }
    ],
    defaultValue: 'ON',
    destructiveWhenOff: false
  },
  timelineChannel: {
    key: 'timelineChannel',
    label: 'タイムライン・チャンネル機能',
    options: [
      { label: 'ON', value: 'ON' },
      { label: 'OFF', value: 'OFF' }
    ],
    defaultValue: 'ON',
    destructiveWhenOff: true // 予約投稿削除の副作用あり
  },
  directMessage: {
    key: 'directMessage',
    label: '個別メッセージ機能',
    options: [
      { label: 'ON', value: 'ON' },
      { label: 'OFF', value: 'OFF' },
      { label: '生徒同士は不可', value: 'STUDENT_TO_STUDENT_DISABLED' }
    ],
    defaultValue: 'STUDENT_TO_STUDENT_DISABLED',
    destructiveWhenOff: false
  },
  parentDirectMessage: {
    key: 'parentDirectMessage',
    label: '保護者との個別メッセージ',
    options: [
      { label: 'ON', value: 'ON' },
      { label: 'OFF', value: 'OFF' }
    ],
    defaultValue: 'ON',
    destructiveWhenOff: false
  },
  allChannel: {
    key: 'allChannel',
    label: '全体チャンネル機能',
    options: [
      { label: 'ON', value: 'ON' },
      { label: 'OFF', value: 'OFF' }
    ],
    defaultValue: 'ON',
    destructiveWhenOff: true // 予約投稿削除の副作用あり
  },
  parentChannel: {
    key: 'parentChannel',
    label: '保護者チャンネル機能',
    options: [
      { label: 'ON', value: 'ON' },
      { label: 'OFF', value: 'OFF' }
    ],
    defaultValue: 'ON',
    destructiveWhenOff: true // 予約投稿削除の副作用あり
  },
  attendance: {
    key: 'attendance',
    label: '出欠連絡機能',
    options: [
      { label: 'ON', value: 'ON' },
      { label: 'OFF', value: 'OFF' }
    ],
    defaultValue: 'ON',
    destructiveWhenOff: false
  },
  contactBook: {
    key: 'contactBook',
    label: '連絡帳機能',
    options: [
      { label: 'ON', value: 'ON' },
      { label: 'OFF', value: 'OFF' }
    ],
    defaultValue: 'ON',
    destructiveWhenOff: false
  },
  mentalHealth: {
    key: 'mentalHealth',
    label: '心の健康観察機能',
    options: [
      { label: 'ON', value: 'ON' },
      { label: 'OFF', value: 'OFF' }
    ],
    defaultValue: 'OFF',
    isOptionalInContract: true, // 契約内容によって画面に表示されない場合がある
    destructiveWhenOff: false
  },
  otherSchoolLog: {
    key: 'otherSchoolLog',
    label: '他校のログ表示を許可',
    options: [
      { label: 'する', value: 'ALLOW' },
      { label: 'しない', value: 'DENY' }
    ],
    defaultValue: 'ALLOW',
    destructiveWhenOff: false
  },
  studentPasswordChange: {
    key: 'studentPasswordChange',
    label: '児童・生徒へパスワード変更を表示',
    options: [
      { label: 'する', value: 'SHOW' },
      { label: 'しない', value: 'HIDE' }
    ],
    defaultValue: 'HIDE',
    destructiveWhenOff: false
  }
};

export const ALL_SETTING_KEYS: SettingKey[] = [
  'storage',
  'timelineChannel',
  'directMessage',
  'parentDirectMessage',
  'allChannel',
  'parentChannel',
  'attendance',
  'contactBook',
  'mentalHealth',
  'otherSchoolLog',
  'studentPasswordChange'
];

export function getSettingDefinition(key: SettingKey): SettingDefinition {
  return SETTING_DEFINITIONS[key];
}

/**
  * 実画面のUIラベル文字列から正規化されたDomain Valueへ変換（SSOT）
  * settingKeyごとに専用の選択肢マッピングを参照（グローバル変換禁止）
  */
export function labelToValue(key: SettingKey, label: string): SettingValue | null {
  const def = SETTING_DEFINITIONS[key];
  const normalized = label.trim().replace(/\s+/g, '');

  for (const opt of def.options) {
    const optNormalized = opt.label.trim().replace(/\s+/g, '');
    if (normalized === optNormalized) {
      return opt.value;
    }
  }

  // 「表示する」「表示しない」などのシノニム対応（settingKeyごとに厳格スコープ）
  if (key === 'studentPasswordChange') {
    if (normalized === '表示する') return 'SHOW';
    if (normalized === '表示しない') return 'HIDE';
  }
  if (key === 'otherSchoolLog') {
    if (normalized === '許可する') return 'ALLOW';
    if (normalized === '許可しない') return 'DENY';
  }

  return null;
}

/**
 * labelToValue の明示的エイリアス (ユーザー指示 3 準拠)
 */
export const mapUiLabel = labelToValue;

/**
 * Domain Valueから画面表示用の公式ラベルへ変換（SSOT）
 * settingKeyごとに専用の選択肢マッピングを参照
 */
export function valueToLabel(key: SettingKey, value: SettingValue): string {
  const def = SETTING_DEFINITIONS[key];
  const found = def.options.find((opt) => opt.value === value);
  return found ? found.label : String(value);
}
