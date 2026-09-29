import * as fs from 'fs';
import * as path from 'path';
import { parseGradeClassCsv } from '../src/batch/gradeClassParser';

function testProductionCsv() {
  const csvPath = path.resolve('data', 'production_grades_classes_raw.csv');
  const content = fs.readFileSync(csvPath, 'utf-8');

  console.log(`=== 本番CSVパース検証 ===`);
  const configs = parseGradeClassCsv(content);
  console.log(`正常パース成功校数: ${configs.length} 校`);

  // 小学校と中学校の内訳
  const elemSchools = configs.filter((c) => !c.isJuniorHigh);
  const jhsSchools = configs.filter((c) => c.isJuniorHigh);
  console.log(`小学校: ${elemSchools.length} 校`);
  console.log(`中学校: ${jhsSchools.length} 校`);

  // サンプル数校の出力確認
  const samples = [
    configs.find((c) => c.schoolName.includes('滝川小学校')),
    configs.find((c) => c.schoolName.includes('堀川小学校')),
    configs.find((c) => c.schoolName.includes('西天満小学校')), // い、ろ
    configs.find((c) => c.schoolName.includes('天満中学校')), // 中学校
    configs.find((c) => c.schoolName.includes('大空小学校')), // ゆめ、あい...
    configs.find((c) => c.schoolName.includes('高倉小学校')), // 3組
    configs.find((c) => c.schoolName.includes('心和中学校')) // 楽、道、夢
  ].filter(Boolean);

  console.log(`\n--- サンプル校の解析結果確認 ---`);
  for (const s of samples) {
    if (!s) continue;
    console.log(`\n【${s.schoolName}】 (コード: ${s.schoolId}, ID: ${s.id}, PW: ${s.password ? '******' : '（共通マスター）'})`);
    console.log(`  学年一覧 (${s.grades.length}件): ` + s.grades.map((g) => `${g.gradeName}(${g.gradeCode})`).join(', '));
    console.log(`  クラス一覧 (${s.classes.length}件): ` + s.classes.map((c) => c.className).join(', '));
  }

  // 二重「組組」や「くみ組」等のバグがないか全校スキャン
  let errorCount = 0;
  for (const c of configs) {
    for (const cls of c.classes) {
      if (cls.className.includes('組組') || cls.className.includes('くみ組') || cls.className.includes('ぐみ組')) {
        console.error(`ERROR: 二重組検出: ${c.schoolName} -> ${cls.className}`);
        errorCount++;
      }
    }
  }

  if (errorCount === 0) {
    console.log('\n全校のクラス名で二重組・表記異常は一切検出されませんでした！');
  } else {
    throw new Error(`二重組エラーが ${errorCount} 件発生しました`);
  }
}

testProductionCsv();
