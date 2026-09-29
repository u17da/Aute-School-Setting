import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const transcriptPath = 'C:\\Users\\u17da\\.gemini\\antigravity\\brain\\50563a92-51db-4afe-b0a2-3dccd3b7011c\\.system_generated\\logs\\transcript.jsonl';
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n');

  let rawUserText = '';
  for (const line of lines) {
    if (line.includes('堀川小学校') && line.includes('ふくむら やすひさ') && line.includes('滝川小学校')) {
      try {
        const obj = JSON.parse(line);
        if (obj.content && obj.content.includes('75996')) {
          rawUserText = obj.content;
          break;
        }
      } catch (e) {}
    }
  }

  if (!rawUserText) {
    console.error('対象のユーザー入力行が見つかりませんでした');
    return;
  }

  console.log(`テキスト取得成功: ${rawUserText.length} 文字`);

  const textLines = rawUserText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  console.log(`総行数: ${textLines.length}`);

  const adminRecords: any[] = [];
  let isTable = false;

  for (const l of textLines) {
    if (l.includes('学校コード') && l.includes('admin+ ID')) {
      isTable = true;
      continue;
    }
    if (isTable) {
      if (l.startsWith('設定作業用') || l.startsWith(',設定作業用') || l.startsWith('schoolChode') || l.startsWith('ユーザーID,性別') || l.startsWith(',,,')) {
        isTable = false;
        continue;
      }
      const parts = l.split(',').map(p => p.trim());
      // 形式: 学校コード,admin+ ID,admin+ PW,学校名,役割,表示名,性別,メールアドレス,ユーザーID,パスワード,外部認証ID,...
      if (parts.length >= 11 && parts[0] && parts[3]) {
        adminRecords.push({
          schoolCode: parts[0],
          adminPlusId: parts[1],
          adminPlusPw: parts[2],
          schoolName: parts[3],
          role: parts[4] || 'admin',
          displayName: parts[5],
          gender: parts[6] || 'male',
          email: parts[7],
          userId: parts[8],
          password: parts[9],
          federationId: parts[10],
          jobTitle: parts[14] || parts[11] || ''
        });
      }
    }
  }

  console.log(`パースされた管理者数: ${adminRecords.length} 名`);

  const schools = new Set(adminRecords.map(r => r.schoolCode));
  const idpSchools = new Set(adminRecords.filter(r => r.adminPlusId.includes('@')).map(r => r.schoolCode));
  const localSchools = new Set(adminRecords.filter(r => !r.adminPlusId.includes('@')).map(r => r.schoolCode));

  console.log(`総学校数: ${schools.size} 校`);
  console.log(`- 外部IdP認証校: ${idpSchools.size} 校`);
  console.log(`- ローカル通常認証校: ${localSchools.size} 校`);

  // CSV書き出し
  const outCsv = path.resolve('data', 'all_school_admins.csv');
  const csvLines = [
    '学校コード,admin+ ID,admin+ PW,学校名,役割,表示名,性別,メールアドレス,ユーザーID,パスワード,外部認証ID,役職',
    ...adminRecords.map(r => `${r.schoolCode},${r.adminPlusId},${r.adminPlusPw},"${r.schoolName}",${r.role},"${r.displayName}",${r.gender},${r.email},${r.userId},${r.password},${r.federationId},"${r.jobTitle}"`)
  ];
  fs.writeFileSync(outCsv, csvLines.join('\n'), 'utf-8');
  console.log(`CSV保存完了: ${outCsv} (行数: ${csvLines.length})`);

  // 集計サマリーJSON
  const summary = {
    totalRecords: adminRecords.length,
    totalSchools: schools.size,
    idpSchoolsCount: idpSchools.size,
    localSchoolsCount: localSchools.size,
    schools: Array.from(schools).map(code => {
      const recs = adminRecords.filter(r => r.schoolCode === code);
      return {
        schoolCode: code,
        schoolName: recs[0].schoolName,
        authType: recs[0].adminPlusId.includes('@') ? 'IdP' : 'Local',
        adminCount: recs.length,
        admins: recs.map(r => `${r.displayName} (${r.userId})`)
      };
    })
  };
  fs.writeFileSync(path.resolve('data', 'all_school_admins_summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`サマリーJSON保存完了: data/all_school_admins_summary.json`);
}

main().catch(console.error);
