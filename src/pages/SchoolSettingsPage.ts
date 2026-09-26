import { Page, Locator } from 'playwright';
import { BasePage } from './BasePage';
import { SettingKey, SettingValue, SettingObservation, SchoolSettingsObservation, SaveObservation } from '../types/settings';
import { ExecutionPlan, PlanAction } from '../types/plan';
import { SETTING_DEFINITIONS, ALL_SETTING_KEYS, labelToValue } from '../settings/definitions';
import { getParentDependencyRule } from '../settings/dependencies';
import { AutomationError } from '../types/errors';
import { logger } from '../logger/logger';
import { compareAllSettingsObservations, validateObservationMatchesPlan } from '../utils/comparator';
import { WritePhase } from '../types/batch';

export interface RadioInspectionDetail {
  label: string;
  value: SettingValue | null;
  checked: boolean;
  disabled: boolean;
  visible: boolean;
  locator: Locator;
}

export interface RowInspectionResult {
  settingKey: SettingKey;
  label: string;
  containerTag: string;
  containerClass: string;
  containerLocator: Locator;
  radios: RadioInspectionDetail[];
}

export class SchoolSettingsPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * 学校設定画面がロードされていることを確認
   */
  async verifyPageLoaded(): Promise<void> {
    const heading = this.page.locator(
      '.v2-header__title:has-text("学校設定"), h1:has-text("学校設定"), h2:has-text("学校設定"), .page-title:has-text("学校設定"), header:has-text("学校設定")'
    ).first();
    try {
      await heading.waitFor({ state: 'visible', timeout: 15000 });
      logger.info('「学校設定」画面のロードを確認しました');
    } catch {
      const currentUrl = this.page.url();
      const pageTitle = await this.page.title().catch(() => '');
      const bodyText = (await this.page.innerText('body').catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
      logger.error(`[SETTINGS_PAGE_NOT_FOUND] 現在のURL="${currentUrl}", タイトル="${pageTitle}", 画面テキスト冒頭="${bodyText}"`);

      // 調査用スクリーンショット保存
      try {
        const ssPath = `screenshots/settings_page_not_found_${Date.now()}.png`;
        await this.page.screenshot({ path: ssPath, fullPage: true });
        logger.info(`診断用スクリーンショット保存: ${ssPath}`);
      } catch {}

      throw new AutomationError(
        'SETTINGS_PAGE_NOT_FOUND',
        `学校設定画面の見出し（.v2-header__title / h1 / h2等）が確認できませんでした (URL: ${currentUrl}, Title: ${pageTitle}, Text: ${bodyText.slice(0, 100)})`
      );
    }
  }

  /**
   * 単一の設定項目について、画面上の専用コンテナを特定し、ラジオボタングループを検査する
   */
  async inspectSettingRow(key: SettingKey): Promise<RowInspectionResult | null> {
    const def = SETTING_DEFINITIONS[key];

    // ラベルによる特定: text="表示名" または :text-is("表示名")
    const labelCandidates = this.page.locator(`text="${def.label}"`);
    const count = await labelCandidates.count();

    if (count === 0) {
      // 契約外で非表示の可能性がある mentalHealth
      if (def.isOptionalInContract) {
        return null;
      }
      throw new AutomationError(
        'UI_STRUCTURE_MISMATCH',
        `設定項目「${def.label}」のラベルが画面内に見つかりませんでした (0件検出)`,
        { key, label: def.label }
      );
    }

    if (count > 1) {
      throw new AutomationError(
        'UI_STRUCTURE_MISMATCH',
        `設定項目「${def.label}」のラベルが画面内に複数見つかりました (${count}件検出)。一意に特定できません`,
        { key, label: def.label, count }
      );
    }

    const labelLocator = labelCandidates.first();

    // コンテナ探索:
    // 1. 直近の祖先行（div.row, tr, fieldset, dl, setting-row）を特定
    let targetContainer: Locator;
    const semanticAncestor = labelLocator.locator(
      'xpath=ancestor::*[self::tr or self::fieldset or self::dl or contains(@class, "row") or contains(@class, "setting-row")][1]'
    );

    if ((await semanticAncestor.count()) > 0) {
      targetContainer = semanticAncestor;
    } else {
      // 見つからない場合は親ブロック
      const parentRow = labelLocator.locator('xpath=ancestor::*[contains(@class, "item") or contains(@class, "field") or contains(@class, "form-group")][1]');
      if ((await parentRow.count()) > 0) {
        targetContainer = parentRow;
      } else {
        targetContainer = labelLocator.locator('xpath=..');
      }
    }

    const containerInfo = await targetContainer.evaluate((el) => ({
      tagName: el.tagName.toLowerCase(),
      className: el.className || ''
    })).catch(() => ({ tagName: 'unknown', className: '' }));

    // コンテナ内のラジオボタン（input[type="radio"] または [role="radio"]）を探索
    const radioElements = targetContainer.locator('input[type="radio"], [role="radio"]');
    const radioCount = await radioElements.count();

    // 期待される選択肢数との照合
    if (radioCount !== def.options.length) {
      if (radioCount === 0) {
        throw new AutomationError(
          'UI_STRUCTURE_MISMATCH',
          `設定項目「${def.label}」にラジオボタンの選択肢が1つも存在しません (Case A: 選択肢不在, 期待: ${def.options.length}個, 画面実測: 0個)`,
          { key, expectedCount: def.options.length, actualCount: 0, container: containerInfo }
        );
      }
      throw new AutomationError(
        'UI_STRUCTURE_MISMATCH',
        `設定項目「${def.label}」のラジオボタン数が仕様と一致しません (期待: ${def.options.length}個, 画面実測: ${radioCount}個)`,
        { key, expectedCount: def.options.length, actualCount: radioCount, container: containerInfo }
      );
    }

    const radios: RadioInspectionDetail[] = [];

    for (let i = 0; i < radioCount; i++) {
      const radioLoc = radioElements.nth(i);

      // ラジオボタンのラベルテキストを取得
      let radioText = '';
      const id = await radioLoc.getAttribute('id');
      if (id) {
        const forLabel = this.page.locator(`label[for="${id}"]`);
        if ((await forLabel.count()) > 0) {
          radioText = (await forLabel.innerText()).trim();
        }
      }

      if (!radioText) {
        const parentLabel = radioLoc.locator('xpath=ancestor::label[1]');
        if ((await parentLabel.count()) > 0) {
          radioText = (await parentLabel.innerText()).trim();
        } else {
          const nextText = await radioLoc.evaluate((el) => {
            const next = el.nextSibling;
            return next ? next.textContent?.trim() : '';
          });
          radioText = nextText || '';
        }
      }

      const checked = await radioLoc.isChecked();
      const disabled = await radioLoc.isDisabled();
      const visible = await radioLoc.isVisible().catch(() => false);
      const normValue = labelToValue(key, radioText);

      if (normValue === null) {
        throw new AutomationError(
          'UI_STRUCTURE_MISMATCH',
          `設定項目「${def.label}」の選択肢テキスト「${radioText}」を正規化Enum値へマッピングできませんでした`,
          { key, radioText }
        );
      }

      radios.push({
        label: radioText,
        value: normValue,
        checked,
        disabled,
        visible,
        locator: radioLoc
      });
    }

    return {
      settingKey: key,
      label: def.label,
      containerTag: containerInfo.tagName,
      containerClass: containerInfo.className,
      containerLocator: targetContainer,
      radios
    };
  }

  /**
   * 11項目すべての実画面状態（Observation）を読み取る
   * ※ Observation.value は必ず正規化された SettingValue（Enum）として格納
   */
  async readAllSettingsObservation(): Promise<{
    observation: SchoolSettingsObservation;
    inspectionDetails: Record<SettingKey, RowInspectionResult | null>;
  }> {
    const observation: Partial<SchoolSettingsObservation> = {};
    const inspectionDetails: Partial<Record<SettingKey, RowInspectionResult | null>> = {};

    let normalKeysSuccessCount = 0;

    for (const key of ALL_SETTING_KEYS) {
      const def = SETTING_DEFINITIONS[key];
      const result = await this.inspectSettingRow(key);
      inspectionDetails[key] = result;

      if (result === null) {
        // mentalHealth などの契約外非表示
        observation[key] = {
          value: null,
          availability: 'CONTRACT_NOT_AVAILABLE'
        };
        continue;
      }

      // Case A: 選択肢不在 (radio が 0 個)
      if (result.radios.length === 0) {
        throw new AutomationError(
          'UI_STRUCTURE_MISMATCH',
          `設定項目「${def.label}」にラジオボタンの選択肢が1つも存在しません (Case A: 選択肢不在)`,
          { key, label: def.label, radioCount: 0 }
        );
      }

      // checked な選択肢の数を厳格に検証
      const checkedRadios = result.radios.filter((r) => r.checked);

      if (checkedRadios.length === 1) {
        const selected = checkedRadios[0];

        // Case C: 単一選択だが disabled かつ 親が ON (親有効なのに子が disabled)
        if (selected.disabled) {
          const parentRule = getParentDependencyRule(key);
          const parentObs = parentRule ? observation[parentRule.parentKey] : null;
          const parentIsOff = parentObs ? parentRule!.isParentOff(parentObs.value as any) : false;
          if (!parentIsOff) {
            throw new AutomationError(
              'UI_STRUCTURE_MISMATCH',
              `設定項目「${def.label}」の選択肢が非活性(disabled)ですが、親設定がOFFになっていません (Case C: 親ONで子disabled)`,
              { key, label: def.label, selectedDisabled: true, parentKey: parentRule?.parentKey, parentValue: parentObs?.value }
            );
          }
        }

        const availability = selected.disabled ? 'DISABLED_BY_DEPENDENCY' : 'AVAILABLE';

        observation[key] = {
          value: selected.value, // 必ず SettingValue Enum (ON, OFF, TEACHERS_ONLY, etc.)
          availability
        };

        if (!def.isOptionalInContract) {
          normalKeysSuccessCount++;
        }
      } else if (checkedRadios.length === 0) {
        // 全radioがdisabledの場合: サーバーからDISABLED_BY_DEPENDENCYとして返された状態 (親ルール存在必須)
        const allDisabled = result.radios.length > 0 && result.radios.every((r) => r.disabled);
        const parentRule = getParentDependencyRule(key);

        if (allDisabled && parentRule) {
          logger.info(`設定項目「${def.label}」は親設定(${parentRule.parentKey})の依存関係により全radio非活性(DISABLED_BY_DEPENDENCY)として取得しました`);
          observation[key] = {
            value: null,
            availability: 'DISABLED_BY_DEPENDENCY'
          };
          if (!def.isOptionalInContract) {
            normalKeysSuccessCount++;
          }
        } else {
          // Case D: 未選択(checkedCount 0)だが radioがenabled(allDisabled=false)または親ルール不在
          throw new AutomationError(
            'UI_STRUCTURE_MISMATCH',
            `設定項目「${def.label}」の選択肢が0個選択されていますが、既知の依存関係(親ルール存在かつ全radio disabled)を満たしていません (Case D: 未選択かつenabled, allDisabled=${allDisabled}, parentKey=${parentRule?.parentKey})`,
            { key, label: def.label, checkedCount: 0, allDisabled, parentKey: parentRule?.parentKey }
          );
        }
      } else {
        // Case B: 複数選択 (radio の checked が 2 個以上)
        throw new AutomationError(
          'UI_STRUCTURE_MISMATCH',
          `設定項目「${def.label}」のchecked状態のラジオボタンが複数個存在します (Case B: 多重選択, 検出数: ${checkedRadios.length}個)`,
          { key, label: def.label, checkedCount: checkedRadios.length }
        );
      }
    }

    // mentalHealthが非表示だった場合、他の必須10項目がすべて正常に取得できていることを前提とする
    if (observation.mentalHealth?.availability === 'CONTRACT_NOT_AVAILABLE' && normalKeysSuccessCount < 10) {
      throw new AutomationError(
        'UI_STRUCTURE_MISMATCH',
        '必須設定項目の取得数が不足しているため、心の健康観察機能の非表示を契約外として確定できませんでした'
      );
    }

    return {
      observation: observation as SchoolSettingsObservation,
      inspectionDetails: inspectionDetails as Record<SettingKey, RowInspectionResult | null>
    };
  }

  /**
   * Phase 2A用: 「更新する」ボタンおよび保存関連UIのDOM構造調査（クリックは一切行いません）
   */
  async inspectSaveButtonAndSignals(): Promise<{
    saveButtonFound: boolean;
    buttonDisabled: boolean;
    buttonText: string;
    candidateSignals: string[];
  }> {
    logger.info('【Phase 2A 調査】保存UI・シグナル候補のDOM構造を検証中 (クリック操作は行いません)');

    const saveButton = this.page.locator(
      'button:has-text("更新する"), input[type="submit"][value*="更新"], button:has-text("保存")'
    ).first();

    const exists = (await saveButton.count()) > 0;
    let buttonDisabled = false;
    let buttonText = '';
    const candidateSignals: string[] = [];

    if (exists) {
      const val = await saveButton.getAttribute('value');
      const inner = (await saveButton.innerText().catch(() => '')).trim();
      buttonText = val || inner;
      buttonDisabled = await saveButton.isDisabled();
      candidateSignals.push(`更新ボタン特定成功: text="${buttonText}", disabled=${buttonDisabled}`);
    } else {
      throw new AutomationError(
        'UI_STRUCTURE_MISMATCH',
        '画面内に「更新する」ボタンが見つかりませんでした'
      );
    }

    // 周囲のアラート領域、トーストコンテナ、メッセージエリア候補を調査
    const toastContainers = this.page.locator('.toast, .alert, .notification, .message-area, [role="alert"]');
    const toastCount = await toastContainers.count();
    if (toastCount > 0) {
      candidateSignals.push(`トースト/通知領域コンテナ候補検出: ${toastCount}件`);
    }

    return {
      saveButtonFound: exists,
      buttonDisabled,
      buttonText,
      candidateSignals
    };
  }

  /**
   * 保存ボタン（「更新する」）のLocatorを取得し、count === 1 を厳格に検証する
   * 実DOM仕様: input[type="submit"][name="commit"][value="更新する"]
  /**
   * 保存ボタン（「更新する」）のLocatorを取得し、count === 1, visible === true, disabled === false を厳格に検証する
   * 指示4: 初回Live Write時は exact selector 'input[type="submit"][name="commit"][value="更新する"]' のみを利用
   */
  async getSaveButton(exactOnly = false): Promise<Locator> {
    const exactSelector = 'input[type="submit"][name="commit"][value="更新する"]';
    const fallbackSelectors = [
      exactSelector,
      'input[type="submit"][value="更新する"]',
      'button:has-text("更新する")',
      'input[type="submit"][name="commit"]'
    ];

    const selectorsToTry = exactOnly ? [exactSelector] : fallbackSelectors;

    for (const sel of selectorsToTry) {
      const loc = this.page.locator(sel);
      const count = await loc.count();
      if (count === 1) {
        const isVisible = await loc.isVisible().catch(() => false);
        const isDisabled = await loc.isDisabled().catch(() => true);

        if (!isVisible) {
          throw new AutomationError(
            'UI_STRUCTURE_MISMATCH',
            `保存ボタン "${sel}" はDOMに存在しますが非表示 (visible === false) です`,
            { selector: sel, isVisible }
          );
        }

        if (isDisabled) {
          throw new AutomationError(
            'PRE_SAVE_VALIDATION_FAILED',
            `保存ボタン "${sel}" が非活性 (disabled === true) のため保存を実行できません`,
            { selector: sel, isDisabled }
          );
        }

        return loc.first();
      } else if (count > 1) {
        throw new AutomationError(
          'UI_STRUCTURE_MISMATCH',
          `保存ボタンLocator "${sel}" が複数件 (${count}件) 検出されました。一意に特定できません`,
          { selector: sel, count }
        );
      }
    }

    throw new AutomationError(
      'UI_STRUCTURE_MISMATCH',
      `画面内に指定された保存ボタンが見つかりませんでした (exactOnly=${exactOnly})`
    );
  }

  /**
   * 指定された設定項目のラジオボタンを選択する (DOM操作)
   */
  async selectSettingRadio(key: SettingKey, targetValue: SettingValue, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new AutomationError('TIMEOUT', 'ラジオボタン操作直前にタイムアウトまたは中断シグナルを検知しました');
    }

    const row = await this.inspectSettingRow(key);
    if (!row) {
      throw new AutomationError(
        'SETTING_NOT_AVAILABLE',
        `設定項目「${key}」は画面上に存在しません (CONTRACT_NOT_AVAILABLE)`,
        { key }
      );
    }

    const targetRadio = row.radios.find((r) => r.value === targetValue);
    if (!targetRadio) {
      throw new AutomationError(
        'UI_STRUCTURE_MISMATCH',
        `設定項目「${key}」に指定された値 "${targetValue}" に対応するラジオボタンが存在しません`,
        { key, targetValue }
      );
    }

    if (targetRadio.disabled) {
      throw new AutomationError(
        'SETTING_NOT_AVAILABLE',
        `設定項目「${key}」の値 "${targetValue}" のラジオボタンはdisabledのため選択できません`,
        { key, targetValue }
      );
    }

    logger.info(`ラジオボタンを選択中: [${row.label}] -> "${targetRadio.label}" (${targetValue})`);
    await targetRadio.locator.check({ force: true });

    // チェック状態を即時検証
    const isChecked = await targetRadio.locator.isChecked();
    if (!isChecked) {
      throw new AutomationError(
        'PRE_SAVE_VALIDATION_FAILED',
        `設定項目「${key}」のラジオボタンクリック後にchecked状態になりませんでした`,
        { key, targetValue }
      );
    }
  }

  /**
   * 保存直前バリデーション (Pre-Save Validation)
   * 1. 保存ボタンの存在・一意性(count===1)・非活性(disabled)でないこと
   * 2. 対象項目が期待値通りに変更されていること
   * 3. 対象外の全項目が baseline と完全一致していること（副作用なし検証）
   */
  async validatePreSave(
    targetKey: SettingKey,
    expectedTargetValue: SettingValue,
    baselineObservation: SchoolSettingsObservation,
    exactOnly = true
  ): Promise<void> {
    logger.info(`保存前検証 (Pre-Save Validation) を実行中: 対象項目=[${targetKey}]...`);

    const saveButton = await this.getSaveButton(exactOnly);
    const isDisabled = await saveButton.isDisabled();
    if (isDisabled) {
      throw new AutomationError(
        'PRE_SAVE_VALIDATION_FAILED',
        '「更新する」ボタンが非活性 (disabled) のため保存を実行できません'
      );
    }

    const { observation: currentDomObservation } = await this.readAllSettingsObservation();

    // 対象項目のDOM値確認
    const targetObs = currentDomObservation[targetKey];
    if (!targetObs || targetObs.value !== expectedTargetValue) {
      throw new AutomationError(
        'PRE_SAVE_VALIDATION_FAILED',
        `保存前検証失敗: 対象項目「${targetKey}」のDOM上の値 (${targetObs?.value}) が期待値 (${expectedTargetValue}) と一致しません`,
        { targetKey, expectedTargetValue, actualValue: targetObs?.value }
      );
    }

    // 対象外項目の副作用なし検証
    for (const key of ALL_SETTING_KEYS) {
      if (key === targetKey) continue;
      const baseItem = baselineObservation[key];
      const curItem = currentDomObservation[key];

      if (baseItem.availability !== curItem.availability || baseItem.value !== curItem.value) {
        throw new AutomationError(
          'UNEXPECTED_SIDE_EFFECT',
          `保存前検証失敗: 対象外項目「${key}」の値がベースラインから意図せず変動しています (Base: ${baseItem.value}, 現在: ${curItem.value})`,
          { key, baseline: baseItem, current: curItem }
        );
      }
    }

    logger.info('保存前検証 (Pre-Save Validation) に成功しました (対象項目一致 & 他項目副作用なし)');
  }

  /**
   * 「更新する」をクリックし、保存挙動の各種シグナルを観測する
   * ※ 指示2: POSTそのもののレスポンス(submitResponseStatus)と、リダイレクト後の最終GETレスポンス(finalNavigationStatus)を分離
   * ※ ログには機密情報（body, Cookie, Authorization header等）を一切含めない
   */
  async clickSaveAndObserveSignals(timeoutMs = 15000, exactOnly = true, signal?: AbortSignal): Promise<SaveObservation> {
    if (signal?.aborted) {
      throw new AutomationError('TIMEOUT', '保存ボタン押下直前にタイムアウトまたは中断シグナルを検知しました');
    }

    const saveButton = await this.getSaveButton(exactOnly);
    const urlBefore = this.page.url();
    const disabledBefore = await saveButton.isDisabled();

    const formInfo = await this.page.locator('form').evaluate((form: HTMLFormElement) => ({
      action: form.action || null,
      method: form.method || null
    })).catch(() => ({ action: null, method: null }));

    logger.info(`【保存実行】「更新する」ボタンをクリックします (form action="${formInfo.action}", method="${formInfo.method}")`);

    let submitRequestUrl = '';
    let submitMethod = '';
    let submitResponseStatus: number | null = null;
    let redirectDetected = false;
    let redirectLocation: string | undefined = undefined;
    let finalNavigationStatus: number | null = null;

    const onRequest = (req: any) => {
      const method = req.method();
      if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && req.url().includes('/organization')) {
        submitRequestUrl = req.url().split('?')[0];
        submitMethod = method;
      }
    };

    const onResponse = (res: any) => {
      const req = res.request();
      if ((req.method() === 'POST' || req.method() === 'PUT' || req.method() === 'PATCH') &&
          req.url().includes('/organization')) {
        submitResponseStatus = res.status();
        const headers = res.headers();
        if (headers['location']) {
          redirectLocation = headers['location'];
        }
      }
      if (res.status() >= 300 && res.status() < 400) {
        redirectDetected = true;
      }
      // ナビゲーション後のGETレスポンス
      if (req.method() === 'GET' && req.url().includes('/organization')) {
        finalNavigationStatus = res.status();
      }
    };

    this.page.on('request', onRequest);
    this.page.on('response', onResponse);

    try {
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null),
        saveButton.click()
      ]);
      await this.page.waitForTimeout(1000);
    } finally {
      this.page.off('request', onRequest);
      this.page.off('response', onResponse);
    }

    const urlAfter = this.page.url();
    const disabledAfter = await saveButton.isDisabled().catch(() => false);

    const flashEl = this.page.locator('.alert, .notice, .toast, .flash-message, [role="alert"]').first();
    let flashMessage: string | undefined = undefined;
    if ((await flashEl.count()) > 0 && (await flashEl.isVisible().catch(() => false))) {
      flashMessage = (await flashEl.innerText().catch(() => '')).trim();
    }

    const saveObs: SaveObservation = {
      submitRequestUrl,
      submitMethod,
      submitResponseStatus,
      redirectDetected,
      redirectLocation,
      finalUrl: urlAfter,
      finalNavigationStatus,
      flashMessage,
      buttonDisabledObserved: disabledBefore || disabledAfter
    };

    logger.info(`【保存シグナル観測結果】POST status=${submitResponseStatus}, redirect=${redirectDetected} (loc=${redirectLocation || 'none'}), final GET status=${finalNavigationStatus}, urlAfter=${urlAfter}, flash="${flashMessage || 'なし'}"`);
    return saveObs;
  }

  /**
   * Multi-action: 計画された複数の操作を order 順に適用する (指示6, 7)
   */
  async applyActions(actions: PlanAction[], signal?: AbortSignal): Promise<void> {
    const sorted = [...actions].sort((a, b) => a.order - b.order);
    logger.info(`複数設定変更 (Multi-action: ${sorted.length}件) を順次適用中...`);

    for (const action of sorted) {
      if (signal?.aborted) {
        throw new AutomationError('TIMEOUT', 'Action適用直前にタイムアウトまたは中断シグナルを検知しました');
      }
      logger.info(`  Step ${action.order}: [${action.label}] ${action.from ?? '(none)'} -> ${action.to}`);
      await this.selectSettingRadio(action.settingKey, action.to, signal);
    }
    logger.info('全Actionのラジオボタン選択を完了しました');
  }

  /**
   * Production用 Pre-Save Validation:
   * 複数Action適用後、保存ボタン押下前に全11項目のDOM状態を取得し、ExecutionPlanのexpectedFinalStateと完全比較する (指示8)
   */
  async validatePreSaveForPlan(
    plan: ExecutionPlan,
    baselineObservation: SchoolSettingsObservation,
    exactOnly = true
  ): Promise<void> {
    logger.info('【Production Pre-Save Validation】全11項目のDOM選択状態と保存ボタンを検証中...');

    // 1. 保存ボタンの検証
    const saveButton = await this.getSaveButton(exactOnly);
    const isDisabled = await saveButton.isDisabled();
    if (isDisabled) {
      throw new AutomationError(
        'PRE_SAVE_VALIDATION_FAILED',
        '「更新する」ボタンが非活性 (disabled) のため保存を実行できません'
      );
    }

    // 2. 現在のDOM全11項目取得
    const { observation: currentDomObs } = await this.readAllSettingsObservation();

    // 3. 全項目について plan.preSaveExpectations と完全比較 (Phase 4C: Pre/Post-Save期待値分離)
    const valResult = validateObservationMatchesPlan(currentDomObs, plan, 'PRE_SAVE');
    if (!valResult.isValid) {
      if (valResult.hasUnexpectedSideEffect) {
        throw new AutomationError(
          'UNEXPECTED_SIDE_EFFECT',
          `保存前検証失敗: 変更対象外の項目が意図せず変更されています: ${valResult.mismatches.map((m) => m.message).join('; ')}`,
          { mismatches: valResult.mismatches }
        );
      }
      throw new AutomationError(
        'PRE_SAVE_VALIDATION_FAILED',
        `保存前検証に失敗しました。DOM選択状態が計画期待値と一致しません: ${valResult.mismatches.map((m) => m.message).join('; ')}`,
        { mismatches: valResult.mismatches }
      );
    }

    logger.info('【Production Pre-Save Validation】成功: 全11項目が計画通りの期待状態であることを確認しました');
  }

  /**
   * Production用 適用 & 保存 & 永続化検証 (指示1, 8, 9, 10: Restoreは行わない)
   * フロー: Multi-action適用 -> Pre-Save全11項目検証 -> 保存クリック&シグナル観測 -> page.reload() -> After Observation取得 -> 全11項目完全一致確認
   */
  async applyAndVerifyProduction(params: {
    plan: ExecutionPlan;
    baselineObservation: SchoolSettingsObservation;
    timeoutMs?: number;
    exactOnly?: boolean;
    signal?: AbortSignal;
    onPhaseChange?: (phase: WritePhase) => void;
  }): Promise<{
    success: boolean;
    recovered: boolean;
    afterObservation: SchoolSettingsObservation;
    saveObservation: SaveObservation | null;
  }> {
    const { plan, baselineObservation, timeoutMs = 15000, exactOnly = true, signal, onPhaseChange } = params;

    // 1. Multi-action を適用 (BEFORE_SAVE)
    onPhaseChange?.('BEFORE_SAVE');
    if (signal?.aborted) {
      throw new AutomationError('INTERRUPTED', '書き込み処理開始直前にタイムアウトまたは中断シグナルを検知しました');
    }
    await this.applyActions(plan.actions, signal);

    // 2. Production Pre-Save Validation (全11項目照合: 指示1)
    if (signal?.aborted) {
      throw new AutomationError('INTERRUPTED', '保存前検証直前にタイムアウトまたは中断シグナルを検知しました');
    }
    await this.validatePreSaveForPlan(plan, baselineObservation, exactOnly);

    // 3. 保存ボタンクリック & シグナル観測
    if (signal?.aborted) {
      throw new AutomationError('INTERRUPTED', '保存ボタン押下直前にタイムアウトまたは中断シグナルを検知しました');
    }
    let saveObservation: SaveObservation | null = null;
    let isRecovered = false;

    // Save request 送信開始 (指示1: SAVE_REQUEST_STARTED)
    onPhaseChange?.('SAVE_REQUEST_STARTED');
    try {
      saveObservation = await this.clickSaveAndObserveSignals(timeoutMs, exactOnly, signal);
    } catch (saveError: any) {
      logger.warn(`保存待機中にタイムアウトまたは例外が発生しました: ${saveError.message}。OUTCOME_RESOLUTIONに移行して永続化状態を確定します`);
      isRecovered = true;
    }

    // 4. Outcome Resolution フェーズ (指示1, 2: 永続状態の確定試行)
    onPhaseChange?.('OUTCOME_RESOLUTION');
    logger.info('【OUTCOME_RESOLUTION】page.reload() を実行してサーバー永続状態の確定を試行します...');

    let reloadedObs: SchoolSettingsObservation;
    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch((e: any) => {
        throw new Error(`reload failure: ${e.message}`);
      });
      await this.verifyPageLoaded().catch((e: any) => {
        throw new Error(`verifyPageLoaded failure: ${e.message}`);
      });
      const res = await this.readAllSettingsObservation().catch((e: any) => {
        throw new Error(`DOM read failure: ${e.message}`);
      });
      reloadedObs = res.observation;
    } catch (resolutionError: any) {
      // 指示2, 3: reload/read失敗、navigation失敗、DOM read失敗等は全て SAVE_OUTCOME_UNKNOWN
      logger.error(`【SAVE_OUTCOME_UNKNOWN】Saveリクエスト送信後に永続状態を確認できませんでした: ${resolutionError.message}`);
      throw new AutomationError(
        'SAVE_OUTCOME_UNKNOWN',
        `Saveリクエスト送信後に永続状態を確認できませんでした (永続状態未確定): ${resolutionError.message}`,
        { originalError: resolutionError.message }
      );
    }

    // 5. 比較検証 (Phase 4C: POST_SAVE基準で検証)
    const postValResult = validateObservationMatchesPlan(reloadedObs, plan, 'POST_SAVE');
    if (!postValResult.isValid) {
      // 指示2: reload/read成功 + 期待状態不一致 -> SAVE_FAILED_KNOWN
      logger.warn(`【SAVE_FAILED_KNOWN】Save後の確認で期待状態と不一致が確定しました: ${postValResult.mismatches.map((m) => m.message).join('; ')}`);
      throw new AutomationError(
        'SAVE_FAILED_KNOWN',
        `保存処理後に設定値が反映されなかったことが確定しました: ${postValResult.mismatches.map((m) => m.message).join('; ')}`,
        { mismatches: postValResult.mismatches }
      );
    }

    // 6. 確定完了 (OUTCOME_CONFIRMED)
    onPhaseChange?.('OUTCOME_CONFIRMED');
    logger.info(`【Production検証成功】全11項目の設定がサーバー上で計画期待値通りに永続化されたことを確認しました (${isRecovered ? 'SUCCESS_RECOVERED' : 'SUCCESS'})`);
    return {
      success: true,
      recovered: isRecovered,
      afterObservation: reloadedObs,
      saveObservation
    };
  }

  /**
   * 単一設定の適用と厳格検証 (WriteおよびRestore共通のSSOTメソッド)
   * フロー: radio選択 -> Pre-Save検証 -> 保存クリック&シグナル観測 -> page.reload() -> After Observation取得 -> 一致確認
   */
  async applyAndVerifySingleChange(params: {
    key: SettingKey;
    targetValue: SettingValue;
    baselineObservation: SchoolSettingsObservation;
    expectedObservation: Record<SettingKey, import('../types/settings').SettingExpectation>;
    timeoutMs?: number;
    exactOnly?: boolean;
  }): Promise<{
    success: boolean;
    recovered: boolean;
    afterObservation: SchoolSettingsObservation;
    signals: Record<string, any> | null;
  }> {
    const { key, targetValue, baselineObservation, expectedObservation, timeoutMs = 15000, exactOnly = true } = params;

    // 1. ラジオボタン変更
    await this.selectSettingRadio(key, targetValue);

    // 2. 保存前検証
    await this.validatePreSave(key, targetValue, baselineObservation, exactOnly);

    // 3. 保存クリック & シグナル観測
    let signals: Record<string, any> | null = null;
    let isRecovered = false;

    try {
      signals = await this.clickSaveAndObserveSignals(timeoutMs, exactOnly);
    } catch (saveError: any) {
      logger.warn(`保存待機中にタイムアウトまたはエラーが発生しました: ${saveError.message}。再クリックは行わずreloadして永続化状態を確認します`);
      // タイムアウト時の既存ルール（再クリック禁止）
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      await this.verifyPageLoaded();
      const { observation: reloadedObs } = await this.readAllSettingsObservation();

      const compareResult = compareAllSettingsObservations(reloadedObs, expectedObservation);
      if (compareResult.isMatched) {
        logger.info('【SUCCESS_RECOVERED】タイムアウト後のreloadによりサーバー永続状態が期待値と一致していることを確認しました');
        return {
          success: true,
          recovered: true,
          afterObservation: reloadedObs,
          signals: null
        };
      } else {
        throw new AutomationError(
          'SAVE_FAILED',
          `保存タイムアウト後の確認で期待値と一致しませんでした: ${compareResult.mismatches.join('; ')}`,
          { mismatches: compareResult.mismatches }
        );
      }
    }

    // 4. 保存成功の最終的な正はreload後のObservationとする (指示9)
    logger.info('page.reload() を実行してサーバー永続状態を再取得・厳格検証します...');
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.verifyPageLoaded();
    const { observation: afterObservation } = await this.readAllSettingsObservation();

    // 5. 比較検証 (SSOT compareAllSettingsObservations)
    const compareResult = compareAllSettingsObservations(afterObservation, expectedObservation);
    if (!compareResult.isMatched) {
      throw new AutomationError(
        'VERIFY_MISMATCH',
        `保存後の検証で期待値と実測値が一致しませんでした: ${compareResult.mismatches.join('; ')}`,
        { mismatches: compareResult.mismatches }
      );
    }

    logger.info(`【検証成功】設定項目「${key}」の変更がサーバー上で期待値通りに永続化されたことを確認しました`);
    return {
      success: true,
      recovered: isRecovered,
      afterObservation,
      signals
    };
  }
}
