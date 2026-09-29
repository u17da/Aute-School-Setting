export interface SchoolGradeClassConfig {
  schoolId: string;
  id?: string;
  password?: string;
  schoolName: string;
  isJuniorHigh: boolean;
  grades: TargetGradeConfig[];
  classes: TargetClassConfig[];
}

export interface TargetGradeConfig {
  gradeName: string; // 例: "1ねん", "2年", "1年", "全校"
  gradeCode: string; // 例: "1", "2", "7", "13"
  isCustomCode?: boolean; // コードが13以上などのカスタム指定
}

export interface TargetClassConfig {
  gradeName: string; // 所属学年名 (例: "1ねん", "2年", "全校")
  className: string; // クラス名 (例: "1ねん1くみ", "1ねんAぐみ", "2年1組", "共通")
}

/**
 * 全角英数を半角英数に変換
 */
export function normalizeZenToHan(str: string): string {
  return str
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':')
    .replace(/｜/g, '|')
    .replace(/、/g, ',')
    .trim();
}

/**
 * 空欄・不要文字列の判定
 */
export function isBlankToken(token: string): boolean {
  const t = token.trim();
  return (
    t === '' ||
    t === '（空欄）' ||
    t === '(空欄)' ||
    t === '空欄' ||
    t === '（なし）' ||
    t === '(なし)' ||
    t === '-' ||
    t === 'ー'
  );
}

/**
 * 文字列が数字のみ（半角）か判定
 */
export function isNumericString(str: string): boolean {
  return /^[0-9]+$/.test(str.trim());
}

/**
 * 学校種別（中学校かどうか）を判定
 */
export function detectJuniorHigh(schoolName: string): boolean {
  return (
    schoolName.includes('中学校') ||
    schoolName.includes('中等教育学校') ||
    schoolName.includes('中等学校') ||
    schoolName.includes('中学')
  );
}

/**
 * クラス名トークンの正規化
 * - 全角数字・英数の半角化
 * - すでに末尾に「組」「くみ」「ぐみ」が付いている場合は除去（二重付与防止）
 */
export function normalizeClassToken(token: string): string {
  let t = normalizeZenToHan(token).trim();
  t = t.replace(/(組|くみ|ぐみ)$/, '').trim();
  return t;
}

/**
 * 1校分の設定を生成
 */
export function buildSchoolGradeClassConfig(
  schoolId: string,
  id: string | undefined,
  password: string | undefined,
  schoolName: string,
  rawSchoolYears: string,
  rawGradeClasses: string
): SchoolGradeClassConfig {
  const isJuniorHigh = detectJuniorHigh(schoolName);
  const grades: TargetGradeConfig[] = [];
  const classes: TargetClassConfig[] = [];

  // 1. 学年一覧（E列）の解析
  const normalizedYearsStr = normalizeZenToHan(rawSchoolYears);
  const yearTokens = normalizedYearsStr
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter((s) => !isBlankToken(s));

  const validGradeNumbers: number[] = [];
  for (const token of yearTokens) {
    const num = parseInt(token, 10);
    if (!isNaN(num)) {
      validGradeNumbers.push(num);
    }
  }

  // 2. 学年設定（マニュアルP.8〜9）の生成
  for (const gNum of validGradeNumbers) {
    if (isJuniorHigh) {
      // 中学校: 1年〜3年 (学年コード 7, 8, 9)
      const code = (gNum + 6).toString(); // 中1=7, 中2=8, 中3=9
      grades.push({
        gradeName: `${gNum}年`,
        gradeCode: code,
        isCustomCode: false
      });
    } else {
      // 小学校: 1ねん (コード1), 2年〜6年 (コード2〜6)
      if (gNum === 1) {
        grades.push({
          gradeName: '1ねん',
          gradeCode: '1',
          isCustomCode: false
        });
      } else {
        grades.push({
          gradeName: `${gNum}年`,
          gradeCode: gNum.toString(),
          isCustomCode: false
        });
      }
    }
  }

  // 全校共通の学年（学年コード13「全校」）
  grades.push({
    gradeName: '全校',
    gradeCode: '13',
    isCustomCode: true
  });

  // 3. 学年別Class（F列）の解析
  const normalizedClassStr = normalizeZenToHan(rawGradeClasses);
  const gradeBlocks = normalizedClassStr
    .split('|')
    .map((b) => b.trim())
    .filter((b) => !isBlankToken(b));

  for (const block of gradeBlocks) {
    const colonIdx = block.indexOf(':');
    if (colonIdx === -1) continue;

    const gStr = block.substring(0, colonIdx).trim();
    if (isBlankToken(gStr)) continue;

    const gNum = parseInt(gStr, 10);
    if (isNaN(gNum)) continue;

    const classTokensStr = block.substring(colonIdx + 1).trim();
    const rawTokens = classTokensStr
      .split(/[,、]/)
      .map((c) => c.trim())
      .filter((c) => !isBlankToken(c));

    for (const rawToken of rawTokens) {
      if (isBlankToken(rawToken)) continue;
      const cleanToken = normalizeClassToken(rawToken);
      if (!cleanToken) continue;

      let gradeName = '';
      let className = '';

      if (isJuniorHigh) {
        // 中学校: 1年1組, 1年A組, 1年楽組 など
        gradeName = `${gNum}年`;
        className = `${gNum}年${cleanToken}組`;
      } else {
        // 小学校
        if (gNum === 1) {
          gradeName = '1ねん';
          const isNum = isNumericString(cleanToken);
          const suffix = isNum ? 'くみ' : 'ぐみ';
          className = `1ねん${cleanToken}${suffix}`;
        } else {
          gradeName = `${gNum}年`;
          className = `${gNum}年${cleanToken}組`;
        }
      }

      // 同一学年・クラス名の重複追加を防止
      if (!classes.some((c) => c.gradeName === gradeName && c.className === className)) {
        classes.push({ gradeName, className });
      }
    }
  }

  // 全校共通のクラス（学年「全校」に紐づく「共通」）
  classes.push({
    gradeName: '全校',
    className: '共通'
  });

  return {
    schoolId,
    id: id?.trim() || undefined,
    password: password?.trim() || undefined,
    schoolName,
    isJuniorHigh,
    grades,
    classes
  };
}

/**
 * CSVコンテンツ全体のパース
 */
export function parseGradeClassCsv(content: string): SchoolGradeClassConfig[] {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  // ヘッダー行を探す
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i].includes('学年別Class') ||
      lines[i].includes('SchoolYear一覧') ||
      lines[i].includes('学校コード') ||
      lines[i].includes('SchoolID')
    ) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    headerIndex = 0;
  }

  const headerCols = parseCsvLine(lines[headerIndex]);

  // 列インデックスの動的判定
  let colSchoolId = 0;
  let colSchoolName = 1;
  let colId = 2;
  let colPw = 3;
  let colSchoolYears = 4;
  let colGradeClasses = 5;

  headerCols.forEach((col, idx) => {
    const c = col.trim();
    if (c === '学校コード' || c === 'SchoolID' || c === '学校ID') colSchoolId = idx;
    else if (c === 'SchoolName' || c === '学校名') colSchoolName = idx;
    else if (c === 'ID' || c === 'ユーザーID') colId = idx;
    else if (c === 'パスワード' || c === 'PW' || c === 'Password') colPw = idx;
    else if (c.includes('SchoolYear') || c.includes('学年一覧')) colSchoolYears = idx;
    else if (c.includes('学年別Class') || c.includes('クラス')) colGradeClasses = idx;
  });

  const results: SchoolGradeClassConfig[] = [];

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#')) continue;

    const cols = parseCsvLine(line);
    // 学年・クラス列を持たない4列データ等はスキップ
    if (cols.length < 6) continue;

    const schoolId = cols[colSchoolId]?.trim() || '';
    const schoolName = cols[colSchoolName]?.trim() || '';
    const id = cols[colId]?.trim() || '';
    const pw = cols[colPw]?.trim() || '';
    const rawSchoolYears = cols[colSchoolYears]?.trim() || '';
    const rawGradeClasses = cols[colGradeClasses]?.trim() || '';

    // 学校コードが NaN または未定義の場合はスキップ
    if (!schoolId || schoolId === 'NaN' || !schoolName || schoolName === 'NaN') continue;

    // 学年・クラスがすべて空欄の学校はスキップ
    if (isBlankToken(rawSchoolYears) && isBlankToken(rawGradeClasses)) {
      continue;
    }

    results.push(
      buildSchoolGradeClassConfig(schoolId, id, pw, schoolName, rawSchoolYears, rawGradeClasses)
    );
  }

  return results;
}

/**
 * 1行のCSVを分割（ダブルクォート内のカンマに対応）
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}
