import * as fs from 'fs';
import * as path from 'path';
import { CredentialProvider, SchoolCredential } from '../types/batch';
import { AutomationError } from '../types/errors';

/**
 * .env からデフォルトの学校管理者資格情報を取得するプロバイダー
 */
export class EnvCredentialProvider implements CredentialProvider {
  private defaultUserId: string;
  private defaultPassword?: string;

  constructor(defaultUserId: string, defaultPassword?: string) {
    this.defaultUserId = defaultUserId;
    this.defaultPassword = defaultPassword;
  }

  async getCredential(ref: string): Promise<SchoolCredential> {
    if (!this.defaultUserId || !this.defaultPassword) {
      throw new AutomationError('LOGIN_FAILED', `Credential ref "${ref}" の資格情報が .env に見つかりません`);
    }
    return {
      userId: this.defaultUserId,
      password: this.defaultPassword
    };
  }

  hasCredential(ref: string): boolean {
    return Boolean(this.defaultUserId && this.defaultPassword);
  }
}

/**
 * Git管理外のローカル秘密ファイル (JSON) から資格情報を参照するプロバイダー (指示14)
 * ファイル例: secrets/credentials.live.json
 */
export class FileCredentialProvider implements CredentialProvider {
  private credentialsMap: Record<string, SchoolCredential> = {};

  constructor(secretsFilePath: string) {
    const resolvedPath = path.resolve(process.cwd(), secretsFilePath);
    if (fs.existsSync(resolvedPath)) {
      const raw = fs.readFileSync(resolvedPath, 'utf-8');
      this.credentialsMap = JSON.parse(raw);
    }
  }

  hasCredential(ref: string): boolean {
    const cred = this.credentialsMap[ref];
    return Boolean(cred && cred.userId && cred.password);
  }

  async getCredential(ref: string): Promise<SchoolCredential> {
    const cred = this.credentialsMap[ref];
    if (!cred || !cred.userId || !cred.password) {
      throw new AutomationError('CREDENTIAL_NOT_FOUND', `Credential ref "${ref}" に対応する認証情報が秘密ファイル内に存在しません`);
    }
    return cred;
  }
}
