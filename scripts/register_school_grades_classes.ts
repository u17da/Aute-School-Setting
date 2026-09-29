import { chromium, Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { parseGradeClassCsv, SchoolGradeClassConfig, TargetGradeConfig, TargetClassConfig } from '../src/batch/gradeClassParser';

interface SchoolExecutionResult {
  schoolId: string;
  schoolName: string;
  isJuniorHigh: boolean;
  status: 'SUCCESS' | 'PARTIAL' | 'SKIPPED_ALL_EXIST' | 'FAILED' | 'DRY_RUN_OK';
  addedGrades: string[];
  skippedGrades: string[];
  addedClasses: string[];
  skippedClasses: string[];
  errorMessage?: string;
  timestamp: string;
}

// 共通マスター認証情報（堀川・滝川など）
const DEFAULT_IDP_ID = 'gakusyukei_nd26_01@oskedu.jp';
const DEFAULT_IDP_PW = '20ntt26d';
const BASE_URL = 'https://ed-cl.com';

/**
 * ログイン処理
 */
async function loginToSchool(page: Page, schoolCode: string, idpId: string, idpPw: string, baseUrl: string) {
  console.log(`[ログイン] トップ画面へアクセス: ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

  console.log(`[ログイン] 学校コード入力: ${schoolCode}`);
  const schoolCodeInput = page.locator(
    'input[placeholder*="学校コード"], input[name*="schoolCode"], input[name*="school_code"], input[id*="schoolCode"], input[type="text"]'
  ).first();
  await schoolCodeInput.waitFor({ state: 'visible', timeout: 20000 });
  await schoolCodeInput.fill(schoolCode);

  const submitBtn = page.locator(
    'button:has-text("次へ"), input[type="submit"], button[type="submit"], button:has-text("ログイン")'
  ).first();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {}),
    submitBtn.click()
  ]);
  await page.waitForTimeout(3000);

  // Microsoft連携ボタンがあるか
  const microsoftButton = page.locator('button:has-text("Microsoft"), a:has-text("Microsoft"), button:has-text("Azure")').first();
  if (await microsoftButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log(`[ログイン] Microsoft連携ボタンをクリック`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      microsoftButton.click()
    ]);
    await page.waitForTimeout(3000);
  }

  // 認証画面の判定
  // パスワード入力欄が最初から同一画面にあるか確認（ローカルアカウントの場合）
  const immediatePwInput = page.locator('input[type="password"]:visible, input[name="password"]').first();
  const isLocalForm = await immediatePwInput.isVisible({ timeout: 4000 }).catch(() => false);

  if (isLocalForm) {
    console.log(`[ログイン] ローカル認証フォームを検出 (ID/PW同時入力)`);
    const idInput = page.locator(
      'input[placeholder*="ユーザーID"], input[placeholder*="ログインID"], input[name*="loginId"], input[name*="userId"], input[type="text"]:visible'
    ).first();
    await idInput.fill(idpId);
    console.log(`[ログイン] ユーザーID入力: ${idpId}`);

    await immediatePwInput.fill(idpPw);
    console.log(`[ログイン] パスワード入力`);

    const loginBtn = page.locator(
      'button:has-text("ログイン"), input[type="submit"][value*="ログイン"], button[type="submit"]'
    ).first();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      loginBtn.click()
    ]);
    await page.waitForTimeout(5000);
  } else {
    // 外部IdP または 2段階フォーム（Google / Entra ID 等）
    const idInput = page.locator(
      'input[type="email"], input[type="text"][name*="loginfmt"], input[placeholder*="ユーザーID"], input[name*="loginId"], input[type="text"]'
    ).first();
    if (await idInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      console.log(`[ログイン] ID入力: ${idpId}`);
      await idInput.fill(idpId);
      const nextBtn = page.locator(
        '#identifierNext button, button:has-text("Next"), button:has-text("次へ"), input[type="submit"][value*="次へ"], input[type="submit"], button[type="submit"]'
      ).first();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        nextBtn.click()
      ]);
      await page.waitForTimeout(3000);
    }

    // パスワード入力
    const pwInput = page.locator('input[type="password"]:visible, input[name="Passwd"], input[name="password"]').first();
    if (await pwInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      console.log(`[ログイン] パスワード入力`);
      await pwInput.fill(idpPw);
      const signInBtn = page.locator(
        '#passwordNext button, button:has-text("Next"), button:has-text("次へ"), button:has-text("サインイン"), button:has-text("ログイン"), input[type="submit"]'
      ).first();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        signInBtn.click()
      ]);
      await page.waitForTimeout(5000);

      // Google 特有の同意画面等
      const confirmBtn = page.locator(
        'button:has-text("同意する"), button:has-text("次へ"), button:has-text("続行"), button:has-text("今すぐ保護"), button:has-text("後で"), button:has-text("キャンセル")'
      ).first();
      if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log(`[ログイン] 確認・同意画面を検出: クリックします`);
        await confirmBtn.click();
        await page.waitForTimeout(3000);
      }

      // 「サインインの状態を維持しますか？」
      const staySignedInBtn = page.locator('input[type="submit"][value*="はい"], button:has-text("はい")').first();
      if (await staySignedInBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log(`[ログイン] サインイン維持確認: 「はい」をクリック`);
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
          staySignedInBtn.click()
        ]);
        await page.waitForTimeout(5000);
      }
    }
  }

  console.log(`[ログイン完了] 現在URL=${page.url()}`);
  await page.waitForLoadState('networkidle').catch(() => {});
}

/**
 * ユーザー管理画面を開く（別タブまたは同一タブ）
 */
async function openUserManagementPage(context: BrowserContext, page: Page): Promise<Page> {
  // 左下のアカウントメニューを展開（セレクタまたは座標 35, 860）
  const accountTrigger = page.locator('.v2-sidebar-current-account, .dropup.v2-nav-footer__item, [class*="nav-footer"], [class*="current-account"]').first();
  if (await accountTrigger.isVisible({ timeout: 4000 }).catch(() => false)) {
    await accountTrigger.click().catch(() => {});
  } else {
    // 座標直接クリック（v2 UI の左下アカウント領域）
    await page.mouse.click(35, 860);
  }
  await page.waitForTimeout(1500);

  // もしメニューがまだ開いていなければ座標クリックを再試行
  const userManageLink = page.locator('a:has-text("ユーザー管理"), li:has-text("ユーザー管理")').first();
  if (!(await userManageLink.isVisible({ timeout: 2000 }).catch(() => false))) {
    await page.mouse.click(35, 860);
    await page.waitForTimeout(1500);
  }

  await userManageLink.waitFor({ state: 'visible', timeout: 15000 });

  const pagePromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await userManageLink.click();
  const newPage = await pagePromise;
  let userPage = page;
  if (newPage) {
    userPage = newPage;
    await userPage.waitForLoadState('domcontentloaded');
  } else {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  }
  await userPage.waitForTimeout(3000);
  return userPage;
}

/**
 * 学年設定画面での学年一覧取得および登録処理
 */
async function syncGrades(
  userPage: Page,
  targetGrades: TargetGradeConfig[],
  isApply: boolean,
  screenshotsDir: string
): Promise<{ added: string[]; skipped: string[] }> {
  console.log(`\n--- [学年設定] 画面へ遷移 ---`);
  const gradeMenuLink = userPage.locator('a:has-text("学年設定"), li:has-text("学年設定")').first();
  await gradeMenuLink.waitFor({ state: 'visible', timeout: 15000 });
  await gradeMenuLink.click();
  await userPage.waitForTimeout(2000);

  // 画面のテーブルまたは新規ボタンが表示されるまで確実に待機
  await userPage.locator('button:has-text("新規"), a:has-text("新規"), table, main').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await userPage.waitForTimeout(1500);

  // 既存学年一覧の取得（メインコンテンツ内のテーブル）
  const existingGradeNames: string[] = [];
  const existingGradeCodes: string[] = [];
  let rows = await userPage.locator('main table tbody tr, .pfua-table tbody tr, table tbody tr').all();
  if (rows.length === 0) {
    await userPage.waitForTimeout(2000);
    rows = await userPage.locator('main table tbody tr, .pfua-table tbody tr, table tbody tr').all();
  }

  for (const row of rows) {
    const text = await row.innerText().catch(() => '');
    if (text.includes('学年は登録されていません') || text.includes('学年名')) continue;
    const cells = (await row.locator('td').allTextContents()).map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 2) {
      existingGradeNames.push(cells[0]);
      existingGradeCodes.push(cells[1]);
    } else {
      const parts = text.split(/\s+/).filter(Boolean);
      if (parts[0]) existingGradeNames.push(parts[0]);
      if (parts[1]) existingGradeCodes.push(parts[1]);
    }
  }
  console.log(`[学年設定] 既存登録学年: ${existingGradeNames.length > 0 ? existingGradeNames.join(', ') : '（なし）'} (コード: ${existingGradeCodes.join(', ')})`);

  const added: string[] = [];
  const skipped: string[] = [];

  for (const target of targetGrades) {
    // 学年名または学年コードが既に存在する場合はスキップ（重複登録によるエラー防止）
    if (existingGradeNames.includes(target.gradeName) || existingGradeCodes.includes(target.gradeCode)) {
      console.log(`  [スキップ] 学年「${target.gradeName}」(コード:${target.gradeCode}) は既に存在するためスキップします`);
      skipped.push(target.gradeName);
      continue;
    }

    if (!isApply) {
      console.log(`  [DRY-RUN] 学年「${target.gradeName}」(コード:${target.gradeCode}) の追加を予定`);
      added.push(target.gradeName);
      continue;
    }

    // 本番適用 (APPLY)
    console.log(`  [学年追加] 「新規」ボタンをクリック -> 学年「${target.gradeName}」(コード:${target.gradeCode})`);
    const newBtn = userPage.locator('button:has-text("新規"), a:has-text("新規")').first();
    await newBtn.waitFor({ state: 'visible', timeout: 15000 });
    await newBtn.click();
    await userPage.waitForTimeout(1500);

    // 学年名入力
    const nameInput = userPage.locator('input#grade_name, input[name="grade[name]"]').first();
    await nameInput.waitFor({ state: 'visible', timeout: 10000 });
    await nameInput.fill(target.gradeName);

    // 学年コード選択
    const codeSelect = userPage.locator('select#grade_code').first();
    if (target.isCustomCode) {
      // カスタムコード（例: 13「全校」）
      const hasCustomVal = await codeSelect.locator('option[value="custom"]').count();
      if (hasCustomVal > 0) {
        await codeSelect.selectOption('custom');
      } else {
        await codeSelect.selectOption({ label: 'カスタム' }).catch(() => codeSelect.selectOption('custom'));
      }
      await userPage.waitForTimeout(500);

      // カスタムコード入力欄
      const customCodeInput = userPage.locator('input#grade_code_code, input[name="grade_code_code"]').first();
      await customCodeInput.waitFor({ state: 'visible', timeout: 3000 });
      await customCodeInput.fill(target.gradeCode);

      // 隠しフィールド同期
      await userPage.evaluate((code) => {
        const hidden = document.querySelector('input[type="hidden"][name="grade[code]"]') as HTMLInputElement;
        if (hidden) hidden.value = code;
      }, target.gradeCode);
    } else {
      // 通常学年コード（1〜12）
      await codeSelect.selectOption(target.gradeCode).catch(async () => {
        // valueで失敗した場合はラベルで試行
        await codeSelect.selectOption({ label: `${target.gradeName}` }).catch(() => {});
      });
    }

    // 保存ボタンクリック
    const saveBtn = userPage.locator('input[type="submit"][value="保存"], button:has-text("保存")').first();
    await saveBtn.click();
    await userPage.waitForTimeout(2500);

    console.log(`  [学年追加完了] 学年「${target.gradeName}」を登録しました`);
    existingGradeNames.push(target.gradeName);
    added.push(target.gradeName);
  }

  // 学年設定後のスクリーンショット
  await userPage.screenshot({ path: path.join(screenshotsDir, 'grade_settings_after.png'), animations: 'disabled', timeout: 5000 }).catch(() => {});
  return { added, skipped };
}

/**
 * クラス設定画面でのクラス一覧取得および登録処理
 */
async function syncClasses(
  userPage: Page,
  targetClasses: TargetClassConfig[],
  isApply: boolean,
  screenshotsDir: string
): Promise<{ added: string[]; skipped: string[] }> {
  console.log(`\n--- [クラス設定] 画面へ遷移 ---`);
  const classMenuLink = userPage.locator('a:has-text("クラス設定"), li:has-text("クラス設定")').first();
  await classMenuLink.waitFor({ state: 'visible', timeout: 15000 });
  await classMenuLink.click();
  await userPage.waitForTimeout(2000);

  // 既存クラス一覧の取得（画面上のテーブル）
  const existingClassNames: string[] = [];
  const rows = await userPage.locator('table tr, [class*="row"]').all();
  for (const row of rows) {
    const text = await row.innerText().catch(() => '');
    if (text.includes('登録されているクラスがありません') || text.includes('クラス名')) continue;

    // input要素があればそのvalue、なければテキストからクラス名を取得
    const classInputs = await row.locator('input[type="text"]').all();
    for (const inp of classInputs) {
      const val = await inp.inputValue().catch(() => '');
      if (val.trim()) existingClassNames.push(val.trim());
    }
  }
  console.log(`[クラス設定] 既存登録クラス数: ${existingClassNames.length}件`);

  const added: string[] = [];
  const skipped: string[] = [];
  const toAddClasses: TargetClassConfig[] = [];

  for (const target of targetClasses) {
    if (existingClassNames.includes(target.className)) {
      skipped.push(target.className);
    } else {
      toAddClasses.push(target);
    }
  }

  console.log(`[クラス設定] 追加対象: ${toAddClasses.length}件, 既存スキップ: ${skipped.length}件`);

  if (toAddClasses.length === 0) {
    console.log(`[クラス設定] 追加すべき未登録クラスはありません`);
    await userPage.screenshot({ path: path.join(screenshotsDir, 'class_settings_after.png'), animations: 'disabled', timeout: 5000 }).catch(() => {});
    return { added, skipped };
  }

  if (!isApply) {
    toAddClasses.forEach((c) => {
      console.log(`  [DRY-RUN] クラス「${c.className}」（学年:${c.gradeName}）の追加を予定`);
      added.push(c.className);
    });
    await userPage.screenshot({ path: path.join(screenshotsDir, 'class_settings_after.png'), animations: 'disabled', timeout: 5000 }).catch(() => {});
    return { added, skipped };
  }

  // 本番適用 (APPLY): 1クラスずつ「クラスの追加」をクリックして行を追加
  for (let idx = 0; idx < toAddClasses.length; idx++) {
    const c = toAddClasses[idx];
    console.log(`  [クラス追加] 「クラスの追加」をクリック (${idx + 1}/${toAddClasses.length}) -> [${c.gradeName}] ${c.className}`);
    const addBtn = userPage.locator('button:has-text("クラスの追加"), a:has-text("クラスの追加")').first();
    await addBtn.waitFor({ state: 'visible', timeout: 10000 });
    await addBtn.click();
    await userPage.waitForTimeout(1000);

    // input要素を持つ行（追加された入力行）を特定
    const inputRows = userPage.locator('table tr:has(input[type="text"]), table tbody tr:has(input)');
    const rowCount = await inputRows.count();

    if (rowCount === 0) {
      // スクショとHTMLを保存してデバッグ
      await userPage.screenshot({ path: path.join(screenshotsDir, 'debug_no_input_rows.png'), animations: 'disabled', timeout: 5000 }).catch(() => {});
      const html = await userPage.content();
      fs.writeFileSync(path.join(screenshotsDir, 'debug_no_input_rows.html'), html, 'utf-8');
      throw new Error(`「クラスの追加」をクリック後に入力行が見つかりませんでした (rowCount=0)`);
    }

    const lastRow = inputRows.nth(rowCount - 1);

    // 学年プルダウン選択
    const gradeSelect = lastRow.locator('select').first();
    if (await gradeSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await gradeSelect.selectOption({ label: c.gradeName }).catch(async () => {
        const altLabel = c.gradeName.replace('ねん', '年').replace('年', 'ねん');
        const opts = await gradeSelect.locator('option').all();
        let matched = false;
        for (const opt of opts) {
          const txt = (await opt.innerText()).trim();
          if (
            txt === c.gradeName ||
            txt === altLabel ||
            txt.includes(c.gradeName) ||
            c.gradeName.includes(txt) ||
            txt.includes(altLabel)
          ) {
            const val = await opt.getAttribute('value');
            if (val) {
              await gradeSelect.selectOption(val);
              matched = true;
              break;
            }
          }
        }
        if (!matched && c.gradeName.startsWith('1年')) {
          for (const opt of opts) {
            const txt = (await opt.innerText()).trim();
            if (txt.includes('7年')) {
              const val = await opt.getAttribute('value');
              if (val) { await gradeSelect.selectOption(val); break; }
            }
          }
        } else if (!matched && c.gradeName.startsWith('2年')) {
          for (const opt of opts) {
            const txt = (await opt.innerText()).trim();
            if (txt.includes('8年')) {
              const val = await opt.getAttribute('value');
              if (val) { await gradeSelect.selectOption(val); break; }
            }
          }
        } else if (!matched && c.gradeName.startsWith('3年')) {
          for (const opt of opts) {
            const txt = (await opt.innerText()).trim();
            if (txt.includes('9年')) {
              const val = await opt.getAttribute('value');
              if (val) { await gradeSelect.selectOption(val); break; }
            }
          }
        }
      });
    }

    // クラス名テキストボックス入力
    const nameInput = lastRow.locator('input[type="text"], input:not([type="hidden"])').first();
    await nameInput.waitFor({ state: 'visible', timeout: 10000 });
    await nameInput.fill(c.className);

    added.push(c.className);
    await userPage.waitForTimeout(200);
  }

  // すべての未登録クラス追加後、「保存」ボタンをクリック
  console.log(`[クラス設定] すべてのクラス入力が完了しました。一括保存を実行します...`);
  const saveBtn = userPage.locator('button:has-text("保存"), input[value="保存"]').first();
  await saveBtn.click();
  await userPage.waitForTimeout(4000);

  // 保存後のスクリーンショット
  await userPage.screenshot({ path: path.join(screenshotsDir, 'class_settings_after.png'), animations: 'disabled', timeout: 5000 }).catch(() => {});
  console.log(`[クラス設定] 一括保存が完了しました`);

  return { added, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply');
  const isDryRun = !isApply || args.includes('--dry-run');

  const csvArgIndex = args.indexOf('--csv');
  const csvPath = csvArgIndex !== -1 ? args[csvArgIndex + 1] : path.resolve('data', 'production_grades_classes_raw.csv');

  const schoolFilterIndex = args.indexOf('--school');
  const schoolFilter = schoolFilterIndex !== -1 ? args[schoolFilterIndex + 1] : undefined;

  const concurrencyIndex = args.indexOf('--concurrency');
  const concurrency = concurrencyIndex !== -1 ? Math.max(1, parseInt(args[concurrencyIndex + 1], 10)) : 2;

  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : undefined;

  const offsetIndex = args.indexOf('--offset');
  const offset = offsetIndex !== -1 ? parseInt(args[offsetIndex + 1], 10) : 0;

  const checkpointsDir = path.resolve('checkpoints');
  if (!fs.existsSync(checkpointsDir)) {
    fs.mkdirSync(checkpointsDir, { recursive: true });
  }
  const checkpointFile = path.join(checkpointsDir, 'completed_grades_classes.txt');

  // 過去の完了済み学校コード読み込み
  const completedSchoolCodes = new Set<string>();
  if (fs.existsSync(checkpointFile)) {
    const lines = fs.readFileSync(checkpointFile, 'utf-8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    lines.forEach((code) => completedSchoolCodes.add(code));
  }

  console.log(`====================================================`);
  console.log(`まなびポケット 学年・クラス一括設定バッチ (マルチワーカー並列)`);
  console.log(`モード: ${isApply ? '【本番適用 (APPLY)】' : '【事前検証 (DRY-RUN)】'}`);
  console.log(`対象CSV: ${csvPath}`);
  console.log(`並列ワーカー数: ${concurrency}`);
  if (limit) console.log(`処理件数制限 (limit): ${limit} 校 (offset: ${offset})`);
  if (schoolFilter) console.log(`フィルター対象学校コード: ${schoolFilter}`);
  console.log(`過去完了済み学校数: ${completedSchoolCodes.size} 校 (自動スキップ)`);
  console.log(`====================================================`);

  if (!fs.existsSync(csvPath)) {
    console.error(`エラー: CSVファイルが見つかりません: ${csvPath}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  let allConfigs = parseGradeClassCsv(csvContent);

  if (schoolFilter) {
    allConfigs = allConfigs.filter((c) => c.schoolId === schoolFilter);
  } else {
    // 完了済み学校を自動除外（レジューム）
    allConfigs = allConfigs.filter((c) => !completedSchoolCodes.has(c.schoolId));
  }

  // offset & limit
  if (offset > 0) {
    allConfigs = allConfigs.slice(offset);
  }
  if (limit && limit > 0) {
    allConfigs = allConfigs.slice(0, limit);
  }

  console.log(`今回実行対象校数: ${allConfigs.length} 校\n`);

  if (allConfigs.length === 0) {
    console.log(`実行対象の学校はありません。すべて完了しています。`);
    return;
  }

  const baseScreenshotDir = path.resolve('screenshots', 'grade_class_register');
  if (!fs.existsSync(baseScreenshotDir)) {
    fs.mkdirSync(baseScreenshotDir, { recursive: true });
  }

  const reportsDir = path.resolve('reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const executionResults: SchoolExecutionResult[] = [];
  let processedCount = 0;
  const totalCount = allConfigs.length;

  const browser = await chromium.launch({
    headless: true,
    slowMo: 50
  });

  try {
    // キュー作成
    const taskQueue = allConfigs.map((config, index) => ({ config, index }));

    // ワーカー定義
    const workerPromises = Array.from({ length: concurrency }, async (_, workerIdx) => {
      const workerTag = `[W${workerIdx + 1}]`;

      while (taskQueue.length > 0) {
        const item = taskQueue.shift();
        if (!item) break;

        const { config } = item;
        processedCount++;
        const currentNum = processedCount;

        console.log(`\n${workerTag} [${currentNum}/${totalCount}] >>> 開始: ${config.schoolName} (コード: ${config.schoolId}) [${config.isJuniorHigh ? '中学校' : '小学校'}]`);

        const schoolShotDir = path.join(baseScreenshotDir, config.schoolId);
        if (!fs.existsSync(schoolShotDir)) {
          fs.mkdirSync(schoolShotDir, { recursive: true });
        }

        const loginId = config.id || DEFAULT_IDP_ID;
        const loginPw = config.password || DEFAULT_IDP_PW;

        let attempt = 0;
        const maxAttempts = 3;
        let schoolSuccess = false;

        while (attempt < maxAttempts && !schoolSuccess) {
          attempt++;
          if (attempt > 1) {
            console.log(`\n${workerTag} [${currentNum}/${totalCount}] >>> 再試行 (${attempt}/${maxAttempts}): ${config.schoolName} (コード: ${config.schoolId})`);
            await new Promise((r) => setTimeout(r, 3000));
          }

          const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
          const page = await context.newPage();

          try {
            await loginToSchool(page, config.schoolId, loginId, loginPw, BASE_URL);
            const userPage = await openUserManagementPage(context, page);

            // 1. 学年設定
            const gradeRes = await syncGrades(userPage, config.grades, isApply, schoolShotDir);

            // 2. クラス設定
            const classRes = await syncClasses(userPage, config.classes, isApply, schoolShotDir);

            const status =
              isDryRun
                ? 'DRY_RUN_OK'
                : gradeRes.added.length === 0 && classRes.added.length === 0
                ? 'SKIPPED_ALL_EXIST'
                : 'SUCCESS';

            executionResults.push({
              schoolId: config.schoolId,
              schoolName: config.schoolName,
              isJuniorHigh: config.isJuniorHigh,
              status,
              addedGrades: gradeRes.added,
              skippedGrades: gradeRes.skipped,
              addedClasses: classRes.added,
              skippedClasses: classRes.skipped,
              timestamp: new Date().toISOString()
            });

            // 本番適用で成功または既存スキップの場合、チェックポイントに追記
            if (isApply && (status === 'SUCCESS' || status === 'SKIPPED_ALL_EXIST')) {
              fs.appendFileSync(checkpointFile, `${config.schoolId}\n`, 'utf-8');
            }

            console.log(`${workerTag} [${currentNum}/${totalCount}] <<< 完了: ${config.schoolName} 結果: ${status} (学年:+${gradeRes.added.length}/クラス:+${classRes.added.length})`);
            schoolSuccess = true;
          } catch (err: any) {
            const isNetworkError =
              err.message?.includes('ERR_INTERNET_DISCONNECTED') ||
              err.message?.includes('ERR_CONNECTION_TIMED_OUT') ||
              err.message?.includes('net::');

            if (attempt < maxAttempts) {
              const waitSec = isNetworkError ? 10 : 3;
              console.warn(
                `${workerTag} [${currentNum}/${totalCount}] [試行${attempt}失敗] ${config.schoolName}: ${err.message} -> ${waitSec}秒待機後に再試行します`
              );
              await new Promise((r) => setTimeout(r, waitSec * 1000));
            } else {
              console.error(`${workerTag} [${currentNum}/${totalCount}] !!! エラー (全試行失敗): ${config.schoolName} (${config.schoolId}):`, err.message);
              executionResults.push({
                schoolId: config.schoolId,
                schoolName: config.schoolName,
                isJuniorHigh: config.isJuniorHigh,
                status: 'FAILED',
                addedGrades: [],
                skippedGrades: [],
                addedClasses: [],
                skippedClasses: [],
                errorMessage: err.message,
                timestamp: new Date().toISOString()
              });
            }
          } finally {
            await context.close().catch(() => {});
          }
        }
      }
    });

    await Promise.all(workerPromises);
  } finally {
    await browser.close();
  }

  // 結果レポート出力
  const reportTime = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonReportPath = path.join(reportsDir, `grade_class_report_${reportTime}.json`);
  fs.writeFileSync(jsonReportPath, JSON.stringify(executionResults, null, 2), 'utf-8');

  const csvRows = [
    '学校ID,学校名,種別,ステータス,追加学年数,スキップ学年数,追加クラス数,スキップクラス数,追加クラス一覧,エラー'
  ];
  for (const r of executionResults) {
    csvRows.push(
      `"${r.schoolId}","${r.schoolName}","${r.isJuniorHigh ? '中学校' : '小学校'}","${r.status}",${r.addedGrades.length},${r.skippedGrades.length},${r.addedClasses.length},${r.skippedClasses.length},"${r.addedClasses.join('; ')}","${(r.errorMessage || '').replace(/"/g, '""')}"`
    );
  }
  const csvReportPath = path.join(reportsDir, `grade_class_report_${reportTime}.csv`);
  fs.writeFileSync(csvReportPath, csvRows.join('\n'), 'utf-8');

  const successCount = executionResults.filter((r) => r.status === 'SUCCESS' || r.status === 'SKIPPED_ALL_EXIST' || r.status === 'DRY_RUN_OK').length;
  const failCount = executionResults.filter((r) => r.status === 'FAILED').length;

  console.log(`\n====================================================`);
  console.log(`バッチ処理が完了しました:`);
  console.log(`  全処理数: ${executionResults.length} 校 (成功: ${successCount} 校, 失敗: ${failCount} 校)`);
  console.log(`  レポート出力:`);
  console.log(`    JSON: ${jsonReportPath}`);
  console.log(`    CSV:  ${csvReportPath}`);
  console.log(`====================================================`);
}

main();
