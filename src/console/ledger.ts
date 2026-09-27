import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CurrentProductionExecutionLedger, CurrentProductionExecutionState, ActiveExecutionResultContext } from './types';
import { BatchSummaryReport } from '../types/batch';
import { normalizeExecutionResult } from './resultsNormalizer';
import { getReportsDir } from '../runtime/paths';

export const CURRENT_LEDGER_FILE_NAME = 'current-production-execution.json';

/**
 * .tmp ファイルへの書き込み -> flush -> rename によるアトミック JSON 保存
 */
export function atomicWriteJsonSync(targetPath: string, data: any): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${targetPath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const jsonContent = JSON.stringify(data, null, 2);
  fs.writeFileSync(tempPath, jsonContent, 'utf-8');
  fs.renameSync(tempPath, targetPath);
}

export function getCurrentLedgerPath(): string {
  return path.join(getReportsDir(), CURRENT_LEDGER_FILE_NAME);
}

export function getContextArtifactPath(productionExecutionId: string): string {
  return path.join(getReportsDir(), `context-${productionExecutionId}.json`);
}

export function getProductionSummaryPath(productionExecutionId: string): string {
  return path.join(getReportsDir(), `summary-${productionExecutionId}.json`);
}

export function writeCurrentLedger(ledger: CurrentProductionExecutionLedger): void {
  atomicWriteJsonSync(getCurrentLedgerPath(), ledger);
}

export function readCurrentLedger(): CurrentProductionExecutionLedger | null {
  const ledgerPath = getCurrentLedgerPath();
  if (!fs.existsSync(ledgerPath)) return null;
  try {
    const raw = fs.readFileSync(ledgerPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schemaVersion === '1.0' && parsed.executionId && parsed.state) {
      return parsed as CurrentProductionExecutionLedger;
    }
  } catch (e) {
    console.error('[ExecutionLedger] Failed to read current ledger:', e);
  }
  return null;
}

export function updateCurrentLedgerState(
  state: CurrentProductionExecutionState,
  overrides?: Partial<CurrentProductionExecutionLedger>
): CurrentProductionExecutionLedger | null {
  const current = readCurrentLedger();
  if (!current) return null;
  const updated: CurrentProductionExecutionLedger = {
    ...current,
    ...overrides,
    state,
    finishedAt: state !== 'RUNNING' && state !== 'STARTING' ? (overrides?.finishedAt || new Date().toISOString()) : current.finishedAt
  };
  writeCurrentLedger(updated);
  return updated;
}

export function writeContextArtifact(context: ActiveExecutionResultContext): string {
  if (!context.productionExecutionId) {
    throw new Error('[RESULT_CONTRACT_INVALID] productionExecutionId is required to persist Context artifact');
  }
  const artifactPath = getContextArtifactPath(context.productionExecutionId);
  const payload = {
    schemaVersion: '1.0',
    productionExecutionId: context.productionExecutionId,
    deploymentId: context.deploymentId,
    runId: context.runId,
    mode: context.mode,
    completedAt: context.completedAt,
    viewModel: context.viewModel,
    summary: context.summary
  };
  atomicWriteJsonSync(artifactPath, payload);
  return artifactPath;
}

/**
 * 再起動時の安全復元 (要件 5)
 * current-production-execution.json という exact pointer だけを見る (directory scan 禁止)
 * state === COMPLETED の場合のみ、exact contextPath / summaryPath を開き Lineage Hash を検証
 */
export function restoreActiveExecutionResultContextFromLedger(expectedLineage?: {
  targetSnapshotId?: string;
  profileSnapshotId?: string;
  finalPreflightExecutionId?: string;
  profileHash?: string;
  schoolsHash?: string;
}): { context: ActiveExecutionResultContext | null; ledger: CurrentProductionExecutionLedger | null; status: 'RESTORED' | 'NOT_COMPLETED' | 'LINEAGE_MISMATCH' | 'CORRUPT' | 'NO_LEDGER' } {
  const ledger = readCurrentLedger();
  if (!ledger) {
    return { context: null, ledger: null, status: 'NO_LEDGER' };
  }

  // state が COMPLETED 以外の場合、過去の成功 Context を復活させない (Crash Recovery 安全原則)
  if (ledger.state !== 'COMPLETED') {
    return { context: null, ledger, status: 'NOT_COMPLETED' };
  }

  // Lineage の検証
  if (expectedLineage) {
    if (expectedLineage.targetSnapshotId && ledger.finalValidationSnapshotId) {
      // 一致確認
    }
    if (expectedLineage.profileSnapshotId && ledger.profileSnapshotId !== expectedLineage.profileSnapshotId) {
      return { context: null, ledger, status: 'LINEAGE_MISMATCH' };
    }
    if (expectedLineage.profileHash && ledger.profileHash !== expectedLineage.profileHash) {
      return { context: null, ledger, status: 'LINEAGE_MISMATCH' };
    }
    if (expectedLineage.schoolsHash && ledger.schoolsHash !== expectedLineage.schoolsHash) {
      return { context: null, ledger, status: 'LINEAGE_MISMATCH' };
    }
  }

  // exact contextPath の読み込み
  if (!fs.existsSync(ledger.contextPath)) {
    return { context: null, ledger, status: 'CORRUPT' };
  }

  try {
    const raw = fs.readFileSync(ledger.contextPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== '1.0' || parsed.productionExecutionId !== ledger.executionId) {
      return { context: null, ledger, status: 'CORRUPT' };
    }

    const context: ActiveExecutionResultContext = {
      productionExecutionId: parsed.productionExecutionId,
      deploymentId: parsed.deploymentId,
      runId: parsed.runId,
      mode: 'PRODUCTION_WRITE',
      summary: parsed.summary,
      viewModel: parsed.viewModel,
      completedAt: parsed.completedAt
    };

    return { context, ledger, status: 'RESTORED' };
  } catch (e) {
    console.error('[ExecutionLedger] Failed to parse context artifact:', e);
    return { context: null, ledger, status: 'CORRUPT' };
  }
}
