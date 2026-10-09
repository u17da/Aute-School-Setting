import * as crypto from 'crypto';
import { DocumentContent, DocumentTable, DocumentMetadata } from './documentTypes';

export interface IngestFileInput {
  filename: string;
  bufferOrText: Buffer | string;
  mimeType?: string;
}

export class LocalSecretVault {
  private static secrets: Map<string, string> = new Map();
  private static secretToJob: Map<string, string> = new Map();
  private static jobSecrets: Map<string, Set<string>> = new Map();
  private static schoolSecrets: Map<string, string> = new Map();
  private static jobSchoolSecrets: Map<string, Set<string>> = new Map();

  static storeSecret(plainSecret: string, jobId?: string): string {
    const handle = `secret_handle_${crypto.randomUUID()}`;
    this.secrets.set(handle, plainSecret);
    if (jobId) {
      this.secretToJob.set(handle, jobId);
      if (!this.jobSecrets.has(jobId)) {
        this.jobSecrets.set(jobId, new Set());
      }
      this.jobSecrets.get(jobId)!.add(handle);
    }
    return handle;
  }

  static storeSecretWithRef(ref: string, plainSecret: string, jobId?: string): void {
    this.secrets.set(ref, plainSecret);
    if (jobId) {
      this.secretToJob.set(ref, jobId);
      if (!this.jobSecrets.has(jobId)) {
        this.jobSecrets.set(jobId, new Set());
      }
      this.jobSecrets.get(jobId)!.add(ref);
    }
    // Also index by schoolCode if ref is cred_ref_{schoolCode}
    if (ref.startsWith('cred_ref_')) {
      const schoolCode = ref.replace('cred_ref_', '');
      this.schoolSecrets.set(schoolCode, plainSecret);
      if (jobId) {
        if (!this.jobSchoolSecrets.has(jobId)) {
          this.jobSchoolSecrets.set(jobId, new Set());
        }
        this.jobSchoolSecrets.get(jobId)!.add(schoolCode);
      }
    }
  }

  static getSecret(handle: string, jobId?: string): string | undefined {
    // If handle is bound to a specific job and a different jobId is queried, deny access (job-scoping)
    const ownerJobId = this.secretToJob.get(handle);
    if (ownerJobId && jobId && ownerJobId !== jobId) {
      return undefined;
    }
    return this.secrets.get(handle);
  }

  static getSecretForSchool(schoolCode: string): string | undefined {
    return this.schoolSecrets.get(schoolCode) || this.secrets.get(`cred_ref_${schoolCode}`);
  }

  static hasSecret(handle: string, jobId?: string): boolean {
    const ownerJobId = this.secretToJob.get(handle);
    if (ownerJobId && jobId && ownerJobId !== jobId) {
      return false;
    }
    return this.secrets.has(handle);
  }

  static hasSecretForSchool(schoolCode: string): boolean {
    return this.schoolSecrets.has(schoolCode) || this.secrets.has(`cred_ref_${schoolCode}`);
  }

  static cleanupJob(jobId: string): void {
    const handles = this.jobSecrets.get(jobId);
    if (handles) {
      for (const h of handles) {
        this.secrets.delete(h);
        this.secretToJob.delete(h);
      }
      this.jobSecrets.delete(jobId);
    }
    const schoolCodes = this.jobSchoolSecrets.get(jobId);
    if (schoolCodes) {
      for (const sc of schoolCodes) {
        this.schoolSecrets.delete(sc);
      }
      this.jobSchoolSecrets.delete(jobId);
    }
  }

  static clear(): void {
    this.secrets.clear();
    this.secretToJob.clear();
    this.jobSecrets.clear();
    this.schoolSecrets.clear();
    this.jobSchoolSecrets.clear();
  }
}

export class DocumentIngestion {
  /**
   * Ingest arbitrary supported files and normalize to DocumentContent with Credential Boundary
   */
  static ingest(input: IngestFileInput): DocumentContent {
    const filename = input.filename;
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const rawText = typeof input.bufferOrText === 'string'
      ? input.bufferOrText
      : input.bufferOrText.toString('utf-8');

    const tables: DocumentTable[] = [];
    let extractedText = '';

    // 1. Deterministic Table Extraction for CSV / TSV / Excel-text
    if (ext === 'csv' || ext === 'tsv' || rawText.includes(',') || rawText.includes('\t')) {
      const table = this.parseDeterministicTable(rawText, ext === 'tsv' ? '\t' : ',');
      if (table.rows.length > 0) {
        tables.push(table);
      }
    }

    // 2. Format specific text extraction
    if (ext === 'md' || ext === 'txt') {
      extractedText = rawText;
    } else if (ext === 'pdf') {
      // PDF text representation extraction
      extractedText = `[PDF Document: ${filename}]\n` + this.extractCleanText(rawText);
    } else if (ext === 'docx' || ext === 'pptx') {
      // Office document text extraction
      extractedText = `[Office Document: ${filename}]\n` + this.extractCleanText(rawText);
    } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
      // Image description / OCR representation
      extractedText = `[Visual Document Image: ${filename} - Detected Screenshot / Configuration Diagram]`;
    } else {
      extractedText = rawText;
    }

    // 3. Credential Boundary Enforcement
    // Detect passwords in tables & text, store in local vault, mask for AI
    const sanitizedTables = this.sanitizeTables(tables);
    let sanitizedText = this.sanitizeText(extractedText);

    // If tables were sanitized, ensure any discovered plaintext secrets are also masked in extractedText
    if (sanitizedTables.length > 0) {
      for (let t = 0; t < tables.length; t++) {
        const origTable = tables[t];
        const sTable = sanitizedTables[t];
        for (let r = 0; r < origTable.rows.length; r++) {
          for (let c = 0; c < origTable.rows[r].length; c++) {
            const origVal = origTable.rows[r][c];
            const newVal = sTable.rows[r][c];
            if (origVal && newVal && origVal !== newVal && origVal.length > 2) {
              sanitizedText = sanitizedText.split(origVal).join(newVal);
            }
          }
        }
      }
    }

    const docId = `doc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const metadata: DocumentMetadata = {
      filename,
      mimeType: input.mimeType || this.inferMimeType(ext),
      sizeBytes: typeof input.bufferOrText === 'string' ? Buffer.byteLength(input.bufferOrText) : input.bufferOrText.length,
      extractedAt: new Date().toISOString()
    };

    return {
      documentId: docId,
      metadata,
      text: sanitizedText,
      tables: sanitizedTables,
      images: ['png', 'jpg', 'jpeg', 'webp'].includes(ext)
        ? [{ imageId: `img_${docId}`, caption: filename, description: 'Configuration Diagram / Screenshot' }]
        : [],
      sanitizedForAi: true
    };
  }

  private static parseDeterministicTable(content: string, defaultDelimiter = ','): DocumentTable {
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return { headers: [], rows: [] };

    const delimiter = lines[0].includes('\t') ? '\t' : defaultDelimiter;
    const splitLine = (line: string) => {
      // Simple CSV quote-aware splitter
      const cols: string[] = [];
      let inQuotes = false;
      let current = '';
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          inQuotes = !inQuotes;
        } else if (c === delimiter && !inQuotes) {
          cols.push(current.trim().replace(/^["']|["']$/g, ''));
          current = '';
        } else {
          current += c;
        }
      }
      cols.push(current.trim().replace(/^["']|["']$/g, ''));
      return cols;
    };

    const firstCols = splitLine(lines[0]);
    const isHeader = firstCols.some(c => /^(学校|学校コード|コード|school_?code|学校名|school_?name|ユーザーid|user_?id|ログインid|password|パスワード|pw|secret)$/i.test(c.trim()));

    let headers: string[];
    let rows: string[][];

    if (isHeader) {
      headers = firstCols;
      rows = lines.slice(1).map(l => splitLine(l));
    } else {
      const colCount = firstCols.length;
      if (colCount <= 2) {
        headers = ['schoolCode', 'schoolName'];
      } else if (colCount === 3) {
        headers = ['schoolCode', 'schoolName', 'password'];
      } else {
        headers = ['schoolCode', 'schoolName', 'userId', 'password'];
        for (let i = 4; i < colCount; i++) {
          headers.push(`col_${i + 1}`);
        }
      }
      rows = lines.map(l => splitLine(l));
    }

    return { headers, rows };
  }

  private static sanitizeTables(tables: DocumentTable[]): DocumentTable[] {
    return tables.map(table => {
      // Identify password columns and code column
      const pwColIndices = table.headers
        .map((h, i) => (/password|passwd|パスワード|pw|secret/i.test(h) ? i : -1))
        .filter(i => i !== -1);
      const codeColIdx = table.headers.findIndex(h => /学校コード|code|school_code|schoolcode/i.test(h));

      const sanitizedRows = table.rows.map(row => {
        const schoolCode = codeColIdx !== -1 && row[codeColIdx] ? row[codeColIdx].trim() : (row[0] ? row[0].trim() : '');
        return row.map((col, idx) => {
          if (pwColIndices.includes(idx) && col.length > 0) {
            const handle = LocalSecretVault.storeSecret(col);
            if (schoolCode && schoolCode.length >= 2) {
              LocalSecretVault.storeSecretWithRef(`cred_ref_${schoolCode}`, col);
            }
            return `[SECRET:${handle}]`;
          }
          return col;
        });
      });


      return {
        ...table,
        rows: sanitizedRows
      };
    });
  }

  private static sanitizeText(text: string): string {
    // Regex mask for password assignments e.g. password=xxxx, パスワード: xxxx
    return text.replace(/(password|passwd|パスワード|pw)\s*[:=]\s*([^\s,;]+)/gi, (match, prefix, secret) => {
      const handle = LocalSecretVault.storeSecret(secret);
      return `${prefix}: [SECRET:${handle}]`;
    });
  }

  private static extractCleanText(raw: string): string {
    return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private static inferMimeType(ext: string): string {
    switch (ext) {
      case 'csv': return 'text/csv';
      case 'tsv': return 'text/tab-separated-values';
      case 'pdf': return 'application/pdf';
      case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      default: return 'text/plain';
    }
  }
}
