import { parseGradeClassCsv, SchoolGradeClassConfig } from '../src/batch/gradeClassParser';

const sampleCsv = `学校別 学年・クラス構成（1校1行）,,,,,
,,,,,
SchoolID,ID,PW,SchoolName,SchoolYear一覧,学年別Class
45633,,,滝川小学校,1、2、3、4、5、6、（空欄）,1：Ａ、B ｜ 2：A、B ｜ 3：A、B、（空欄） ｜ 4：A、B ｜ 5：A、B ｜ 6：A、B、（空欄） ｜ （空欄）：（空欄）
75996,,,堀川小学校,1、2、3、4、5、6、（空欄）,1：1、2、3、4、5 ｜ 2：1、2、3、4、5、6 ｜ 3：1、2、3、4、5 ｜ 4：1、2、3、4、5、6 ｜ 5：1、2、3、4、5 ｜ 6：1、2、3、4、5 ｜ （空欄）：（空欄）
99001,,,中央中学校,1、2、3、（空欄）,1：1、2、3 ｜ 2：1、2、3 ｜ 3：1、2、3 ｜ （空欄）：（空欄）
`;

function testParser() {
  console.log('=== 学年・クラスCSVパーサーの単体テスト開始 ===');
  const configs = parseGradeClassCsv(sampleCsv);
  console.log(`パース結果校数: ${configs.length}校`);

  // 1. 滝川小学校
  const takigawa = configs.find((c) => c.schoolId === '45633')!;
  console.log(`\n--- [1] 滝川小学校 ---`);
  console.log(`学校名: ${takigawa.schoolName}, 中学校判定: ${takigawa.isJuniorHigh}`);
  console.log(`学年一覧:`, takigawa.grades.map((g) => `${g.gradeName}(コード:${g.gradeCode})`).join(', '));
  console.log(`クラス一覧 (${takigawa.classes.length}クラス):`);
  takigawa.classes.forEach((c) => console.log(`  - [${c.gradeName}] ${c.className}`));

  // 検証
  if (takigawa.isJuniorHigh !== false) throw new Error('滝川小学校は小学校判定されるべきです');
  if (takigawa.grades[0].gradeName !== '1ねん') throw new Error('小1の学年名称は "1ねん" であるべきです');
  if (takigawa.grades.find((g) => g.gradeName === '全校')?.gradeCode !== '13') throw new Error('学年コード13「全校」が存在すべきです');
  if (!takigawa.classes.some((c) => c.className === '1ねんAぐみ')) throw new Error('1ねんAぐみ が存在すべきです');
  if (!takigawa.classes.some((c) => c.className === '1ねんBぐみ')) throw new Error('1ねんBぐみ が存在すべきです');
  if (!takigawa.classes.some((c) => c.className === '2年A組')) throw new Error('2年A組 が存在すべきです');
  if (!takigawa.classes.some((c) => c.className === '共通' && c.gradeName === '全校')) throw new Error('全校の共通クラスが存在すべきです');

  // 2. 堀川小学校
  const horikawa = configs.find((c) => c.schoolId === '75996')!;
  console.log(`\n--- [2] 堀川小学校 ---`);
  console.log(`学校名: ${horikawa.schoolName}, 中学校判定: ${horikawa.isJuniorHigh}`);
  console.log(`学年一覧:`, horikawa.grades.map((g) => `${g.gradeName}(コード:${g.gradeCode})`).join(', '));
  console.log(`クラス一覧 (${horikawa.classes.length}クラス):`);
  horikawa.classes.forEach((c) => console.log(`  - [${c.gradeName}] ${c.className}`));

  // 検証
  if (!horikawa.classes.some((c) => c.className === '1ねん1くみ')) throw new Error('数字クラスは "1ねん1くみ" であるべきです');
  if (!horikawa.classes.some((c) => c.className === '1ねん5くみ')) throw new Error('数字クラスは "1ねん5くみ" であるべきです');
  if (!horikawa.classes.some((c) => c.className === '2年1組')) throw new Error('2年1組 が存在すべきです');
  if (!horikawa.classes.some((c) => c.className === '2年6組')) throw new Error('2年6組 が存在すべきです');

  // 3. 中央中学校
  const chuoJhs = configs.find((c) => c.schoolId === '99001')!;
  console.log(`\n--- [3] 中央中学校 ---`);
  console.log(`学校名: ${chuoJhs.schoolName}, 中学校判定: ${chuoJhs.isJuniorHigh}`);
  console.log(`学年一覧:`, chuoJhs.grades.map((g) => `${g.gradeName}(コード:${g.gradeCode})`).join(', '));
  console.log(`クラス一覧 (${chuoJhs.classes.length}クラス):`);
  chuoJhs.classes.forEach((c) => console.log(`  - [${c.gradeName}] ${c.className}`));

  // 検証
  if (chuoJhs.isJuniorHigh !== true) throw new Error('中央中学校は中学校判定されるべきです');
  if (chuoJhs.grades[0].gradeName !== '1年' || chuoJhs.grades[0].gradeCode !== '7') {
    throw new Error('中学校1年の学年名称は "1年"、コードは "7" であるべきです');
  }
  if (!chuoJhs.classes.some((c) => c.className === '1年1組')) throw new Error('中学校は "1年1組" であるべきです');
  if (!chuoJhs.classes.some((c) => c.className === '共通' && c.gradeName === '全校')) throw new Error('全校の共通クラスが存在すべきです');

  console.log('\nすべての単体テストが正常に合格しました！');
}

testParser();
