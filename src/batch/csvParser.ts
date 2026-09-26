import { parse } from 'csv-parse/sync';
import { BatchSchoolItem, SchoolCredential } from '../types/batch';
import { AutomationError } from '../types/errors';

export interface ParsedCsvBundle {
  schools: BatchSchoolItem[];
  credentials: Record<string, SchoolCredential>;
  totalCount: number;
  enabledCount: number;
  preview: { schoolCode: string; schoolName: string }[];
}

const ALLOWED_UNIFIED_HEADERS = new Set(['schoolCode', 'schoolName', 'userId', 'password', 'enabled']);
const ALLOWED_LEGACY_HEADERS = new Set(['schoolCode', 'schoolName', 'credentialRef', 'enabled']);

/**
 * RFC 4180 準拠の CSV パーサー & Public / Secret 分離
 */
export function parseAndSeparateSchoolsCsv(csvContent: string): ParsedCsvBundle {
  // 1. UTF-8 BOM の除去
  const normalizedContent = csvContent.startsWith('\uFEFF')
    ? csvContent.slice(1)
    : csvContent;

  if (!normalizedContent.trim()) {
    throw new AutomationError('CONFIG_INVALID', 'CSVファイルが空です');
  }

  // 2. RFC 4180 パース (csv-parse/sync)
  let records: string[][];
  try {
    records = parse(normalizedContent, {
      bom: true,
      relax_quotes: false,
      skip_empty_lines: true,
      trim: true,
      comment: '#'
    });
  } catch (err: any) {
    throw new AutomationError('CONFIG_INVALID', `CSV構文エラー (RFC 4180違反): ${err.message || 'クォートやカンマの形式が不正です'}`);
  }

  if (records.length === 0) {
    throw new AutomationError('CONFIG_INVALID', 'CSVファイルに有効なデータ行が存在しません');
  }

  // 3. ヘッダー Allow-list 検証
  const rawHeader = records[0].map((h) => h.trim());
  const headerSet = new Set(rawHeader);

  // 未知ヘッダー検査
  const isUnified = rawHeader.includes('userId') || rawHeader.includes('password');
  const allowedSet = isUnified ? ALLOWED_UNIFIED_HEADERS : ALLOWED_LEGACY_HEADERS;

  for (const h of rawHeader) {
    if (!allowedSet.has(h)) {
      throw new AutomationError(
        'CONFIG_INVALID',
        `CSVヘッダーに未許可のカラムが含まれています: "${h}" (許可カラム: [${Array.from(allowedSet).join(', ')}])`
      );
    }
  }

  const codeIdx = rawHeader.indexOf('schoolCode');
  const nameIdx = rawHeader.indexOf('schoolName');
  const enabledIdx = rawHeader.indexOf('enabled');

  if (codeIdx === -1 || nameIdx === -1) {
    throw new AutomationError('CONFIG_INVALID', 'CSVヘッダーに schoolCode または schoolName が見つかりません');
  }

  const userIdx = rawHeader.indexOf('userId');
  const passIdx = rawHeader.indexOf('password');
  const credRefIdx = rawHeader.indexOf('credentialRef');

  if (isUnified) {
    if (userIdx === -1 || passIdx === -1) {
      throw new AutomationError('CONFIG_INVALID', '1本化CSVには userId と password の両方のカラムが必要です');
    }
  } else {
    if (credRefIdx === -1) {
      throw new AutomationError('CONFIG_INVALID', '従来のCSVには credentialRef カラムが必要です');
    }
  }

  // 4. データ行の検証と Public / Secret 分離
  const schools: BatchSchoolItem[] = [];
  const credentials: Record<string, SchoolCredential> = {};
  const seenCodes = new Set<string>();

  for (let rowIndex = 1; rowIndex < records.length; rowIndex++) {
    const row = records[rowIndex];
    const rowNum = rowIndex + 1; // 1-indexed

    const schoolCode = (row[codeIdx] || '').trim();
    const schoolName = (row[nameIdx] || '').trim();

    if (!schoolCode) {
      throw new AutomationError('CONFIG_INVALID', `${rowNum}行目: schoolCode が空です`);
    }

    let enabled = true;
    if (enabledIdx !== -1 && row[enabledIdx] !== undefined && row[enabledIdx] !== '') {
      const val = row[enabledIdx].toLowerCase().trim();
      if (val === 'true' || val === '1') {
        enabled = true;
      } else if (val === 'false' || val === '0') {
        enabled = false;
      } else {
        throw new AutomationError('CONFIG_INVALID', `${rowNum}行目: enabled の値が不正です ("${row[enabledIdx]}")。true/false または 1/0 を指定してください`);
      }
    }

    // enabled === true の場合は各値の必須チェック & 重複チェック
    if (enabled) {
      if (seenCodes.has(schoolCode)) {
        throw new AutomationError('BATCH_INPUT_INVALID', `${rowNum}行目: 有効な学校に重複した schoolCode が存在します (${schoolCode})`);
      }
      seenCodes.add(schoolCode);

      if (!schoolName) {
        throw new AutomationError('CONFIG_INVALID', `${rowNum}行目: 有効な学校の schoolName が空です`);
      }

      if (isUnified) {
        const userId = (row[userIdx] || '').trim();
        const password = row[passIdx] || ''; // password は末尾空白も許容しうるが必須

        if (!userId) {
          throw new AutomationError('CONFIG_INVALID', `${rowNum}行目: 有効な学校の userId が空です`);
        }
        if (!password) {
          throw new AutomationError('CONFIG_INVALID', `${rowNum}行目: 有効な学校の password が空です`);
        }

        // 決定論的 credentialRef (schoolCode を利用)
        const credentialRef = schoolCode;

        // Public Data
        schools.push({
          schoolCode,
          schoolName,
          credentialRef,
          enabled
        });

        // Secret Data (分離して保持)
        credentials[credentialRef] = {
          userId,
          password
        };
      } else {
        const credentialRef = (row[credRefIdx] || '').trim();
        if (!credentialRef) {
          throw new AutomationError('CONFIG_INVALID', `${rowNum}行目: 有効な学校の credentialRef が空です`);
        }

        schools.push({
          schoolCode,
          schoolName,
          credentialRef,
          enabled
        });
      }
    } else {
      // 無効行 (enabled === false)
      const credentialRef = isUnified ? schoolCode : (row[credRefIdx] || '').trim() || schoolCode;
      schools.push({
        schoolCode,
        schoolName: schoolName || schoolCode,
        credentialRef,
        enabled
      });
      if (isUnified && row[userIdx] && row[passIdx]) {
        credentials[credentialRef] = {
          userId: row[userIdx].trim(),
          password: row[passIdx]
        };
      }
    }
  }

  const enabledSchools = schools.filter((s) => s.enabled);
  const preview = schools.slice(0, 20).map((s) => ({
    schoolCode: s.schoolCode,
    schoolName: s.schoolName
  }));

  return {
    schools,
    credentials,
    totalCount: schools.length,
    enabledCount: enabledSchools.length,
    preview
  };
}
