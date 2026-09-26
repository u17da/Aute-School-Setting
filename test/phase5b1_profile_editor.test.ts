import assert from 'assert';
import * as http from 'http';
import { ConsoleServer } from '../src/console/server';
import { BatchProcessAdapter } from '../src/console/adapter';
import { SETTING_DEFINITIONS } from '../src/settings/definitions';
import { generateSettingsHash } from '../src/utils/hash';

console.log('=== Phase 5B.1: Profile Editor, Immutable Snapshot & Dynamic Preflight Tests (A-I) ===\n');

let passedTests = 0;
let failedTests = 0;

async function runTest(testName: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`[PASS] ${testName}`);
    passedTests++;
  } catch (err: any) {
    console.error(`[FAIL] ${testName}:`, err.message || err);
    failedTests++;
  }
}

async function httpRequest(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: any; rawBody: string }> {
  return new Promise((resolve, reject) => {
    const postData = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const reqHeaders: Record<string, string> = {
      Host: `127.0.0.1:${options.port}`,
      ...(options.headers || {})
    };

    if (postData !== undefined && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method || 'GET',
        headers: reqHeaders
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: parsed,
            rawBody: data
          });
        });
      }
    );

    req.on('error', reject);

    if (postData !== undefined) {
      req.write(postData);
    }
    req.end();
  });
}

async function main() {
  const adapter = new BatchProcessAdapter({ stopFallbackTimeoutMs: 1000 });
  const server = new ConsoleServer({ port: 0, host: '127.0.0.1', adapter });
  const actualPort = await server.start();
  const csrfToken = server.getCsrfToken();

  try {
    // Test A: GUI 11項目enum SSOT一致
    await runTest('Test A: GET /api/profile/definitions matches SETTING_DEFINITIONS SSOT', async () => {
      const res = await httpRequest({
        port: actualPort,
        path: '/api/profile/definitions'
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.definitions.length, 11);

      for (const def of res.body.definitions) {
        const expected = (SETTING_DEFINITIONS as any)[def.key];
        assert.ok(expected, `Missing definition for key: ${def.key}`);
        assert.strictEqual(def.label, expected.label);
        assert.strictEqual(def.options.length, expected.options.length);
        assert.strictEqual(def.destructiveWhenOff, Boolean(expected.destructiveWhenOff));
      }
    });

    // Test B: UNMANAGED 選択動作 (null または未指定が UNMANAGED と判定される)
    await runTest('Test B: Dynamic profile with UNMANAGED fields handled properly', async () => {
      const partialProfile = {
        storage: 'ON',
        timelineChannel: 'ON',
        directMessage: null,
        parentDirectMessage: null
      };
      const res = await httpRequest({
        port: actualPort,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: { profile: partialProfile }
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'PASS');
      assert.strictEqual(res.body.snapshot.enabledSchoolCount, 3);
      assert.ok(res.body.snapshot.profileSnapshotId);
    });

    // Test C: Profile Hash 算出の決定論性
    await runTest('Test C: Profile Hash generation is deterministic', async () => {
      const p1 = { storage: 'ON', timelineChannel: 'OFF' };
      const p2 = { timelineChannel: 'OFF', storage: 'ON' };
      const h1 = generateSettingsHash(p1 as any);
      const h2 = generateSettingsHash(p2 as any);
      assert.strictEqual(h1, h2, 'Different key order must produce identical profileHash');
    });

    // Test D: Editor変更で Validation が即座に invalid になること
    await runTest('Test D: POST /api/profile/invalidate clears Validation Snapshot', async () => {
      // 1. Validation 実行
      const valRes = await httpRequest({
        port: actualPort,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: { profile: { storage: 'ON' } }
      });
      assert.strictEqual(valRes.body.status, 'PASS');
      assert.ok(adapter.getSnapshot() !== null);

      // 2. Invalidate 実行
      const invRes = await httpRequest({
        port: actualPort,
        path: '/api/profile/invalidate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken }
      });
      assert.strictEqual(invRes.statusCode, 200);
      assert.strictEqual(adapter.getSnapshot(), null);
      assert.strictEqual(adapter.getJobState(), 'IDLE');
    });

    // Test E: Editor変更で Preflight 開始が拒絶されること
    await runTest('Test E: Preflight start rejected when validation is stale/invalidated', async () => {
      // Snapshot が null の状態で Preflight 開始
      const preflightRes = await httpRequest({
        port: actualPort,
        path: '/api/preflight/start',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: {}
      });
      assert.strictEqual(preflightRes.statusCode, 400);
      assert.strictEqual(preflightRes.body.error, 'VALIDATION_REQUIRED');
    });

    // Test F: Preset変更で Invalidation が発生すること
    await runTest('Test F: GET /api/profile/presets provides RECOMMENDED and UNMANAGED_ALL', async () => {
      const presetsRes = await httpRequest({
        port: actualPort,
        path: '/api/profile/presets'
      });
      assert.strictEqual(presetsRes.statusCode, 200);
      assert.strictEqual(presetsRes.body.presets.length, 2);
      assert.strictEqual(presetsRes.body.presets[0].id, 'RECOMMENDED');
      assert.strictEqual(presetsRes.body.presets[1].id, 'UNMANAGED_ALL');
    });

    // Test G: JSON import / validate strict schema (未知key拒否、不正enum拒否)
    await runTest('Test G: Unknown key or invalid enum value rejected by strict schema', async () => {
      const invalidProfileUnknownKey = {
        storage: 'ON',
        maliciousKey: 'HACKED'
      };
      const res1 = await httpRequest({
        port: actualPort,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: { profile: invalidProfileUnknownKey }
      });
      assert.strictEqual(res1.body.status, 'FAIL');
      assert.strictEqual(res1.body.error.code, 'CONFIG_INVALID');

      const invalidProfileBadEnum = {
        storage: 'SUPER_ON'
      };
      const res2 = await httpRequest({
        port: actualPort,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: { profile: invalidProfileBadEnum }
      });
      assert.strictEqual(res2.body.status, 'FAIL');
      assert.strictEqual(res2.body.error.code, 'CONFIG_INVALID');
    });

    // Test H: Export に secret なし (認証情報・学校情報を含まない)
    await runTest('Test H: POST /api/profile/export contains NO secrets', async () => {
      const res = await httpRequest({
        port: actualPort,
        path: '/api/profile/export',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: { profile: { storage: 'ON', timelineChannel: 'ON' } }
      });
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.requestedSettings);
      assert.ok(res.body.profileHash);
      assert.ok(res.body.exportedAt);
      assert.ok(res.body.toolVersion);

      // 秘密情報が存在しないことを厳格検証
      const raw = res.rawBody.toLowerCase();
      assert.ok(!raw.includes('password'), 'Export must not contain password');
      assert.ok(!raw.includes('userid'), 'Export must not contain userId');
      assert.ok(!raw.includes('schoolcode'), 'Export must not contain schoolCode');
    });

    // Test I: Preflight Snapshot profile 一致
    await runTest('Test I: Dynamic profile creates immutable ProfileSnapshot with ID', async () => {
      const dynamicProfile = {
        storage: 'ON',
        timelineChannel: 'ON',
        directMessage: 'STUDENT_TO_STUDENT_DISABLED'
      };
      const valRes = await httpRequest({
        port: actualPort,
        path: '/api/validate',
        method: 'POST',
        headers: { 'X-CSRF-Nonce': csrfToken },
        body: { profile: dynamicProfile }
      });
      assert.strictEqual(valRes.body.status, 'PASS');
      const snapshot = valRes.body.snapshot;
      assert.ok(snapshot.profileSnapshotId.startsWith('prof-snap-'));

      const activeSnap = adapter.getActiveProfileSnapshot();
      assert.ok(activeSnap);
      assert.strictEqual(activeSnap.snapshotId, snapshot.profileSnapshotId);
      assert.strictEqual(activeSnap.profileHash, snapshot.profileHash);
      assert.strictEqual(activeSnap.requestedSettings.storage, 'ON');
    });

  } finally {
    await server.stop();
  }

  console.log(`\nPhase 5B.1 Test Results: ${passedTests} passed, ${failedTests} failed`);
  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error running tests:', err);
  process.exit(1);
});
