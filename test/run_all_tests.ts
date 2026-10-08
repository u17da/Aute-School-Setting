import { spawnSync } from 'child_process';
import * as path from 'path';

console.log('>>> Running Comprehensive Test Suite (Formal Test Runner) <<<\n');

const testFiles = [
  path.resolve(__dirname, 'phase1.test.ts'),
  path.resolve(__dirname, 'phase2a.test.ts'),
  path.resolve(__dirname, 'phase2b.test.ts'),
  path.resolve(__dirname, 'console.test.ts'),
  path.resolve(__dirname, 'login_verification_flow.test.ts'),
  path.resolve(__dirname, 'platform/platform_core.test.ts'),
  path.resolve(__dirname, 'platform/platform_claude_autonomous_planner.test.ts'),
  path.resolve(__dirname, 'platform/platform_interactive_planner_and_session.test.ts')
];

let failed = false;

for (const testFile of testFiles) {
  const relPath = path.relative(process.cwd(), testFile);
  console.log(`[TEST-RUNNER] Executing: ${relPath}`);

  const tsNodeBin = path.resolve(__dirname, '../node_modules/ts-node/dist/bin.js');
  const result = spawnSync(process.execPath, [tsNodeBin, testFile], {
    stdio: 'inherit',
    cwd: process.cwd()
  });

  if (result.status !== 0) {
    console.error(`[TEST-RUNNER] FAILED: ${relPath} (exit code ${result.status})`);
    failed = true;
    break;
  }
  console.log(`[TEST-RUNNER] PASSED: ${relPath}\n`);
}

if (failed) {
  process.exit(1);
} else {
  console.log('>>> All Test Suites Completed Successfully! <<<');
  process.exit(0);
}
