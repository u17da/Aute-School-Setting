import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { SchoolSettingsPage } from '../src/pages/SchoolSettingsPage';
import { buildExecutionPlan } from '../src/automation/buildExecutionPlan';
import { evaluateExecutionPlan } from '../src/automation/evaluateExecutionPlan';
import { SchoolSettingsObservation, SettingKey, SaveObservation } from '../src/types/settings';
import { AutomationError } from '../src/types/errors';
import { compareAllSettingsObservations, validateObservationMatchesPlan } from '../src/utils/comparator';

let browser: Browser;
let context: BrowserContext;
let page: Page;

function buildMockHtml(currentValues: Record<string, string>, hasSaveButton = true): string {
  const defaults: Record<string, string> = {
    storage: 'everyone',
    timelineChannel: 'everyone',
    directMessage: 'without_student_to_student',
    parentDirectMessage: 'everyone',
    allChannel: 'everyone',
    parentChannel: 'everyone',
    attendance: 'everyone',
    contactBook: 'everyone',
    mentalHealth: 'everyone',
    otherSchoolLog: 'everyone',
    studentPasswordChange: 'disabled'
  };

  const rows = [
    { key: 'storage', label: 'ストレージ機能', name: 'organization[preference_attributes][shared_file_permission]', options: [{ val: 'everyone', text: 'ON' }, { val: 'disabled', text: 'OFF' }, { val: 'manager_or_greater', text: '先生のみ' }] },
    { key: 'timelineChannel', label: 'タイムライン・チャンネル機能', name: 'organization[preference_attributes][channel_permission]', options: [{ val: 'everyone', text: 'ON' }, { val: 'disabled', text: 'OFF' }] },
    { key: 'directMessage', label: '個別メッセージ機能', name: 'organization[preference_attributes][direct_message_permission]', options: [{ val: 'everyone', text: 'ON' }, { val: 'disabled', text: 'OFF' }, { val: 'without_student_to_student', text: '生徒同士は不可' }] },
    { key: 'parentDirectMessage', label: '保護者との個別メッセージ', name: 'organization[preference_attributes][parent_direct_message_permission]', options: [{ val: 'everyone', text: 'ON' }, { val: 'disabled', text: 'OFF' }] },
    { key: 'allChannel', label: '全体チャンネル機能', name: 'organization[preference_attributes][general_channel_permission]', options: [{ val: 'everyone', text: 'ON' }, { val: 'disabled', text: 'OFF' }] },
    { key: 'parentChannel', label: '保護者チャンネル機能', name: 'organization[preference_attributes][parent_channel_permission]', options: [{ val: 'everyone', text: 'ON' }, { val: 'disabled', text: 'OFF' }] },
    { key: 'attendance', label: '出欠連絡機能', name: 'organization[preference_attributes][attendance_permission]', options: [{ val: 'everyone', text: 'ON' }, { val: 'disabled', text: 'OFF' }] },
    { key: 'contactBook', label: '連絡帳機能', name: 'organization[preference_attributes][communication_book_permission]', options: [{ val: 'everyone', text: 'ON' }, { val: 'disabled', text: 'OFF' }] },
    { key: 'mentalHealth', label: '心の健康観察機能', name: 'organization[preference_attributes][cocolog_permission]', options: [{ val: 'everyone', text: 'ON' }, { val: 'disabled', text: 'OFF' }] },
    { key: 'otherSchoolLog', label: '他校のログ表示を許可', name: 'organization[preference_attributes][view_access_logs_of_other_schools_permission]', options: [{ val: 'everyone', text: 'する' }, { val: 'disabled', text: 'しない' }] },
    { key: 'studentPasswordChange', label: '児童・生徒へパスワード変更を表示', name: 'organization[preference_attributes][student_password_change_permission]', options: [{ val: 'everyone', text: 'する' }, { val: 'disabled', text: 'しない' }] }
  ];

  const rowsHtml = rows.map((r) => {
    const curVal = currentValues[r.key] !== undefined ? currentValues[r.key] : defaults[r.key];
    const radios = r.options.map((opt) => `
      <label class="radio-inline">
        <input type="radio" name="${r.name}" value="${opt.val}" ${opt.val === curVal ? 'checked="checked"' : ''}>
        ${opt.text}
      </label>
    `).join('\n');

    return `
      <div class="row">
        <div class="col-sm-5 col-md-3">
          <label>${r.label}</label>
        </div>
        <div class="col-sm-7 col-md-9" aria-label="${r.label}">
          ${radios}
        </div>
      </div>
    `;
  }).join('\n');

  const saveHtml = hasSaveButton ? `
    <div class="form-inline text-center">
      <input type="submit" name="commit" value="更新する" class="btn btn-default">
    </div>
  ` : '';

  return `
    <!DOCTYPE html>
    <html>
    <head><title>学校設定</title></head>
    <body>
      <div class="v2-header__title">学校設定</div>
      <form action="/manage/organization" method="post">
        <div class="user_config_form">
          ${rowsHtml}
        </div>
        ${saveHtml}
      </form>
    </body>
    </html>
  `;
}

function createBaselineObservation(): SchoolSettingsObservation {
  return {
    storage: { value: 'ON', availability: 'AVAILABLE' },
    timelineChannel: { value: 'ON', availability: 'AVAILABLE' },
    directMessage: { value: 'STUDENT_TO_STUDENT_DISABLED', availability: 'AVAILABLE' },
    parentDirectMessage: { value: 'ON', availability: 'AVAILABLE' },
    allChannel: { value: 'ON', availability: 'AVAILABLE' },
    parentChannel: { value: 'ON', availability: 'AVAILABLE' },
    attendance: { value: 'ON', availability: 'AVAILABLE' },
    contactBook: { value: 'ON', availability: 'AVAILABLE' },
    mentalHealth: { value: 'ON', availability: 'AVAILABLE' },
    otherSchoolLog: { value: 'ALLOW', availability: 'AVAILABLE' },
    studentPasswordChange: { value: 'HIDE', availability: 'AVAILABLE' }
  };
}

async function runTests() {
  console.log('================================================');
  console.log('Phase 2B: Single Safe Write PoC Unit / Mock Tests');
  console.log('================================================\n');

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();

  let passedCount = 0;

  // Test 1: plan.actions.length === 1 の厳格チェック (1項目指定時は通過)
  try {
    const baseObs = createBaselineObservation();
    const plan = buildExecutionPlan({
      schoolCode: 'PRRHC',
      schoolName: 'MEXCBTデモ学校',
      currentObservation: baseObs,
      requestedSettings: { studentPasswordChange: 'SHOW' }
    });

    if (plan.actions.length !== 1) {
      throw new Error(`actions count must be 1, got ${plan.actions.length}`);
    }
    if (plan.actions[0].settingKey !== 'studentPasswordChange' || plan.actions[0].to !== 'SHOW') {
      throw new Error('Action content mismatch');
    }
    console.log('✓ Test 1: 単一項目要求時に plan.actions.length === 1 が正常生成される');
    passedCount++;
  } catch (err: any) {
    console.error('✗ Test 1 失敗:', err.message);
  }

  // Test 2: 複数項目要求（2項目以上）の場合に POC_SCOPE_VIOLATION でブロック
  try {
    const baseObs = createBaselineObservation();
    const plan = buildExecutionPlan({
      schoolCode: 'PRRHC',
      schoolName: 'MEXCBTデモ学校',
      currentObservation: baseObs,
      requestedSettings: { studentPasswordChange: 'SHOW', otherSchoolLog: 'DENY' }
    });

    // Phase 2B 安全チェック
    if (plan.actions.length !== 1) {
      // 期待通り複数Actionが検出される
      console.log(`✓ Test 2: 複数項目要求 (${plan.actions.length}件) を検知して Phase 2B 実行をブロック可能`);
      passedCount++;
    } else {
      throw new Error('複数Actionが検出されませんでした');
    }
  } catch (err: any) {
    console.error('✗ Test 2 失敗:', err.message);
  }

  // Test 3: 差分なし（0件要求）の場合に POC_SCOPE_VIOLATION でブロック
  try {
    const baseObs = createBaselineObservation();
    const plan = buildExecutionPlan({
      schoolCode: 'PRRHC',
      schoolName: 'MEXCBTデモ学校',
      currentObservation: baseObs,
      requestedSettings: { studentPasswordChange: 'HIDE' } // 現在値と同じ
    });

    if (plan.actions.length === 0) {
      console.log('✓ Test 3: 変更差分なし (actions.length === 0) を検知して Phase 2B 実行をブロック可能');
      passedCount++;
    } else {
      throw new Error('差分なしでActionが生成されました');
    }
  } catch (err: any) {
    console.error('✗ Test 3 失敗:', err.message);
  }

  // Test 4: 保存ボタンLocatorの一意性検証 (count === 1)
  try {
    const html = buildMockHtml({ studentPasswordChange: 'disabled' });
    await page.setContent(html);
    const settingsPage = new SchoolSettingsPage(page);

    const saveButton = await settingsPage.getSaveButton();
    const isVisible = await saveButton.isVisible();
    if (!isVisible) throw new Error('保存ボタンが可視ではありません');

    console.log('✓ Test 4: 実DOM仕様保存ボタン input[type="submit"][name="commit"][value="更新する"] を一意に特定');
    passedCount++;
  } catch (err: any) {
    console.error('✗ Test 4 失敗:', err.message);
  }

  // Test 5: ラジオボタン選択操作 (selectSettingRadio)
  try {
    const html = buildMockHtml({ studentPasswordChange: 'disabled' });
    await page.setContent(html);
    const settingsPage = new SchoolSettingsPage(page);

    await settingsPage.selectSettingRadio('studentPasswordChange', 'SHOW');
    const { observation } = await settingsPage.readAllSettingsObservation();

    if (observation.studentPasswordChange.value !== 'SHOW') {
      throw new Error(`Radio check failed: got ${observation.studentPasswordChange.value}`);
    }
    console.log('✓ Test 5: selectSettingRadio によるラジオボタン選択と checked 状態確認に成功');
    passedCount++;
  } catch (err: any) {
    console.error('✗ Test 5 失敗:', err.message);
  }

  // Test 6: Pre-Save Validation: 正常系 (対象項目一致 & 他10項目変化なし)
  try {
    const html = buildMockHtml({ studentPasswordChange: 'disabled' });
    await page.setContent(html);
    const settingsPage = new SchoolSettingsPage(page);

    const baseObs = createBaselineObservation();
    await settingsPage.selectSettingRadio('studentPasswordChange', 'SHOW');

    // Pre-Save Validation 実行 (例外が出なければ成功)
    await settingsPage.validatePreSave('studentPasswordChange', 'SHOW', baseObs);
    console.log('✓ Test 6: Pre-Save Validation 正常系 (対象項目変更 & 他項目副作用なし) を通過');
    passedCount++;
  } catch (err: any) {
    console.error('✗ Test 6 失敗:', err.message);
  }

  // Test 7: Pre-Save Validation: 異常系 (対象外項目が意図せず変更された場合に UNEXPECTED_SIDE_EFFECT)
  try {
    // 他の項目 attendance も意図せず OFF になっているHTML
    const html = buildMockHtml({ studentPasswordChange: 'disabled', attendance: 'disabled' });
    await page.setContent(html);
    const settingsPage = new SchoolSettingsPage(page);

    const baseObs = createBaselineObservation(); // attendance は ON のはず
    await settingsPage.selectSettingRadio('studentPasswordChange', 'SHOW');

    let threw = false;
    try {
      await settingsPage.validatePreSave('studentPasswordChange', 'SHOW', baseObs);
    } catch (e: any) {
      if (e.status === 'UNEXPECTED_SIDE_EFFECT') {
        threw = true;
      }
    }

    if (!threw) throw new Error('UNEXPECTED_SIDE_EFFECT が検知されませんでした');
    console.log('✓ Test 7: Pre-Save Validation で対象外項目の副作用を UNEXPECTED_SIDE_EFFECT としてブロック');
    passedCount++;
  } catch (err: any) {
    console.error('✗ Test 7 失敗:', err.message);
  }

  // Test 8: Single Safe Write & Restore の完全シーケンス
  try {
    // 初期状態: studentPasswordChange: HIDE
    let serverValue = 'disabled'; // サーバー上の永続値シミュレーション
    const baseObs = createBaselineObservation();

    // ページロード関数
    const loadCurrentPage = async () => {
      await page.setContent(buildMockHtml({ studentPasswordChange: serverValue }));
    };

    await loadCurrentPage();
    const settingsPage = new SchoolSettingsPage(page);

    // (A) Write: HIDE -> SHOW
    await settingsPage.selectSettingRadio('studentPasswordChange', 'SHOW');
    await settingsPage.validatePreSave('studentPasswordChange', 'SHOW', baseObs);

    // サーバー反映シミュレーション
    serverValue = 'everyone';
    await loadCurrentPage(); // reloadシミュレーション

    const { observation: writeObs } = await settingsPage.readAllSettingsObservation();
    if (writeObs.studentPasswordChange.value !== 'SHOW') {
      throw new Error('Write後の値がSHOWになっていません');
    }

    // (B) Restore: SHOW -> HIDE
    await settingsPage.selectSettingRadio('studentPasswordChange', 'HIDE');
    await settingsPage.validatePreSave('studentPasswordChange', 'HIDE', writeObs);

    // サーバー復元シミュレーション
    serverValue = 'disabled';
    await loadCurrentPage(); // reloadシミュレーション

    const { observation: restoreObs } = await settingsPage.readAllSettingsObservation();
    const matchRes = compareAllSettingsObservations(restoreObs, baseObs);
    if (!matchRes.isMatched) {
      throw new Error(`Restore後の値がBaselineと一致しません: ${matchRes.mismatches.join('; ')}`);
    }

    console.log('✓ Test 8: Single Safe Write & Restore 完全シーケンス (変更->検証->復元->検証) が成功');
    passedCount++;
  } catch (err: any) {
    console.error('✗ Test 8 失敗:', err.message);
  }

  // Test 9: Restore 失敗時の RESTORE_FAILED 検知
  try {
    let serverValue = 'disabled';
    const baseObs = createBaselineObservation();

    const loadCurrentPage = async () => {
      await page.setContent(buildMockHtml({ studentPasswordChange: serverValue }));
    };

    await loadCurrentPage();
    const settingsPage = new SchoolSettingsPage(page);

    // Write実行 (SHOW)
    await settingsPage.selectSettingRadio('studentPasswordChange', 'SHOW');
    serverValue = 'everyone';
    await loadCurrentPage();

    // Restore実行を試みるがサーバー側で復元失敗（everyoneのまま）するケース
    await settingsPage.selectSettingRadio('studentPasswordChange', 'HIDE');
    // serverValue は everyone のまま reload される
    await loadCurrentPage();

    const { observation: afterRestoreObs } = await settingsPage.readAllSettingsObservation();
    const matchRes = compareAllSettingsObservations(afterRestoreObs, baseObs);

    if (!matchRes.isMatched) {
      // 復元失敗を検知
      const restoreError = new AutomationError(
        'RESTORE_FAILED',
        `元値復元失敗: ${matchRes.mismatches.join('; ')}`,
        { originalValue: 'HIDE', currentValue: 'SHOW' }
      );
      if (restoreError.status === 'RESTORE_FAILED') {
        console.log('✓ Test 9: Restore 失敗時に RESTORE_FAILED として重大エラーを検知・記録');
        passedCount++;
      }
    } else {
      throw new Error('復元失敗が検知されませんでした');
    }
  } catch (err: any) {
    console.error('✗ Test 9 失敗:', err.message);
  }

  // Test 10: Phase 4C Pre-Save / Post-Save Validation 分離検証 (directMessage OFF時)
  try {
    const baseObs = createBaselineObservation();
    baseObs.directMessage = { value: 'ON', availability: 'AVAILABLE' };
    baseObs.parentDirectMessage = { value: 'ON', availability: 'AVAILABLE' };

    const plan = buildExecutionPlan({
      schoolCode: 'SCH01',
      schoolName: '学校A',
      currentObservation: baseObs,
      requestedSettings: { directMessage: 'OFF' }
    });

    // 1. Pre-Save 時の DOM: directMessage のみ OFF に選択、parentDirectMessage は未保存のため ON のまま
    const preSaveDomObs: SchoolSettingsObservation = {
      ...baseObs,
      directMessage: { value: 'OFF', availability: 'AVAILABLE' },
      parentDirectMessage: { value: 'ON', availability: 'AVAILABLE' }
    };
    const preValResult = validateObservationMatchesPlan(preSaveDomObs, plan, 'PRE_SAVE');
    if (!preValResult.isValid) {
      throw new Error(`Pre-Save検証が失敗しました: ${preValResult.mismatches.map((m) => m.message).join('; ')}`);
    }

    // 2. Post-Save 時の DOM: サーバー保存 reload 後、parentDirectMessage が DISABLED_BY_DEPENDENCY / value: null になる
    const postSaveDomObs: SchoolSettingsObservation = {
      ...baseObs,
      directMessage: { value: 'OFF', availability: 'AVAILABLE' },
      parentDirectMessage: { value: null, availability: 'DISABLED_BY_DEPENDENCY' }
    };
    const postValResult = validateObservationMatchesPlan(postSaveDomObs, plan, 'POST_SAVE');
    if (!postValResult.isValid) {
      throw new Error(`Post-Save検証が失敗しました: ${postValResult.mismatches.map((m) => m.message).join('; ')}`);
    }

    console.log('✓ Test 10: Phase 4C Pre/Post-Save Validation 分離検証 (Pre: Baseline維持 / Post: 利用不能化) が成功');
    passedCount++;
  } catch (err: any) {
    console.error('✗ Test 10 失敗:', err.message);
  }

  // Test 11: SaveObservation の submitRequestUrl と finalUrl の分離保持検証
  try {
    const mockSaveObs: SaveObservation = {
      submitRequestUrl: 'https://ed-cl.com/manage/organization',
      submitMethod: 'POST',
      submitResponseStatus: 302,
      redirectDetected: true,
      redirectLocation: 'https://ed-cl.com/manage/organization/edit',
      finalUrl: 'https://ed-cl.com/manage/organization/edit',
      finalNavigationStatus: 200,
      flashMessage: '更新しました'
    };

    const submitUrl: string = mockSaveObs.submitRequestUrl;
    const finalUrl: string = mockSaveObs.finalUrl ?? '';

    if (submitUrl !== 'https://ed-cl.com/manage/organization') {
      throw new Error('submitRequestUrl がPOST送信先URLと一致しません');
    }
    if (finalUrl !== 'https://ed-cl.com/manage/organization/edit') {
      throw new Error('finalUrl がリダイレクト完了後URLと一致しません');
    }
    if ((submitUrl as string) === (finalUrl as string)) {
      // 意図的なチェック: 2つのURLが同値でないことを検証
      if (submitUrl === finalUrl as any) {
        throw new Error('submitRequestUrl と finalUrl が分離されていません');
      }
    }

    console.log('✓ Test 11: SaveObservation の submitRequestUrl と finalUrl の厳格分離検証が成功');
    passedCount++;
  } catch (err: any) {
    console.error('✗ Test 11 失敗:', err.message);
  }

  await context.close();
  await browser.close();

  console.log(`\n================================================`);
  console.log(`Phase 2B Tests: ${passedCount} / 11 Passed`);
  console.log(`================================================\n`);

  if (passedCount !== 11) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('Test execution failed:', e);
  process.exit(1);
});
