import * as fs from 'fs';
import * as path from 'path';
import { PlatformJob } from '../types/job';
import { getDataRootDir } from '../../runtime/paths';

import { validateOperationIR } from '../types/plan';
import { LocalSecretVault } from '../ingestion/documentIngestion';

export class JobStore {
  private static instance: JobStore | null = null;
  private jobs: Map<string, PlatformJob> = new Map();
  private storageDir: string;

  constructor() {
    this.storageDir = path.join(getDataRootDir(), 'jobs');
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      this.loadExistingJobs();
    } catch {
      // Memory fallback if filesystem access fails
    }
  }

  static getInstance(): JobStore {
    if (!JobStore.instance) {
      JobStore.instance = new JobStore();
    }
    return JobStore.instance;
  }

  getJob(jobId: string): PlatformJob | undefined {
    const job = this.jobs.get(jobId);
    if (job && this.isJobMissingCredentials(job)) {
      if (job.status !== 'COMPLETED' && job.status !== 'FAILED' && job.status !== 'STOPPED' && job.status !== 'HALTED_BY_CIRCUIT_BREAKER') {
        job.status = 'CREDENTIAL_REQUIRED';
      }
    }
    return job;
  }

  private isJobMissingCredentials(job: PlatformJob): boolean {
    if (!job.targetSet || !job.targetSet.schools || job.targetSet.schools.length === 0) return false;
    // Check if any ready school has missing secrets in LocalSecretVault
    const readySchools = job.targetSet.schools.filter(s => s.validationStatus === 'READY' && s.enabled);
    if (readySchools.length === 0) return false;
    for (const s of readySchools) {
      if (!LocalSecretVault.hasSecret(s.credentialRef, job.jobId)) {
        return true;
      }
    }
    return false;
  }

  listJobs(): PlatformJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  saveJob(job: PlatformJob): void {
    job.updatedAt = new Date().toISOString();
    this.jobs.set(job.jobId, job);

    // Save to disk without secrets
    try {
      const sanitizedJob = this.sanitizeJobForStorage(job);
      const filePath = path.join(this.storageDir, `${job.jobId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(sanitizedJob, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[JobStore] Failed to persist job ${job.jobId} to disk:`, e);
    }
  }

  private sanitizeJobForStorage(job: PlatformJob): PlatformJob {
    // Deep clone and ensure no plaintext secrets are persisted
    const cloned: PlatformJob = JSON.parse(JSON.stringify(job));
    if (cloned.targetSet) {
      if (typeof cloned.targetSet.rawTextProvided !== 'boolean' && cloned.targetSet.rawTextProvided !== undefined) {
        cloned.targetSet.rawTextProvided = Boolean(cloned.targetSet.rawTextProvided);
      }
      if (cloned.targetSet.schools) {
        for (const s of cloned.targetSet.schools) {
          // Strip any residual sensitive metadata
          if (s.metadata?.password) delete s.metadata.password;
          if (s.metadata?.credential) delete s.metadata.credential;
        }
      }
    }
    return cloned;
  }

  private loadExistingJobs(): void {
    try {
      if (!fs.existsSync(this.storageDir)) return;
      const files = fs.readdirSync(this.storageDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(this.storageDir, file), 'utf-8');
          const job: PlatformJob = JSON.parse(content);
          if (job.executionPlan?.operations) {
            job.executionPlan.operations.forEach(op => validateOperationIR(op));
          }
          if (this.isJobMissingCredentials(job)) {
            if (job.status !== 'COMPLETED' && job.status !== 'FAILED' && job.status !== 'STOPPED' && job.status !== 'HALTED_BY_CIRCUIT_BREAKER') {
              job.status = 'CREDENTIAL_REQUIRED';
            }
          }
          this.jobs.set(job.jobId, job);
        } catch {
          // ignore corrupted or schema-invalid files
        }
      }
    } catch {
      // ignore
    }
  }
}
