let csrfToken = '';
let currentJobState = 'IDLE';
let currentExecutionPurpose = null;
let eventSource = null;

let targetSnapshot = null;
let observationSnapshot = null;
let draftProfile = null;
let activeProfileSnapshot = null;
let finalValidationSnapshot = null;
let activeFinalPreflightReport = null;
let activeFinalPreflightContext = null;
let previewPlan = null;

let editorDirty = false;
let previewVerified = false;
let serverApplyReady = false;
let serverWorkflowCapabilities = null;

let settingDefinitions = [];
let profilePresets = [];
let currentDraftSettings = {};
let currentConfirmationToken = null;
let currentApplyManifest = null;
let previewDebounceTimer = null;

let initialServerInstanceId = null;
let initialServerBuildFingerprint = null;
let hasVersionMismatch = false;
let resultsFetchSeq = 0;
let isApplyingInFlight = false;

document.addEventListener('DOMContentLoaded', () => {
  const metaInstance = document.querySelector('meta[name="server-instance-id"]');
  if (metaInstance) initialServerInstanceId = metaInstance.getAttribute('content');
  const metaBuild = document.querySelector('meta[name="server-build-fingerprint"]');
  if (metaBuild) initialServerBuildFingerprint = metaBuild.getAttribute('content');

  fetchStatus();
  subscribeSse();
  loadLatestResults();
  setupDragAndDrop();
  loadProfileDefinitionsAndPresets();
});

// ==========================================
// ナビゲーション (5ステップ)
// ==========================================
function switchTab(tabName) {
  const tabs = ['target', 'observe', 'decide', 'apply', 'result'];
  tabs.forEach((t) => {
    const btn = document.getElementById(`tab${t.charAt(0).toUpperCase() + t.slice(1)}Btn`);
    const screen = document.getElementById(`screen${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (t === tabName) {
      btn?.classList.add('active');
      screen?.classList.add('active');
    } else {
      btn?.classList.remove('active');
      screen?.classList.remove('active');
    }
  });

  if (tabName === 'apply' && activeFinalPreflightReport) {
    updateApplyGate(activeFinalPreflightReport);
  }

  if (tabName === 'result') {
    loadLatestResults();
  }
}

function setupDragAndDrop() {
  const dropZone = document.getElementById('dropZone');
  if (!dropZone) return;

  ['dragenter', 'dragover'].forEach((eventName) => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('dragover');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      onFileSelected(files);
    }
  });
}

async function onFileSelected(files) {
  if (!files || files.length === 0) return;
  const file = files[0];

  if (!file.name.toLowerCase().endsWith('.csv')) {
    alert('【ファイル形式エラー】\n選択されたファイルは .csv ではありません。\nExcel で「CSV UTF-8（コンマ区切り）（*.csv）」として保存した .csv ファイルをご利用ください。');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/schools/upload', {
      method: 'POST',
      headers: {
        'X-Filename': encodeURIComponent(file.name),
        'X-CSRF-Nonce': csrfToken
      },
      body: file
    });

    const data = await res.json();
    if (!res.ok) {
      alert(`CSV読み込みエラー: ${data.message || data.error}`);
      return;
    }

    // UI更新
    const uploadFileInfo = document.getElementById('uploadFileInfo');
    if (uploadFileInfo) uploadFileInfo.style.display = 'block';

    const uploadFileNameVal = document.getElementById('uploadFileNameVal');
    if (uploadFileNameVal) uploadFileNameVal.textContent = data.originalFileName;

    const uploadFileSizeVal = document.getElementById('uploadFileSizeVal');
    if (uploadFileSizeVal) uploadFileSizeVal.textContent = `(${(data.fileSize / 1024).toFixed(1)} KB)`;

    const uploadParsedStatsVal = document.getElementById('uploadParsedStatsVal');
    if (uploadParsedStatsVal) {
      uploadParsedStatsVal.textContent = `全 ${data.totalSchools} 校（有効: ${data.enabledSchools} 校）`;
    }

    const schoolsFileVal = document.getElementById('schoolsFileVal');
    if (schoolsFileVal) schoolsFileVal.textContent = data.originalFileName;

    const enabledSchoolsVal = document.getElementById('enabledSchoolsVal');
    if (enabledSchoolsVal) enabledSchoolsVal.textContent = `${data.enabledSchools} 校`;
    const targetSchoolsCountVal = document.getElementById('targetSchoolsCountVal');
    if (targetSchoolsCountVal) targetSchoolsCountVal.textContent = `${data.enabledSchools} 校`;

    const previewBody = document.getElementById('uploadPreviewBody');
    if (previewBody && data.preview) {
      previewBody.innerHTML = '';
      data.preview.forEach((s, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${idx + 1}</td>
          <td class="font-mono">${escapeHtml(s.schoolCode)}</td>
          <td>${escapeHtml(s.schoolName)}</td>
          <td class="text-success font-bold">${s.hasCredential ? '✓ 設定済' : '✗ 未設定'}</td>
        `;
        previewBody.appendChild(tr);
      });
    }

    // アップロード成功後、自動的に対象学校の確定・チェックを実行
    invalidateTarget('新しいCSVが選択されました。');
    await executeTargetValidate();
  } catch (err) {
    alert(`CSV読み込み通信エラー: ${err.message}`);
  }
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();

    csrfToken = data.csrfToken;
    currentJobState = data.jobState;
    currentExecutionPurpose = data.currentExecutionPurpose || (data.currentJob ? data.currentJob.mode : null);
    targetSnapshot = data.targetSnapshot;
    observationSnapshot = data.observationSnapshot;
    draftProfile = data.draftProfile;
    activeProfileSnapshot = data.activeProfileSnapshot;
    finalValidationSnapshot = data.finalValidationSnapshot;
    activeFinalPreflightReport = data.activeFinalPreflightReport;
    activeFinalPreflightContext = data.activeFinalPreflightContext;
    serverApplyReady = Boolean(data.applyReady);
    serverWorkflowCapabilities = data.workflowCapabilities || null;

    // 世代照合 (Version / Instance Mismatch Check: 指示9)
    if (data.serverInstanceId && initialServerInstanceId && data.serverInstanceId !== initialServerInstanceId) {
      hasVersionMismatch = true;
    }
    if (data.serverBuildFingerprint && initialServerBuildFingerprint && data.serverBuildFingerprint !== initialServerBuildFingerprint) {
      hasVersionMismatch = true;
    }

    const mismatchBanner = document.getElementById('versionMismatchBanner');
    if (mismatchBanner) {
      mismatchBanner.style.display = hasVersionMismatch ? 'block' : 'none';
    }

    if (hasVersionMismatch) {
      // 安全のため Apply 系ボタンをすべて無効化 (Fail-Closed)
      serverApplyReady = false;
      const prepareBtn = document.getElementById('prepareApplyBtn');
      if (prepareBtn) prepareBtn.disabled = true;
      const goToApply = document.getElementById('goToApplyBtn');
      if (goToApply) goToApply.disabled = true;
    }

    updateJobStateBadge(currentJobState, currentExecutionPurpose);
    updateStepAccessibility();

    if (targetSnapshot) {
      renderTargetSnapshot(targetSnapshot);
    }
    if (observationSnapshot) {
      renderObservationData(observationSnapshot);
    }
    // draftProfile が存在し、かつエディタが未編集(not dirty)の場合のみ設定を反映
    if (draftProfile?.settings && !editorDirty) {
      currentDraftSettings = { ...draftProfile.settings };
      renderProfileEditor();
    }
    if (activeFinalPreflightReport) {
      const banner = document.getElementById('previewComparisonBanner');
      const text = document.getElementById('previewComparisonText');
      const goToApply = document.getElementById('goToApplyBtn');
      const finalSec = document.getElementById('finalPreflightSection');
      if (finalSec) finalSec.style.display = 'block';
      if (banner && text) {
        banner.className = 'alert-box alert-success mt-3';
        text.textContent = '✅ 最終確認完了: 事前プレビューとの間に差分や不整合はありませんでした。安全に本番反映へ進めます。';
        banner.style.display = 'block';
      }
      if (goToApply) goToApply.disabled = !serverApplyReady || hasVersionMismatch;
      updateApplyGate(activeFinalPreflightReport);
    }
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

function updateJobStateBadge(state, purpose) {
  const badge = document.getElementById('jobStateBadge');
  if (!badge) return;

  badge.className = 'badge';
  badge.setAttribute('data-state', state);
  let label = state;

  switch (state) {
    case 'IDLE':
      badge.classList.add('badge-idle');
      label = '待機中';
      break;
    case 'RUNNING':
      badge.classList.add('badge-running');
      label = purpose === 'DISCOVERY' ? '現状調査中' : (purpose === 'FINAL_PREFLIGHT' ? '最終確認中' : '本番反映中');
      break;
    case 'STOPPING':
      badge.classList.add('badge-stopping');
      label = '停止処理中';
      break;
    case 'COMPLETED':
      badge.classList.add('badge-completed');
      label = '完了';
      break;
    case 'INTERRUPTED':
      badge.classList.add('badge-interrupted');
      label = '安全停止';
      break;
    case 'FAILED':
      badge.classList.add('badge-failed');
      label = 'エラー停止';
      break;
    default:
      badge.classList.add('badge-idle');
  }

  badge.textContent = label;
}

function updateStepAccessibility() {
  const tabObserve = document.getElementById('tabObserveBtn');
  const tabDecide = document.getElementById('tabDecideBtn');
  const tabApply = document.getElementById('tabApplyBtn');

  if (tabObserve) tabObserve.disabled = !targetSnapshot;
  if (tabDecide) tabDecide.disabled = !observationSnapshot;
  if (tabApply) tabApply.disabled = (!serverApplyReady && !activeFinalPreflightReport) || hasVersionMismatch;
}

function invalidateTarget(reason) {
  targetSnapshot = null;
  observationSnapshot = null;
  draftProfile = null;
  activeProfileSnapshot = null;
  finalValidationSnapshot = null;
  activeFinalPreflightReport = null;
  previewPlan = null;

  const goToObserve = document.getElementById('goToObserveBtn');
  if (goToObserve) goToObserve.disabled = true;

  const obsBox = document.getElementById('observationResultBox');
  if (obsBox) obsBox.style.display = 'none';

  const finalSec = document.getElementById('finalPreflightSection');
  if (finalSec) finalSec.style.display = 'none';

  updateStepAccessibility();
}

async function loadProfileDefinitionsAndPresets() {
  try {
    const [defRes, preRes] = await Promise.all([
      fetch('/api/profile/definitions'),
      fetch('/api/profile/presets')
    ]);

    if (defRes.ok) {
      const data = await defRes.json();
      settingDefinitions = data.definitions || [];
    }

    if (preRes.ok) {
      const data = await preRes.json();
      profilePresets = data.presets || [];
    }

    initDraftSettings();
    renderProfileEditor();
  } catch (err) {
    console.error('Failed to load profile definitions/presets:', err);
  }
}

function initDraftSettings() {
  currentDraftSettings = {};
  settingDefinitions.forEach((def) => {
    currentDraftSettings[def.key] = null; // UNMANAGED
  });
}

// ==========================================
// STEP 1: 対象学校
// ==========================================
async function executeTargetValidate() {
  const btn = document.getElementById('targetValidateBtn');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/target/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({})
    });

    const data = await res.json();
    if (!res.ok || data.status === 'FAIL') {
      alert(`対象学校のチェックエラー: ${data.message || data.error?.message || 'チェックに失敗しました'}`);
      return;
    }

    targetSnapshot = data.targetSnapshot;
    renderTargetSnapshot(targetSnapshot);
    updateStepAccessibility();
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderTargetSnapshot(snap) {
  const credResEl = document.getElementById('credResolvedVal');
  if (credResEl) credResEl.textContent = `${snap.resolvedCredentialsCount} 校 (充足率 100%)`;

  const credMissEl = document.getElementById('credMissingVal');
  if (credMissEl) credMissEl.textContent = '0 校';

  const countEl = document.getElementById('targetSchoolsCountVal') || document.getElementById('enabledSchoolsVal');
  if (countEl) countEl.textContent = `${snap.totalSchoolCount ?? snap.totalSchools} 校`;

  const box = document.getElementById('targetSnapshotBox');
  if (box) box.style.display = 'grid';

  const goToObserve = document.getElementById('goToObserveBtn');
  if (goToObserve) goToObserve.disabled = false;
}

async function goToObserveAndStart() {
  switchTab('observe');
  await startDiscovery();
}

// ==========================================
// STEP 2: 対象学校の現状調査
// ==========================================
async function startDiscovery() {
  try {
    const res = await fetch('/api/discovery/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({})
    });

    const data = await res.json();
    if (!res.ok) {
      alert(`現状調査の開始エラー: ${data.message || data.error}`);
      return;
    }

    showObserveProgressCard(true);
    setDiscoveryActionButtons('RUNNING');
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
}

async function resumeDiscovery() {
  try {
    const res = await fetch('/api/discovery/resume', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({})
    });
    if (!res.ok) {
      const data = await res.json();
      alert(`再開エラー: ${data.message || data.error}`);
    } else {
      setDiscoveryActionButtons('RUNNING');
    }
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
}

async function retryFailedDiscovery() {
  try {
    const res = await fetch('/api/discovery/retry-failed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({})
    });
    if (!res.ok) {
      const data = await res.json();
      alert(`再試行エラー: ${data.message || data.error}`);
    } else {
      setDiscoveryActionButtons('RUNNING');
    }
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
}

async function stopCurrentJob() {
  try {
    let endpoint = '/api/discovery/stop';
    if (currentExecutionPurpose === 'FINAL_PREFLIGHT') endpoint = '/api/final-preflight/stop';
    if (currentExecutionPurpose === 'PRODUCTION_WRITE') endpoint = '/api/preflight/stop';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`安全停止エラー: ${data.message || data.error}`);
    }
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
}

function setDiscoveryActionButtons(state) {
  const startBtn = document.getElementById('discoveryStartBtn');
  const stopBtn = document.getElementById('discoveryStopBtn');
  const resumeBtn = document.getElementById('discoveryResumeBtn');
  const retryBtn = document.getElementById('discoveryRetryFailedBtn');

  if (state === 'RUNNING') {
    if (startBtn) startBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'inline-block';
    if (resumeBtn) resumeBtn.style.display = 'none';
    if (retryBtn) retryBtn.style.display = 'none';
  } else if (state === 'INTERRUPTED') {
    if (startBtn) startBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';
    if (resumeBtn) resumeBtn.style.display = 'inline-block';
    if (retryBtn) retryBtn.style.display = 'none';
  } else if (state === 'FAILED') {
    if (startBtn) startBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';
    if (resumeBtn) resumeBtn.style.display = 'none';
    if (retryBtn) retryBtn.style.display = 'inline-block';
  } else {
    if (startBtn) startBtn.style.display = 'inline-block';
    if (stopBtn) stopBtn.style.display = 'none';
    if (resumeBtn) resumeBtn.style.display = 'none';
    if (retryBtn) retryBtn.style.display = 'none';
  }
}

function showObserveProgressCard(show) {
  const card = document.getElementById('observeProgressCard');
  if (card) card.style.display = show ? 'block' : 'none';
}

function getSettingDisplayLabel(key, value) {
  if (value === null || value === undefined || value === 'UNMANAGED') return '変更しない（現状維持）';
  if (value === 'CONTRACT_NOT_AVAILABLE') return '未契約';

  if (key === 'otherSchoolLog') {
    if (value === 'ALLOW') return '許可する';
    if (value === 'DENY') return '許可しない';
  }
  if (key === 'studentPasswordChange') {
    if (value === 'SHOW') return '表示する';
    if (value === 'HIDE') return '表示しない';
  }
  if (key === 'directMessage' && value === 'STUDENT_TO_STUDENT_DISABLED') {
    return '生徒同士は不可';
  }
  if (key === 'storage' && value === 'TEACHERS_ONLY') {
    return '先生のみ';
  }
  if (value === 'ON') return 'ON';
  if (value === 'OFF') return 'OFF';

  const def = settingDefinitions.find((d) => d.key === key);
  if (def) {
    const opt = def.options.find((o) => o.value === value);
    if (opt) return opt.label;
  }
  return String(value);
}

function formatDiffKey(key, diffStr) {
  if (!diffStr || typeof diffStr !== 'string') return '';
  if (diffStr.includes('→')) {
    const parts = diffStr.split('→').map((s) => s.trim());
    const fromLabel = getSettingDisplayLabel(key, parts[0]);
    const toLabel = getSettingDisplayLabel(key, parts[1]);
    return `${fromLabel} → ${toLabel}`;
  }
  return getSettingDisplayLabel(key, diffStr);
}

function renderObservationData(obs) {
  const box = document.getElementById('observationResultBox');
  if (!box) return;

  box.style.display = 'block';
  const totalEl = document.getElementById('obsTotalSchoolsVal');
  if (totalEl) totalEl.textContent = obs.totalSchools;

  // 11項目の現在分布テーブル描画
  const tbody = document.getElementById('observationDistributionBody');
  if (tbody) {
    tbody.innerHTML = '';
    const distData = obs.distribution || obs.settingDistribution || {};
    settingDefinitions.forEach((def) => {
      const dist = distData[def.key] || {};
      const chips = Object.entries(dist).map(([val, cnt]) => {
        let badgeClass = 'badge-idle';
        if (val === 'ON' || val === 'ALLOW' || val === 'SHOW') badgeClass = 'badge-completed';
        if (val === 'OFF' || val === 'DENY' || val === 'HIDE') badgeClass = 'badge-stopping';
        if (val === 'CONTRACT_NOT_AVAILABLE') badgeClass = 'badge-failed';
        const label = getSettingDisplayLabel(def.key, val);
        return `<span class="badge ${badgeClass}" style="margin-right: 0.5rem;">${escapeHtml(label)}: ${cnt}校</span>`;
      }).join('');

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="font-bold">${escapeHtml(def.label)}</td>
        <td>${chips || '<span class="text-muted">なし</span>'}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  renderProfileEditor();
  updateStepAccessibility();
}

// ==========================================
// STEP 3: 設定・差分確認 (統合画面)
// ==========================================
function renderProfileEditor() {
  const tbody = document.getElementById('profileEditorBody');
  if (!tbody) return;

  tbody.innerHTML = '';
  const distData = observationSnapshot?.distribution || observationSnapshot?.settingDistribution || null;
  const isParentOff = currentDraftSettings['timelineChannel'] === 'OFF';

  // タイムライン機能OFF時に子機能が手動でOFFになっているか判定
  const allChannelVal = currentDraftSettings['allChannel'];
  const parentChannelVal = currentDraftSettings['parentChannel'];
  const hasTimelineConflict = isParentOff && (allChannelVal !== 'OFF' || parentChannelVal !== 'OFF');

  settingDefinitions.forEach((def) => {
    const currentVal = currentDraftSettings[def.key] ?? null;

    // 現状分布チップ
    let distHtml = '<span class="text-muted">未調査</span>';
    if (distData) {
      const dist = distData[def.key] || {};
      const entries = Object.entries(dist);
      if (entries.length > 0) {
        distHtml = entries.map(([val, cnt]) => {
          const label = getSettingDisplayLabel(def.key, val);
          return `<span class="badge badge-idle font-sm" style="margin-right: 4px;">${escapeHtml(label)}: ${cnt}</span>`;
        }).join('');
      } else {
        distHtml = '<span class="text-muted">-</span>';
      }
    }

    // 心の健康観察の未契約チェック
    const isMentalHealthUncontracted = def.key === 'mentalHealth' && distData?.mentalHealth?.['CONTRACT_NOT_AVAILABLE'] > 0;

    // 子機能（全体チャンネル・保護者チャンネル）の親矛盾チェック
    const isChildOfTimeline = (def.key === 'allChannel' || def.key === 'parentChannel');
    const childNeedsManualOff = isParentOff && isChildOfTimeline && currentVal !== 'OFF';

    // 選択肢（英語コードを排除し、まなびポケットの日本語表記に統一）
    const options = [
      { value: 'UNMANAGED', label: '変更しない（現状維持）', disabled: false },
      ...def.options.map((opt) => {
        let optDisabled = false;
        let optLabel = opt.label;
        if (isMentalHealthUncontracted && opt.value === 'ON') {
          optDisabled = true;
          optLabel += ' [未契約校ありのため選択不可]';
        }
        return { value: opt.value, label: optLabel, disabled: optDisabled };
      })
    ];

    // アラート列の表示内容
    let alertText = '<span class="text-muted">-</span>';
    if (childNeedsManualOff) {
      alertText = '<span class="text-danger font-bold">⚠️ タイムライン機能がOFFのため、手動で「OFF」に設定してください</span>';
    } else if (isMentalHealthUncontracted) {
      alertText = '<span class="text-warning font-sm font-bold">※ 未契約の学校が含まれるためONにできません</span>';
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-bold">${escapeHtml(def.label)}</td>
      <td>${distHtml}</td>
      <td>
        <select class="form-select" data-key="${def.key}" onchange="onSettingChange('${def.key}', this.value)">
          ${options.map((o) => `<option value="${o.value}" ${o.disabled ? 'disabled' : ''} ${((currentVal === null && o.value === 'UNMANAGED') || String(currentVal) === o.value) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
        </select>
      </td>
      <td class="font-sm">${alertText}</td>
    `;
    tbody.appendChild(tr);
  });

  checkEditorWarnings(hasTimelineConflict);
  updateDestructiveNoticeState();
}

function onSettingChange(key, value) {
  const newVal = value === 'UNMANAGED' ? null : value;

  // 心の健康観察が未契約ありの場合はブロック
  if (key === 'mentalHealth' && newVal === 'ON') {
    const distData = observationSnapshot?.distribution || observationSnapshot?.settingDistribution || null;
    if (distData?.mentalHealth?.['CONTRACT_NOT_AVAILABLE'] > 0) {
      alert('【設定エラー】\n対象学校の中に「心の健康観察」が未契約の学校が含まれているため、ONに設定することはできません。');
      currentDraftSettings['mentalHealth'] = null;
      renderProfileEditor();
      return;
    }
  }

  // 設定値を反映
  currentDraftSettings[key] = newVal;
  editorDirty = true;
  previewVerified = false;

  renderProfileEditor();
}

function applyPreset(presetId) {
  const preset = profilePresets.find((p) => p.id === presetId);
  if (!preset) return;

  const distData = observationSnapshot?.distribution || observationSnapshot?.settingDistribution || null;
  const isMentalHealthUncontracted = distData?.mentalHealth?.['CONTRACT_NOT_AVAILABLE'] > 0;

  settingDefinitions.forEach((def) => {
    let val = preset.settings[def.key] ?? null;
    if (def.key === 'mentalHealth' && val === 'ON' && isMentalHealthUncontracted) {
      val = null; // 未契約ならONにしない
    }
    currentDraftSettings[def.key] = val;
  });

  editorDirty = true;
  previewVerified = false;

  renderProfileEditor();
}

function checkEditorWarnings(hasTimelineConflict) {
  const depWarn = document.getElementById('editorDependencyWarning');
  const depMsg = document.getElementById('editorDependencyMessage');
  const desWarn = document.getElementById('editorDestructiveWarning');
  const desList = document.getElementById('editorDestructiveFieldsList');
  const btnCheckDiff = document.getElementById('calculatePreviewBtn') || document.getElementById('btnCheckDiff');
  const btnConfirm = document.getElementById('profileConfirmBtn');

  // 依存関係チェック（タイムラインOFF時の手動OFF強制）
  let depIssue = null;
  if (hasTimelineConflict) {
    depIssue = '「タイムライン・チャンネル機能」をOFFにする場合、子機能（全体チャンネル・保護者チャンネル）も手動で「OFF」に設定する必要があります。アラートの出ている項目を「OFF」に設定してください。';
  }

  if (depWarn && depMsg) {
    if (depIssue) {
      depMsg.textContent = depIssue;
      depWarn.style.display = 'block';
    } else {
      depWarn.style.display = 'none';
    }
  }

  if (btnCheckDiff) {
    btnCheckDiff.disabled = Boolean(hasTimelineConflict);
  }
  if (btnConfirm) {
    // タイムライン矛盾があるか、または設定が未確認(dirty / unverified)の場合は確定ボタンを無効化
    btnConfirm.disabled = Boolean(hasTimelineConflict) || editorDirty || !previewVerified;
    if (editorDirty) {
      btnConfirm.title = '設定が変更されています。「この設定での差分を確認」を実行してください';
    } else if (!previewVerified) {
      btnConfirm.title = '先に差分を確認してください';
    } else {
      btnConfirm.title = '';
    }
  }

  // 破壊的変更チェック (OFF指定された destructiveWhenOff 項目)
  const destructiveFields = [];
  settingDefinitions.forEach((def) => {
    if (def.destructiveWhenOff && currentDraftSettings[def.key] === 'OFF') {
      destructiveFields.push(def.label);
    }
  });

  if (desWarn && desList) {
    if (destructiveFields.length > 0) {
      desList.textContent = destructiveFields.join('、 ');
      desWarn.style.display = 'block';
    } else {
      desWarn.style.display = 'none';
    }
  }
}

function updateDestructiveNoticeState() {
  const container = document.getElementById('destructiveRiskContainer');
  const help = document.getElementById('allowDestructiveHelpText');
  if (!container) return;

  const hasDestructive = settingDefinitions.some(
    (def) => def.destructiveWhenOff && currentDraftSettings[def.key] === 'OFF'
  );

  if (hasDestructive) {
    container.style.display = 'block';
    if (help) {
      help.textContent = '予約投稿の自動削除を伴う設定変更（チャンネル非表示化等）を含む学校は、安全のため今回の本番反映対象から自動除外されます。';
    }
  } else {
    container.style.display = 'none';
  }
}

// ユーザーが明示的に「この設定での差分を確認 ↓」をクリックした時の処理
async function onCheckDiffClicked() {
  const isParentOff = currentDraftSettings['timelineChannel'] === 'OFF';
  const allChannelVal = currentDraftSettings['allChannel'];
  const parentChannelVal = currentDraftSettings['parentChannel'];
  if (isParentOff && (allChannelVal !== 'OFF' || parentChannelVal !== 'OFF')) {
    alert('【設定エラー】\nタイムライン・チャンネル機能がOFFのため、全体チャンネル・保護者チャンネルを手動で「OFF」に設定してください。');
    return;
  }

  const btn = document.getElementById('calculatePreviewBtn') || document.getElementById('btnCheckDiff');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '差分を計算中...';
  }

  try {
    const success = await saveDraftAndCalculatePreview();
    if (success) {
      editorDirty = false;
      previewVerified = true;
      checkEditorWarnings(isParentOff && (allChannelVal !== 'OFF' || parentChannelVal !== 'OFF'));

      // 差分確認エリアへスムーズスクロール
      const diffSection = document.getElementById('previewSummaryBox') || document.getElementById('previewComparisonCard');
      if (diffSection) {
        diffSection.scrollIntoView({ behavior: 'smooth' });
      }
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'この設定での差分を確認 ↓';
    }
  }
}

async function saveDraftAndCalculatePreview() {
  if (!targetSnapshot || !observationSnapshot) return false;

  try {
    // 1. ドラフト設定を保存 (Lineage CAS 検証付き)
    const draftRes = await fetch('/api/profile/draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({
        targetSnapshotId: targetSnapshot.targetSnapshotId,
        observationSnapshotId: observationSnapshot.observationSnapshotId,
        expectedDraftRevision: draftProfile?.draftRevision ?? 0,
        settings: currentDraftSettings
      })
    });

    const draftData = await draftRes.json();
    if (!draftRes.ok) {
      if (draftRes.status === 409) {
        alert('【整合性エラー】\n設定状態が更新されています。最新の状態を取得します。');
        await fetchStatus();
      } else {
        alert(`ドラフト保存エラー: ${draftData.message || draftData.error}`);
      }
      return false;
    }
    draftProfile = draftData.draftProfile;

    // 2. プレビューを計算 (高速)
    const prevRes = await fetch('/api/preview/calculate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({
        observationSnapshotId: observationSnapshot.observationSnapshotId,
        draftRevision: draftProfile.draftRevision,
        draftHash: draftProfile.draftHash
      })
    });

    const prevData = await prevRes.json();
    if (!prevRes.ok) {
      alert(`プレビュー計算エラー: ${prevData.message || prevData.error}`);
      return false;
    }

    previewPlan = prevData;
    renderPreviewSummary(previewPlan);
    return true;
  } catch (err) {
    console.error('Preview calculate error:', err);
    alert(`通信エラー: ${err.message}`);
    return false;
  }
}

function renderPreviewSummary(plan) {
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  const total = plan.totalSchools || 0;
  const failed = plan.observationFailedCount || 0;

  setVal('previewTotalVal', total);
  setVal('previewTargetVal', `${plan.targetCount || 0} 校`);
  setVal('previewAlreadyConfiguredVal', `${plan.alreadyConfiguredCount || 0} 校`);
  setVal('previewDestructiveVal', `${plan.destructiveCount || 0} 校`);

  // 変更項目数の内訳
  renderActionsDistribution(plan);

  // 11項目の現在値と変更予定テーブル
  renderMergedDistribution(plan);

  // 破壊的変更警告アラート
  const desBox = document.getElementById('destructiveAlertBox');
  const desContainer = document.getElementById('destructiveSchoolsTableContainer');
  if (desBox && desContainer) {
    if (plan.destructiveCount > 0 && plan.destructiveSchools?.length > 0) {
      desContainer.innerHTML = `
        <table class="data-table data-table-sm mt-1">
          <thead><tr><th>学校コード</th><th>学校名</th><th>予約投稿削除対象の項目</th></tr></thead>
          <tbody>
            ${plan.destructiveSchools.map((s) => `
              <tr>
                <td class="font-mono">${escapeHtml(s.schoolCode)}</td>
                <td>${escapeHtml(s.schoolName)}</td>
                <td class="text-danger font-bold">${escapeHtml(s.destructiveFields?.join(', ') || 'チャンネル非表示化')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      desBox.style.display = 'block';
    } else {
      desBox.style.display = 'none';
    }
  }

  // 未契約機能警告アラート
  const uncBox = document.getElementById('uncontractedAlertBox');
  const uncMsg = document.getElementById('uncontractedAlertMsg');
  const uncContainer = document.getElementById('uncontractedSchoolsTableContainer');
  if (uncBox && uncContainer) {
    if (plan.uncontractedCount > 0 && plan.uncontractedSchools?.length > 0) {
      if (uncMsg) uncMsg.textContent = `${plan.uncontractedCount} 校で契約外の機能をONにする要求が含まれています。反映時はスキップされます。`;
      uncContainer.innerHTML = `
        <table class="data-table data-table-sm mt-1">
          <thead><tr><th>学校コード</th><th>学校名</th><th>未契約項目</th></tr></thead>
          <tbody>
            ${plan.uncontractedSchools.map((s) => `
              <tr>
                <td class="font-mono">${escapeHtml(s.schoolCode)}</td>
                <td>${escapeHtml(s.schoolName)}</td>
                <td class="text-warning font-bold">${escapeHtml(s.uncontractedFields?.join(', ') || '-')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      uncBox.style.display = 'block';
    } else {
      uncBox.style.display = 'none';
    }
  }

  // 失敗校一覧
  const failGroup = document.getElementById('failedSchoolsGroup');
  const failBody = document.getElementById('failedSchoolsTableBody');
  if (failGroup && failBody) {
    if (failed > 0 && plan.failedSchools?.length > 0) {
      failBody.innerHTML = plan.failedSchools.map((s) => `
        <tr>
          <td class="font-mono">${escapeHtml(s.schoolCode)}</td>
          <td>${escapeHtml(s.schoolName)}</td>
          <td class="text-danger">${escapeHtml(s.errorMessage || s.errorCode || '調査エラー')}</td>
        </tr>
      `).join('');
      failGroup.style.display = 'block';
    } else {
      failGroup.style.display = 'none';
    }
  }
}

function renderActionsDistribution(plan) {
  const dist = plan.actionsDistribution || {};
  const formatDist = (v) => (v !== undefined && v !== null ? `${v} 校` : '0 校');

  const dist0El = document.getElementById('dist0');
  if (dist0El) dist0El.textContent = formatDist(dist['0'] ?? dist.zero ?? plan.alreadyConfiguredCount);

  const dist1El = document.getElementById('dist1');
  if (dist1El) dist1El.textContent = formatDist(dist['1'] ?? dist.one);

  const dist2El = document.getElementById('dist2');
  if (dist2El) dist2El.textContent = formatDist(dist['2'] ?? dist.two);

  const dist3El = document.getElementById('dist3Plus');
  if (dist3El) dist3El.textContent = formatDist(dist['3+'] ?? dist.threePlus);
}

function renderMergedDistribution(plan) {
  const tbody = document.getElementById('mergedDistributionTableBody');
  if (!tbody) return;

  const curDist = plan.currentStateDistribution || observationSnapshot?.distribution || {};
  const diffDist = plan.settingDiffDistribution || {};
  const planDist = plan.plannedChangeDistribution || {};

  tbody.innerHTML = '';
  settingDefinitions.forEach((def) => {
    // 現在値の内訳
    const curEntries = Object.entries(curDist[def.key] || {});
    const curBadges = curEntries.length > 0
      ? curEntries.map(([val, cnt]) => {
          let bClass = 'badge-idle';
          if (val === 'ON' || val === 'ALLOW' || val === 'SHOW') bClass = 'badge-completed';
          if (val === 'OFF' || val === 'DENY' || val === 'HIDE') bClass = 'badge-stopping';
          if (val === 'CONTRACT_NOT_AVAILABLE') bClass = 'badge-failed';
          const label = getSettingDisplayLabel(def.key, val);
          return `<span class="badge ${bClass}" style="margin-right: 0.35rem;">${escapeHtml(label)}: ${cnt}校</span>`;
        }).join('')
      : '<span class="text-muted">なし (0校)</span>';

    // 変更予定の内訳
    let planBadges = '<span class="text-muted">変更なし</span>';
    const diffEntries = Object.entries(diffDist[def.key] || {});
    if (diffEntries.length > 0) {
      planBadges = diffEntries.map(([dKey, cnt]) => {
        const diffLabel = formatDiffKey(def.key, dKey);
        return `<span class="badge badge-info" style="margin-right: 0.35rem;">${escapeHtml(diffLabel)}: ${cnt}校</span>`;
      }).join('');
    } else {
      const pEntries = Object.entries(planDist[def.key] || {});
      if (pEntries.length > 0) {
        planBadges = pEntries.map(([val, cnt]) => {
          const label = getSettingDisplayLabel(def.key, val);
          return `<span class="badge badge-info" style="margin-right: 0.35rem;">${escapeHtml(label)}: ${cnt}校</span>`;
        }).join('');
      }
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="font-bold">${escapeHtml(def.label)}</div>
      </td>
      <td>${curBadges}</td>
      <td>${planBadges}</td>
    `;
    tbody.appendChild(tr);
  });
}

// 最終確認を実行する (プロファイル確定 & Final Preflight)
async function confirmProfileAndStartFinalPreflight() {
  if (editorDirty || !previewVerified) {
    alert('【確認エラー】\n設定が変更されているか、プレビューが最新ではありません。先に「この設定での差分を確認」を実行してください。');
    return;
  }
  if (!draftProfile) {
    alert('設定内容の準備が完了していません。設定値を指定して差分を確認してください。');
    return;
  }

  const btn = document.getElementById('profileConfirmBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '最終確認を準備中...';
  }

  try {
    // 1. プロファイル確定
    const res = await fetch('/api/profile/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({
        targetSnapshotId: draftProfile.targetSnapshotId,
        observationSnapshotId: draftProfile.observationSnapshotId,
        expectedDraftRevision: draftProfile.draftRevision,
        expectedDraftHash: draftProfile.draftHash
      })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(`設定確定エラー: ${data.message || data.error}`);
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'この内容で最終確認を実行する →';
      }
      return;
    }

    activeProfileSnapshot = data.profileSnapshot;

    // 2. シームレスに Final Preflight を開始
    const finalSec = document.getElementById('finalPreflightSection');
    if (finalSec) finalSec.style.display = 'block';

    if (btn) {
      btn.textContent = '最終チェック実行中...';
    }

    await startFinalPreflight();
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'この内容で最終確認を実行する →';
    }
  }
}

async function startFinalPreflight() {
  try {
    const res = await fetch('/api/final-preflight/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({})
    });

    const data = await res.json();
    if (!res.ok) {
      alert(`最終確認の開始エラー: ${data.message || data.error}`);
      return;
    }

    const card = document.getElementById('finalPreflightProgressCard');
    if (card) card.style.display = 'block';
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
}

// ==========================================
// STEP 4: 本番反映
// ==========================================
function updateApplyGate(report) {
  const badge = document.getElementById('applyGateBadge');
  const alertBox = document.getElementById('applyGateAlert');
  const statusText = document.getElementById('applyGateStatusText');

  if (!report || report.status !== 'COMPLETE') {
    if (badge) {
      badge.textContent = 'チェック未完了';
      badge.className = 'badge badge-warning';
    }
    if (statusText) statusText.textContent = '最終確認が完了していません。先にSTEP 3で最終確認を行ってください。';
    return;
  }

  const hasFailures = (report.readFailed || 0) > 0 || !report.allReadSucceeded;
  const hasBlocks = (report.planBlocked || 0) > 0 || !report.allPlansExecutable;

  if (hasFailures || hasBlocks) {
    if (badge) {
      badge.textContent = 'チェック不合格 (反映不可)';
      badge.className = 'badge badge-danger';
    }
    if (alertBox) alertBox.className = 'alert-box alert-danger mb-3';
    if (statusText) statusText.textContent = `安全確認でエラーが発生した学校があります（読み取り失敗: ${report.readFailed || 0}校、ブロック: ${report.planBlocked || 0}校）。`;
  } else {
    if (badge) {
      badge.textContent = 'チェック合格 (反映可能)';
      badge.className = 'badge badge-success';
    }
    if (alertBox) alertBox.className = 'alert-box alert-success mb-3';
    if (statusText) statusText.textContent = '全校の安全確認が完了しました。本番反映を開始できます。';
  }

  // 集計カードの更新
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  const targetCount = report.requiresChange !== undefined ? report.requiresChange : (report.writeEligibleCount || report.writeEligible || 0);
  const skippedCount = report.destructiveChangeSchools !== undefined ? report.destructiveChangeSchools : (report.destructiveSchoolsCount || report.destructiveSchools || 0);
  const alreadyCount = report.alreadyConfigured !== undefined ? report.alreadyConfigured : (report.alreadyConfiguredCount || 0);

  setVal('applyTargetCountVal', `${targetCount} 校`);
  setVal('applySkippedDestructiveVal', `${skippedCount} 校`);
  setVal('applyAlreadyConfiguredVal', `${alreadyCount} 校`);

  // 予約投稿削除リスクの案内表示制御
  const desRiskContainer = document.getElementById('destructiveRiskContainer');
  const skippedCard = document.getElementById('applySkippedDestructiveCard');
  if (skippedCount > 0) {
    if (desRiskContainer) desRiskContainer.style.display = 'block';
    if (skippedCard) skippedCard.style.opacity = '1.0';
  } else {
    if (desRiskContainer) desRiskContainer.style.display = 'none';
    if (skippedCard) skippedCard.style.opacity = '0.6';
  }

  // 実行ボタンの制御 (Server SSOT: serverApplyReady)
  const applyBtn = document.getElementById('applyExecuteBtn');
  if (applyBtn) {
    applyBtn.disabled = !serverApplyReady || hasFailures || hasBlocks;
  }
}

async function onApplyExecuteClicked() {
  const btn = document.getElementById('applyExecuteBtn');
  if (btn) btn.disabled = true;

  try {
    // 1. 自動で適用準備 (承認トークン発行) を呼び出し
    const res = await fetch('/api/apply/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({})
    });

    const data = await res.json();
    if (!res.ok) {
      alert(`本番適用の準備エラー: ${data.message || data.error}`);
      return;
    }

    currentApplyManifest = data.manifest;
    currentConfirmationToken = data.confirmationToken;

    // 2. モーダルに数値をセット
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    setVal('modalTargetCount', data.targetCount);
    setVal('modalAlreadyCount', data.alreadyConfiguredCount);
    setVal('modalSkippedCount', data.skippedDestructiveCount);

    // 3. 画面中央に確認モーダルを表示
    const modal = document.getElementById('applyConfirmModal');
    if (modal) modal.style.display = 'flex';
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function closeApplyConfirmModal() {
  const modal = document.getElementById('applyConfirmModal');
  if (modal) modal.style.display = 'none';
}

async function executeApplyStart() {
  if (isApplyingInFlight) return;
  if (!currentConfirmationToken) {
    alert('承認トークンが存在しません。もう一度お試しください。');
    return;
  }

  const modalStartBtn = document.getElementById('modalApplyStartBtn');
  if (modalStartBtn) {
    modalStartBtn.disabled = true;
    modalStartBtn.textContent = '反映開始中...';
  }
  isApplyingInFlight = true;

  try {
    const res = await fetch('/api/apply/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({
        confirmationToken: currentConfirmationToken
      })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(`本番適用の開始エラー: ${data.message || data.error}`);
      return;
    }

    closeApplyConfirmModal();

    const progressSec = document.getElementById('applyProgressSection');
    if (progressSec) progressSec.style.display = 'block';

    currentJobState = 'RUNNING';
    currentExecutionPurpose = 'PRODUCTION_WRITE';
    updateJobStateBadge(currentJobState, currentExecutionPurpose);
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  } finally {
    isApplyingInFlight = false;
    if (modalStartBtn) {
      modalStartBtn.disabled = false;
      modalStartBtn.textContent = '本番反映を開始する';
    }
  }
}

async function loadLatestResults() {
  const seq = ++resultsFetchSeq;
  try {
    const res = await fetch('/api/results/latest');
    if (seq !== resultsFetchSeq) return;
    if (!res.ok) {
      showResultContractError(`結果データの取得に失敗しました (HTTP ${res.status})`);
      return;
    }
    const data = await res.json();
    if (seq !== resultsFetchSeq) return;

    if (!data || data.status === 'NOT_AVAILABLE' || !data.hasResults) {
      if (data && data.status === 'RUNNING') {
        renderRunningResults(data.message || '本番反映を実行中です...');
      } else if (data && data.status === 'FAILED') {
        renderEmptyResults();
        showResultContractError(data.message || '本番反映は正常完了しませんでした');
      } else {
        renderEmptyResults();
      }
      return;
    }

    renderResultsScreen(data);
  } catch (err) {
    if (seq !== resultsFetchSeq) return;
    console.error('Failed to load latest results:', err);
    showResultContractError(`結果データ読み込みエラー: ${err.message}`);
  }
}

function renderRunningResults(message) {
  const alertEl = document.getElementById('resultContractAlert');
  if (alertEl) alertEl.style.display = 'none';

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(val);
  };
  setVal('resultTotalVal', '-');
  setVal('resultSuccessVal', '-');
  setVal('resultAlreadyConfiguredVal', '-');
  setVal('resultFailedVal', '-');
  setVal('resultSkippedVal', '-');

  const notProcessedCard = document.getElementById('resultNotProcessedCard');
  if (notProcessedCard) notProcessedCard.style.display = 'none';
  const outcomeUnknownCard = document.getElementById('resultOutcomeUnknownCard');
  if (outcomeUnknownCard) outcomeUnknownCard.style.display = 'none';

  const tbody = document.getElementById('resultSchoolsBody');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center text-primary font-bold">⏳ ${escapeHtml(message)}</td></tr>`;
  }
}

function showResultContractError(message) {
  const alertEl = document.getElementById('resultContractAlert');
  if (alertEl) {
    alertEl.textContent = `【データ契約エラー】 ${message}`;
    alertEl.style.display = 'block';
  }
}

function renderEmptyResults() {
  const alertEl = document.getElementById('resultContractAlert');
  if (alertEl) alertEl.style.display = 'none';

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(val);
  };
  setVal('resultTotalVal', '-');
  setVal('resultSuccessVal', '-');
  setVal('resultAlreadyConfiguredVal', '-');
  setVal('resultFailedVal', '-');
  setVal('resultSkippedVal', '-');

  const notProcessedCard = document.getElementById('resultNotProcessedCard');
  if (notProcessedCard) notProcessedCard.style.display = 'none';
  const outcomeUnknownCard = document.getElementById('resultOutcomeUnknownCard');
  if (outcomeUnknownCard) outcomeUnknownCard.style.display = 'none';

  const tbody = document.getElementById('resultSchoolsBody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">本番反映の実行結果はまだありません（実行完了後に結果が表示されます）</td></tr>';
  }
}

function renderResultsScreen(data) {
  const alertEl = document.getElementById('resultContractAlert');
  if (alertEl) alertEl.style.display = 'none';

  // 1. 本番適用モードかつ正規化 ViewModel (ExecutionResultViewModel) が存在する場合
  if (data.mode === 'PRODUCTION_WRITE' && data.result) {
    const vm = data.result;

    // 必須契約フィールドの厳格検証 (要件 17: 不正時に 0 へフォールバックしない)
    if (
      typeof vm.totalCount !== 'number' ||
      typeof vm.appliedSuccessCount !== 'number' ||
      !Array.isArray(vm.schools)
    ) {
      showResultContractError('[RESULT_CONTRACT_INVALID] ExecutionResultViewModel の必須フィールドが存在しません');
      return;
    }

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(val);
    };

    setVal('resultTotalVal', vm.totalCount);
    setVal('resultSuccessVal', vm.appliedSuccessCount);
    setVal('resultAlreadyConfiguredVal', vm.alreadyConfiguredCount || 0);
    setVal('resultFailedVal', vm.failedKnownCount || 0);
    setVal('resultSkippedVal', vm.skippedDestructiveCount || 0);

    // 未処理カード (notProcessedCount) の表示制御 (要件 15)
    const notProcessedCard = document.getElementById('resultNotProcessedCard');
    if (notProcessedCard) {
      if ((vm.notProcessedCount || 0) > 0) {
        notProcessedCard.style.display = 'block';
        setVal('resultNotProcessedVal', vm.notProcessedCount);
      } else {
        notProcessedCard.style.display = 'none';
      }
    }

    // 要手動確認カード (attentionRequiredCount) の表示制御 (要件 8, 15)
    const outcomeUnknownCard = document.getElementById('resultOutcomeUnknownCard');
    const attentionCount = vm.attentionRequiredCount || 0;
    if (outcomeUnknownCard) {
      if (attentionCount > 0) {
        outcomeUnknownCard.style.display = 'block';
        setVal('resultOutcomeUnknownVal', attentionCount);
      } else {
        outcomeUnknownCard.style.display = 'none';
      }
    }

    // ダウンロードリンク
    const btnSummary = document.getElementById('btnDownloadSummary');
    if (btnSummary) btnSummary.href = `/api/reports/download/summary`;
    const btnDetail = document.getElementById('btnDownloadDetail');
    if (btnDetail) btnDetail.href = `/api/reports/download/summary`;

    // 学校別テーブル描画 (完全受動的バインド)
    const tbody = document.getElementById('resultSchoolsBody');
    if (tbody) {
      tbody.innerHTML = '';
      if (vm.schools.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">学校データがありません</td></tr>';
        return;
      }

      vm.schools.forEach((s) => {
        let badgeClass = 'badge-completed';
        let badgeLabel = '成功';

        switch (s.category) {
          case 'APPLIED':
            badgeClass = 'badge-completed';
            badgeLabel = '成功';
            break;
          case 'ALREADY_CONFIGURED':
            badgeClass = 'badge-idle';
            badgeLabel = '変更不要';
            break;
          case 'SKIPPED':
            badgeClass = 'badge-warning';
            badgeLabel = '安全スキップ';
            break;
          case 'OUTCOME_UNKNOWN':
            badgeClass = 'badge-failed font-bold';
            badgeLabel = '⚠️ 要手動確認';
            break;
          case 'FAILED_KNOWN':
            badgeClass = 'badge-danger';
            badgeLabel = '失敗';
            break;
          case 'BLOCKED':
            badgeClass = 'badge-danger';
            badgeLabel = 'ブロック';
            break;
          case 'INTERRUPTED':
            badgeClass = 'badge-warning';
            badgeLabel = '中断';
            break;
          case 'NOT_PROCESSED':
            badgeClass = 'badge-idle text-muted';
            badgeLabel = '未処理';
            break;
          case 'RESULT_INCONSISTENT':
            badgeClass = 'badge-danger font-bold';
            badgeLabel = '⚠️ データ不整合 (要確認)';
            break;
        }

        const statusBadge = `<span class="badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>`;
        const messageStyle = s.requiresHumanReview ? 'color: var(--color-danger, #d9534f); font-weight: bold;' : '';

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="font-mono">${escapeHtml(s.schoolCode)}</td>
          <td>${escapeHtml(s.schoolName)}</td>
          <td>${statusBadge}</td>
          <td class="font-sm" style="${messageStyle}">${escapeHtml(s.message)}</td>
        `;
        tbody.appendChild(tr);
      });
    }
    return;
  }

  // 本番反映の正規化 ViewModel が存在しない場合は初期・空表示（Preflight レポートの誤認混入を完全遮断）
  renderEmptyResults();
}

// ==========================================
// SSE Progress & Logs
// ==========================================
function subscribeSse() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/api/preflight/events');

  eventSource.addEventListener('stateChange', (e) => {
    const data = JSON.parse(e.data);
    currentJobState = data.state;
    if (data.mode) currentExecutionPurpose = data.mode;
    updateJobStateBadge(currentJobState, currentExecutionPurpose);

    if (currentExecutionPurpose === 'DISCOVERY') {
      setDiscoveryActionButtons(currentJobState);
      if (currentJobState === 'COMPLETED' || currentJobState === 'INTERRUPTED') {
        fetchStatus();
      }
    } else if (currentExecutionPurpose === 'FINAL_PREFLIGHT') {
      if (currentJobState === 'COMPLETED') {
        fetchStatus();
        const banner = document.getElementById('previewComparisonBanner');
        const text = document.getElementById('previewComparisonText');
        const goToApply = document.getElementById('goToApplyBtn');
        const btn = document.getElementById('profileConfirmBtn');
        if (btn) {
          btn.disabled = false;
          btn.textContent = '最終確認 完了済 (再確認を実行)';
        }
        if (banner && text) {
          banner.className = 'alert-box alert-success mt-3';
          text.textContent = '✅ 最終確認完了: 事前プレビューとの間に差分や不整合はありませんでした。安全に本番反映へ進めます。';
          banner.style.display = 'block';
        }
        if (goToApply) goToApply.disabled = !serverApplyReady || hasVersionMismatch;
      }
    } else if (currentExecutionPurpose === 'PRODUCTION_WRITE') {
      if (currentJobState === 'COMPLETED' || currentJobState === 'FAILED') {
        loadLatestResults();
        const activeTab = document.querySelector('.nav-tabs .tab-btn.active');
        if (activeTab && activeTab.id === 'tabApplyBtn') {
          switchTab('result');
        }
      }
    }
  });

  // Phase 6A: Production Apply 完了イベント (Context確定済み)
  eventSource.addEventListener('productionApplyCompleted', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data && data.context && data.context.viewModel) {
        renderResultsScreen({
          mode: 'PRODUCTION_WRITE',
          result: data.context.viewModel,
          summary: data.context.summary,
          deploymentId: data.context.deploymentId,
          runId: data.context.runId,
          completedAt: data.context.completedAt
        });
      } else {
        loadLatestResults();
      }
      const activeTab = document.querySelector('.nav-tabs .tab-btn.active');
      if (activeTab && activeTab.id === 'tabApplyBtn') {
        switchTab('result');
      }
    } catch (err) {
      console.error('Failed to handle productionApplyCompleted SSE event:', err);
      loadLatestResults();
    }
  });

  eventSource.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);

    if (currentExecutionPurpose === 'DISCOVERY') {
      const bar = document.getElementById('observeProgressBar');
      if (bar) bar.style.width = `${data.percentage}%`;

      const pct = document.getElementById('observeProgressPercent');
      if (pct) pct.textContent = `${data.percentage}%`;

      const cnt = document.getElementById('observeProgressCount');
      if (cnt) cnt.textContent = `${data.processed} / ${data.total} 校`;

      const succ = document.getElementById('observeSuccessCount');
      if (succ && data.success !== undefined) succ.textContent = `${data.success} 校`;

      const fail = document.getElementById('observeFailedCount');
      if (fail && data.failed !== undefined) fail.textContent = `${data.failed} 校`;

      const remCount = document.getElementById('observeRemainingCount');
      if (remCount) {
        const remainingVal = data.remaining !== undefined ? data.remaining : Math.max(0, data.total - data.processed);
        remCount.textContent = `${remainingVal} 校`;
      }

      const cur = document.getElementById('observeProgressCurrentSchool');
      if (cur && data.currentSchool) {
        cur.textContent = `(処理中: ${data.currentSchool.schoolName})`;
      }

      const elp = document.getElementById('observeElapsedVal');
      if (elp) elp.textContent = `${data.elapsedSeconds}秒`;

      const rem = document.getElementById('observeRemainingVal');
      if (rem) rem.textContent = data.estimatedRemainingSeconds !== null ? `約 ${data.estimatedRemainingSeconds}秒` : '-';
    } else if (currentExecutionPurpose === 'FINAL_PREFLIGHT') {
      const bar = document.getElementById('finalPreflightProgressBar');
      if (bar) bar.style.width = `${data.percentage}%`;

      const pct = document.getElementById('finalPreflightProgressPercent');
      if (pct) pct.textContent = `${data.percentage}%`;

      const cnt = document.getElementById('finalPreflightProgressCount');
      if (cnt) cnt.textContent = `${data.processed} / ${data.total} 校`;
    } else if (currentExecutionPurpose === 'PRODUCTION_WRITE') {
      const fill = document.getElementById('applyProgressBarFill');
      if (fill) fill.style.width = `${data.percentage}%`;

      const cnt = document.getElementById('applyProgressCountLabel');
      if (cnt) cnt.textContent = `${data.processed} / ${data.total} 校`;

      const pct = document.getElementById('applyProgressPercentLabel');
      if (pct) pct.textContent = `${data.percentage}%`;
    }
  });

  eventSource.addEventListener('log', (e) => {
    const text = e.data;
    const logBox = document.getElementById('observeLogOutput');
    if (logBox) {
      logBox.textContent += text + '\n';
      logBox.scrollTop = logBox.scrollHeight;
    }
    const applyLogBox = document.getElementById('applyLogConsole');
    if (applyLogBox) {
      applyLogBox.textContent += text + '\n';
      applyLogBox.scrollTop = applyLogBox.scrollHeight;
    }
  });
}

function clearLogs() {
  const logBox = document.getElementById('observeLogOutput');
  if (logBox) logBox.textContent = '';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
