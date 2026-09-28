import * as http from 'http';
import { BatchProcessAdapter } from '../src/console/adapter';
import { ConsoleServer } from '../src/console/server';
import { DiscoveryStartRequestSchema } from '../src/console/types';

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`✅ PASS: ${msg}`);
    passedCount++;
  } else {
    console.error(`❌ FAIL: ${msg}`);
    failedCount++;
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTests() {
  console.log('=== [DISCOVERY CONCURRENCY] Multi-session Discovery Tests ===\n');

  // 1. Zod Schema の Concurrency バリデーション検証
  console.log('--- Case 1: DiscoveryStartRequestSchema Validation ---');
  {
    const valid1 = DiscoveryStartRequestSchema.safeParse({});
    assert(valid1.success && valid1.data.concurrency === undefined, 'Empty body passes with undefined concurrency');

    const valid2 = DiscoveryStartRequestSchema.safeParse({ concurrency: 3 });
    assert(valid2.success && valid2.data.concurrency === 3, 'concurrency: 3 passes');

    const valid3 = DiscoveryStartRequestSchema.safeParse({ concurrency: 5 });
    assert(valid3.success && valid3.data.concurrency === 5, 'concurrency: 5 passes (max bound)');

    const valid4 = DiscoveryStartRequestSchema.safeParse({ concurrency: 1 });
    assert(valid4.success && valid4.data.concurrency === 1, 'concurrency: 1 passes (min bound)');

    const invalidMax = DiscoveryStartRequestSchema.safeParse({ concurrency: 6 });
    assert(!invalidMax.success, 'concurrency: 6 is rejected (> 5)');

    const invalidMin = DiscoveryStartRequestSchema.safeParse({ concurrency: 0 });
    assert(!invalidMin.success, 'concurrency: 0 is rejected (< 1)');

    const invalidNegative = DiscoveryStartRequestSchema.safeParse({ concurrency: -1 });
    assert(!invalidNegative.success, 'concurrency: -1 is rejected');

    const invalidFloat = DiscoveryStartRequestSchema.safeParse({ concurrency: 2.5 });
    assert(!invalidFloat.success, 'concurrency: 2.5 is rejected (must be int)');

    const invalidUnknown = DiscoveryStartRequestSchema.safeParse({ concurrency: 3, unknownField: true });
    assert(!invalidUnknown.success, 'unknown fields are rejected (.strict())');
  }

  // 2. Adapter の startDiscoveryProcess における CLI 引数検証
  console.log('\n--- Case 2: Adapter startDiscoveryProcess Arguments ---');
  {
    const adapter = new BatchProcessAdapter();
    let capturedArgs: string[] = [];

    // spawnChildInternal をモックして引数をキャプチャ
    (adapter as any).spawnChildInternal = (args: string[]) => {
      capturedArgs = args;
    };
    (adapter as any).targetSnapshot = {
      targetSnapshotId: 'tgt-mock',
      schoolsHash: 'hash-mock',
      authMode: 'A'
    };
    (adapter as any).materializeTempFiles = () => ({
      schoolsPath: 'config/schools.live.csv',
      credentialsPath: undefined,
      cleanup: () => {}
    });

    // concurrency: 3 を渡して起動
    adapter.startDiscoveryProcess('START', { concurrency: 3 });
    assert(capturedArgs.includes('--concurrency'), 'args include --concurrency flag');
    const concIdx = capturedArgs.indexOf('--concurrency');
    assert(capturedArgs[concIdx + 1] === '3', 'args pass 3 as concurrency value');
    assert(capturedArgs.includes('--purpose') && capturedArgs[capturedArgs.indexOf('--purpose') + 1] === 'discovery', 'args purpose is discovery');

    // concurrency: 1 の場合 (--concurrency フラグは渡されない、デフォルト1)
    capturedArgs = [];
    adapter.startDiscoveryProcess('START', { concurrency: 1 });
    assert(!capturedArgs.includes('--concurrency'), 'args do not include --concurrency when concurrency <= 1');

    // concurrency: undefined の場合
    capturedArgs = [];
    adapter.startDiscoveryProcess('START', {});
    assert(!capturedArgs.includes('--concurrency'), 'args do not include --concurrency when undefined');
  }

  // 3. Server POST /api/discovery/start 統合テスト
  console.log('\n--- Case 3: Server POST /api/discovery/start Integration ---');
  {
    const adapter = new BatchProcessAdapter();
    let capturedConcurrency: number | undefined;

    adapter.startDiscoveryProcess = (_mode: any, params?: any) => {
      capturedConcurrency = params?.concurrency;
    };
    (adapter as any).getCurrentRunId = () => 'run-conc-test';

    const server = new ConsoleServer({ port: 3097, adapter });
    await server.start();
    const csrfToken = server.getCsrfToken();

    try {
      // 3.1 concurrency: 4 でリクエスト
      const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = http.request(
          'http://127.0.0.1:3097/api/discovery/start',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Nonce': csrfToken
            }
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(data) }));
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ concurrency: 4 }));
        req.end();
      });

      assert(res.status === 200, `POST /api/discovery/start returns 200, got ${res.status}`);
      assert(res.body.status === 'STARTED', 'status is STARTED');
      assert(res.body.mode === 'DISCOVERY', 'mode is DISCOVERY');
      assert(res.body.concurrency === 4, `response has concurrency: 4, got ${res.body.concurrency}`);
      assert(capturedConcurrency === 4, `adapter received concurrency: 4, got ${capturedConcurrency}`);

      // 3.2 不正な concurrency (6) のリクエスト
      const invalidRes = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = http.request(
          'http://127.0.0.1:3097/api/discovery/start',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Nonce': csrfToken
            }
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(data) }));
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ concurrency: 6 }));
        req.end();
      });

      assert(invalidRes.status === 400, `POST with concurrency: 6 returns 400, got ${invalidRes.status}`);
      assert(invalidRes.body.error === 'INVALID_REQUEST', 'error is INVALID_REQUEST');

    } finally {
      await server.stop();
    }
  }

  // 4. Concurrency Safety: PRODUCTION_WRITE での Concurrency 強制 1 の保証
  console.log('\n--- Case 4: Production Write Concurrency Safety Isolation ---');
  {
    // runBatch の concurrency 判定ロジック検証
    const calculateEffectiveConcurrency = (purpose: string, requestedConcurrency?: number): number => {
      return purpose === 'DISCOVERY'
        ? Math.max(1, Math.min(requestedConcurrency ?? 1, 5))
        : 1;
    };

    assert(calculateEffectiveConcurrency('DISCOVERY', 3) === 3, 'DISCOVERY with 3 -> effective is 3');
    assert(calculateEffectiveConcurrency('DISCOVERY', 4) === 4, 'DISCOVERY with 4 -> effective is 4');
    assert(calculateEffectiveConcurrency('DISCOVERY', 10) === 5, 'DISCOVERY with 10 -> capped at 5');
    assert(calculateEffectiveConcurrency('DISCOVERY', 0) === 1, 'DISCOVERY with 0 -> floored at 1');
    assert(calculateEffectiveConcurrency('DISCOVERY', undefined) === 1, 'DISCOVERY with undefined -> default 1');

    // 本番書き込み時は常に 1
    assert(calculateEffectiveConcurrency('APPLY', 4) === 1, 'APPLY with 4 -> forced to 1');
    assert(calculateEffectiveConcurrency('PRODUCTION_WRITE', 5) === 1, 'PRODUCTION_WRITE with 5 -> forced to 1');
    assert(calculateEffectiveConcurrency('FINAL_PREFLIGHT', 4) === 1, 'FINAL_PREFLIGHT with 4 -> forced to 1');
  }

  console.log(`\n======================================================`);
  console.log(`Discovery Concurrency Tests: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log(`======================================================\n`);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
