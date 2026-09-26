import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BatchProcessAdapter } from './adapter';
import {
  ValidateRequestSchema,
  EmptyActionRequestSchema,
  FORBIDDEN_WRITE_FIELDS,
  ConsoleJobState,
  ActiveUploadedBatch
} from './types';
import { sanitizeObject } from './sanitizer';
import { SETTING_DEFINITIONS } from '../settings/definitions';
import { SettingKey } from '../types/settings';
import { NormalizedResultsViewModel, NormalizedSchoolResult } from '../types/batch';
import { parseAndSeparateSchoolsCsv } from '../batch/csvParser';
import { AutomationError } from '../types/errors';
import { RequestedSettingsSchema } from '../config/schema';
import { generateSettingsHash, getToolVersion } from '../utils/hash';

export interface ConsoleServerOptions {
  port?: number;
  host?: string;
  adapter?: BatchProcessAdapter;
}

export class ConsoleServer {
  private server: http.Server | null = null;
  private adapter: BatchProcessAdapter;
  private port: number;
  private host: string;
  private csrfToken: string;
  private sseClients: Set<http.ServerResponse> = new Set();

  constructor(options: ConsoleServerOptions = {}) {
    this.port = options.port ?? 3000;
    this.host = options.host ?? '127.0.0.1'; // 127.0.0.1 のみバインド (指示19)
    this.adapter = options.adapter ?? new BatchProcessAdapter();
    this.csrfToken = crypto.randomBytes(16).toString('hex'); // CSRF nonce (指示7)

    this.setupAdapterEvents();
  }

  getAdapter(): BatchProcessAdapter {
    return this.adapter;
  }

  getPort(): number {
    return this.port;
  }

  getCsrfToken(): string {
    return this.csrfToken;
  }

  private setupAdapterEvents(): void {
    this.adapter.on('stateChange', (data) => {
      this.broadcastSse('stateChange', data);
    });

    this.adapter.on('progress', (data) => {
      this.broadcastSse('progress', data);
    });

    this.adapter.on('log', (line) => {
      this.broadcastSse('log', { line });
    });
  }

  private broadcastSse(event: string, data: any): void {
    const sanitized = sanitizeObject(data);
    const msg = `event: ${event}\ndata: ${JSON.stringify(sanitized)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(msg);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.sendJson(res, 500, { error: 'INTERNAL_ERROR', message: err.message });
        });
      });

      this.server.listen(this.port, this.host, () => {
        const addr = this.server?.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        this.port = actualPort;
        console.log(`[ConsoleServer] Operator Console listening on http://${this.host}:${this.port}`);
        resolve(this.port);
      });

      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  /**
   * Host / Origin / CSRF ガード (指示7, 20)
   */
  private verifySecurity(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const hostHeader = req.headers['host'] || '';
    const originHeader = req.headers['origin'] || '';

    // 1. Host ヘッダー検証
    const allowedHosts = [
      `localhost:${this.port}`,
      `127.0.0.1:${this.port}`,
      'localhost',
      '127.0.0.1'
    ];
    if (!allowedHosts.includes(hostHeader.toLowerCase())) {
      this.sendJson(res, 403, { error: 'FORBIDDEN_HOST', message: `Invalid host: ${hostHeader}` });
      return false;
    }

    // 2. Origin ヘッダー検証 (存在する場合)
    if (originHeader) {
      const allowedOrigins = [
        `http://localhost:${this.port}`,
        `http://127.0.0.1:${this.port}`
      ];
      if (!allowedOrigins.includes(originHeader.toLowerCase())) {
        this.sendJson(res, 403, { error: 'FORBIDDEN_ORIGIN', message: `Invalid origin: ${originHeader}` });
        return false;
      }
    }

    // 3. CSRF Nonce 検証 (State-changing POST リクエスト)
    if (req.method === 'POST') {
      const token = req.headers['x-csrf-nonce'];
      if (!token || token !== this.csrfToken) {
        this.sendJson(res, 403, { error: 'INVALID_CSRF_TOKEN', message: 'CSRF token missing or mismatch' });
        return false;
      }
    }

    return true;
  }

  private async parseJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString('utf-8');
        if (body.length > 1024 * 1024) {
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e: any) {
          reject(new Error(`Invalid JSON: ${e.message}`));
        }
      });
      req.on('error', reject);
    });
  }

  private async parseCsvBody(req: http.IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      let receivedBytes = 0;
      let exceeded = false;
      req.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > maxBytes) {
          exceeded = true;
          return;
        }
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        if (exceeded) {
          reject(new AutomationError('CONFIG_INVALID', 'CSVファイルサイズが上限 (5MB) を超過しています'));
        } else {
          resolve(body);
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
    const sanitized = sanitizeObject(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(sanitized));
  }

  private sendFile(res: http.ServerResponse, filePath: string, contentType: string): void {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } else {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    const pathname = parsedUrl.pathname;
    const method = req.method || 'GET';

    // セキュリティ検証 (Host / Origin / CSRF)
    if (!this.verifySecurity(req, res)) {
      return;
    }

    // 1. 静的ファイル配信
    if (method === 'GET') {
      const publicDir = path.resolve(__dirname, 'public');
      if (pathname === '/' || pathname === '/index.html') {
        this.sendFile(res, path.join(publicDir, 'index.html'), 'text/html; charset=utf-8');
        return;
      }
      if (pathname === '/guide.html') {
        this.sendFile(res, path.join(publicDir, 'guide.html'), 'text/html; charset=utf-8');
        return;
      }
      if (pathname === '/styles.css') {
        this.sendFile(res, path.join(publicDir, 'styles.css'), 'text/css; charset=utf-8');
        return;
      }
      if (pathname === '/app.js') {
        this.sendFile(res, path.join(publicDir, 'app.js'), 'application/javascript; charset=utf-8');
        return;
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // 2. GET /api/status (指示4, 5, 7, 8)
    if (method === 'GET' && pathname === '/api/status') {
      const state = this.adapter.getJobState();
      const snapshot = this.adapter.getSnapshot();
      const activeUpload = this.adapter.getActiveUpload();
      this.sendJson(res, 200, {
        jobState: state,
        csrfToken: this.csrfToken,
        snapshot,
        activeProfileSnapshot: this.adapter.getActiveProfileSnapshot(),
        inputSource: this.adapter.getInputSource(),
        activeUpload: activeUpload
          ? {
              uploadId: activeUpload.uploadId,
              originalFileName: activeUpload.originalFileName,
              fileSize: activeUpload.fileSize,
              totalSchools: activeUpload.schools.length,
              enabledSchools: activeUpload.schools.filter((s) => s.enabled).length
            }
          : null,
        currentJob:
          state === 'RUNNING' || state === 'STOPPING'
            ? {
                runId: this.adapter.getCurrentRunId(),
                startedAt: this.adapter.getStartedAt(),
                mode: 'PREFLIGHT_DRY_RUN'
              }
            : undefined,
        recentLogs: this.adapter.getRecentLogs()
      });
      return;
    }

    // 2.0A GET /api/profile/definitions (SSOT: Setting Definitions & 依存情報)
    if (method === 'GET' && pathname === '/api/profile/definitions') {
      const defs = (Object.keys(SETTING_DEFINITIONS) as SettingKey[]).map((key) => {
        const def = SETTING_DEFINITIONS[key];
        return {
          key: def.key,
          label: def.label,
          options: def.options,
          defaultValue: def.defaultValue,
          destructiveWhenOff: Boolean(def.destructiveWhenOff),
          isOptionalInContract: Boolean(def.isOptionalInContract)
        };
      });
      this.sendJson(res, 200, { definitions: defs });
      return;
    }

    // 2.0B GET /api/profile/presets (v1: 推奨設定 & 全項目維持)
    if (method === 'GET' && pathname === '/api/profile/presets') {
      const recommended: Record<string, string> = {
        storage: 'ON',
        timelineChannel: 'ON',
        directMessage: 'STUDENT_TO_STUDENT_DISABLED',
        parentDirectMessage: 'ON',
        allChannel: 'ON',
        parentChannel: 'ON',
        attendance: 'ON',
        contactBook: 'ON',
        mentalHealth: 'OFF',
        otherSchoolLog: 'ALLOW',
        studentPasswordChange: 'HIDE'
      };
      const unmanagedAll: Record<string, null> = {};
      for (const k of Object.keys(SETTING_DEFINITIONS)) {
        unmanagedAll[k] = null;
      }

      this.sendJson(res, 200, {
        presets: [
          {
            id: 'RECOMMENDED',
            name: '推奨設定',
            description: '標準推奨構成（個別メッセージは生徒同士不可、心の健康OFF、パスワード変更非表示など）',
            settings: recommended
          },
          {
            id: 'UNMANAGED_ALL',
            name: '全項目維持',
            description: '全11項目を変更せず現状維持（UNMANAGED）にします',
            settings: unmanagedAll
          }
        ]
      });
      return;
    }

    // 2.0C POST /api/profile/invalidate (Editor変更・Preset適用・Import時の即時無効化)
    if (method === 'POST' && pathname === '/api/profile/invalidate') {
      this.adapter.invalidateValidation('PROFILE_CHANGED');
      this.sendJson(res, 200, { success: true });
      return;
    }

    // 2.0D POST /api/profile/export (strict検証 & 認証情報を含まない安全エクスポート)
    if (method === 'POST' && pathname === '/api/profile/export') {
      let body: any;
      try {
        body = await this.parseJsonBody(req);
      } catch {
        body = {};
      }
      let settingsToExport = body.profile;
      if (!settingsToExport) {
        const snap = this.adapter.getActiveProfileSnapshot();
        if (snap) {
          settingsToExport = snap.requestedSettings;
        } else {
          this.sendJson(res, 400, { error: 'NO_PROFILE', message: 'エクスポート可能な設定が存在しません' });
          return;
        }
      }
      const parsed = RequestedSettingsSchema.strict().safeParse(settingsToExport);
      if (!parsed.success) {
        this.sendJson(res, 400, { error: 'INVALID_PROFILE', message: '設定内容の形式が不正です' });
        return;
      }
      const profileHash = generateSettingsHash(parsed.data);
      const toolVersion = getToolVersion();
      this.sendJson(res, 200, {
        requestedSettings: parsed.data,
        profileHash,
        exportedAt: new Date().toISOString(),
        toolVersion
      });
      return;
    }

    // 2.1 POST /api/source/select (指示7: 入力ソース明示切り替え)
    if (method === 'POST' && pathname === '/api/source/select') {
      const state = this.adapter.getJobState();
      if (state === 'RUNNING' || state === 'STOPPING') {
        this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: '実行中は入力ソースを変更できません' });
        return;
      }

      let body: any;
      try {
        body = await this.parseJsonBody(req);
      } catch (err: any) {
        this.sendJson(res, 400, { error: 'INVALID_JSON', message: err.message });
        return;
      }

      const source = body.source;
      if (source !== 'UPLOAD' && source !== 'LOCAL_DEFAULT') {
        this.sendJson(res, 400, { error: 'INVALID_SOURCE', message: 'source は UPLOAD または LOCAL_DEFAULT を指定してください' });
        return;
      }

      try {
        this.adapter.setInputSource(source);
        this.sendJson(res, 200, { success: true, source });
      } catch (err: any) {
        this.sendJson(res, 400, { error: 'INVALID_REQUEST', message: err.message });
      }
      return;
    }

    // 2.2 POST /api/schools/upload (指示11: CSV直接アップロード & RFC 4180 パース & 秘密分離)
    if (method === 'POST' && pathname === '/api/schools/upload') {
      const state = this.adapter.getJobState();
      if (state === 'RUNNING' || state === 'STOPPING') {
        this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'バッチ実行中は新しいCSVをアップロードできません' });
        return;
      }

      let csvText: string;
      try {
        csvText = await this.parseCsvBody(req);
      } catch (err: any) {
        const status = err.message?.includes('上限') ? 413 : 400;
        this.sendJson(res, status, { error: 'UPLOAD_FAILED', message: err.message });
        return;
      }

      // クライアントファイル名取得 (安全にサニタイズ、パス記号除去)
      const rawHeaderName = req.headers['x-filename'] as string | undefined;
      let safeFileName = 'uploaded_schools.csv';
      if (rawHeaderName) {
        try {
          const decoded = decodeURIComponent(rawHeaderName);
          const base = path.basename(decoded).replace(/[^a-zA-Z0-9_\-\.\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf]/g, '_');
          if (base.toLowerCase().endsWith('.csv')) {
            safeFileName = base;
          }
        } catch {
          // ignore fallback
        }
      }

      try {
        // RFC 4180 パース & Public / Secret 分離
        const parsed = parseAndSeparateSchoolsCsv(csvText);

        const uploadId = `upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const batch: ActiveUploadedBatch = {
          uploadId,
          originalFileName: safeFileName,
          fileSize: Buffer.byteLength(csvText, 'utf-8'),
          schools: parsed.schools,
          credentials: parsed.credentials,
          createdAt: new Date().toISOString()
        };

        this.adapter.setUploadedBatch(batch);

        // 指示6: 秘密情報をレスポンスに一切返さない！ PreviewはschoolCode/schoolNameのみ最大20校
        this.sendJson(res, 200, {
          success: true,
          uploadId,
          originalFileName: safeFileName,
          fileSize: batch.fileSize,
          totalSchools: parsed.totalCount,
          enabledSchools: parsed.enabledCount,
          preview: parsed.preview
        });
      } catch (err: any) {
        this.sendJson(res, 400, {
          error: err.code || 'CONFIG_INVALID',
          message: err.message || 'CSVの検証に失敗しました'
        });
      }
      return;
    }

    // 3. POST /api/validate (指示2, 6)
    if (method === 'POST' && pathname === '/api/validate') {
      const state = this.adapter.getJobState();
      if (state === 'RUNNING' || state === 'STOPPING') {
        this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'バッチ処理実行中は検証を実行できません' });
        return;
      }

      let body: any;
      try {
        body = await this.parseJsonBody(req);
      } catch (err: any) {
        this.sendJson(res, 400, { error: 'INVALID_JSON', message: err.message });
        return;
      }

      // Write関連フィールド拒絶 (指示3)
      for (const field of FORBIDDEN_WRITE_FIELDS) {
        if (field in body) {
          this.sendJson(res, 400, { error: 'WRITE_FORBIDDEN', message: `Write関連フィールド '${field}' は許可されていません` });
          return;
        }
      }

      const parseRes = ValidateRequestSchema.safeParse(body);
      if (!parseRes.success) {
        this.sendJson(res, 400, {
          error: 'CONFIG_INVALID',
          message: `リクエスト検証エラー: ${parseRes.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
        });
        return;
      }

      try {
        const valRes = this.adapter.executeValidation(parseRes.data);
        // Profile の各項目を MANAGED / UNMANAGED として整形 (指示4, 22)
        const profileItems = (Object.keys(SETTING_DEFINITIONS) as SettingKey[]).map((key) => {
          const val = valRes.profileDetails[key];
          return {
            key,
            label: SETTING_DEFINITIONS[key].label,
            status: val !== undefined && val !== null ? 'MANAGED' : 'UNMANAGED',
            value: val !== undefined && val !== null ? String(val) : null
          };
        });

        this.sendJson(res, 200, {
          status: 'PASS',
          snapshot: valRes.snapshot,
          profileItems,
          schoolsCount: valRes.schoolsCount,
          enabledCount: valRes.enabledCount,
          schoolsPath: valRes.schoolsPath
        });
      } catch (err: any) {
        this.sendJson(res, 200, {
          status: 'FAIL',
          error: {
            code: err.issueCode || err.status || 'VALIDATION_FAILED',
            message: err.message,
            details: sanitizeObject(err.details || {})
          }
        });
      }
      return;
    }

    // 4. POST /api/preflight/start (指示3, 7, 8)
    if (method === 'POST' && pathname === '/api/preflight/start') {
      await this.handleBatchStart(req, res, 'START');
      return;
    }

    // 5. POST /api/preflight/resume (指示4, 17)
    if (method === 'POST' && pathname === '/api/preflight/resume') {
      await this.handleBatchStart(req, res, 'RESUME');
      return;
    }

    // 6. POST /api/preflight/retry-failed (指示4, 18)
    if (method === 'POST' && pathname === '/api/preflight/retry-failed') {
      await this.handleBatchStart(req, res, 'RETRY_FAILED');
      return;
    }

    // 7. POST /api/preflight/stop (指示10)
    if (method === 'POST' && pathname === '/api/preflight/stop') {
      try {
        this.adapter.stopBatchProcess();
        this.sendJson(res, 200, { status: 'STOPPING', message: '安全停止要求を送信しました' });
      } catch (err: any) {
        const code = err.status === 'JOB_NOT_RUNNING' ? 400 : 500;
        this.sendJson(res, code, { error: err.status || 'ERROR', message: err.message });
      }
      return;
    }

    // 8. GET /api/preflight/events (SSE) (指示9)
    if (method === 'GET' && pathname === '/api/preflight/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write('\n');
      this.sseClients.add(res);

      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // 9. GET /api/reports/latest (指示11, 12, 13, 14, 15, 16)
    if (method === 'GET' && pathname === '/api/reports/latest') {
      const reports = this.loadLatestReports();
      this.sendJson(res, 200, reports);
      return;
    }

    // 10. GET /api/reports/download/:type (指示6, 16)
    if (method === 'GET' && pathname.startsWith('/api/reports/download/')) {
      const type = pathname.replace('/api/reports/download/', '').toLowerCase();
      // Allow-list 厳格検証 (summary, preflight, checkpoint のみ)
      const ALLOWED_TYPES = ['summary', 'preflight', 'checkpoint'];
      if (!ALLOWED_TYPES.includes(type)) {
        this.sendJson(res, 400, { error: 'INVALID_REPORT_TYPE', message: `許可されていないレポート種別です: ${type}` });
        return;
      }

      const filePath = this.resolveLatestReportPath(type);
      if (!filePath || !fs.existsSync(filePath)) {
        this.sendJson(res, 404, { error: 'REPORT_NOT_FOUND', message: `レポートファイルが見つかりません: ${type}` });
        return;
      }

      const raw = fs.readFileSync(filePath, 'utf-8');
      try {
        const parsed = JSON.parse(raw);
        const sanitized = sanitizeObject(parsed);
        const jsonStr = JSON.stringify(sanitized, null, 2);
        const filename = `${type}-sanitized-${Date.now()}.json`;

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`
        });
        res.end(jsonStr);
      } catch {
        this.sendJson(res, 500, { error: 'PARSE_ERROR', message: 'レポートJSONのパースに失敗しました' });
      }
      return;
    }

    // 11. POST /api/apply/prepare (指示5: 2段階 Confirmation Token API - 第1段階)
    if (method === 'POST' && pathname === '/api/apply/prepare') {
      const state = this.adapter.getJobState();
      if (state === 'RUNNING' || state === 'STOPPING') {
        this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'すでに別のバッチ処理が実行中または停止処理中です' });
        return;
      }

      let body: any = {};
      try {
        body = await this.parseJsonBody(req);
      } catch (err: any) {
        this.sendJson(res, 400, { error: 'INVALID_JSON', message: err.message });
        return;
      }

      // Write関連の不正フィールド拒絶
      for (const field of FORBIDDEN_WRITE_FIELDS) {
        if (field in body) {
          this.sendJson(res, 400, { error: 'WRITE_FORBIDDEN', message: `Write関連フィールド '${field}' は許可されていません` });
          return;
        }
      }

      try {
        const result = this.adapter.prepareProductionApply();
        this.sendJson(res, 200, {
          status: 'PREPARED',
          manifest: result.manifest,
          confirmationToken: result.tokenData.token,
          expiresAt: result.tokenData.expiresAt,
          targetCount: result.manifest.applyTargets.length,
          skippedDestructiveCount: result.manifest.skippedDestructiveCount,
          alreadyConfiguredCount: result.manifest.alreadyConfiguredCount
        });
      } catch (err: any) {
        const statusCode =
          err.status === 'JOB_CONFLICT' ||
          err.issueCode === 'CHECKPOINT_MISMATCH' ||
          err.issueCode === 'UNSAFE_CONFIGURATION' ||
          err.issueCode === 'CONFIG_INVALID'
            ? 400
            : 500;
        this.sendJson(res, statusCode, {
          error: err.issueCode || err.status || 'PREPARE_FAILED',
          message: err.message
        });
      }
      return;
    }

    // 12. POST /api/apply/start (Phase 5B.3: 本番非破壊書き込みプロセスの起動)
    if (method === 'POST' && pathname === '/api/apply/start') {
      const state = this.adapter.getJobState();
      if (state === 'RUNNING' || state === 'STOPPING') {
        this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'すでに別のバッチ処理が実行中または停止処理中です' });
        return;
      }

      let body: any = {};
      try {
        body = await this.parseJsonBody(req);
      } catch (err: any) {
        this.sendJson(res, 400, { error: 'INVALID_JSON', message: err.message });
        return;
      }

      // Write関連の不正フィールド拒絶 (CLIフラグ注入等の脆弱性を完全排除)
      for (const field of FORBIDDEN_WRITE_FIELDS) {
        if (field in body) {
          this.sendJson(res, 400, { error: 'WRITE_FORBIDDEN', message: `Write関連フィールド '${field}' は許可されていません` });
          return;
        }
      }

      // confirmationToken 必須検証
      if (!body.confirmationToken || typeof body.confirmationToken !== 'string') {
        this.sendJson(res, 400, { error: 'CONFIG_INVALID', message: '有効な confirmationToken が指定されていません' });
        return;
      }

      try {
        this.adapter.startProductionApplyProcess(body.confirmationToken);
        this.sendJson(res, 200, {
          status: 'STARTED',
          mode: 'PRODUCTION_WRITE',
          runId: this.adapter.getCurrentRunId(),
          message: '非破壊本番適用プロセスを開始しました (PRODUCTION_WRITE)'
        });
      } catch (err: any) {
        const statusCode =
          err.status === 'JOB_CONFLICT' ||
          err.issueCode === 'CHECKPOINT_MISMATCH' ||
          err.issueCode === 'APPROVAL_AUDIT_INVALID' ||
          err.issueCode === 'UNSAFE_CONFIGURATION' ||
          err.issueCode === 'CONFIG_INVALID'
            ? 400
            : 500;
        this.sendJson(res, statusCode, {
          error: err.issueCode || err.status || 'APPLY_START_FAILED',
          message: err.message
        });
      }
      return;
    }

    // 未知のエンドポイント
    this.sendJson(res, 404, { error: 'NOT_FOUND', message: `Endpoint not found: ${method} ${pathname}` });
  }

  private async handleBatchStart(req: http.IncomingMessage, res: http.ServerResponse, mode: 'START' | 'RESUME' | 'RETRY_FAILED'): Promise<void> {
    const state = this.adapter.getJobState();
    // Single Job Guard (指示5)
    if (state === 'RUNNING' || state === 'STOPPING') {
      this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'すでに別のバッチ処理が実行中または停止処理中です' });
      return;
    }

    let body: any;
    try {
      body = await this.parseJsonBody(req);
    } catch (err: any) {
      this.sendJson(res, 400, { error: 'INVALID_JSON', message: err.message });
      return;
    }

    // Write関連フィールド拒絶 (指示3, 4)
    for (const field of FORBIDDEN_WRITE_FIELDS) {
      if (field in body) {
        this.sendJson(res, 400, { error: 'WRITE_FORBIDDEN', message: `Write関連フィールド '${field}' は許可されていません` });
        return;
      }
    }

    // 空オブジェクト strict チェック
    const parseRes = EmptyActionRequestSchema.safeParse(body);
    if (!parseRes.success) {
      this.sendJson(res, 400, {
        error: 'INVALID_REQUEST',
        message: `リクエスト検証エラー: 未知のフィールドが存在します: ${parseRes.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      });
      return;
    }

    try {
      this.adapter.startBatchProcess(mode, {});
      this.sendJson(res, 200, {
        status: 'STARTED',
        mode: 'PREFLIGHT_DRY_RUN',
        runId: this.adapter.getCurrentRunId(),
        message: '設定変更・保存は行いません (PREFLIGHT_DRY_RUN)'
      });
    } catch (err: any) {
      const code = err.status === 'VALIDATION_STALE' || err.status === 'VALIDATION_REQUIRED' ? 400 : 500;
      this.sendJson(res, code, { error: err.status || 'ERROR', message: err.message });
    }
  }

  private resolveLatestReportPath(type: string): string | null {
    if (type === 'checkpoint') {
      const dir = path.resolve(process.cwd(), 'checkpoints');
      if (!fs.existsSync(dir)) return null;
      const files = fs.readdirSync(dir).filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'));
      if (files.length === 0) return null;
      files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
      return path.join(dir, files[0]);
    }

    const dir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(dir)) return null;
    const prefix = type === 'summary' ? 'summary-' : 'preflight-';
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
    if (files.length === 0) return null;
    files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    return path.join(dir, files[0]);
  }

  private loadLatestReports(): any {
    const summaryPath = this.resolveLatestReportPath('summary');
    const preflightPath = this.resolveLatestReportPath('preflight');
    const checkpointPath = this.resolveLatestReportPath('checkpoint');

    const result: any = {
      summary: null,
      preflight: null,
      checkpoint: null,
      normalized: null
    };

    if (summaryPath && fs.existsSync(summaryPath)) {
      try {
        result.summary = sanitizeObject(JSON.parse(fs.readFileSync(summaryPath, 'utf-8')));
      } catch {}
    }
    if (preflightPath && fs.existsSync(preflightPath)) {
      try {
        result.preflight = sanitizeObject(JSON.parse(fs.readFileSync(preflightPath, 'utf-8')));
      } catch {}
    }
    if (checkpointPath && fs.existsSync(checkpointPath)) {
      try {
        result.checkpoint = sanitizeObject(JSON.parse(fs.readFileSync(checkpointPath, 'utf-8')));
      } catch {}
    }

    // 整合性検証 (deploymentId, runId, profileHash, schoolsHash, toolFingerprint)
    let inconsistent = false;
    let inconsistentReason: string | undefined;

    if (result.summary && result.preflight) {
      const s = result.summary;
      const p = result.preflight;
      if (s.deploymentId !== p.deploymentId) {
        inconsistent = true;
        inconsistentReason = `deploymentId mismatch: summary=${s.deploymentId}, preflight=${p.deploymentId}`;
      } else if (p.runId && s.runId !== p.runId) {
        inconsistent = true;
        inconsistentReason = `runId mismatch: summary=${s.runId}, preflight=${p.runId}`;
      } else if (s.profileHash !== p.profileHash) {
        inconsistent = true;
        inconsistentReason = `profileHash mismatch: summary=${s.profileHash}, preflight=${p.profileHash}`;
      } else if (s.schoolsHash !== p.schoolsHash) {
        inconsistent = true;
        inconsistentReason = `schoolsHash mismatch: summary=${s.schoolsHash}, preflight=${p.schoolsHash}`;
      } else if (s.toolFingerprint && p.toolFingerprint && s.toolFingerprint !== p.toolFingerprint) {
        inconsistent = true;
        inconsistentReason = `toolFingerprint mismatch: summary=${s.toolFingerprint}, preflight=${p.toolFingerprint}`;
      }
    }

    // 現在の選択中 Input と Latest Results の整合性検証 (指示1: RESULTS_STALE)
    let isStale = false;
    let staleReason: string | undefined;

    if (result.preflight || result.summary) {
      const currentHashes = this.adapter.getCurrentInputHashes();
      if (currentHashes) {
        const reportSchoolsHash = result.preflight?.schoolsHash || result.summary?.schoolsHash;
        const reportProfileHash = result.preflight?.profileHash || result.summary?.profileHash;

        if (reportSchoolsHash && currentHashes.schoolsHash !== reportSchoolsHash) {
          isStale = true;
          staleReason = `現在の入力データのハッシュ (${currentHashes.schoolsHash.slice(0, 8)}...) が過去の実行結果のハッシュ (${reportSchoolsHash.slice(0, 8)}...) と一致しません`;
        } else if (reportProfileHash && currentHashes.profileHash !== reportProfileHash) {
          isStale = true;
          staleReason = `現在のプロファイルハッシュ (${currentHashes.profileHash.slice(0, 8)}...) が過去の実行結果のハッシュ (${reportProfileHash.slice(0, 8)}...) と一致しません`;
        }
      }
    }

    result.isStale = isStale;
    result.staleReason = staleReason;

    if (result.preflight || result.summary) {
      const p = result.preflight;
      const s = result.summary;
      const cp = result.checkpoint;

      const totalSchools = s?.totalSchools ?? p?.total ?? (cp ? Object.keys(cp.entries || {}).length : 0);
      const processedSchools = s?.processedSchools ?? p?.processed ?? 0;
      const readSuccess = s?.readSuccess ?? p?.readSuccess ?? 0;
      const readFailed = s?.readFailed ?? p?.readFailed ?? 0;
      const alreadyConfigured = s?.alreadyConfigured ?? p?.alreadyConfigured ?? 0;
      const requiresChange = s?.requiresChange ?? p?.requiresChange ?? 0;
      const planBlocked = s?.planBlocked ?? p?.planBlocked ?? 0;
      const destructiveChangeSchools = s?.destructiveChangeSchools ?? p?.destructiveChangeSchools ?? 0;

      // Safe Write Eligible は Preflight の writeEligible を優先
      let writeEligible = 0;
      if (p && Array.isArray(p.schools)) {
        writeEligible = p.schools.filter((sch: any) => sch.writeEligible).length;
      } else if (s) {
        writeEligible = s.writeEligibleNonDestructive ?? 0;
      }

      const actionsDistribution = s?.actionsDistribution ?? { zero: 0, one: 0, two: 0, threePlus: 0 };
      const currentStateDistribution = s?.currentStateDistribution ?? {};
      const plannedChangeDistribution = s?.plannedChangeDistribution ?? {};

      const currentStateCoverage = p?.currentStateCoverage ?? s?.currentStateCoverage ?? {
        collected: readSuccess,
        total: totalSchools
      };
      const plannedChangeCoverage = p?.plannedChangeCoverage ?? s?.plannedChangeCoverage ?? {
        collected: readSuccess,
        total: totalSchools
      };

      // 学校結果の統合 (Preflight + Summary / Checkpoint)
      const schoolsMap = new Map<string, NormalizedSchoolResult>();

      if (p && Array.isArray(p.schools)) {
        for (const ps of p.schools) {
          schoolsMap.set(ps.schoolCode, {
            schoolCode: ps.schoolCode,
            schoolName: ps.schoolName,
            readStatus: ps.readStatus,
            planExecutable: ps.planExecutable,
            hasDestructiveChanges: ps.hasDestructiveChanges,
            writeEligible: ps.writeEligible,
            actionsCount: ps.actionsCount ?? 0
          });
        }
      }

      if (s && Array.isArray(s.schoolResults)) {
        for (const sr of s.schoolResults) {
          const existing = schoolsMap.get(sr.schoolCode);
          if (existing) {
            existing.executionStatus = sr.executionStatus;
            existing.errorMessage = sr.error;
            if (sr.actionsCount !== undefined && existing.actionsCount === 0) {
              existing.actionsCount = sr.actionsCount;
            }
          } else {
            const isOk =
              sr.status === 'SUCCESS' ||
              sr.status === 'SUCCESS_ALREADY_CONFIGURED' ||
              sr.executionStatus === 'DRY_RUN_COMPLETED';
            schoolsMap.set(sr.schoolCode, {
              schoolCode: sr.schoolCode,
              schoolName: sr.schoolName,
              readStatus: sr.status === 'INTERRUPTED' ? 'INTERRUPTED' : (isOk ? 'SUCCESS' : 'FAILED'),
              executionStatus: sr.executionStatus,
              errorMessage: sr.error,
              planExecutable: Boolean(sr.planExecutable),
              hasDestructiveChanges: Boolean(sr.hasDestructiveChanges),
              writeEligible: Boolean(sr.planExecutable && !sr.hasDestructiveChanges && isOk),
              actionsCount: sr.actionsCount ?? 0
            });
          }
        }
      }

      const normalized: NormalizedResultsViewModel = {
        status: p?.status || (s?.isInterrupted ? 'INTERRUPTED' : (s ? 'COMPLETE' : 'INCOMPLETE')),
        deploymentId: p?.deploymentId || s?.deploymentId || '',
        runId: p?.runId || s?.runId || '',
        totalSchools,
        processedSchools,
        readSuccess,
        readFailed,
        alreadyConfigured,
        requiresChange,
        planBlocked,
        destructiveChangeSchools,
        writeEligible,
        writeGateEligible: Boolean(p?.writeGateEligible),
        allReadSucceeded: Boolean(p ? p.allReadSucceeded : (s ? (s.readSuccess === s.totalSchools && s.readFailed === 0) : false)),
        allPlansExecutable: Boolean(p ? p.allPlansExecutable : (s ? (s.planExecutable === s.totalSchools && s.planBlocked === 0) : false)),
        actionsDistribution,
        currentStateDistribution,
        plannedChangeDistribution,
        currentStateCoverage,
        plannedChangeCoverage,
        destructiveChangeDetails: s?.destructiveChangeDetails ?? [],
        schools: Array.from(schoolsMap.values()),
        inconsistent,
        inconsistentReason,
        isStale,
        staleReason
      };

      result.normalized = normalized;
    }

    return result;
  }
}

// CLI起動用
if (require.main === module) {
  const port = parseInt(process.env.CONSOLE_PORT || '3000', 10);
  const server = new ConsoleServer({ port, host: '127.0.0.1' });
  server.start().catch((e) => {
    console.error('[ConsoleServer] Failed to start:', e);
    process.exit(1);
  });
}
