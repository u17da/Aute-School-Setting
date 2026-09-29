import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

async function main() {
  const transcriptPath = 'C:\\Users\\u17da\\.gemini\\antigravity\\brain\\50563a92-51db-4afe-b0a2-3dccd3b7011c\\.system_generated\\logs\\transcript_full.jsonl';
  const fileStream = fs.createReadStream(transcriptPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let rawContent = '';
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      if (data.type === 'USER_INPUT' && typeof data.content === 'string') {
        if (data.content.includes('学校コード,admin+ ID,admin+ PW')) {
          rawContent = data.content;
        }
      }
    } catch (e) {}
  }

  if (!rawContent) {
    console.error('ユーザー入力データが見つかりませんでした');
    return;
  }

  // <USER_REQUEST> タグを除去
  const match = rawContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>([\s\S]*)/);
  const body = match ? match[2] : rawContent;

  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  console.log(`総行数: ${lines.length}`);

  // テーブル1: 学校コード,admin+ ID,admin+ PW,学校名,役割,表示名,性別,メールアドレス,ユーザーID,パスワード,外部認証ID,完了チェック,作業者,備考,管理職
  const adminRecords: any[] = [];
  let isTable1 = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('学校コード,admin+ ID,admin+ PW')) {
      isTable1 = true;
      continue;
    }
    if (isTable1) {
      if (line.startsWith('設定作業用') || line.startsWith(',設定作業用') || line.startsWith('schoolChode') || line.startsWith('ユーザーID,性別') || line.startsWith(',,,')) {
        isTable1 = false;
        continue;
      }

      const cols = line.split(',').map(c => c.trim());
      if (cols.length >= 11 && cols[0] && cols[6]) {
        // 学校コード, admin+ ID, admin+ PW, 学校名, 役割, 表示名, 性別, メールアドレス, ユーザーID, パスワード, 外部認証ID
        adminRecords.push({
          schoolCode: cols[0],
          adminPlusId: cols[1],
          adminPlusPw: cols[2],
          schoolName: cols[3],
          role: cols[4] || 'admin',
          displayName: cols[5],
          gender: cols[6],
          email: cols[7],
          userId: cols[8],
          password: cols[9],
          federationId: cols[10],
          jobTitle: cols[14] || ''
        });
      }
    }
  }

  console.log(`抽出された管理者レコード数: ${adminRecords.length} 件`);

  // 集計
  const schools = new Set(adminRecords.map(r => r.schoolCode));
  const idpSchools = new Set(adminRecords.filter(r => r.adminPlusId.includes('@')).map(r => r.schoolCode));
  const localSchools = new Set(adminRecords.filter(r => !r.adminPlusId.includes('@')).map(r => r.schoolCode));

  console.log(`総学校数: ${schools.size} 校`);
  console.log(`- 外部IdP認証校 (@oskedu.jp): ${idpSchools.size} 校`);
  console.log(`- ローカル通常認証校 (schooladmin): ${localSchools.size} 校`);

  // CSV出力 (scripts/register_school_admins.ts 向け完全フォーマット)
  // 学校コード,admin+ ID,admin+ PW,学校名,役割,表示名,性別,メールアドレス,ユーザーID,パスワード,外部認証ID,役職
  const csvHeader = '学校コード,admin+ ID,admin+ PW,学校名,役割,表示名,性別,メールアドレス,ユーザーID,パスワード,外部認証ID,役職';
  const csvRows = adminRecords.map(r => 
    `${r.schoolCode},${r.adminPlusId},${r.adminPlusPw},"${r.schoolName}",${r.role},"${r.displayName}",${r.gender},${r.email},${r.userId},${r.password},${r.federationId},"${r.jobTitle}"`
  );

  const outCsvPath = path.resolve('data', 'all_school_admins.csv');
  fs.writeFileSync(outCsvPath, [csvHeader, ...csvRows].join('\n'), 'utf-8');
  console.log(`CSV保存完了: ${outCsvPath}`);

  // 学校ごとの集計JSON
  const stats = {
    totalRecords: adminRecords.length,
    totalSchools: schools.size,
    idpSchoolsCount: idpSchools.size,
    localSchoolsCount: localSchools.size,
    schoolsList: Array.from(schools).map(code => {
      const recs = adminRecords.filter(r => r.schoolCode === code);
      return {
        schoolCode: code,
        schoolName: recs[0].schoolName,
        authType: recs[0].adminPlusId.includes('@') ? 'IdP' : 'Local',
        adminPlusId: recs[0].adminPlusId,
        adminCount: recs.length,
        admins: recs.map(r => `${r.displayName} (${r.userId})`)
      };
    })
  };

  const outStatsPath = path.resolve('data', 'all_school_admins_stats.json');
  fs.writeFileSync(outStatsPath, JSON.stringify(stats, null, 2), 'utf-8');
  console.log(`集計JSON保存完了: ${outStatsPath}`);
}

main().catch(console.error);
