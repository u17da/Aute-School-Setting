import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RequestedSettings, EffectiveExecutionOptions } from '../types/config';
import { BatchSchoolItem } from '../types/batch';

/**
 * オブジェクトをキー順ソートした canonical なオブジェクトに正規化
 */
function sortObjectKeys<T extends Record<string, any>>(obj: T): any {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, any> = {};
  for (const key of sortedKeys) {
    result[key] = sortObjectKeys(obj[key]);
  }
  return result;
}

/**
 * settingsHash: 400校に同一設定を配布したことを証明するためのHash (settingsのみ)
 */
export function generateSettingsHash(settings: RequestedSettings): string {
  const canonical = sortObjectKeys(settings);
  const jsonStr = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(jsonStr).digest('hex');
}

/**
 * runConfigHash: その1回の実行条件（学校、設定、オプション）を完全追跡・監査するためのHash
 */
export function generateRunConfigHash(params: {
  schoolCode: string;
  schoolName: string;
  settings: RequestedSettings;
  executionOptions: EffectiveExecutionOptions;
}): string {
  const canonical = sortObjectKeys({
    schoolCode: params.schoolCode,
    schoolName: params.schoolName,
    settings: params.settings,
    executionOptions: {
      apply: params.executionOptions.apply,
      allowDestructive: params.executionOptions.allowDestructive,
      allowLiveWrite: params.executionOptions.allowLiveWrite,
      authMode: params.executionOptions.authMode,
      headless: params.executionOptions.headless
    }
  });
  const jsonStr = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(jsonStr).digest('hex');
}

/**
 * schoolsHash: 対象学校定義一覧の実行順序を保持した canonical hash (指示3)
 * ※ schoolCodeでソートせず、確定した実行順序 (order) を含めてハッシュ化
 */
export function generateSchoolsHash(schools: BatchSchoolItem[]): string {
  const orderedList = schools.map((s, index) => ({
    order: index,
    credentialRef: s.credentialRef,
    enabled: s.enabled,
    schoolCode: s.schoolCode,
    schoolName: s.schoolName
  }));

  const jsonStr = JSON.stringify(orderedList);
  return crypto.createHash('sha256').update(jsonStr).digest('hex');
}

import { ALL_SETTING_KEYS } from '../settings/definitions';
import { ApplyTargetItem } from '../types/batch';

/**
 * baselineHash: 各学校の全11 SettingKeyについて value と availability の両方を固定key順で canonical 化して Hash 化 (指示7)
 */
export function generateBaselineHash(
  observation: Partial<Record<string, any>>
): string {
  const canonicalList = ALL_SETTING_KEYS.map((key) => {
    const item = (observation as any)?.[key];
    if (!item) {
      return { key, value: null, availability: 'CONTRACT_NOT_AVAILABLE' };
    }
    if (typeof item === 'object' && ('value' in item || 'availability' in item)) {
      return {
        key,
        value: item.value ?? null,
        availability: item.availability || (item.value !== null ? 'AVAILABLE' : 'CONTRACT_NOT_AVAILABLE')
      };
    }
    return {
      key,
      value: item,
      availability: item !== null && item !== undefined ? 'AVAILABLE' : 'CONTRACT_NOT_AVAILABLE'
    };
  });

  const jsonStr = JSON.stringify(canonicalList);
  return crypto.createHash('sha256').update(jsonStr).digest('hex');
}

/**
 * applyTargetHash: 各Apply Targetの canonical representation (schoolCode順ソート) 全体から生成する監査Hash (指示3)
 */
export function generateApplyTargetHash(targets: ApplyTargetItem[] | string[]): string {
  if (targets.length === 0) {
    return crypto.createHash('sha256').update(JSON.stringify([])).digest('hex');
  }

  // 文字列配列の場合は後方互換でソートしてハッシュ化
  if (typeof targets[0] === 'string') {
    const sorted = [...(targets as string[])].sort();
    return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  }

  // ApplyTargetItem[] の場合 (指示3 準拠)
  const sorted = [...(targets as ApplyTargetItem[])].sort((a, b) => a.schoolCode.localeCompare(b.schoolCode));
  const canonicalItems = sorted.map((t) => {
    const sortedActions = [...t.plannedActions].sort((a, b) => a.settingKey.localeCompare(b.settingKey));
    const sortedExpectedKeys = Object.keys(t.expectedFinalState).sort();
    const sortedExpected: Record<string, string | null> = {};
    for (const k of sortedExpectedKeys) {
      sortedExpected[k] = t.expectedFinalState[k];
    }
    return {
      schoolCode: t.schoolCode,
      baselineHash: t.baselineHash,
      plannedActions: sortedActions,
      expectedFinalState: sortedExpected
    };
  });

  const jsonStr = JSON.stringify(canonicalItems);
  return crypto.createHash('sha256').update(jsonStr).digest('hex');
}

/**
 * 指示10: package.json から toolVersion を取得 (SSOT)
 */
export function getToolVersion(): string {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version || '1.0.0';
    }
  } catch {
    // fallback
  }
  return '1.0.0';
}

/**
 * 指示6: ソースコード (src 配下の全 ts ファイル), package.json, package-lock.json から toolFingerprint を計算
 * Windows / macOS 間での差異を防ぐため改行コードを LF に正規化
 */
export function generateToolFingerprint(): string {
  const hash = crypto.createHash('sha256');

  // src ディレクトリ配下の全tsファイルを再帰探索してソート順にハッシュに追加
  function hashDir(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hashDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const rawContent = fs.readFileSync(fullPath, 'utf-8');
        const normalized = rawContent.replace(/\r\n/g, '\n');
        hash.update(entry.name);
        hash.update(normalized);
      }
    }
  }

  hashDir(path.resolve(process.cwd(), 'src'));

  const pkgPath = path.resolve(process.cwd(), 'package.json');
  if (fs.existsSync(pkgPath)) {
    const rawContent = fs.readFileSync(pkgPath, 'utf-8');
    hash.update('package.json');
    hash.update(rawContent.replace(/\r\n/g, '\n'));
  }

  const lockPath = path.resolve(process.cwd(), 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const rawContent = fs.readFileSync(lockPath, 'utf-8');
    hash.update('package-lock.json');
    hash.update(rawContent.replace(/\r\n/g, '\n'));
  }

  return hash.digest('hex');
}

