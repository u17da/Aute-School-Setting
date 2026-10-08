import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BatchProcessAdapter } from './adapter';
import {
  ValidateRequestSchema,
  TargetValidateRequestSchema,
  DraftProfileRequestSchema,
  ProfileConfirmRequestSchema,
  EmptyActionRequestSchema,
  DiscoveryStartRequestSchema,
  FORBIDDEN_WRITE_FIELDS,
  ConsoleJobState,
  ActiveUploadedBatch,
  ConsoleError
} from './types';
import { normalizeExecutionResult } from './resultsNormalizer';
import { sanitizeObject } from './sanitizer';
import { SETTING_DEFINITIONS } from '../settings/definitions';
import { SettingKey } from '../types/settings';
import { NormalizedResultsViewModel, NormalizedSchoolResult } from '../types/batch';
import { parseAndSeparateSchoolsCsv } from '../batch/csvParser';
import { AutomationError } from '../types/errors';
import { RequestedSettingsSchema } from '../config/schema';
import { generateSettingsHash, getToolVersion } from '../utils/hash';
import { getReportsDir, getCheckpointsDir, getLogsDir, getDataRootDir } from '../runtime/paths';
import { readCurrentLedger } from './ledger';
import { PlatformRouter } from '../platform/api/platformRouter';

export interface ConsoleServerOptions {
  port?: number;
  host?: string;
  adapter?: BatchProcessAdapter;
}

interface CachedAsset {
  contentType: string;
  buffer: Buffer;
  hash: string;
}

export class ConsoleServer {
  private server: http.Server | null = null;
  private adapter: BatchProcessAdapter;
  private port: number;
  private host: string;
  private csrfToken: string;
  private serverInstanceId: string;
  private serverStartedAt: string;
  private serverBuildFingerprint: string = 'unknown';
  private cachedStaticAssets: Map<string, CachedAsset> = new Map();
  private sseClients: Set<http.ServerResponse> = new Set();
  private platformRouter: PlatformRouter = new PlatformRouter();

  constructor(options: ConsoleServerOptions = {}) {
    this.port = options.port ?? 3000;
    this.host = options.host ?? '127.0.0.1'; // 127.0.0.1 のみバインド (指示19)
    this.adapter = options.adapter ?? new BatchProcessAdapter();
    this.csrfToken = crypto.randomBytes(16).toString('hex'); // CSRF nonce (指示7)
    this.serverInstanceId = `srv-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    this.serverStartedAt = new Date().toISOString();

    // 起動時に静的アセットをメモリへ完全固定 (Immutable In-Memory Generation)
    this.loadAndCacheStaticAssets();

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

  getServerInstanceId(): string {
    return this.serverInstanceId;
  }

  getServerStartedAt(): string {
    return this.serverStartedAt;
  }

  getServerBuildFingerprint(): string {
    return this.serverBuildFingerprint;
  }

  private loadAndCacheStaticAssets(): void {
    const publicDir = path.resolve(__dirname, 'public');
    const assetDefs: Array<{ route: string; file: string; contentType: string }> = [
      { route: '/index.html', file: 'index.html', contentType: 'text/html; charset=utf-8' },
      { route: '/guide.html', file: 'guide.html', contentType: 'text/html; charset=utf-8' },
      { route: '/styles.css', file: 'styles.css', contentType: 'text/css; charset=utf-8' },
      { route: '/app.js', file: 'app.js', contentType: 'application/javascript; charset=utf-8' }
    ];

    const hash = crypto.createHash('sha256');

    for (const def of assetDefs) {
      const fullPath = path.join(publicDir, def.file);
      if (fs.existsSync(fullPath)) {
        const raw = fs.readFileSync(fullPath);
        const fileHash = crypto.createHash('sha256').update(raw).digest('hex');
        this.cachedStaticAssets.set(def.route, {
          contentType: def.contentType,
          buffer: raw,
          hash: fileHash
        });
        hash.update(def.file);
        hash.update(raw);
      }
    }

    this.serverBuildFingerprint = hash.digest('hex').substring(0, 16);

    // index.html には serverInstanceId と serverBuildFingerprint のメタタグを事前注入してメモリ固定
    const indexAsset = this.cachedStaticAssets.get('/index.html');
    if (indexAsset) {
      let html = indexAsset.buffer.toString('utf-8');
      const metaInjection = `<meta name="server-instance-id" content="${this.serverInstanceId}">\n  <meta name="server-build-fingerprint" content="${this.serverBuildFingerprint}">`;
      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>\n  ${metaInjection}`);
      }
      const updatedBuffer = Buffer.from(html, 'utf-8');
      const updatedAsset: CachedAsset = {
        ...indexAsset,
        buffer: updatedBuffer
      };
      this.cachedStaticAssets.set('/index.html', updatedAsset);
      this.cachedStaticAssets.set('/', updatedAsset);
    }
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

    this.adapter.on('productionApplyCompleted', (data) => {
      this.broadcastSse('productionApplyCompleted', data);
    });

    this.adapter.on('discoveryCompleted', (data) => {
      this.broadcastSse('discoveryCompleted', data);
    });

    this.adapter.on('finalPreflightCompleted', (data) => {
      this.broadcastSse('finalPreflightCompleted', data);
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

    // 1. 静的ファイル配信 (Immutable In-Memory Static Assets Generation)
    if (method === 'GET') {
      const cached = this.cachedStaticAssets.get(pathname);
      if (cached) {
        res.writeHead(200, {
          'Content-Type': cached.contentType,
          'Content-Length': cached.buffer.length,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'X-Server-Instance-Id': this.serverInstanceId,
          'X-Server-Build-Fingerprint': this.serverBuildFingerprint
        });
        res.end(cached.buffer);
        return;
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // 1.5 Platform API Router
    if (pathname.startsWith('/api/platform/')) {
      let body: any = {};
      if (method === 'POST') {
        try {
          body = await this.parseJsonBody(req);
        } catch (e: any) {
          this.sendJson(res, 400, { error: 'INVALID_JSON', message: e.message });
          return;
        }
      }
      const handled = await this.platformRouter.handle(
        pathname,
        method,
        req,
        body,
        (status, data) => this.sendJson(res, status, data),
        (event, data) => this.broadcastSse(event, data)
      );
      if (handled) return;
    }

    // 2. GET /api/status (指示4, 5, 7, 8 & Phase 6A: Server Instance Binding)
    if (method === 'GET' && pathname === '/api/status') {
      const state = this.adapter.getJobState();
      const snapshot = this.adapter.getSnapshot();
      const activeUpload = this.adapter.getActiveUpload();
      const applyReady = this.adapter.isApplyReady();
      const workflowCapabilities = this.adapter.getWorkflowCapabilities();
      const activeFinalPreflightContext = this.adapter.getActiveFinalPreflightContext();

      this.sendJson(res, 200, {
        serverInstanceId: this.serverInstanceId,
        serverStartedAt: this.serverStartedAt,
        serverBuildFingerprint: this.serverBuildFingerprint,
        canPrepareApply: workflowCapabilities.canPrepareApply,
        jobState: state,
        csrfToken: this.csrfToken,
        applyReady,
        workflowCapabilities,
        activeFinalPreflightContext,
        snapshot,
        targetSnapshot: this.adapter.getTargetSnapshot(),
        observationSnapshot: this.adapter.getObservationSnapshot(),
        draftProfile: this.adapter.getDraftProfile(),
        activeProfileSnapshot: this.adapter.getActiveProfileSnapshot(),
        finalValidationSnapshot: this.adapter.getFinalValidationSnapshot(),
        activeFinalPreflightReport: this.adapter.getActiveFinalPreflightReport(),
        activeFinalSummaryReport: this.adapter.getActiveFinalSummaryReport(),
        currentExecutionPurpose: this.adapter.getCurrentExecutionPurpose(),
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
                mode: this.adapter.getCurrentExecutionPurpose() || 'PREFLIGHT_DRY_RUN'
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

    // Phase 6A: POST /api/target/validate (Target確定・検証)
    if (method === 'POST' && pathname === '/api/target/validate') {
      const state = this.adapter.getJobState();
      if (state === 'RUNNING' || state === 'STOPPING') {
        this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'ジョブ実行中または停止処理中は検証を実行できません' });
        return;
      }

      let body: any;
      try {
        body = await this.parseJsonBody(req);
      } catch (err: any) {
        this.sendJson(res, 400, { error: 'INVALID_JSON', message: err.message });
        return;
      }

      for (const field of FORBIDDEN_WRITE_FIELDS) {
        if (field in body) {
          this.sendJson(res, 400, { error: 'WRITE_FORBIDDEN', message: `Write関連フィールド '${field}' は許可されていません` });
          return;
        }
      }

      const parseRes = TargetValidateRequestSchema.safeParse(body);
      if (!parseRes.success) {
        this.sendJson(res, 400, {
          error: 'CONFIG_INVALID',
          message: `リクエスト検証エラー: ${parseRes.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
        });
        return;
      }

      try {
        const valRes = this.adapter.executeTargetValidation(parseRes.data);
        this.sendJson(res, 200, {
          status: 'PASS',
          targetSnapshot: valRes.targetSnapshot,
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

    // Phase 6A: Discovery エンドポイント群
    if (method === 'POST' && pathname === '/api/discovery/start') {
      await this.handleDiscoveryStart(req, res, 'START');
      return;
    }
    if (method === 'POST' && pathname === '/api/discovery/resume') {
      await this.handleDiscoveryStart(req, res, 'RESUME');
      return;
    }
    if (method === 'POST' && pathname === '/api/discovery/retry-failed') {
      await this.handleDiscoveryStart(req, res, 'RETRY_FAILED');
      return;
    }
    if (method === 'POST' && pathname === '/api/discovery/stop') {
      try {
        this.adapter.stopDiscoveryProcess();
        this.sendJson(res, 200, { status: 'STOPPING', message: '安全停止要求を送信しました' });
      } catch (err: any) {
        const code = err.status === 'JOB_NOT_RUNNING' ? 400 : 500;
        this.sendJson(res, code, { error: err.status || 'ERROR', message: err.message });
      }
      return;
    }
    if (method === 'GET' && pathname === '/api/observation/latest') {
      const obs = this.adapter.getObservationSnapshot() || this.adapter.loadLatestObservationSnapshot();
      if (!obs) {
        this.sendJson(res, 404, { error: 'OBSERVATION_NOT_FOUND', message: '最新の現状調査データが見つかりません' });
        return;
      }
      this.sendJson(res, 200, obs);
      return;
    }

    // Phase 6A: Decide / Draft Profile & Preview & Confirm エンドポイント群
    if (method === 'GET' && pathname === '/api/profile/draft') {
      const draft = this.adapter.getDraftProfile();
      this.sendJson(res, 200, { draftProfile: draft });
      return;
    }
    if (method === 'POST' && pathname === '/api/profile/draft') {
      const state = this.adapter.getJobState();
      if (state === 'RUNNING' || state === 'STOPPING') {
        this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'ジョブ実行中または停止処理中は設定を変更できません' });
        return;
      }
      let body: any;
      try {
        body = await this.parseJsonBody(req);
      } catch (err: any) {
        this.sendJson(res, 400, { error: 'INVALID_JSON', message: err.message });
        return;
      }
      for (const field of FORBIDDEN_WRITE_FIELDS) {
        if (field in body) {
          this.sendJson(res, 400, { error: 'WRITE_FORBIDDEN', message: `Write関連フィールド '${field}' は許可されていません` });
          return;
        }
      }
      const parseRes = DraftProfileRequestSchema.safeParse(body);
      if (!parseRes.success) {
        this.sendJson(res, 400, {
          error: 'CONFIG_INVALID',
          message: `リクエスト検証エラー: ${parseRes.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
        });
        return;
      }
      try {
        const updated = this.adapter.updateDraftProfile(parseRes.data.settings, {
          targetSnapshotId: parseRes.data.targetSnapshotId,
          observationSnapshotId: parseRes.data.observationSnapshotId,
          expectedDraftRevision: parseRes.data.expectedDraftRevision
        });
        this.sendJson(res, 200, { status: 'UPDATED', draftProfile: updated });
      } catch (err: any) {
        const code = err.status === 'JOB_CONFLICT' || err.status === 'LINEAGE_MISMATCH' || err.status === 'DRAFT_STALE'
          ? 409
          : (err.status === 'VALIDATION_REQUIRED' || err.issueCode === 'CONFIG_INVALID' ? 400 : 500);
        this.sendJson(res, code, { error: err.issueCode || err.status || 'DRAFT_UPDATE_FAILED', message: err.message });
      }
      return;
    }
    if (method === 'POST' && pathname === '/api/preview/calculate') {
      const state = this.adapter.getJobState();
      if (state === 'RUNNING' || state === 'STOPPING') {
        this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'ジョブ実行中はプレビューを計算できません' });
        return;
      }
      let body: any = {};
      try {
        body = await this.parseJsonBody(req);
      } catch {}

      try {
        const preview = this.adapter.calculatePreview(
          body?.observationSnapshotId,
          body?.draftRevision,
          body?.draftHash
        );
        this.sendJson(res, 200, preview);
      } catch (err: any) {
        const code = err.status === 'LINEAGE_MISMATCH' || err.status === 'DRAFT_STALE'
          ? 409
          : (err.status === 'VALIDATION_REQUIRED' ? 400 : 500);
        this.sendJson(res, code, { error: err.issueCode || err.status || 'PREVIEW_CALCULATION_FAILED', message: err.message });
      }
      return;
    }
    if (method === 'POST' && pathname === '/api/profile/confirm') {
      const state = this.adapter.getJobState();
      if (state === 'RUNNING' || state === 'STOPPING') {
        this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'ジョブ実行中または停止処理中はプロファイルを確定できません' });
        return;
      }
      let body: any;
      try {
        body = await this.parseJsonBody(req);
      } catch (err: any) {
        this.sendJson(res, 400, { error: 'INVALID_JSON', message: err.message });
        return;
      }
      for (const field of FORBIDDEN_WRITE_FIELDS) {
        if (field in body) {
          this.sendJson(res, 400, { error: 'WRITE_FORBIDDEN', message: `Write関連フィールド '${field}' は許可されていません` });
          return;
        }
      }
      const parseRes = ProfileConfirmRequestSchema.safeParse(body);
      if (!parseRes.success) {
        this.sendJson(res, 400, {
          error: 'CONFIG_INVALID',
          message: `リクエスト検証エラー: ${parseRes.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
        });
        return;
      }
      try {
        const snap = this.adapter.confirmProfile(
          parseRes.data.expectedDraftRevision,
          parseRes.data.expectedDraftHash,
          parseRes.data.targetSnapshotId,
          parseRes.data.observationSnapshotId
        );
        this.sendJson(res, 200, { status: 'CONFIRMED', profileSnapshot: snap });
      } catch (err: any) {
        const code = err.status === 'JOB_CONFLICT' || err.status === 'LINEAGE_MISMATCH' || err.status === 'DRAFT_STALE'
          ? 409
          : (err.status === 'VALIDATION_REQUIRED' ? 400 : 500);
        this.sendJson(res, code, { error: err.status || 'CONFIRM_FAILED', message: err.message });
      }
      return;
    }

    // 3. POST /api/validate (既存後方互換用)
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

    // Phase 6A: Final Preflight エンドポイント群 & 既存互換 (Phase 5A レガシー実行時は handleBatchStart へフォールバック)
    if (method === 'POST' && pathname === '/api/final-preflight/start') {
      await this.handleFinalPreflightStart(req, res, 'START');
      return;
    }
    if (method === 'POST' && pathname === '/api/preflight/start') {
      if (this.adapter.getFinalValidationSnapshot()) {
        await this.handleFinalPreflightStart(req, res, 'START');
      } else {
        await this.handleBatchStart(req, res, 'START');
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/final-preflight/resume') {
      await this.handleFinalPreflightStart(req, res, 'RESUME');
      return;
    }
    if (method === 'POST' && pathname === '/api/preflight/resume') {
      if (this.adapter.getFinalValidationSnapshot()) {
        await this.handleFinalPreflightStart(req, res, 'RESUME');
      } else {
        await this.handleBatchStart(req, res, 'RESUME');
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/final-preflight/retry-failed') {
      await this.handleFinalPreflightStart(req, res, 'RETRY_FAILED');
      return;
    }
    if (method === 'POST' && pathname === '/api/preflight/retry-failed') {
      if (this.adapter.getFinalValidationSnapshot()) {
        await this.handleFinalPreflightStart(req, res, 'RETRY_FAILED');
      } else {
        await this.handleBatchStart(req, res, 'RETRY_FAILED');
      }
      return;
    }

    if (method === 'POST' && (pathname === '/api/final-preflight/stop' || pathname === '/api/preflight/stop')) {
      try {
        if (this.adapter.getCurrentExecutionPurpose() === 'FINAL_PREFLIGHT') {
          this.adapter.stopFinalPreflightProcess();
        } else {
          this.adapter.stopBatchProcess();
        }
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

    // 9A. GET /api/results/latest (Phase 6A: Current Production Execution Result 厳格SSOT, No Disk Fallback)
    if (method === 'GET' && pathname === '/api/results/latest') {
      let execCtx = this.adapter.getActiveExecutionResultContext();
      if (!execCtx) {
        // 再起動時等の Ledger からの安全復元を試行
        this.adapter.restoreProductionResultFromLedger();
        execCtx = this.adapter.getActiveExecutionResultContext();
      }

      if (execCtx) {
        this.sendJson(res, 200, {
          status: 'AVAILABLE',
          ok: true,
          hasResults: true,
          mode: 'PRODUCTION_WRITE',
          result: execCtx.viewModel,
          summary: execCtx.summary,
          detail: execCtx.summary,
          deploymentId: execCtx.deploymentId,
          runId: execCtx.runId,
          completedAt: execCtx.completedAt
        });
        return;
      }

      // Memory Context がなく復元もできなかった場合、Ledger を確認
      const ledger = readCurrentLedger();
      if (ledger && (ledger.state === 'RUNNING' || ledger.state === 'STARTING')) {
        this.sendJson(res, 200, {
          status: 'RUNNING',
          ok: true,
          hasResults: false,
          state: ledger.state,
          executionId: ledger.executionId,
          message: '本番反映を実行中です...'
        });
        return;
      }

      if (ledger && (ledger.state === 'RESULT_INVALID' || ledger.state === 'OUTCOME_UNKNOWN' || ledger.state === 'INTERRUPTED')) {
        this.sendJson(res, 200, {
          status: 'FAILED',
          ok: false,
          hasResults: false,
          state: ledger.state,
          executionId: ledger.executionId,
          message: ledger.errorMessage || `本番反映は正常完了しませんでした (状態: ${ledger.state})`
        });
        return;
      }

      // 該当なし (Fail-Closed: 過去の推測レポート探索は行わない)
      this.sendJson(res, 200, {
        status: 'NOT_AVAILABLE',
        ok: false,
        hasResults: false,
        reason: 'RESULT_CONTEXT_NOT_AVAILABLE',
        message: '現在の実行コンテキストにおける本番反映結果は存在しません'
      });
      return;
    }

    // 9B. GET /api/reports/latest (レポートファイル閲覧用フォールバック)
    if (method === 'GET' && pathname === '/api/reports/latest') {
      const execCtx = this.adapter.getActiveExecutionResultContext();
      if (execCtx) {
        this.sendJson(res, 200, {
          ok: true,
          mode: 'PRODUCTION_WRITE',
          hasResults: true,
          result: execCtx.viewModel,
          summary: execCtx.summary,
          detail: execCtx.summary,
          deploymentId: execCtx.deploymentId,
          runId: execCtx.runId
        });
        return;
      }

      const reports = this.loadLatestReports();
      const hasResults = Boolean(reports.summary || reports.preflight || reports.checkpoint);

      if (reports.summary && reports.summary.mode === 'PRODUCTION_WRITE') {
        let resultViewModel = null;
        try {
          resultViewModel = normalizeExecutionResult(reports.summary);
        } catch (e: any) {
          console.error('[ConsoleServer] Failed to normalize production summary:', e);
        }

        this.sendJson(res, 200, {
          ok: true,
          mode: 'PRODUCTION_WRITE',
          hasResults,
          result: resultViewModel,
          summary: reports.summary,
          detail: reports.summary,
          checkpoint: reports.checkpoint,
          normalized: reports.normalized
        });
        return;
      }

      this.sendJson(res, 200, {
        ...reports,
        hasResults,
        mode: 'PREFLIGHT_DRY_RUN',
        detail: reports.preflight || reports.summary
      });
      return;
    }

    // 10. GET /api/reports/download/:type (指示6, 16: Exact Artifact Download, mtime探索完全撤廃)
    if (method === 'GET' && pathname.startsWith('/api/reports/download/')) {
      const type = pathname.replace('/api/reports/download/', '').toLowerCase();
      // Allow-list 厳格検証 (summary, preflight, checkpoint, observation)
      const ALLOWED_TYPES = ['summary', 'preflight', 'checkpoint', 'observation'];
      if (!ALLOWED_TYPES.includes(type)) {
        this.sendJson(res, 400, { error: 'INVALID_REPORT_TYPE', message: `許可されていないレポート種別です: ${type}` });
        return;
      }

      let payload: any = null;

      if (type === 'summary') {
        const execCtx = this.adapter.getActiveExecutionResultContext();
        if (execCtx?.summary) {
          payload = execCtx.summary;
        } else {
          const finalSummary = this.adapter.getActiveFinalSummaryReport();
          if (finalSummary) {
            payload = finalSummary;
          } else {
            const ledger = readCurrentLedger();
            if (ledger?.summaryPath && fs.existsSync(ledger.summaryPath)) {
              try {
                payload = JSON.parse(fs.readFileSync(ledger.summaryPath, 'utf-8'));
              } catch {}
            }
          }
        }
      } else if (type === 'preflight') {
        const pf = this.adapter.getActiveFinalPreflightReport();
        if (pf) {
          payload = pf;
        }
      } else if (type === 'observation') {
        const obs = this.adapter.getObservationSnapshot();
        if (obs) {
          payload = obs;
        }
      } else if (type === 'checkpoint') {
        const pfCtx = this.adapter.getActiveFinalPreflightContext();
        const execCtx = this.adapter.getActiveExecutionResultContext();
        const runId = execCtx?.runId || pfCtx?.runId || this.adapter.getCurrentRunId();
        if (runId) {
          const cpPath = path.join(getCheckpointsDir(), `checkpoint-${runId}.json`);
          if (fs.existsSync(cpPath)) {
            try {
              payload = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
            } catch {}
          }
        }
      }

      if (!payload) {
        this.sendJson(res, 404, { error: 'REPORT_NOT_FOUND', message: `レポートデータが見つかりません: ${type}` });
        return;
      }

      const sanitized = sanitizeObject(payload);
      const jsonStr = JSON.stringify(sanitized, null, 2);
      const filename = `${type}-sanitized-${Date.now()}.json`;

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      res.end(jsonStr);
      return;
    }

    // 10.5 POST /api/results/reset (過去データのリセット・初期化)
    if (method === 'POST' && pathname === '/api/results/reset') {
      const state = this.adapter.getJobState();
      if (state === 'RUNNING' || state === 'STOPPING') {
        this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: '処理実行中はリセットできません' });
        return;
      }

      try {
        const rootDir = getDataRootDir();
        const archiveDir = path.join(rootDir, 'archive');
        if (!fs.existsSync(archiveDir)) {
          fs.mkdirSync(archiveDir, { recursive: true });
        }

        const targetDirs = [getReportsDir(), getCheckpointsDir(), getLogsDir()];
        for (const dirPath of targetDirs) {
          if (fs.existsSync(dirPath)) {
            const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
            for (const file of files) {
              const src = path.join(dirPath, file);
              const dest = path.join(archiveDir, `${Date.now()}-${file}`);
              try {
                fs.renameSync(src, dest);
              } catch {
                // 移動失敗時はコピー後削除
                try {
                  fs.copyFileSync(src, dest);
                  fs.unlinkSync(src);
                } catch {
                  // 無視
                }
              }
            }
          }
        }

        this.adapter.resetAllResults();
        this.sendJson(res, 200, { success: true, message: '過去の実行結果をリセットしました' });
      } catch (err: any) {
        this.sendJson(res, 500, { error: 'RESET_FAILED', message: `リセット処理中にエラーが発生しました: ${err.message}` });
      }
      return;
    }

    // 11. POST /api/apply/prepare (指示5 & Phase 6B: Confirmation Token 発行, allowDestructive 対応)
    if (method === 'POST' && pathname === '/api/apply/prepare') {
      const state = this.adapter.getJobState();
      if (state === 'RUNNING' || state === 'STOPPING') {
        this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'すでに別のジョブが実行中または停止処理中です' });
        return;
      }

      let body: any = {};
      try {
        body = await this.parseJsonBody(req);
      } catch (err: any) {
        this.sendJson(res, 400, { error: 'INVALID_JSON', message: err.message });
        return;
      }

      // Write関連の不正フィールド拒絶 (allowDestructive のみ boolean 値として安全に許可)
      for (const field of FORBIDDEN_WRITE_FIELDS) {
        if (field in body) {
          if (field === 'allowDestructive' && typeof body.allowDestructive === 'boolean') {
            continue;
          }
          this.sendJson(res, 400, { error: 'WRITE_FORBIDDEN', message: `Write関連フィールド '${field}' は許可されていません` });
          return;
        }
      }

      try {
        const result = this.adapter.prepareProductionApply(
          undefined,
          undefined,
          Boolean(body.allowDestructive),
          Boolean(body.directApply)
        );
        this.sendJson(res, 200, {
          status: 'PREPARED',
          manifest: result.manifest,
          confirmationToken: result.tokenData.token,
          expiresAt: result.tokenData.expiresAt,
          targetCount: result.manifest.applyTargets.length,
          skippedDestructiveCount: result.manifest.skippedDestructiveCount,
          alreadyConfiguredCount: result.manifest.alreadyConfiguredCount,
          allowDestructive: result.manifest.allowDestructive === true,
          directApply: result.manifest.directApply === true
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

    // 12. POST /api/apply/start (Phase 5B.3 & Phase 6A: 本番非破壊書き込みプロセスの起動, Override完全禁止)
    if (method === 'POST' && pathname === '/api/apply/start') {
      const state = this.adapter.getJobState();
      if (state === 'RUNNING' || state === 'STOPPING') {
        this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'すでに別のジョブが実行中または停止処理中です' });
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

  private async handleDiscoveryStart(req: http.IncomingMessage, res: http.ServerResponse, mode: 'START' | 'RESUME' | 'RETRY_FAILED'): Promise<void> {
    const state = this.adapter.getJobState();
    if (state === 'RUNNING' || state === 'STOPPING') {
      this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'すでに別のジョブが実行中または停止処理中です' });
      return;
    }

    let body: any;
    try {
      body = await this.parseJsonBody(req);
    } catch (err: any) {
      this.sendJson(res, 400, { error: 'INVALID_JSON', message: err.message });
      return;
    }

    for (const field of FORBIDDEN_WRITE_FIELDS) {
      if (field in body) {
        this.sendJson(res, 400, { error: 'WRITE_FORBIDDEN', message: `Write関連フィールド '${field}' は許可されていません` });
        return;
      }
    }

    const parseRes = DiscoveryStartRequestSchema.safeParse(body);
    if (!parseRes.success) {
      this.sendJson(res, 400, {
        error: 'INVALID_REQUEST',
        message: `リクエスト検証エラー: ${parseRes.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      });
      return;
    }

    try {
      this.adapter.startDiscoveryProcess(mode, {
        concurrency: parseRes.data.concurrency
      });
      this.sendJson(res, 200, {
        status: 'STARTED',
        mode: 'DISCOVERY',
        runId: this.adapter.getCurrentRunId(),
        concurrency: parseRes.data.concurrency || 1,
        message: '現状調査プロセスを開始しました (DISCOVERY: Read-only)'
      });
    } catch (err: any) {
      const code = err.status === 'JOB_CONFLICT' ? 409 : (err.status === 'SAMPLE_DATA_BLOCKED' || err.status === 'VALIDATION_REQUIRED' ? 400 : 500);
      this.sendJson(res, code, {
        error: err.issueCode || err.status || 'SPAWN_FAILED',
        message: err.message
      });
    }
  }

  private async handleFinalPreflightStart(req: http.IncomingMessage, res: http.ServerResponse, mode: 'START' | 'RESUME' | 'RETRY_FAILED'): Promise<void> {
    const state = this.adapter.getJobState();
    if (state === 'RUNNING' || state === 'STOPPING') {
      this.sendJson(res, 409, { error: 'JOB_CONFLICT', message: 'すでに別のジョブが実行中または停止処理中です' });
      return;
    }

    let body: any;
    try {
      body = await this.parseJsonBody(req);
    } catch (err: any) {
      this.sendJson(res, 400, { error: 'INVALID_JSON', message: err.message });
      return;
    }

    for (const field of FORBIDDEN_WRITE_FIELDS) {
      if (field in body) {
        this.sendJson(res, 400, { error: 'WRITE_FORBIDDEN', message: `Write関連フィールド '${field}' は許可されていません` });
        return;
      }
    }

    const parseRes = EmptyActionRequestSchema.safeParse(body);
    if (!parseRes.success) {
      this.sendJson(res, 400, {
        error: 'INVALID_REQUEST',
        message: `リクエスト検証エラー: 未知のフィールドが存在します: ${parseRes.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      });
      return;
    }

    try {
      this.adapter.startFinalPreflightProcess(mode, {});
      this.sendJson(res, 200, {
        status: 'STARTED',
        mode: 'FINAL_PREFLIGHT',
        runId: this.adapter.getCurrentRunId(),
        message: 'Final Preflight プロセスを開始しました (FINAL_PREFLIGHT: Read-only)'
      });
    } catch (err: any) {
      const code = err.status === 'JOB_CONFLICT' ? 409 : (err.status === 'SAMPLE_DATA_BLOCKED' || err.status === 'VALIDATION_REQUIRED' ? 400 : 500);
      this.sendJson(res, code, {
        error: err.issueCode || err.status || 'SPAWN_FAILED',
        message: err.message
      });
    }
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
    if (type === 'summary') {
      const execCtx = this.adapter.getActiveExecutionResultContext();
      if (execCtx?.productionExecutionId) {
        const exactPath = path.join(getReportsDir(), `summary-${execCtx.productionExecutionId}.json`);
        if (fs.existsSync(exactPath)) return exactPath;
      }
      const ledger = readCurrentLedger();
      if (ledger?.summaryPath && fs.existsSync(ledger.summaryPath)) {
        return ledger.summaryPath;
      }
    }

    if (type === 'preflight') {
      const fpCtx = this.adapter.getActiveFinalPreflightContext();
      if (fpCtx?.executionId) {
        const exactPath = path.join(getReportsDir(), `preflight-${fpCtx.executionId}.json`);
        if (fs.existsSync(exactPath)) return exactPath;
      }
    }

    // ディスクからのフォールバック探索 (テストや手動配置ファイル用)
    try {
      const dir = getReportsDir();
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir)
          .filter(f => f.startsWith(`${type}-`) && f.endsWith('.json'))
          .map(f => ({ name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) return files[0].path;
      }
    } catch {}

    return null;
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
