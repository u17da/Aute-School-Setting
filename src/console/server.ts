import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BatchProcessAdapter } from './adapter';
import {
  ValidateRequestSchema,
  EmptyActionRequestSchema,
  FORBIDDEN_WRITE_FIELDS,
  ConsoleJobState
} from './types';
import { sanitizeObject } from './sanitizer';
import { SETTING_DEFINITIONS } from '../settings/definitions';
import { SettingKey } from '../types/settings';

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
      return;
    }
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
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
      if (pathname === '/styles.css') {
        this.sendFile(res, path.join(publicDir, 'styles.css'), 'text/css; charset=utf-8');
        return;
      }
      if (pathname === '/app.js') {
        this.sendFile(res, path.join(publicDir, 'app.js'), 'application/javascript; charset=utf-8');
        return;
      }
    }

    // 2. GET /api/status (指示4, 5, 7)
    if (method === 'GET' && pathname === '/api/status') {
      const state = this.adapter.getJobState();
      const snapshot = this.adapter.getSnapshot();
      this.sendJson(res, 200, {
        jobState: state,
        csrfToken: this.csrfToken,
        snapshot,
        currentJob: state === 'RUNNING' || state === 'STOPPING' ? {
          runId: this.adapter.getCurrentRunId(),
          startedAt: this.adapter.getStartedAt(),
          mode: 'PREFLIGHT_DRY_RUN'
        } : undefined,
        recentLogs: this.adapter.getRecentLogs()
      });
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
          enabledCount: valRes.enabledCount
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
      checkpoint: null
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
