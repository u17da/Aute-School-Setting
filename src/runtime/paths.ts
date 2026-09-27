import * as path from 'path';
import * as fs from 'fs';

/**
 * Runtime Paths SSOT (Single Source of Truth)
 *
 * reports / checkpoints / logs / screenshots / runtime-state のパス解決を集約。
 * 環境変数 MANAPOKE_DATA_DIR が設定されている場合はその配下、
 * 未設定（非Portable通常実行）時は process.cwd() をfallbackとして使用。
 */

export function getDataRootDir(): string {
  if (process.env.MANAPOKE_DATA_DIR) {
    return path.resolve(process.env.MANAPOKE_DATA_DIR);
  }
  return process.cwd();
}

export function getReportsDir(): string {
  const dir = path.resolve(getDataRootDir(), 'reports');
  ensureDir(dir);
  return dir;
}

export function getCheckpointsDir(): string {
  const dir = path.resolve(getDataRootDir(), 'checkpoints');
  ensureDir(dir);
  return dir;
}

export function getLogsDir(): string {
  const dir = path.resolve(getDataRootDir(), 'logs');
  ensureDir(dir);
  return dir;
}

export function getScreenshotsDir(): string {
  const dir = path.resolve(getDataRootDir(), 'screenshots');
  ensureDir(dir);
  return dir;
}

export function getRuntimeStateDir(): string {
  const dir = path.resolve(getDataRootDir(), '.runtime');
  ensureDir(dir);
  return dir;
}

export function getConsolePidFilePath(): string {
  return path.resolve(getRuntimeStateDir(), 'console.pid');
}

export function getConsoleOwnerFilePath(): string {
  return path.resolve(getRuntimeStateDir(), 'console-owner.json');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore concurrent creation
    }
  }
}
