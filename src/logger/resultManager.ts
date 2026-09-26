import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ExecutionResult, ExecutionPlan, ExecutionPlanEvaluation, ExecutionIssue } from '../types/plan';
import { ExecutionStatus } from '../types/errors';
import { EffectiveExecutionOptions, RequestedSettings } from '../types/config';
import { SchoolSettingsObservation } from '../types/settings';
import { generateSettingsHash, generateRunConfigHash } from '../utils/hash';

export const TOOL_VERSION = '1.0.0';

export class ResultManager {
  private result: ExecutionResult;
  private logDir: string;

  constructor() {
    this.logDir = path.resolve(process.cwd(), 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    this.result = {
      runId,
      toolVersion: TOOL_VERSION,
      startedAt,
      finishedAt: startedAt,
      schoolCode: null,
      schoolName: null,
      status: 'UNEXPECTED_ERROR',
      settingsHash: null,
      runConfigHash: null,
      executionOptions: null,
      executionPlan: null,
      evaluation: null,
      beforeObservation: null,
      afterObservation: null,
      issues: [],
      screenshotPaths: {}
    };
  }

  getResult(): ExecutionResult {
    return this.result;
  }

  setExecutionOptions(options: EffectiveExecutionOptions): void {
    this.result.executionOptions = options;
  }

  setSchoolInfo(schoolCode: string, schoolName: string): void {
    this.result.schoolCode = schoolCode;
    this.result.schoolName = schoolName;
  }

  setAuthObservation(authObs: import('../types/auth').AuthObservation): void {
    this.result.authObservation = authObs;
  }

  setHashes(settings: RequestedSettings, options: EffectiveExecutionOptions): void {
    this.result.settingsHash = generateSettingsHash(settings);
    if (this.result.schoolCode && this.result.schoolName) {
      this.result.runConfigHash = generateRunConfigHash({
        schoolCode: this.result.schoolCode,
        schoolName: this.result.schoolName,
        settings,
        executionOptions: options
      });
    }
  }

  setPlanAndEvaluation(plan: ExecutionPlan, evaluation: ExecutionPlanEvaluation): void {
    this.result.executionPlan = plan;
    this.result.evaluation = evaluation;
    if (evaluation.blockReasons.length > 0) {
      this.result.issues.push(...evaluation.blockReasons);
    }
  }

  setBeforeObservation(obs: SchoolSettingsObservation): void {
    this.result.beforeObservation = obs;
  }

  setAfterObservation(obs: SchoolSettingsObservation): void {
    this.result.afterObservation = obs;
  }

  addIssue(issue: ExecutionIssue): void {
    this.result.issues.push(issue);
  }

  setStatus(status: ExecutionStatus): void {
    this.result.status = status;
  }

  setScreenshotPath(stage: string, path: string): void {
    this.result.screenshotPaths[stage] = path;
  }

  save(): string {
    this.result.finishedAt = new Date().toISOString();
    const codePart = this.result.schoolCode ? `-${this.result.schoolCode}` : '-init';
    const timestamp = this.result.finishedAt.replace(/[:.]/g, '-');
    const fileName = `result${codePart}-${timestamp}.json`;
    const filePath = path.join(this.logDir, fileName);

    fs.writeFileSync(filePath, JSON.stringify(this.result, null, 2), 'utf-8');
    return filePath;
  }
}
