import * as crypto from 'crypto';
import { DocumentContent, DocumentTable, DocumentMetadata } from './documentTypes';

export interface IngestFileInput {
  filename: string;
  bufferOrText: Buffer | string;
  mimeType?: string;
}

export class LocalSecretVault {
  private static secrets: Map<string, string> = new Map();
  private static jobSecrets: Map<string, Set<string>> = new Map();

  private static storageKey(jobId: string, handle: string): string {
    return `${jobId}\u0000${handle}`;
  }

  static storeSecret(plainSecret: string, jobId: string): string {
    if (!jobId || typeof jobId !== 'string' || jobId.trim().length === 0) {
      throw new Error('JOB_ID_REQUIRED: Storing secrets in LocalSecretVault requires an explicit non-empty jobId');
    }
    const handle = `secret_handle_${crypto.randomUUID()}`;
    const key = this.storageKey(jobId, handle);
    this.secrets.set(key, plainSecret);
    if (!this.jobSecrets.has(jobId)) {
      this.jobSecrets.set(jobId, new Set());
    }
    this.jobSecrets.get(jobId)!.add(key);
    return handle;
  }

  static storeSecretWithRef(ref: string, plainSecret: string, jobId: string): void {
    if (!jobId || typeof jobId !== 'string' || jobId.trim().length === 0) {
      throw new Error('JOB_ID_REQUIRED: Storing secrets in LocalSecretVault requires an explicit non-empty jobId');
    }
    const key = this.storageKey(jobId, ref);
    this.secrets.set(key, plainSecret);
    if (!this.jobSecrets.has(jobId)) {
      this.jobSecrets.set(jobId, new Set());
    }
    this.jobSecrets.get(jobId)!.add(key);
  }

  static getSecret(handle: string, jobId: string): string | undefined {
    if (!jobId || typeof jobId !== 'string' || jobId.trim().length === 0) {
      return undefined; // Fail-closed: jobId is mandatory
    }
    const key = this.storageKey(jobId, handle);
    return this.secrets.get(key);
  }

  static hasSecret(handle: string, jobId: string): boolean {
    if (!jobId || typeof jobId !== 'string' || jobId.trim().length === 0) {
      return false; // Fail-closed: jobId is mandatory
    }
    const key = this.storageKey(jobId, handle);
    return this.secrets.has(key);
  }

  static cleanupJob(jobId: string): void {
    const keys = this.jobSecrets.get(jobId);
    if (keys) {
      for (const k of keys) {
        this.secrets.delete(k);
      }
      this.jobSecrets.delete(jobId);
    }
  }

  static clear(): void {
    this.secrets.clear();
    this.jobSecrets.clear();
  }
}

export class DocumentIngestion {
  /**
   * Ingest arbitrary supported files and normalize to DocumentContent with Credential Boundary
   */
  static ingest(input: IngestFileInput, jobId: string): DocumentContent {
    if (!jobId || typeof jobId !== 'string' || jobId.trim().length === 0) {
      throw new Error('JOB_ID_REQUIRED: DocumentIngestion.ingest requires an explicit non-empty jobId');
    }
    const activeJobId = jobId;
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
    // Detect passwords in tables & text, store in local vault with activeJobId, mask for AI
    const sanitizedTables = this.sanitizeTables(tables, activeJobId);
    let sanitizedText = this.sanitizeText(extractedText, activeJobId);

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

  private static sanitizeTables(tables: DocumentTable[], jobId: string): DocumentTable[] {
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
            const handle = LocalSecretVault.storeSecret(col, jobId);
            if (schoolCode && schoolCode.length >= 2) {
              LocalSecretVault.storeSecretWithRef(`cred_ref_${schoolCode}`, col, jobId);
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

  private static sanitizeText(text: string, jobId: string): string {
    // Regex mask for password assignments e.g. password=xxxx, パスワード: xxxx
    return text.replace(/(password|passwd|パスワード|pw)\s*[:=]\s*([^\s,;]+)/gi, (match, prefix, secret) => {
      const handle = LocalSecretVault.storeSecret(secret, jobId);
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
