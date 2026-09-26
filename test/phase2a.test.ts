import { chromium, Browser } from 'playwright';
import { SchoolSettingsPage } from '../src/pages/SchoolSettingsPage';
import { HomePage } from '../src/pages/HomePage';
import { buildExecutionPlan } from '../src/automation/buildExecutionPlan';
import { evaluateExecutionPlan } from '../src/automation/evaluateExecutionPlan';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

console.log('================================================');
console.log('Phase 2A: Browser Integration Tests');
console.log('================================================\n');

// 正常な11項目を含む完全なHTMLテンプレート
function getNormalSchoolSettingsHtml(): string {
  return `
    <!DOCTYPE html>
    <html lang="ja">
    <head><meta charset="utf-8"><title>学校設定</title></head>
    <body>
      <header>
        <div class="school-name">大阪市立なにわ小学校</div>
      </header>
      <h1>学校設定</h1>
      <form>
        <div class="setting-row">
          <label class="setting-title">ストレージ機能</label>
          <label><input type="radio" name="storage" value="ON" checked> ON</label>
          <label><input type="radio" name="storage" value="OFF"> OFF</label>
          <label><input type="radio" name="storage" value="TEACHERS_ONLY"> 先生のみ</label>
        </div>
        <div class="setting-row">
          <label class="setting-title">タイムライン・チャンネル機能</label>
          <label><input type="radio" name="timeline" value="ON" checked> ON</label>
          <label><input type="radio" name="timeline" value="OFF"> OFF</label>
        </div>
        <div class="setting-row">
          <label class="setting-title">個別メッセージ機能</label>
          <label><input type="radio" name="dm" value="ON"> ON</label>
          <label><input type="radio" name="dm" value="OFF"> OFF</label>
          <label><input type="radio" name="dm" value="STUDENT_TO_STUDENT_DISABLED" checked> 生徒同士は不可</label>
        </div>
        <div class="setting-row">
          <label class="setting-title">保護者との個別メッセージ</label>
          <label><input type="radio" name="pdm" value="ON" checked> ON</label>
          <label><input type="radio" name="pdm" value="OFF"> OFF</label>
        </div>
        <div class="setting-row">
          <label class="setting-title">全体チャンネル機能</label>
          <label><input type="radio" name="allch" value="ON" checked> ON</label>
          <label><input type="radio" name="allch" value="OFF"> OFF</label>
        </div>
        <div class="setting-row">
          <label class="setting-title">保護者チャンネル機能</label>
          <label><input type="radio" name="pch" value="ON" checked> ON</label>
          <label><input type="radio" name="pch" value="OFF"> OFF</label>
        </div>
        <div class="setting-row">
          <label class="setting-title">出欠連絡機能</label>
          <label><input type="radio" name="att" value="ON" checked> ON</label>
          <label><input type="radio" name="att" value="OFF"> OFF</label>
        </div>
        <div class="setting-row">
          <label class="setting-title">連絡帳機能</label>
          <label><input type="radio" name="contact" value="ON" checked> ON</label>
          <label><input type="radio" name="contact" value="OFF"> OFF</label>
        </div>
        <div class="setting-row">
          <label class="setting-title">心の健康観察機能</label>
          <label><input type="radio" name="mental" value="ON"> ON</label>
          <label><input type="radio" name="mental" value="OFF" checked> OFF</label>
        </div>
        <div class="setting-row">
          <label class="setting-title">他校のログ表示を許可</label>
          <label><input type="radio" name="otherlog" value="ALLOW" checked> する</label>
          <label><input type="radio" name="otherlog" value="DENY"> しない</label>
        </div>
        <div class="setting-row">
          <label class="setting-title">児童・生徒へパスワード変更を表示</label>
          <label><input type="radio" name="pwdchange" value="SHOW"> する</label>
          <label><input type="radio" name="pwdchange" value="HIDE" checked> しない</label>
        </div>
        <div>
          <button type="button" class="btn-save">更新する</button>
        </div>
      </form>
    </body>
    </html>
  `;
}

async function runTests() {
  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Test 1: 正常なHTMLからの11項目Observation取得とDry Run接続
    {
      await page.setContent(getNormalSchoolSettingsHtml());
      const settingsPage = new SchoolSettingsPage(page);
      await settingsPage.verifyPageLoaded();
      const { observation: obs } = await settingsPage.readAllSettingsObservation();

      assert(obs.storage.value === 'ON', 'storage should be ON');
      assert(obs.timelineChannel.value === 'ON', 'timelineChannel should be ON');
      assert(obs.directMessage.value === 'STUDENT_TO_STUDENT_DISABLED', 'directMessage should be STUDENT_TO_STUDENT_DISABLED');
      assert(obs.otherSchoolLog.value === 'ALLOW', 'otherSchoolLog should be ALLOW');
      assert(obs.studentPasswordChange.value === 'HIDE', 'studentPasswordChange should be HIDE');

      // Phase 1 BuildExecutionPlan に接続
      const plan = buildExecutionPlan({
        schoolCode: 'SCH01',
        schoolName: '大阪市立なにわ小学校',
        currentObservation: obs,
        requestedSettings: { attendance: 'OFF' }
      });
      const evalResult = evaluateExecutionPlan(plan);
      assert(evalResult.isExecutable === true, 'Plan should be executable');
      assert(plan.actions.length === 1 && plan.actions[0].settingKey === 'attendance', 'Action should be attendance');
      console.log('✓ Test 1: 正常HTMLから11項目のObservation取得とExecutionPlan接続に成功');
    }

    // Test 2: mentalHealth が契約外非表示の場合
    {
      const htmlWithoutMental = getNormalSchoolSettingsHtml().replace(
        /<div class="setting-row">\s*<label class="setting-title">心の健康観察機能[\s\S]*?<\/div>/,
        ''
      );
      await page.setContent(htmlWithoutMental);
      const settingsPage = new SchoolSettingsPage(page);
      const { observation: obs } = await settingsPage.readAllSettingsObservation();

      assert(obs.mentalHealth.value === null, 'mentalHealth value should be null');
      assert(obs.mentalHealth.availability === 'CONTRACT_NOT_AVAILABLE', 'mentalHealth should be CONTRACT_NOT_AVAILABLE');
      assert(obs.storage.value === 'ON', 'other settings intact');
      console.log('✓ Test 2: mentalHealth契約外非表示時にCONTRACT_NOT_AVAILABLEとして安全に取得');
    }

    // Test 3: 必須項目が欠落している場合 (UI_STRUCTURE_MISMATCH)
    {
      const htmlWithoutStorage = getNormalSchoolSettingsHtml().replace(
        /<div class="setting-row">\s*<label class="setting-title">ストレージ機能[\s\S]*?<\/div>/,
        ''
      );
      await page.setContent(htmlWithoutStorage);
      const settingsPage = new SchoolSettingsPage(page);
      let caught = false;
      try {
        await settingsPage.readAllSettingsObservation();
      } catch (err: any) {
        caught = true;
        assert(err.status === 'UI_STRUCTURE_MISMATCH', 'Expected UI_STRUCTURE_MISMATCH');
      }
      assert(caught, 'Should catch UI_STRUCTURE_MISMATCH for missing mandatory item');
      console.log('✓ Test 3: 通常必須項目が欠落している場合にUI_STRUCTURE_MISMATCHを検知');
    }

    // Test 4: ラベルが複数件重複している場合 (UI_STRUCTURE_MISMATCH)
    {
      const htmlWithDuplicate = getNormalSchoolSettingsHtml() + `<div><label>出欠連絡機能</label></div>`;
      await page.setContent(htmlWithDuplicate);
      const settingsPage = new SchoolSettingsPage(page);
      let caught = false;
      try {
        await settingsPage.readAllSettingsObservation();
      } catch (err: any) {
        caught = true;
        assert(err.status === 'UI_STRUCTURE_MISMATCH', 'Expected UI_STRUCTURE_MISMATCH on duplicate label');
      }
      assert(caught, 'Should catch UI_STRUCTURE_MISMATCH on duplicate');
      console.log('✓ Test 4: ラベルが重複している場合にUI_STRUCTURE_MISMATCHを一意性チェックで検知');
    }

    // Test 5: 選択肢数が仕様と一致しない場合 (UI_STRUCTURE_MISMATCH)
    {
      const htmlWrongOptions = getNormalSchoolSettingsHtml().replace(
        '<label><input type="radio" name="storage" value="TEACHERS_ONLY"> 先生のみ</label>',
        ''
      ); // ストレージ機能を2択にする
      await page.setContent(htmlWrongOptions);
      const settingsPage = new SchoolSettingsPage(page);
      let caught = false;
      try {
        await settingsPage.readAllSettingsObservation();
      } catch (err: any) {
        caught = true;
        assert(err.status === 'UI_STRUCTURE_MISMATCH', 'Expected UI_STRUCTURE_MISMATCH on option count');
      }
      assert(caught, 'Should catch UI_STRUCTURE_MISMATCH on wrong option count');
      console.log('✓ Test 5: 選択肢数が仕様と不一致の場合にUI_STRUCTURE_MISMATCHを検知');
    }

    // Test 6: 保存UIおよびシグナル候補の調査 (Phase 2A)
    {
      await page.setContent(getNormalSchoolSettingsHtml());
      const settingsPage = new SchoolSettingsPage(page);
      const inspection = await settingsPage.inspectSaveButtonAndSignals();
      assert(inspection.saveButtonFound === true, 'Save button should be found');
      assert(inspection.buttonText === '更新する', 'Button text should be 更新する');
      console.log('✓ Test 6: 保存ボタンおよびシグナル候補のDOM調査が正常に実行可能');
    }

    // Test 7: 学校照合（完全一致 vs 推測不一致）
    {
      await page.setContent(getNormalSchoolSettingsHtml());
      const homePage = new HomePage(page);

      // 完全一致 -> 成功
      await homePage.verifySchool('12345678', '大阪市立なにわ小学校');

      // 「なにわ小」と「なにわ小学校」の部分一致・推測一致 -> SCHOOL_MISMATCH
      let caught = false;
      try {
        await homePage.verifySchool('12345678', '大阪市立なにわ小');
      } catch (err: any) {
        caught = true;
        assert(err.status === 'SCHOOL_MISMATCH', 'Expected SCHOOL_MISMATCH for partial match');
      }
      assert(caught, 'Should reject partial/fuzzy school name');
      console.log('✓ Test 7: 学校名照合の完全一致ルール（部分一致「なにわ小」をSCHOOL_MISMATCHで拒絶）');
    }

    // Test 8: Phase 4C 実環境再現 Fixture (directMessage: OFF, parentDirectMessage: checkedCount=0 / 全disabled)
    {
      const htmlDisabledChild = getNormalSchoolSettingsHtml()
        .replace(
          /<div class="setting-row">\s*<label class="setting-title">個別メッセージ機能[\s\S]*?<\/div>/,
          `<div class="setting-row">
            <label class="setting-title">個別メッセージ機能</label>
            <label><input type="radio" name="dm" value="ON"> ON</label>
            <label><input type="radio" name="dm" value="OFF" checked> OFF</label>
            <label><input type="radio" name="dm" value="STUDENT_TO_STUDENT_DISABLED"> 生徒同士は不可</label>
          </div>`
        )
        .replace(
          /<div class="setting-row">\s*<label class="setting-title">保護者との個別メッセージ[\s\S]*?<\/div>/,
          `<div class="setting-row">
            <label class="setting-title">保護者との個別メッセージ</label>
            <label><input type="radio" name="pdm" value="ON" disabled="disabled"> ON</label>
            <label><input type="radio" name="pdm" value="OFF" disabled="disabled"> OFF</label>
            <span class="help-text">「個別メッセージ機能」がOFFのため利用できません</span>
          </div>`
        );
      await page.setContent(htmlDisabledChild);
      const settingsPage = new SchoolSettingsPage(page);
      const { observation: obs } = await settingsPage.readAllSettingsObservation();

      assert(obs.directMessage.value === 'OFF', 'directMessage should be OFF');
      assert(obs.parentDirectMessage.value === null, 'parentDirectMessage value should be null');
      assert(obs.parentDirectMessage.availability === 'DISABLED_BY_DEPENDENCY', 'parentDirectMessage availability should be DISABLED_BY_DEPENDENCY');
      console.log('✓ Test 8: Live Fixture (親OFF/子checkedCount=0/全disabled) から DISABLED_BY_DEPENDENCY / value: null を正常取得');
    }

    // Test 9: Phase 4C パーサー異常系4ケースの厳格検知 (Case A〜D)
    {
      const settingsPage = new SchoolSettingsPage(page);

      // Case A: 選択肢不在 (radio が 0 個)
      {
        const htmlCaseA = getNormalSchoolSettingsHtml().replace(
          /<div class="setting-row">\s*<label class="setting-title">出欠連絡機能[\s\S]*?<\/div>/,
          `<div class="setting-row"><label class="setting-title">出欠連絡機能</label></div>`
        );
        await page.setContent(htmlCaseA);
        let caught = false;
        try {
          await settingsPage.readAllSettingsObservation();
        } catch (err: any) {
          caught = true;
          assert(err.status === 'UI_STRUCTURE_MISMATCH', 'Expected UI_STRUCTURE_MISMATCH for Case A');
          assert(err.message.includes('Case A'), 'Message should indicate Case A');
        }
        assert(caught, 'Should catch Case A: 選択肢不在');
      }

      // Case B: 多重選択 (checked が 2 個: 不正マークアップで同一行のradioが多重checked)
      {
        const htmlCaseB = getNormalSchoolSettingsHtml().replace(
          '<label><input type="radio" name="att" value="OFF"> OFF</label>',
          '<label><input type="radio" name="att_broken" value="OFF" checked> OFF</label>'
        );
        await page.setContent(htmlCaseB);
        let caught = false;
        try {
          await settingsPage.readAllSettingsObservation();
        } catch (err: any) {
          caught = true;
          assert(err.status === 'UI_STRUCTURE_MISMATCH', 'Expected UI_STRUCTURE_MISMATCH for Case B');
          assert(err.message.includes('Case B'), 'Message should indicate Case B');
        }
        assert(caught, 'Should catch Case B: 多重選択');
      }

      // Case C: 親ONなのに子がdisabled
      {
        const htmlCaseC = getNormalSchoolSettingsHtml().replace(
          /<div class="setting-row">\s*<label class="setting-title">保護者との個別メッセージ[\s\S]*?<\/div>/,
          `<div class="setting-row">
            <label class="setting-title">保護者との個別メッセージ</label>
            <label><input type="radio" name="pdm" value="ON" checked disabled="disabled"> ON</label>
            <label><input type="radio" name="pdm" value="OFF" disabled="disabled"> OFF</label>
          </div>`
        );
        await page.setContent(htmlCaseC);
        let caught = false;
        try {
          await settingsPage.readAllSettingsObservation();
        } catch (err: any) {
          caught = true;
          assert(err.status === 'UI_STRUCTURE_MISMATCH', 'Expected UI_STRUCTURE_MISMATCH for Case C');
          assert(err.message.includes('Case C'), 'Message should indicate Case C');
        }
        assert(caught, 'Should catch Case C: 親ONで子disabled');
      }

      // Case D: checkedCount=0 だが radio が enabled
      {
        const htmlCaseD = getNormalSchoolSettingsHtml().replace(
          '<label><input type="radio" name="att" value="ON" checked> ON</label>',
          '<label><input type="radio" name="att" value="ON"> ON</label>'
        );
        await page.setContent(htmlCaseD);
        let caught = false;
        try {
          await settingsPage.readAllSettingsObservation();
        } catch (err: any) {
          caught = true;
          assert(err.status === 'UI_STRUCTURE_MISMATCH', 'Expected UI_STRUCTURE_MISMATCH for Case D');
          assert(err.message.includes('Case D'), 'Message should indicate Case D');
        }
        assert(caught, 'Should catch Case D: 未選択かつenabled');
      }

      console.log('✓ Test 9: Phase 4C パーサー異常系4ケース (Case A〜D) を UI_STRUCTURE_MISMATCH で確実に検知');
    }

    console.log('\n================================================');
    console.log('All Phase 2A Browser Integration Tests Passed!');
    console.log('================================================');
  } finally {
    await context.close();
    await browser.close();
  }
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
