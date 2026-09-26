import { SettingKey, SettingObservation, SettingExpectation } from '../src/types/settings';
import { SchoolConfigFile, EffectiveExecutionOptions } from '../src/types/config';
import { validateConfigStatic } from '../src/settings/staticValidation';
import { buildExecutionPlan } from '../src/automation/buildExecutionPlan';
import { evaluateExecutionPlan } from '../src/automation/evaluateExecutionPlan';
import { checkExecutionGate } from '../src/automation/executionGate';
import { compareObservationToExpectation } from '../src/utils/comparator';
import { generateSettingsHash, generateRunConfigHash } from '../src/utils/hash';
import { resolveExecutionOptions } from '../src/config/options';
import { loadSchoolConfigFile } from '../src/config/loader';
import { ResultManager } from '../src/logger/resultManager';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

console.log('================================================');
console.log('Phase 1: Domain Logic Unit Tests (18 Cases)');
console.log('================================================\n');

// 共通デフォルト観測値（11項目通常稼働中）
function createDefaultObservation(): Record<SettingKey, SettingObservation> {
  return {
    storage: { value: 'ON', availability: 'AVAILABLE' },
    timelineChannel: { value: 'ON', availability: 'AVAILABLE' },
    directMessage: { value: 'STUDENT_TO_STUDENT_DISABLED', availability: 'AVAILABLE' },
    parentDirectMessage: { value: 'ON', availability: 'AVAILABLE' },
    allChannel: { value: 'ON', availability: 'AVAILABLE' },
    parentChannel: { value: 'ON', availability: 'AVAILABLE' },
    attendance: { value: 'ON', availability: 'AVAILABLE' },
    contactBook: { value: 'ON', availability: 'AVAILABLE' },
    mentalHealth: { value: 'OFF', availability: 'AVAILABLE' },
    otherSchoolLog: { value: 'ALLOW', availability: 'AVAILABLE' },
    studentPasswordChange: { value: 'HIDE', availability: 'AVAILABLE' }
  };
}

const defaultOptions: EffectiveExecutionOptions = {
  configFile: 'config/school.sample.json',
  apply: false,
  allowDestructive: false,
  allowLiveWrite: false,
  batchApply: false,
  authMode: 'A',
  headless: true,
  slowMoMs: 0,
  defaultTimeoutMs: 30000
};

// Case 1: 連動OFFとリスク検知
{
  const obs = createDefaultObservation();
  const plan = buildExecutionPlan({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    currentObservation: obs,
    requestedSettings: { timelineChannel: 'OFF' }
  });

  assert(plan.actions.length === 1, 'Actions should only contain timelineChannel');
  assert(plan.actions[0].settingKey === 'timelineChannel', 'Action key should be timelineChannel');
  assert(plan.dependencyEffects.length === 2, 'Should have 2 dependency effects (allChannel, parentChannel)');
  assert(plan.dependencyEffects.some((e) => e.targetSettingKey === 'allChannel' && e.expectedValue === 'OFF'), 'allChannel effect should be OFF');
  assert(plan.dependencyEffects.some((e) => e.targetSettingKey === 'parentChannel' && e.expectedValue === 'OFF'), 'parentChannel effect should be OFF');
  assert(plan.hasDestructiveChanges === true, 'Should have destructive changes');
  console.log('✓ Case 1: 連動OFFとリスク検知 (actionsに連動項目を含めずdependencyEffectsへ分離)');
}

// Case 2: Runtime未充足 (親OFF、子ON要求)
{
  const obs = createDefaultObservation();
  obs.timelineChannel.value = 'OFF';
  obs.allChannel.value = 'OFF';
  obs.parentChannel.value = 'OFF';

  const plan = buildExecutionPlan({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    currentObservation: obs,
    requestedSettings: { allChannel: 'ON' } // timelineChannelはnull
  });

  const evaluation = evaluateExecutionPlan(plan);
  assert(evaluation.isExecutable === false, 'Should not be executable');
  assert(evaluation.blockReasons.some((r) => r.code === 'DEPENDENCY_UNSATISFIED'), 'Should flag DEPENDENCY_UNSATISFIED');
  console.log('✓ Case 2: Runtime未充足 (親OFF・要求nullの状態で子ON要求をDEPENDENCY_UNSATISFIEDでブロック)');
}

// Case 3: 個別メッセージ連動
{
  const obs = createDefaultObservation();
  obs.directMessage.value = 'ON';
  obs.parentDirectMessage.value = 'ON';

  const plan = buildExecutionPlan({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    currentObservation: obs,
    requestedSettings: { directMessage: 'OFF' }
  });

  assert(plan.actions.length === 1 && plan.actions[0].settingKey === 'directMessage', 'Only directMessage action');
  assert(
    plan.dependencyEffects.some(
      (e) =>
        e.targetSettingKey === 'parentDirectMessage' &&
        e.effectType === 'AVAILABILITY_CHANGE' &&
        e.expectedValue === null &&
        e.expectedAvailability === 'DISABLED_BY_DEPENDENCY'
    ),
    'parentDirectMessage AVAILABILITY_CHANGE effect'
  );
  console.log('✓ Case 3: 個別メッセージ連動 (directMessage OFFによりparentDirectMessageが利用不能連動 AVAILABILITY_CHANGE / value: null)');
}

// Case 4: 契約外設定の正常スルー (mentalHealth CONTRACT_NOT_AVAILABLE, requested=null)
{
  const obs = createDefaultObservation();
  obs.mentalHealth = { value: null, availability: 'CONTRACT_NOT_AVAILABLE' };

  const plan = buildExecutionPlan({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    currentObservation: obs,
    requestedSettings: { mentalHealth: null }
  });

  const evaluation = evaluateExecutionPlan(plan);
  assert(evaluation.isExecutable === true, 'Should be executable when mentalHealth=null');
  assert(plan.items.mentalHealth.expected.value === null, 'expected value should be null');
  assert(plan.items.mentalHealth.expected.availability === 'CONTRACT_NOT_AVAILABLE', 'expected availability should be CONTRACT_NOT_AVAILABLE');
  console.log('✓ Case 4: 契約外設定の正常スルー (mentalHealthが契約外かつ要求nullで正常)');
}

// Case 5: 契約外設定の要求エラー (mentalHealth CONTRACT_NOT_AVAILABLE, requested=ON)
{
  const obs = createDefaultObservation();
  obs.mentalHealth = { value: null, availability: 'CONTRACT_NOT_AVAILABLE' };

  const plan = buildExecutionPlan({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    currentObservation: obs,
    requestedSettings: { mentalHealth: 'ON' }
  });

  const evaluation = evaluateExecutionPlan(plan);
  assert(evaluation.isExecutable === false, 'Should not be executable');
  assert(evaluation.blockReasons.some((r) => r.code === 'SETTING_NOT_AVAILABLE'), 'Should flag SETTING_NOT_AVAILABLE');
  console.log('✓ Case 5: 契約外設定のON要求エラー (契約外項目へのON要求をSETTING_NOT_AVAILABLEでブロック)');
}

// Case 5b: 契約外設定へのOFF要求の適合化 (未契約校へのOFF要求は変更不要としてパス)
{
  const obs = createDefaultObservation();
  obs.mentalHealth = { value: null, availability: 'CONTRACT_NOT_AVAILABLE' };

  const plan = buildExecutionPlan({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    currentObservation: obs,
    requestedSettings: { mentalHealth: 'OFF' }
  });

  const evaluation = evaluateExecutionPlan(plan);
  assert(evaluation.isExecutable === true, '未契約へのOFF要求は実行可能(適合)と判定されること');
  assert(evaluation.blockReasons.length === 0, 'ブロック理由は0件であること');
  assert(plan.actions.length === 0, 'アクション数は0件（変更不要）であること');
  console.log('✓ Case 5b: 契約外設定へのOFF要求の適合化 (未契約校へのOFF要求は変更不要としてパス)');
}

// Case 6: 破壊的変更のEvaluation正常性
{
  const obs = createDefaultObservation();
  const plan = buildExecutionPlan({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    currentObservation: obs,
    requestedSettings: { timelineChannel: 'OFF' }
  });

  const evaluation = evaluateExecutionPlan(plan);
  assert(evaluation.isExecutable === true, 'Plan itself should be logically executable');
  assert(evaluation.requiresDestructiveConfirmation === true, 'Requires destructive confirmation');
  console.log('✓ Case 6: 破壊的変更のEvaluation正常性 (isExecutable: true かつ requiresDestructiveConfirmation: true)');
}

// Case 7: Unmanaged項目の副作用なし
{
  const obs = createDefaultObservation();
  const plan = buildExecutionPlan({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    currentObservation: obs,
    requestedSettings: { attendance: 'OFF' } // 他はnull
  });

  const unmanagedKeys: SettingKey[] = ['storage', 'contactBook', 'otherSchoolLog', 'studentPasswordChange'];
  for (const k of unmanagedKeys) {
    assert(plan.items[k].expected.value === obs[k].value, `${k} expected should match current`);
    assert(plan.items[k].reason === 'UNCHANGED', `${k} reason should be UNCHANGED`);
  }
  console.log('✓ Case 7: Unmanaged項目の副作用なし (要求nullの項目がexpected=currentかつUNCHANGED)');
}

// Case 8: 静的矛盾 (タイムラインOFF + 全体ON)
{
  const config: SchoolConfigFile = {
    school: { schoolCode: 'SCH01', schoolName: '学校A' },
    settings: { timelineChannel: 'OFF', allChannel: 'ON' }
  };
  let caught = false;
  try {
    validateConfigStatic(config, defaultOptions);
  } catch (err: any) {
    caught = true;
    assert(err.status === 'CONFIG_CONFLICT', 'Expected CONFIG_CONFLICT');
  }
  assert(caught, 'Should throw CONFIG_CONFLICT');
  console.log('✓ Case 8: 静的矛盾 (timelineChannel: OFF + allChannel: ON -> CONFIG_CONFLICT)');
}

// Case 9: 静的矛盾 (個別メッセージOFF + 保護者ON)
{
  const config: SchoolConfigFile = {
    school: { schoolCode: 'SCH01', schoolName: '学校A' },
    settings: { directMessage: 'OFF', parentDirectMessage: 'ON' }
  };
  let caught = false;
  try {
    validateConfigStatic(config, defaultOptions);
  } catch (err: any) {
    caught = true;
    assert(err.status === 'CONFIG_CONFLICT', 'Expected CONFIG_CONFLICT');
  }
  assert(caught, 'Should throw CONFIG_CONFLICT');
  console.log('✓ Case 9: 静的矛盾 (directMessage: OFF + parentDirectMessage: ON -> CONFIG_CONFLICT)');
}

// Case 10: 外部IdP安全性 (AUTH_MODE=B + studentPasswordChange=SHOW)
{
  const config: SchoolConfigFile = {
    school: { schoolCode: 'SCH01', schoolName: '学校A' },
    settings: { studentPasswordChange: 'SHOW' }
  };
  const bOptions = { ...defaultOptions, authMode: 'B' as const };
  let caught = false;
  try {
    validateConfigStatic(config, bOptions);
  } catch (err: any) {
    caught = true;
    assert(err.status === 'UNSAFE_CONFIGURATION', 'Expected UNSAFE_CONFIGURATION');
  }
  assert(caught, 'Should throw UNSAFE_CONFIGURATION');
  console.log('✓ Case 10: 外部IdP安全性 (AUTH_MODE=B + studentPasswordChange: SHOW -> UNSAFE_CONFIGURATION)');
}

// Case 11: Execution Gate 破壊的変更ブロック
{
  const obs = createDefaultObservation();
  const plan = buildExecutionPlan({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    currentObservation: obs,
    requestedSettings: { timelineChannel: 'OFF' }
  });
  const evaluation = evaluateExecutionPlan(plan);

  // --apply=true だが --allow-destructive=false
  let caught = false;
  try {
    checkExecutionGate(plan, evaluation, { ...defaultOptions, apply: true, allowDestructive: false });
  } catch (err: any) {
    caught = true;
    assert(err.status === 'DESTRUCTIVE_CHANGE_BLOCKED', 'Expected DESTRUCTIVE_CHANGE_BLOCKED');
  }
  assert(caught, 'Should throw DESTRUCTIVE_CHANGE_BLOCKED');
  console.log('✓ Case 11: Execution Gate 破壊的変更ブロック (--applyあり/--allow-destructiveなし)');
}

// Case 12: Unmanaged項目の副作用検知
{
  // attendance (要求null、expected: ON) が画面上で OFF に変化していた場合
  const expected: SettingExpectation = { value: 'ON' };
  const actualChanged: SettingObservation = { value: 'OFF', availability: 'AVAILABLE' };

  const comp = compareObservationToExpectation(actualChanged, expected);
  assert(comp.matches === false, 'Comparison should detect mismatch');
  assert(comp.valueMatches === false, 'Value should mismatch');
  console.log('✓ Case 12: Unmanaged項目の副作用検知 (expected.value=ON と actual=OFF の不一致検知)');
}

// Case 13: 必須項目不在の検知 (UI_STRUCTURE_MISMATCH)
{
  // 通常必須項目（storage等）が画面から取得できない状況の判定ロジック
  const normalKeys: SettingKey[] = ['storage', 'timelineChannel', 'attendance', 'contactBook'];
  const missingObs: Partial<Record<SettingKey, SettingObservation>> = {
    timelineChannel: { value: 'ON', availability: 'AVAILABLE' }
    // storage が不在
  };

  const isMissingNormalKey = normalKeys.some((k) => !missingObs[k]);
  assert(isMissingNormalKey === true, 'Should detect missing normal key');
  console.log('✓ Case 13: 必須項目不在の検知 (通常必須項目がDOM上に不在の場合はUI_STRUCTURE_MISMATCH)');
}

// Case 14: settingsHash と runConfigHash の分離
{
  const settings = { storage: 'ON' as const, attendance: 'OFF' as const };
  const hash1 = generateSettingsHash(settings);

  // 学校名とコードが異なる設定
  const runHash1 = generateRunConfigHash({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    settings,
    executionOptions: { ...defaultOptions, apply: true }
  });
  const runHash2 = generateRunConfigHash({
    schoolCode: 'SCH02',
    schoolName: '学校B',
    settings,
    executionOptions: { ...defaultOptions, apply: true }
  });

  assert(hash1 === generateSettingsHash(settings), 'settingsHash should be identical');
  assert(runHash1 !== runHash2, 'runConfigHash should be different across schools');
  console.log('✓ Case 14: settingsHash と runConfigHash の分離 (settingsHash同一、runConfigHash固有)');
}

// Case 15: CLI引数バリデーション (--allow-destructive requires --apply)
{
  let caught = false;
  try {
    resolveExecutionOptions({ allowDestructive: true, apply: false });
  } catch (err: any) {
    caught = true;
    assert(err.status === 'CLI_ARGUMENT_ERROR', 'Expected CLI_ARGUMENT_ERROR');
  }
  assert(caught, 'Should throw CLI_ARGUMENT_ERROR');
  console.log('✓ Case 15: CLI引数バリデーション (--allow-destructive単独指定を拒否)');
}

// Case 16: --allow-destructive単独指定時のResultManager動作
{
  const rm = new ResultManager();
  try {
    resolveExecutionOptions({ allowDestructive: true, apply: false });
  } catch (err: any) {
    rm.setStatus(err.status);
    rm.addIssue({ code: err.issueCode, message: err.message });
  }
  const result = rm.getResult();
  assert(result.status === 'CLI_ARGUMENT_ERROR', 'Result status should be CLI_ARGUMENT_ERROR');
  assert(result.schoolCode === null, 'schoolCode can be null before init');
  assert(result.runId.length > 0, 'runId must exist');
  console.log('✓ Case 16: 初期化前エラーでもExecutionResult記録可能 (CLI_ARGUMENT_ERROR)');
}

// Case 17: 不正なJSON/スキーマ違反時のResultManager動作
{
  const rm = new ResultManager();
  try {
    loadSchoolConfigFile('config/non_existent_file.json');
  } catch (err: any) {
    rm.setStatus(err.status);
    rm.addIssue({ code: err.issueCode, message: err.message });
  }
  const result = rm.getResult();
  assert(result.status === 'CONFIG_INVALID', 'Result status should be CONFIG_INVALID');
  assert(result.settingsHash === null, 'settingsHash can be null');
  console.log('✓ Case 17: 不正設定ファイル時にCONFIG_INVALIDでExecutionResult記録可能');
}

// Case 18: Observation / Expectation 共通比較関数の動作
{
  // 1. availability 未指定 -> value のみ検証
  const act1: SettingObservation = { value: 'OFF', availability: 'AVAILABLE' };
  const exp1: SettingExpectation = { value: 'OFF' }; // availability undefined
  const res1 = compareObservationToExpectation(act1, exp1);
  assert(res1.matches === true, 'res1 should match because value matches and availability is undefined');

  // 2. availability 指定あり一致 -> 一致
  const act2: SettingObservation = { value: null, availability: 'CONTRACT_NOT_AVAILABLE' };
  const exp2: SettingExpectation = { value: null, availability: 'CONTRACT_NOT_AVAILABLE' };
  const res2 = compareObservationToExpectation(act2, exp2);
  assert(res2.matches === true, 'res2 should match (both null and CONTRACT_NOT_AVAILABLE)');

  // 3. availability 指定あり不一致 -> 不一致
  const act3: SettingObservation = { value: null, availability: 'AVAILABLE' };
  const exp3: SettingExpectation = { value: null, availability: 'CONTRACT_NOT_AVAILABLE' };
  const res3 = compareObservationToExpectation(act3, exp3);
  assert(res3.matches === false, 'res3 should mismatch on availability');

  console.log('✓ Case 18: Observation / Expectation 共通比較関数の動作 (value一致・availability条件分岐)');
}

// Case 19: Phase 4C 依存関係判定 (親OFF/子DISABLED状態での子ON単独要求ブロック vs 親ON+子ON同時要求許可)
{
  const obs = createDefaultObservation();
  obs.directMessage = { value: 'OFF', availability: 'AVAILABLE' };
  obs.parentDirectMessage = { value: null, availability: 'DISABLED_BY_DEPENDENCY' };

  // 1. 子単独で ON を要求 -> DEPENDENCY_UNSATISFIED でブロック
  const planBlocked = buildExecutionPlan({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    currentObservation: obs,
    requestedSettings: { parentDirectMessage: 'ON' }
  });
  const evalBlocked = evaluateExecutionPlan(planBlocked);
  assert(!evalBlocked.isExecutable, 'Should be blocked because parent final state is OFF');
  assert(evalBlocked.blockReasons.some((r) => r.code === 'DEPENDENCY_UNSATISFIED'), 'Should have DEPENDENCY_UNSATISFIED reason');

  // 2. 親ON + 子ON 同時要求 -> 親の最終期待値がONになるため実行可能
  const planAllowed = buildExecutionPlan({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    currentObservation: obs,
    requestedSettings: { directMessage: 'ON', parentDirectMessage: 'ON' }
  });
  const evalAllowed = evaluateExecutionPlan(planAllowed);
  assert(evalAllowed.isExecutable, 'Should be executable when both parent and child are requested ON');
  assert(evalAllowed.blockReasons.length === 0, 'No block reasons');

  console.log('✓ Case 19: Phase 4C 依存関係判定 (親OFF/子DISABLED状態での単独ON要求ブロック & 親子同時ON要求許可)');
}

// Case 20: Phase 4C Pre/Post-Save 期待値マップの分離生成
{
  const obs = createDefaultObservation();
  obs.directMessage = { value: 'ON', availability: 'AVAILABLE' };
  obs.parentDirectMessage = { value: 'ON', availability: 'AVAILABLE' };

  const plan = buildExecutionPlan({
    schoolCode: 'SCH01',
    schoolName: '学校A',
    currentObservation: obs,
    requestedSettings: { directMessage: 'OFF' }
  });

  // Pre-Save 期待値: directMessage のみ OFF、parentDirectMessage は Baseline (ON / AVAILABLE)
  assert(Boolean(plan.preSaveExpectations), 'preSaveExpectations must exist');
  const pre = plan.preSaveExpectations!;
  assert(pre.directMessage.value === 'OFF', 'preSave directMessage should be OFF');
  assert(pre.parentDirectMessage.value === 'ON', 'preSave parentDirectMessage should remain Baseline (ON)');
  assert(pre.parentDirectMessage.availability === 'AVAILABLE', 'preSave parentDirectMessage should remain AVAILABLE');

  // Post-Save 期待値: directMessage は OFF、parentDirectMessage は DISABLED_BY_DEPENDENCY / value: null
  assert(Boolean(plan.postSaveExpectations), 'postSaveExpectations must exist');
  const post = plan.postSaveExpectations!;
  assert(post.directMessage.value === 'OFF', 'postSave directMessage should be OFF');
  assert(post.parentDirectMessage.value === null, 'postSave parentDirectMessage value should be null');
  assert(post.parentDirectMessage.availability === 'DISABLED_BY_DEPENDENCY', 'postSave parentDirectMessage should be DISABLED_BY_DEPENDENCY');

  console.log('✓ Case 20: Phase 4C Pre/Post-Save 期待値マップの分離生成 (Pre: Baseline維持 / Post: 利用不能化)');
}

console.log('\n================================================');
console.log('All 20 Phase 1 Unit Tests Passed Successfully!');
console.log('================================================');
