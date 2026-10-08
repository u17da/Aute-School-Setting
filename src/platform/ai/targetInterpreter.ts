import * as crypto from 'crypto';
import { z } from 'zod';
import { TargetSchool, TargetSet, TargetValidationStatus } from '../types/target';
import { DocumentIngestion, LocalSecretVault } from '../ingestion/documentIngestion';

export interface ParseTargetInput {
  rawText?: string;
  files?: Array<{ filename: string; content: string }>;
}

export const TargetSchoolSchema = z.object({
  schoolCode: z.string().min(1),
  schoolName: z.string().min(1),
  userId: z.string().optional(),
  credentialRef: z.string().min(1),
  enabled: z.boolean(),
  validationStatus: z.enum(['READY', 'MISSING', 'AMBIGUOUS'])
});

export class TargetInterpreter {
  /**
   * Parse arbitrary text or file inputs into a Normalized TargetSet
   * Pipeline: File -> Deterministic DocumentIngestion -> LLM/Rule Interpretation -> Zod Validation
   */
  static parseTargets(input: ParseTargetInput): TargetSet {
    const schoolsMap = new Map<string, TargetSchool>();
    const sourceFiles: string[] = [];

    // 1. Process files via DocumentIngestion
    if (input.files && input.files.length > 0) {
      for (const file of input.files) {
        sourceFiles.push(file.filename);
        const doc = DocumentIngestion.ingest({
          filename: file.filename,
          bufferOrText: file.content
        });

        // 1a. If deterministic table was extracted
        if (doc.tables.length > 0) {
          for (const table of doc.tables) {
            this.extractSchoolsFromTable(table, file.filename, schoolsMap);
          }
        } else {
          // 1b. Fallback to text parsing
          this.extractSchoolsFromText(doc.text, file.filename, schoolsMap);
        }
      }
    }

    // 2. Process raw text if provided
    if (input.rawText && input.rawText.trim().length > 0) {
      const doc = DocumentIngestion.ingest({
        filename: 'direct_input.txt',
        bufferOrText: input.rawText
      });
      if (doc.tables.length > 0) {
        for (const table of doc.tables) {
          this.extractSchoolsFromTable(table, 'direct_input', schoolsMap);
        }
      } else {
        this.extractSchoolsFromText(doc.text, 'direct_input', schoolsMap);
      }
    }

    const schools = Array.from(schoolsMap.values());

    // Validate completeness
    let readyCount = 0;
    let missingCount = 0;
    let ambiguousCount = 0;

    for (const school of schools) {
      this.validateSchool(school);
      if (school.validationStatus === 'READY') readyCount++;
      else if (school.validationStatus === 'MISSING') missingCount++;
      else if (school.validationStatus === 'AMBIGUOUS') ambiguousCount++;
    }

    const targetSetId = `ts_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    return {
      targetSetId,
      name: `TargetSet_${new Date().toISOString().slice(0, 10)}`,
      createdAt: new Date().toISOString(),
      sourceFiles,
      rawTextProvided: input.rawText,
      schools,
      summary: {
        total: schools.length,
        ready: readyCount,
        missing: missingCount,
        ambiguous: ambiguousCount
      }
    };
  }

  private static extractSchoolsFromTable(
    table: { headers: string[]; rows: string[][] },
    sourceRef: string,
    schoolsMap: Map<string, TargetSchool>
  ): void {
    // Identify columns
    const codeIdx = table.headers.findIndex(h => /学校コード|code|school_code|schoolcode/i.test(h));
    const nameIdx = table.headers.findIndex(h => /学校名|school_name|schoolname|name/i.test(h));
    const userIdx = table.headers.findIndex(h => /ユーザーid|userid|user_id|admin_id|login_id/i.test(h));

    const finalCodeIdx = codeIdx !== -1 ? codeIdx : 0;
    const finalNameIdx = nameIdx !== -1 ? nameIdx : (table.headers.length > 1 ? 1 : -1);
    const finalUserIdx = userIdx !== -1 ? userIdx : (table.headers.length > 2 ? 2 : -1);

    for (const row of table.rows) {
      if (row.length === 0) continue;
      const code = row[finalCodeIdx]?.trim();
      if (!code || code.length < 2) continue;

      const name = finalNameIdx !== -1 && row[finalNameIdx] !== undefined ? row[finalNameIdx].trim() : '';
      const user = finalUserIdx !== -1 && row[finalUserIdx] ? row[finalUserIdx].trim() : undefined;

      const credentialRef = `cred_ref_${code}`;

      if (schoolsMap.has(code)) {
        const existing = schoolsMap.get(code)!;
        if (existing.schoolName !== name && name !== `学校_${code}`) {
          existing.validationStatus = 'AMBIGUOUS';
          existing.ambiguityReason = `学校名不一致による重複競合: "${existing.schoolName}" vs "${name}"`;
        }
      } else {
        schoolsMap.set(code, {
          schoolCode: code,
          schoolName: name,
          userId: user,
          credentialRef,
          enabled: true,
          sourceReference: sourceRef,
          validationStatus: 'READY'
        });
      }
    }
  }

  private static extractSchoolsFromText(
    text: string,
    sourceRef: string,
    schoolsMap: Map<string, TargetSchool>
  ): void {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

    for (const line of lines) {
      // Header skip
      if (line.includes('学校コード') || line.includes('schoolCode') || line.includes('school_code')) {
        continue;
      }

      // Detect separator: CSV, TSV, or whitespace/pipe
      let tokens: string[] = [];
      if (line.includes(',')) {
        tokens = line.split(',').map(t => t.trim().replace(/^["']|["']$/g, ''));
      } else if (line.includes('\t')) {
        tokens = line.split('\t').map(t => t.trim().replace(/^["']|["']$/g, ''));
      } else if (line.includes('|')) {
        tokens = line.split('|').map(t => t.trim().replace(/^["']|["']$/g, ''));
      } else {
        tokens = line.split(/\s+/).map(t => t.trim());
      }

      if (tokens.length === 0 || !tokens[0]) continue;

      const codeCandidate = tokens[0];
      // Only proceed if it looks somewhat like a code or ID (alphanumeric / code)
      if (codeCandidate.length < 2) continue;

      const schoolName = tokens.length > 1 && tokens[1] !== undefined ? tokens[1].trim() : '';
      const userId = tokens.length > 2 && tokens[2] !== undefined ? tokens[2].trim() : undefined;
      
      // Credential Safety: Never store plaintext passwords. Generate a credentialRef handle.
      const credentialRef = `cred_ref_${codeCandidate}`;

      if (schoolsMap.has(codeCandidate)) {
        const existing = schoolsMap.get(codeCandidate)!;
        // Duplicate detection
        if (existing.schoolName !== schoolName && schoolName !== `学校_${codeCandidate}`) {
          existing.validationStatus = 'AMBIGUOUS';
          existing.ambiguityReason = `学校名不一致による重複競合: "${existing.schoolName}" vs "${schoolName}"`;
        }
      } else {
        schoolsMap.set(codeCandidate, {
          schoolCode: codeCandidate,
          schoolName,
          userId,
          credentialRef,
          enabled: true,
          sourceReference: sourceRef,
          validationStatus: 'READY'
        });
      }
    }
  }

  private static validateSchool(school: TargetSchool): void {
    const missing: string[] = [];
    if (!school.schoolCode || school.schoolCode.trim() === '') {
      missing.push('schoolCode');
    }
    if (!school.schoolName || school.schoolName.trim() === '') {
      missing.push('schoolName');
    }
    if (!school.credentialRef || school.credentialRef.trim() === '') {
      missing.push('credentialRef');
    }

    if (missing.length > 0) {
      school.validationStatus = 'MISSING';
      school.missingFields = missing;
    } else if (school.validationStatus !== 'AMBIGUOUS') {
      school.validationStatus = 'READY';
    }
  }
}
