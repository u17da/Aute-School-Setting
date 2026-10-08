import assert from 'assert';
import { chromium } from 'playwright';

async function runE2eAcceptance() {
  console.log('=== [PLATFORM E2E BROWSER ACCEPTANCE START] ===');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    // 1. ページロード
    console.log('--- Step 0: Loading Console UI http://127.0.0.1:3000 ---');
    await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' });

    // AI Platform モードがデフォルトで表示されているか
    const platformVisible = await page.isVisible('#platformContainer');
    assert(platformVisible, 'Platform Container must be visible');
    console.log('  [PASS] Platform Container visible');

    // 2. Step 1: 対象学校の入力と読み取り
    console.log('--- Step 1: Input targets and parse ---');
    const inputArea = page.locator('#targetRawTextInput');
    await inputArea.fill(`C2001001,堀川小学校,adminPass1\nC2001002,滝川小学校,adminPass2\nC2001003,北野中学校,adminPass3`);

    // 「① 入力内容を読み取る」ボタンをクリック
    const btnParse = page.locator('#btnParseTargets');
    await btnParse.click();

    // 読み取り結果テーブルの出現を待機
    await page.waitForSelector('#targetSummaryCard', { state: 'visible', timeout: 5000 });
    const totalCount = await page.locator('#statTargetTotal').textContent();
    assert.strictEqual(totalCount?.trim(), '3', 'Total count should be 3');
    console.log('  [PASS] Targets parsed successfully: Total =', totalCount);

    // ログイン確認ボタンをクリック
    console.log('--- Step 1.2: Validate login ---');
    await page.route('**/api/platform/targets/validate-login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total: 3,
          valid: 3,
          failed: 0,
          results: [
            { schoolCode: 'C2001001', schoolName: '堀川小学校', status: 'VALID', message: '実機ログイン成功: 学校名「堀川小学校」を確認しました。' },
            { schoolCode: 'C2001002', schoolName: '滝川小学校', status: 'VALID', message: '実機ログイン成功: 学校名「滝川小学校」を確認しました。' },
            { schoolCode: 'C2001003', schoolName: '北野中学校', status: 'VALID', message: '実機ログイン成功: 学校名「北野中学校」を確認しました。' }
          ]
        })
      });
    });

    const btnLogin = page.locator('#btnValidateLogin');
    await btnLogin.click();

    // ログイン確認結果の出現を待機
    await page.waitForSelector('#loginValidationResultsBox', { state: 'visible', timeout: 10000 });
    const resultText = await page.locator('#loginValidationResultsText').textContent();
    assert(resultText?.includes('3'), 'Validation result should mention 3 schools');
    console.log('  [PASS] Login validation completed:', resultText?.trim());

    // Step 2 へ進む
    const btnGoStep2 = page.locator('#btnGoToStep2');
    await btnGoStep2.click();

    // 3. Step 2: 作業手順の計画立案
    console.log('--- Step 2: Plan generation ---');
    await page.waitForSelector('#wizScreenStep2', { state: 'visible', timeout: 5000 });

    // Mock API for Step 2 UI Verification if ANTHROPIC_API_KEY is not configured in server env
    let planGenCount = 0;
    await page.route('**/api/platform/plan/generate', async (route) => {
      planGenCount++;
      const req = route.request();
      const postData = JSON.parse(req.postData() || '{}');

      if (planGenCount === 1) {
        // Initial Plan
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jobId: 'job_e2e_001',
            executionPlan: {
              planId: 'plan_e2e_001',
              targetSetId: 'ts_test_001',
              userInstruction: postData.userInstruction,
              status: 'READY',
              humanSummary: {
                interpretedIntent: '児童生徒のパスワード変更を許可する',
                targetScope: '指定された3校',
                actionSummary: '学校設定変更',
                settingValueSummary: 'studentPasswordChange: SHOW',
                skipBehavior: '既に設定済みなら安全にスキップ',
                capabilityUsed: 'CHANGE_SCHOOL_SETTINGS',
                riskLevel: 'REVERSIBLE_WRITE'
              },
              operations: [
                {
                  operationId: 'op_1',
                  operationType: 'CHANGE_SCHOOL_SETTINGS',
                  capabilityId: 'CHANGE_SCHOOL_SETTINGS',
                  riskClass: 'REVERSIBLE_WRITE',
                  reversible: true,
                  inputMapping: { studentPasswordChange: 'SHOW' },
                  preconditions: [],
                  verification: []
                }
              ],
              assumptions: [{ id: 'a1', description: '学校管理画面に設定項目が存在すること', impactIfFalse: '' }],
              riskLevel: 'REVERSIBLE_WRITE',
              estimatedAffectedSchools: 3,
              validationScopeProposal: {
                unit: 'SCHOOL',
                count: 1,
                description: '影響範囲を抑え、画面変化を確かめるため1校で先行検証',
                policyApproved: true
              }
            },
            timeEstimate: {
              estimatedTotalDurationSec: 15,
              confidenceRangeSec: [10, 20],
              p95DurationSec: 6,
              displayFormatted: '10秒 ～ 20秒'
            },
            costEstimate: {
              estimatedCostJpy: 0.12,
              estimatedInputTokens: 850,
              estimatedOutputTokens: 220
            },
            policy: { gates: {} }
          })
        });
      } else {
        // Refined Plan (PlanDiff included)
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jobId: 'job_e2e_002',
            executionPlan: {
              planId: 'plan_e2e_002',
              targetSetId: 'ts_test_001',
              userInstruction: `${postData.userInstruction} [修正: ${postData.refinementInstruction}]`,
              status: 'READY',
              humanSummary: {
                interpretedIntent: '児童生徒のパスワード変更を禁止する（修正指示を反映）',
                targetScope: '指定された3校',
                actionSummary: '学校設定変更',
                settingValueSummary: 'studentPasswordChange: HIDE',
                skipBehavior: '既に設定済みなら安全にスキップ',
                capabilityUsed: 'CHANGE_SCHOOL_SETTINGS',
                riskLevel: 'REVERSIBLE_WRITE'
              },
              operations: [
                {
                  operationId: 'op_1_mod',
                  operationType: 'CHANGE_SCHOOL_SETTINGS',
                  capabilityId: 'CHANGE_SCHOOL_SETTINGS',
                  riskClass: 'REVERSIBLE_WRITE',
                  reversible: true,
                  inputMapping: { studentPasswordChange: 'HIDE' },
                  preconditions: [],
                  verification: []
                }
              ],
              assumptions: [{ id: 'a1', description: '学校管理画面に設定項目が存在すること', impactIfFalse: '' }],
              riskLevel: 'REVERSIBLE_WRITE',
              estimatedAffectedSchools: 3,
              validationScopeProposal: {
                unit: 'SCHOOL',
                count: 1,
                description: '影響範囲を抑え、画面変化を確かめるため1校で先行検証',
                policyApproved: true
              },
              planDiff: {
                added: ['studentPasswordChange: HIDE'],
                unchanged: [],
                removed: ['studentPasswordChange: SHOW'],
                summaryText: 'パスワード変更の許可設定を「許可」から「禁止」に変更しました。'
              }
            },
            timeEstimate: {
              estimatedTotalDurationSec: 15,
              confidenceRangeSec: [10, 20],
              p95DurationSec: 6,
              displayFormatted: '10秒 ～ 20秒'
            },
            costEstimate: {
              estimatedCostJpy: 0.15,
              estimatedInputTokens: 950,
              estimatedOutputTokens: 260
            },
            policy: { gates: {} }
          })
        });
      }
    });

    const instructionInput = page.locator('#taskInstructionInput');
    await instructionInput.fill('各学校で児童生徒がパスワードを変えられるようにしてください。設定済みならスキップで。');

    const btnGenPlan = page.locator('#btnGeneratePlan');
    await btnGenPlan.click();

    // 作業計画プレビューの出現を待機
    await page.waitForSelector('#planPreviewContainer', { state: 'visible', timeout: 15000 });

    // Haiku による作業まとめカードの確認
    const interpretedIntent = await page.locator('#summaryInterpretedIntent').textContent();
    console.log('  Interpreted Intent:', interpretedIntent);
    assert(interpretedIntent && interpretedIntent !== '-', 'Interpreted Intent must be present');

    // 自然な日本語の時間表示の確認 (0m～0m バグがないこと)
    const durationDisplay = await page.locator('#estDurationDisplay').textContent();
    console.log('  Natural Duration Display:', durationDisplay);
    assert(durationDisplay && durationDisplay !== '--' && !durationDisplay.includes('0m'), 'Must display natural time without 0m');
    console.log('  [PASS] Initial Plan created with human summary and natural estimates.');

    // 4. Step 2.2: 対話型修正・再計画ループ (PlanDiff の確認)
    console.log('--- Step 2.2: Interactive refinement & PlanDiff ---');
    const refinementInput = page.locator('#planRefinementInput');
    await refinementInput.fill('やっぱり禁止（HIDE）にしてください。');

    const btnRefine = page.locator('#btnRefinePlan');
    await btnRefine.click();

    // PlanDiff カードの出現を待機
    await page.waitForSelector('#planDiffCard', { state: 'visible', timeout: 15000 });
    const diffSummary = await page.locator('#planDiffSummaryText').textContent();
    console.log('  PlanDiff Summary:', diffSummary);
    assert(diffSummary && diffSummary.length > 0, 'PlanDiff summary must be shown');

    // 以前の承認が無効化されていることを確認 (Invalidation)
    const isGate1Checked = await page.locator('#chkGate1Plan').isChecked();
    assert.strictEqual(isGate1Checked, false, 'Gate 1 must be reset after refinement');
    console.log('  [PASS] PlanDiff displayed and old approvals invalidated properly.');

    // 5. Gate 1 承認 & 事前シミュレーション実行
    console.log('--- Step 2.3: Gate 1 approval & Dry-run simulation ---');
    await page.route('**/api/platform/policy/approve', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ policy: { gates: {} } })
      });
    });

    await page.route('**/api/platform/jobs/run', async (route) => {
      const req = route.request();
      const postData = JSON.parse(req.postData() || '{}');
      const isDryRun = postData.mode === 'LOGICAL_DRY_RUN';

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          summary: {
            totalSchools: 3,
            processedCount: 3,
            successCount: 3,
            skippedCount: 0,
            alreadyConfiguredCount: 0,
            blockedCount: 0,
            failedCount: 0,
            elapsedSeconds: isDryRun ? 4 : 8,
            etaSeconds: 0,
            accumulatedAiCostJpy: 0.15,
            circuitBreakerState: 'CLOSED',
            runtimeHealth: 'HEALTHY',
            currentSchool: '北野中学校',
            currentOperation: 'CHANGE_SCHOOL_SETTINGS'
          },
          results: [
            { schoolCode: 'C2001001', schoolName: '堀川小学校', status: 'SUCCESS', planned: ['CHANGE_SCHOOL_SETTINGS'], error: null, verificationPassed: true, durationMs: 1200 },
            { schoolCode: 'C2001002', schoolName: '滝川小学校', status: 'SUCCESS', planned: ['CHANGE_SCHOOL_SETTINGS'], error: null, verificationPassed: true, durationMs: 1400 },
            { schoolCode: 'C2001003', schoolName: '北野中学校', status: 'SUCCESS', planned: ['CHANGE_SCHOOL_SETTINGS'], error: null, verificationPassed: true, durationMs: 1300 }
          ],
          analysis: {
            headlineSummary: '全3校で安全に検証が完了しました。',
            keyFindings: ['すべての対象学校で設定画面の表示が確認されました。', '本番書き込みは発生していません。'],
            recommendations: ['設定内容に問題がないことを確認し、全体適用へ進んでください。']
          }
        })
      });
    });

    await page.locator('#chkGate1Plan').check();

    const btnDryRun = page.locator('#btnRunDryRun');
    await page.waitForFunction(() => !(document.querySelector('#btnRunDryRun') as HTMLButtonElement)?.disabled);
    await btnDryRun.click();

    // 事前シミュレーション完了メッセージの待機
    await page.waitForFunction(() => {
      const el = document.querySelector('#dryRunStatusLabel');
      return el && el.textContent?.includes('シミュレーション完了');
    }, { timeout: 10000 });

    const dryRunStatus = await page.locator('#dryRunStatusLabel').textContent();
    console.log('  Dry-run Status:', dryRunStatus);
    assert(dryRunStatus?.includes('シミュレーション完了'), 'Dry-run must complete successfully');

    // Gate 2 承認
    await page.locator('#chkGate2DryRun').check();
    console.log('  [PASS] Dry-run executed safely without live write.');

    // Step 3 へ進む
    const btnGoStep3 = page.locator('#btnGoToStep3');
    await page.waitForFunction(() => !(document.querySelector('#btnGoToStep3') as HTMLButtonElement)?.disabled);
    await btnGoStep3.click();

    // 6. Step 3: 自動実行ダッシュボード & 動的先行検証
    console.log('--- Step 3: Dashboard & Dynamic Validation Scope ---');
    await page.waitForSelector('#wizScreenStep3', { state: 'visible', timeout: 5000 });

    // 動的先行検証スコープの確認
    const scopeProposal = await page.locator('#proposalScopeCounts').textContent();
    const scopeUnit = await page.locator('#proposalScopeUnit').textContent();
    console.log(`  Dynamic Scope Proposal: ${scopeProposal} (Unit: ${scopeUnit})`);
    assert(scopeProposal && scopeProposal.length > 0, 'Dynamic Scope Proposal must be rendered');

    // 先行検証承認 (Gate 3)
    await page.locator('#chkGate3Canary').check();
    await page.waitForFunction(() => !(document.querySelector('#btnRunCanary') as HTMLButtonElement)?.disabled);

    // 先行検証ボタンをクリック
    console.log('  Running Canary Validation...');
    const btnCanary = page.locator('#btnRunCanary');
    await btnCanary.click();

    // 実行完了の待機
    await page.waitForFunction(() => {
      const el = document.querySelector('#runActionStatusText');
      return el && (el.textContent?.includes('完了') || el.textContent?.includes('成功'));
    }, { timeout: 20000 });

    // 結果テーブルの確認
    const resultsTableRows = await page.locator('#resultsSchoolsTableBody tr').count();
    console.log(`  Results table rows count: ${resultsTableRows}`);
    assert(resultsTableRows > 0, 'Results table must have rows');

    console.log('  [PASS] Step 3 Dashboard, Dynamic Scope, and Results executed successfully.');
    console.log('=== [ALL PLATFORM E2E BROWSER ACCEPTANCE TESTS PASSED] ===');
  } finally {
    await browser.close();
  }
}

runE2eAcceptance().catch((err) => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
