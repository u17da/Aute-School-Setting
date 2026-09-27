/**
 * Stable Launcher Contract for Manapoke School Settings Operator Console
 *
 * 役割:
 * - 起動前 Self-Check
 * - Single Instance ガード & PID Management
 * - Auto Port 探索
 * - 環境変数注入 (MANAPOKE_DATA_DIR, PLAYWRIGHT_BROWSERS_PATH, NODE_USE_SYSTEM_CA)
 * - Operator Console Server の起動
 * - 起動確認後のブラウザ自動オープン
 * - --stop による安全停止 (Safe Stop & PID限定終了)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { exec, spawn } = require('child_process');

// 1. パス構造の解決
// 通常 Portable 配置時: <packageRoot>/app/launcher.js -> packageRoot = path.resolve(__dirname, '..')
// 開発リポジトリ実行時: <repoRoot>/scripts/launcher.js -> packageRoot = path.resolve(__dirname, '..')
const appDir = __dirname;
const packageRoot = path.resolve(appDir, '..');

// runtime / data ディレクトリの決定
// Portable 環境では packageRoot 配下に runtime / data が存在
const isPortablePackage = fs.existsSync(path.join(packageRoot, 'runtime')) && fs.existsSync(path.join(packageRoot, 'data'));
const runtimeDir = isPortablePackage ? path.join(packageRoot, 'runtime') : path.join(packageRoot, 'runtime');
const dataDir = isPortablePackage ? path.join(packageRoot, 'data') : path.resolve(process.env.MANAPOKE_DATA_DIR || path.join(packageRoot, 'data'));

const runtimeStateDir = path.join(dataDir, '.runtime');
const pidFilePath = path.join(runtimeStateDir, 'console.pid');
const ownerFilePath = path.join(runtimeStateDir, 'console-owner.json');

// cwd を appDir に固定 (確定要件1)
process.chdir(appDir);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
  }
}

function getAppVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    return pkg.version || '1.0.0';
  } catch (_) {
    return '1.0.0';
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function checkConsoleHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/status`, { timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ ok: true, state: json.jobState || json.state, data: json });
        } catch (_) {
          resolve({ ok: false });
        }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
    ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// ----------------------------------------------------
// STOP モード処理 (--stop)
// ----------------------------------------------------
async function handleStop() {
  console.log('まなびポケット 学校設定ツールの停止処理を実行しています...');

  if (!fs.existsSync(pidFilePath) || !fs.existsSync(ownerFilePath)) {
    console.log('ツールは起動していません。');
    process.exit(0);
  }

  let ownerData;
  try {
    ownerData = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8'));
  } catch (_) {
    console.log('プロセス情報ファイルを読み込めませんでした。クリーンアップを実行します。');
    try { fs.unlinkSync(pidFilePath); } catch (_) {}
    try { fs.unlinkSync(ownerFilePath); } catch (_) {}
    process.exit(0);
  }

  const pid = ownerData.pid;
  const port = ownerData.port;

  if (!isPidAlive(pid)) {
    console.log('対象プロセスは既に終了しています。状態ファイルをクリーンアップしました。');
    try { fs.unlinkSync(pidFilePath); } catch (_) {}
    try { fs.unlinkSync(ownerFilePath); } catch (_) {}
    process.exit(0);
  }

  // 既存 Console Server のヘルス確認
  const health = await checkConsoleHealth(port);
  if (health.ok) {
    // 実行中 (RUNNING / STOPPING) の場合は application-level safe stop を要求
    if (health.state === 'RUNNING' || health.state === 'STOPPING') {
      console.log('現在処理中の学校があります。安全停止 (Graceful Shutdown) を要求しています...');
      try {
        await new Promise((resolve) => {
          const req = http.request(
            `http://127.0.0.1:${port}/api/preflight/stop`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' } },
            () => resolve()
          );
          req.on('error', () => resolve());
          req.write(JSON.stringify({}));
          req.end();
        });

        // 最大 20 秒間ポーリングして完了待機
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const h = await checkConsoleHealth(port);
          if (!h.ok || h.state === 'READY' || h.state === 'IDLE' || h.state === 'FAILED' || h.state === 'STOPPED') {
            console.log('安全停止が完了しました。');
            break;
          }
        }
      } catch (_) {}
    }
  }

  // PID の終了処理 (無関係なプロセスは絶対に終了しない)
  console.log(`コンソールサーバー (PID: ${pid}) を終了しています...`);
  try {
    process.kill(pid, 'SIGINT');
  } catch (_) {}

  // 終了待機 (最大 5 秒)
  let killed = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isPidAlive(pid)) {
      killed = true;
      break;
    }
  }

  if (!killed && isPidAlive(pid)) {
    console.log('SIGINT で終了しなかったため、対象プロセスを終了します...');
    if (process.platform === 'win32') {
      exec(`taskkill /F /PID ${pid}`, () => {});
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    }
  }

  try { fs.unlinkSync(pidFilePath); } catch (_) {}
  try { fs.unlinkSync(ownerFilePath); } catch (_) {}
  console.log('まなびポケット 学校設定ツールを安全に停止しました。');
  process.exit(0);
}

// ----------------------------------------------------
// START モード処理
// ----------------------------------------------------
async function findAvailablePort(startPort) {
  function checkPort(p) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => {
        srv.close(() => resolve(true));
      });
      srv.listen(p, '127.0.0.1');
    });
  }

  for (let p = startPort; p < startPort + 50; p++) {
    const isFree = await checkPort(p);
    if (isFree) return p;
  }
  throw new Error(`利用可能なポートが見つかりませんでした (${startPort} - ${startPort + 50})`);
}

async function handleStart() {
  console.log('========================================================');
  console.log(' まなびポケット 学校設定 一括変更ツール (Portable)       ');
  console.log('========================================================');
  console.log('起動前チェックを実行しています...');

  ensureDir(dataDir);
  ensureDir(runtimeStateDir);

  // 1. Self-Check
  // (a) data ディレクトリ書き込み権限
  try {
    const testFile = path.join(dataDir, `.write-test-${Date.now()}`);
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  } catch (err) {
    console.error('\n【エラー】このフォルダへの書き込み権限がありません。');
    console.error('別の書き込み可能なフォルダへ ZIP を展開して再試行してください。\n');
    process.exit(1);
  }

  // (b) 必須アプリ本体ファイル確認
  const requiredAppFiles = ['package.json', 'src/console/server.ts'];
  for (const rf of requiredAppFiles) {
    if (!fs.existsSync(path.join(appDir, rf))) {
      console.error(`\n【エラー】必要なファイル (${rf}) が不足しています。ZIP を再展開してください。\n`);
      process.exit(1);
    }
  }

  // (c) Chromium 存在確認 (Portable パッケージ時)
  const browsersDir = path.join(runtimeDir, 'browsers');
  if (isPortablePackage) {
    if (!fs.existsSync(browsersDir)) {
      console.error('\n【エラー】同梱ブラウザ (Chromium) が見つかりません。ZIP を再展開してください。\n');
      process.exit(1);
    }
  }

  // 2. Single Instance ガード
  if (fs.existsSync(pidFilePath) && fs.existsSync(ownerFilePath)) {
    try {
      const ownerData = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8'));
      if (isPidAlive(ownerData.pid)) {
        const health = await checkConsoleHealth(ownerData.port);
        if (health.ok) {
          const url = `http://127.0.0.1:${ownerData.port}`;
          console.log('\nOperator Console は既に起動しています。');
          console.log(`ブラウザでコンソールを開きます: ${url}`);
          openBrowser(url);
          process.exit(0);
        }
      }
    } catch (_) {
      // stale metadata -> ignore and overwrite
    }
  }

  // 3. ポート決定 (Auto Port)
  const defaultPort = parseInt(process.env.CONSOLE_PORT || '3000', 10);
  let selectedPort;
  try {
    selectedPort = await findAvailablePort(defaultPort);
  } catch (err) {
    console.error('\n【エラー】ポートの確保に失敗しました:', err.message);
    process.exit(1);
  }

  if (selectedPort !== defaultPort) {
    console.log(`ポート ${defaultPort} は別アプリで使用中のため、ポート ${selectedPort} で起動します。`);
  }

  // 4. 環境変数の設定 (確定要件 1, 2)
  process.env.MANAPOKE_DATA_DIR = dataDir;
  if (fs.existsSync(browsersDir)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir;
  }
  process.env.NODE_USE_SYSTEM_CA = '1';
  process.env.CONSOLE_PORT = String(selectedPort);

  // 5. PID & Owner ファイルの記録 (PID Management)
  const ownerInfo = {
    pid: process.pid,
    port: selectedPort,
    startedAt: new Date().toISOString(),
    appVersion: getAppVersion(),
    packageRoot: packageRoot
  };
  fs.writeFileSync(pidFilePath, String(process.pid), 'utf8');
  fs.writeFileSync(ownerFilePath, JSON.stringify(ownerInfo, null, 2), 'utf8');

  // クリーンアップハンドラ
  const cleanup = () => {
    try {
      if (fs.existsSync(pidFilePath)) {
        const recordedPid = parseInt(fs.readFileSync(pidFilePath, 'utf8').trim(), 10);
        if (recordedPid === process.pid) {
          fs.unlinkSync(pidFilePath);
          fs.unlinkSync(ownerFilePath);
        }
      }
    } catch (_) {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  // 6. ts-node 登録 & ConsoleServer 起動
  console.log('コンソールサーバーを起動しています...');
  try {
    const tsNode = require('ts-node');
    tsNode.register({ transpileOnly: true });
  } catch (e) {
    console.error('\n【エラー】ts-node の初期化に失敗しました:', e.message);
    cleanup();
    process.exit(1);
  }

  let serverInstance;
  try {
    const { ConsoleServer } = require('./src/console/server');
    serverInstance = new ConsoleServer({ port: selectedPort, host: '127.0.0.1' });
    await serverInstance.start();
  } catch (e) {
    console.error('\n【エラー】コンソールサーバーの起動に失敗しました:', e.message);
    cleanup();
    process.exit(1);
  }

  const targetUrl = `http://127.0.0.1:${selectedPort}`;
  console.log('--------------------------------------------------------');
  console.log(`Operator Console を開きました: ${targetUrl}`);
  console.log('終了するには Stop-Manapoke.cmd を実行するか、このウィンドウで Ctrl+C を押してください。');
  console.log('--------------------------------------------------------');

  // ブラウザ自動オープン
  openBrowser(targetUrl);
}

// ----------------------------------------------------
// エントリポイント判定
// ----------------------------------------------------
const isStopCommand = process.argv.includes('--stop');
if (isStopCommand) {
  handleStop().catch((err) => {
    console.error('停止処理中にエラーが発生しました:', err);
    process.exit(1);
  });
} else {
  handleStart().catch((err) => {
    console.error('起動処理中に予期せぬエラーが発生しました:', err);
    process.exit(1);
  });
}
