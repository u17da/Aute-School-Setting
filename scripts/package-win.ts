/**
 * Package Builder for Windows x64 Portable Package
 *
 * 実行: npm run package:win
 *
 * 確定要件準拠:
 * 1. 3層分離構造 (runtime, app, data)
 * 2. Playwright Chromium の動的解決 & 同梱 (ハードコード禁止)
 * 3. Allow-list 方式によるファイル配置 & 厳格な Secret Scan (ファイルdenyと実値検知の分離)
 * 4. package.json version を SSOT とした完全同期
 * 5. 生成環境での Chromium 実 launch 動作確認
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '..');

// 1. バージョン取得 (SSOT)
const pkgJsonPath = path.join(repoRoot, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
const version = pkg.version || '1.0.0';
const packageName = `Manapoke-School-Settings-v${version}-win-x64`;

console.log('========================================================');
console.log(` Building Portable Package: ${packageName}`);
console.log('========================================================');

const distDir = path.join(repoRoot, 'dist-package');
const stagingDir = path.join(distDir, packageName);
const zipPath = path.join(distDir, `${packageName}.zip`);

// クリーンアップ
if (fs.existsSync(stagingDir)) {
  console.log(`[Clean] Removing existing staging directory: ${stagingDir}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
if (fs.existsSync(zipPath)) {
  console.log(`[Clean] Removing existing zip archive: ${zipPath}`);
  fs.unlinkSync(zipPath);
}

fs.mkdirSync(stagingDir, { recursive: true });

// 2. ディレクトリ構造の作成
const runtimeDir = path.join(stagingDir, 'runtime');
const browsersDir = path.join(runtimeDir, 'browsers');
const appDir = path.join(stagingDir, 'app');
const dataDir = path.join(stagingDir, 'data');

fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(browsersDir, { recursive: true });
fs.mkdirSync(appDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const emptyDataSubdirs = ['reports', 'checkpoints', 'logs', 'screenshots', '.runtime'];
for (const sub of emptyDataSubdirs) {
  fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
}
console.log('[Setup] Created 3-tier directory structure (runtime, app, data)');

// 3. Node.js Runtime 同梱
console.log('[Runtime] Bundling Node.js executable...');
const sourceNodeExe = process.execPath;
const targetNodeExe = path.join(runtimeDir, 'node.exe');
fs.copyFileSync(sourceNodeExe, targetNodeExe);
console.log(`[Runtime] Copied node.exe from ${sourceNodeExe} to ${targetNodeExe}`);

// 4. Playwright Chromium の動的解決 & コピー (確定要件4)
console.log('[Browsers] Resolving Playwright browser dependencies dynamically...');
const browsersJsonPath = path.join(repoRoot, 'node_modules', 'playwright-core', 'browsers.json');
if (!fs.existsSync(browsersJsonPath)) {
  throw new Error(`playwright-core/browsers.json not found at ${browsersJsonPath}`);
}

const browsersData = JSON.parse(fs.readFileSync(browsersJsonPath, 'utf8'));
const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
const playwrightCacheDir = path.join(localAppData, 'ms-playwright');

if (!fs.existsSync(playwrightCacheDir)) {
  throw new Error(`Playwright cache directory not found at ${playwrightCacheDir}`);
}

const browserEntries = browsersData.browsers.filter(
  (b: any) => b.name === 'chromium' || b.name === 'chromium-headless-shell' || b.name === 'ffmpeg'
);

if (browserEntries.length === 0) {
  throw new Error('No chromium browser entries found in browsers.json');
}

for (const entry of browserEntries) {
  const possibleNames = [
    `${entry.name}-${entry.revision}`,
    `${entry.name.replace(/-/g, '_')}-${entry.revision}`
  ];
  let srcBrowserDir = '';
  let dirName = '';
  for (const name of possibleNames) {
    const candidate = path.join(playwrightCacheDir, name);
    if (fs.existsSync(candidate)) {
      srcBrowserDir = candidate;
      dirName = name;
      break;
    }
  }

  if (srcBrowserDir && dirName) {
    const destBrowserDir = path.join(browsersDir, dirName);
    console.log(`[Browsers] Copying ${dirName} (${entry.browserVersion || 'revision ' + entry.revision})...`);
    fs.cpSync(srcBrowserDir, destBrowserDir, { recursive: true });
  } else if (entry.name === 'chromium' || entry.name === 'chromium-headless-shell') {
    throw new Error(`Required browser artifact ${entry.name}-${entry.revision} not found in ${playwrightCacheDir}. Run npx playwright install chromium.`);
  }
}

// 5. アプリケーションファイルの Allow-list コピー
console.log('[App] Copying application files (Allow-list)...');

// (a) src ディレクトリ全体
fs.cpSync(path.join(repoRoot, 'src'), path.join(appDir, 'src'), { recursive: true });

// (b) config ディレクトリからサンプル・スキーマのみ
const appConfigDir = path.join(appDir, 'config');
fs.mkdirSync(appConfigDir, { recursive: true });
const allowConfigSampleFiles = [
  'credentials.sample.json',
  'schools.sample.csv',
  'schema.json',
  'production-profile.sample.json'
];
for (const file of allowConfigSampleFiles) {
  const src = path.join(repoRoot, 'config', file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(appConfigDir, file));
  }
}

// (c) 設定・依存ファイル
fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(appDir, 'package.json'));
fs.copyFileSync(path.join(repoRoot, 'package-lock.json'), path.join(appDir, 'package-lock.json'));
fs.copyFileSync(path.join(repoRoot, 'tsconfig.json'), path.join(appDir, 'tsconfig.json'));

// (d) Stable Launcher
fs.copyFileSync(path.join(repoRoot, 'scripts', 'launcher.js'), path.join(appDir, 'launcher.js'));

// (e) 必要 node_modules
console.log('[App] Copying required node_modules...');
const srcNodeModules = path.join(repoRoot, 'node_modules');
const destNodeModules = path.join(appDir, 'node_modules');

// node_modules のうち、.cache やテスト系不要ファイルを除外しつつコピー
fs.cpSync(srcNodeModules, destNodeModules, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(srcNodeModules, src);
    if (rel.startsWith('.cache') || rel.includes('playwright-core\\.local-browsers')) {
      return false;
    }
    return true;
  }
});

// 6. ルート起動スクリプト & 説明書の配置
console.log('[Root] Generating Start-Manapoke.cmd, Stop-Manapoke.cmd, VERSION.txt, はじめに.txt...');

// Start-Manapoke.cmd
const startCmdContent = [
  '@echo off',
  'setlocal',
  'chcp 65001 >nul 2>&1',
  '',
  'cd /d "%~dp0"',
  '',
  'if not exist "runtime\\node.exe" (',
  '    echo [ERROR] runtime\\node.exe not found.',
  '    echo Please extract the ZIP archive completely.',
  '    pause',
  '    exit /b 1',
  ')',
  '',
  'if not exist "app\\launcher.js" (',
  '    echo [ERROR] app\\launcher.js not found.',
  '    echo Please extract the ZIP archive completely.',
  '    pause',
  '    exit /b 1',
  ')',
  '',
  '"runtime\\node.exe" "app\\launcher.js" %*',
  'if %errorlevel% neq 0 (',
  '    pause',
  ')',
  ''
].join('\r\n');
fs.writeFileSync(path.join(stagingDir, 'Start-Manapoke.cmd'), startCmdContent, { encoding: 'utf8' });

// Stop-Manapoke.cmd (確定要件6)
const stopCmdContent = [
  '@echo off',
  'setlocal',
  'chcp 65001 >nul 2>&1',
  '',
  'cd /d "%~dp0"',
  '',
  'if not exist "runtime\\node.exe" (',
  '    echo [ERROR] runtime\\node.exe not found.',
  '    echo Please extract the ZIP archive completely.',
  '    pause',
  '    exit /b 1',
  ')',
  '',
  'if not exist "app\\launcher.js" (',
  '    echo [ERROR] app\\launcher.js not found.',
  '    echo Please extract the ZIP archive completely.',
  '    pause',
  '    exit /b 1',
  ')',
  '',
  '"runtime\\node.exe" "app\\launcher.js" --stop',
  'if %errorlevel% neq 0 (',
  '    pause',
  ')',
  ''
].join('\r\n');
fs.writeFileSync(path.join(stagingDir, 'Stop-Manapoke.cmd'), stopCmdContent, { encoding: 'utf8' });

// VERSION.txt
fs.writeFileSync(path.join(stagingDir, 'VERSION.txt'), `${version}\n`, 'utf8');

// はじめに.txt
const readmeTxtContent = `======================================================================
  まなびポケット 学校設定 一括変更ツール (Portable) Ver ${version}
======================================================================

【起動手順】
1. このZIPファイルを任意のフォルダへ展開（すべて展開）します。
2. 展開先にある「Start-Manapoke.cmd」をダブルクリックします。
3. 自動的に起動チェックが行われ、ブラウザで操作画面が開きます。
   （URL: http://127.0.0.1:3000）

【基本操作の流れ】
1. 画面1: 「学校一覧と設定値の準備・入力チェック」
   ・CSVファイル（schoolCode, schoolName, userId, password）をドラッグ＆ドロップ
   ・変更したい設定項目を指定（または「デフォルトを一括設定」）
   ・「事前検証を開始する」をクリック
2. 画面2: 「検証の進行状況」
   ・全校の設定読み取りが自動で実行されます（この段階では変更されません）
3. 画面3: 「検証結果」
   ・設定の差分やリスクを確認します（成功率 100% で次へ進めます）
4. 画面4: 「設定の反映・適用」
   ・内容を確認し、安全な非破壊変更を本番環境へ反映します

【停止手順】
・コンソール画面から安全に停止するか、または「Stop-Manapoke.cmd」を実行してください。

【重要なお知らせと注意事項】
・本ツールは自己完結型です。Node.jsやPlaywright等のインストールは一切不要です。
・設定反映（書き込み）の前に、必ず事前検証結果をご確認ください。
・予約投稿削除リスク（タイムライン/チャンネル非表示）のある学校は自動的にスキップされます。
・「SAVE_OUTCOME_UNKNOWN（保存結果不明）」が表示された場合は再実行せず、管理画面をご確認ください。
・処理実行中はパソコンを強制終了したりネットワークを切断したりしないでください。
・以前のバージョンから移行する場合は、「data」フォルダ内の過去レポート（reports/checkpoints/logs/screenshots）を新バージョンへコピーして引き継ぐことができます（.runtimeはコピーしないでください）。
======================================================================
`;
fs.writeFileSync(path.join(stagingDir, 'はじめに.txt'), readmeTxtContent, 'utf8');

// 7. 厳格な Secret Scan (確定要件3: ファイルdenyと実値検知の完全分離)
console.log('[Security] Running strict Secret Scan on staging directory...');

const fileDenyPatterns = [
  /^\.env(?!\.example)/i,
  /^credentials\.json$/i,
  /\.live\./i,
  /^\.git$/i,
  /^report-.*\.json$/i,
  /^preflight-.*\.json$/i,
  /^summary-.*\.json$/i,
  /^checkpoint-.*\.json$/i,
  /^result-.*\.json$/i
];

const liveDemoKeywords = [
  'PAKCW',
  'PRRHC',
  'PSD20'
];

let scanFailed = false;
const scanViolations: string[] = [];

function scanDirectory(dir: string) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const fullPath = path.join(dir, ent.name);
    const relPath = path.relative(stagingDir, fullPath);

    // 1. File Deny Rule (node_modules 配下は除外)
    if (!relPath.startsWith('app\\node_modules') && !relPath.startsWith('runtime')) {
      for (const pat of fileDenyPatterns) {
        if (pat.test(ent.name) && !ent.name.includes('.sample.')) {
          scanViolations.push(`[DENY_FILE] Forbidden file pattern: ${relPath}`);
          scanFailed = true;
        }
      }
    }

    if (ent.isDirectory()) {
      scanDirectory(fullPath);
    } else if (ent.isFile()) {
      // 2. 実値検知 (テキストファイルのみ対象、node_modulesは除く)
      if (!relPath.startsWith('app\\node_modules') && !relPath.startsWith('runtime')) {
        const ext = path.extname(ent.name).toLowerCase();
        if (['.ts', '.js', '.json', '.csv', '.txt', '.html', '.css', '.md'].includes(ext)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            for (const kw of liveDemoKeywords) {
              if (content.includes(kw)) {
                scanViolations.push(`[LIVE_SECRET] Live demo school code '${kw}' detected in ${relPath}`);
                scanFailed = true;
              }
            }
          } catch (_) {}
        }
      }
    }
  }
}

scanDirectory(stagingDir);

if (scanFailed) {
  console.error('\n【BUILD FAILURE】Secret Scan detected violations:');
  for (const v of scanViolations) {
    console.error(`  - ${v}`);
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
  process.exit(1);
}
console.log('[Security] Secret Scan PASS: No secret files or live demo data detected.');

// 8. 同梱 Chromium 実 launch 動作確認 (確定要件4)
console.log('[Verify] Testing bundled Chromium launch inside staging environment...');
try {
  const testScript = `
    const { chromium } = require('${path.join(appDir, 'node_modules', 'playwright').replace(/\\/g, '/')}');
    process.env.PLAYWRIGHT_BROWSERS_PATH = '${browsersDir.replace(/\\/g, '/')}';
    (async () => {
      const browser = await chromium.launch({ headless: true });
      const version = browser.version();
      await browser.close();
      console.log('CHROME_LAUNCH_OK:' + version);
    })();
  `;
  const launchOut = execSync(`"${targetNodeExe}" -e "${testScript.replace(/\n/g, ' ')}"`, {
    encoding: 'utf8',
    timeout: 15000
  });
  if (!launchOut.includes('CHROME_LAUNCH_OK')) {
    throw new Error(`Unexpected browser launch output: ${launchOut}`);
  }
  const match = launchOut.match(/CHROME_LAUNCH_OK:([^\s]+)/);
  console.log(`[Verify] Bundled Chromium launched successfully! Version: ${match ? match[1] : 'unknown'}`);
} catch (err: any) {
  console.error('\n【BUILD FAILURE】Bundled Chromium launch test failed:', err.message);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  process.exit(1);
}

// 9. ZIP アーカイブの生成
console.log(`[ZIP] Compressing into ${zipPath}...`);
try {
  // PowerShell Compress-Archive を利用 (シングルクォートでスペース対応)
  const psCmd = `Compress-Archive -Path '${stagingDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
  execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'inherit' });
} catch (err: any) {
  console.error('\n【BUILD FAILURE】ZIP compression failed:', err.message);
  process.exit(1);
}

const zipStat = fs.statSync(zipPath);
const zipSizeMb = (zipStat.size / (1024 * 1024)).toFixed(2);

console.log('========================================================');
console.log(' Portable Package Created Successfully!');
console.log(` Package Directory: ${stagingDir}`);
console.log(` ZIP Archive:       ${zipPath} (${zipSizeMb} MB)`);
console.log(` Version:           ${version}`);
console.log('========================================================');
