// 設定項目のキー定義
export type SettingKey =
  | 'storage'
  | 'timelineChannel'
  | 'directMessage'
  | 'parentDirectMessage'
  | 'allChannel'
  | 'parentChannel'
  | 'attendance'
  | 'contactBook'
  | 'mentalHealth'
  | 'otherSchoolLog'
  | 'studentPasswordChange';

// 正規化された設定値の型定義
export type OnOff = 'ON' | 'OFF';
export type StorageValue = 'ON' | 'OFF' | 'TEACHERS_ONLY';
export type DirectMessageValue = 'ON' | 'OFF' | 'STUDENT_TO_STUDENT_DISABLED';
export type PermissionValue = 'ALLOW' | 'DENY';
export type DisplayValue = 'SHOW' | 'HIDE';

export type SettingValue =
  | OnOff
  | StorageValue
  | DirectMessageValue
  | PermissionValue
  | DisplayValue;

// 各設定キーごとの許容値マップ
export type SettingValueMap = {
  storage: StorageValue;
  timelineChannel: OnOff;
  directMessage: DirectMessageValue;
  parentDirectMessage: OnOff;
  allChannel: OnOff;
  parentChannel: OnOff;
  attendance: OnOff;
  contactBook: OnOff;
  mentalHealth: OnOff;
  otherSchoolLog: PermissionValue;
  studentPasswordChange: DisplayValue;
};

// UI上の利用可能性状態モデル
export type SettingAvailability =
  | 'AVAILABLE'               // 通常利用・操作可能
  | 'CONTRACT_NOT_AVAILABLE'  // 契約上、画面に存在しない (例: 心の健康観察機能)
  | 'DISABLED_BY_DEPENDENCY'; // 実DOM上でdisabled/無効化を観測した場合

// 実画面から観測した状態
export interface SettingObservation {
  value: SettingValue | null;
  availability: SettingAvailability;
}

// 検証対象となる期待状態（availabilityがundefinedなら値のみ検証）
export interface SettingExpectation {
  value: SettingValue | null;
  availability?: SettingAvailability;
}

export type SchoolSettingsObservation = Record<SettingKey, SettingObservation>;

// 画面表示名とEnum値の対応定義
export interface OptionDefinition {
  label: string;
  value: SettingValue;
}

export interface SettingDefinition {
  key: SettingKey;
  label: string;
  options: OptionDefinition[];
  defaultValue: SettingValue;
  isOptionalInContract?: boolean; // 契約内容によって画面に表示されない場合があるか
  destructiveWhenOff?: boolean;   // ON → OFF にすると予約投稿等が削除されるか
}

// 保存処理時の詳細観測結果 (指示2: POSTと最終GETのstatusを分離)
export interface SaveObservation {
  submitRequestUrl: string;
  submitMethod: string;
  submitResponseStatus: number | null; // POSTそのもののレスポンス (例: 302, 200)
  redirectDetected: boolean;
  redirectLocation?: string;
  finalUrl: string | null;
  finalNavigationStatus: number | null; // リダイレクト後の最終GETレスポンス (例: 200)
  flashMessage?: string;
  buttonDisabledObserved?: boolean;
}
