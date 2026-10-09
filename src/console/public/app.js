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
let initialTabRestored = false;

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
  checkApiKeyStatus();
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

  if (tabName === 'apply') {
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
    } else if (activeProfileSnapshot || draftProfile) {
      // ダイレクト反映モード時の Apply Gate 更新
      updateApplyGate(previewPlan || draftProfile);
    }

    // 初回ロード時に最高到達ステップへ自動遷移（リロードによる一からの誤認を防止）
    if (!initialTabRestored) {
      initialTabRestored = true;
      if (activeProfileSnapshot || (targetSnapshot && observationSnapshot && draftProfile)) {
        switchTab('apply');
      } else if (observationSnapshot) {
        switchTab('decide');
      } else if (targetSnapshot) {
        switchTab('observe');
      }
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
  const isDirectReady = Boolean(targetSnapshot && observationSnapshot && (draftProfile || activeProfileSnapshot));
  if (tabApply) tabApply.disabled = ((!serverApplyReady && !activeFinalPreflightReport && !isDirectReady) || hasVersionMismatch);
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
function getDiscoveryConcurrency() {
  const concEl = document.getElementById('discoveryConcurrencySelect');
  if (!concEl) return 3;
  const val = parseInt(concEl.value, 10);
  return isNaN(val) ? 3 : Math.max(1, Math.min(val, 5));
}

async function startDiscovery() {
  try {
    const concurrency = getDiscoveryConcurrency();
    const res = await fetch('/api/discovery/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({ concurrency })
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
    const concurrency = getDiscoveryConcurrency();
    const res = await fetch('/api/discovery/resume', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({ concurrency })
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
    const concurrency = getDiscoveryConcurrency();
    const res = await fetch('/api/discovery/retry-failed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({ concurrency })
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
  const concSelect = document.getElementById('discoveryConcurrencySelect');

  if (concSelect) {
    concSelect.disabled = (state === 'RUNNING');
  }

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
  const isTimelineOff = currentDraftSettings['timelineChannel'] === 'OFF';
  const allChannelVal = currentDraftSettings['allChannel'];
  const parentChannelVal = currentDraftSettings['parentChannel'];
  const hasTimelineConflict = isTimelineOff && (allChannelVal !== 'OFF' || parentChannelVal !== 'OFF');

  const isDmOff = currentDraftSettings['directMessage'] === 'OFF';
  const parentDmVal = currentDraftSettings['parentDirectMessage'];
  const hasDmConflict = isDmOff && parentDmVal !== 'OFF';

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

    // 子機能（全体チャンネル・保護者チャンネル・保護者個別メッセージ）の親矛盾チェック
    const isChildOfTimeline = (def.key === 'allChannel' || def.key === 'parentChannel');
    const childNeedsManualOff = isTimelineOff && isChildOfTimeline && currentVal !== 'OFF';
    const isChildOfDm = def.key === 'parentDirectMessage';
    const dmChildNeedsManualOff = isDmOff && isChildOfDm && currentVal !== 'OFF';

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
    } else if (dmChildNeedsManualOff) {
      alertText = '<span class="text-danger font-bold">⚠️ 個別メッセージ機能がOFFのため、手動で「OFF」に設定してください</span>';
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

  checkEditorWarnings(hasTimelineConflict, hasDmConflict);
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

function checkEditorWarnings(hasTimelineConflict, hasDmConflict) {
  const depWarn = document.getElementById('editorDependencyWarning');
  const depMsg = document.getElementById('editorDependencyMessage');
  const desWarn = document.getElementById('editorDestructiveWarning');
  const desList = document.getElementById('editorDestructiveFieldsList');
  const btnCheckDiff = document.getElementById('calculatePreviewBtn') || document.getElementById('btnCheckDiff');
  const btnConfirm = document.getElementById('profileConfirmBtn');

  // 依存関係チェック（タイムライン・個別メッセージOFF時の手動OFF強制）
  const depIssues = [];
  if (hasTimelineConflict) {
    depIssues.push('「タイムライン・チャンネル機能」をOFFにする場合、子機能（全体チャンネル・保護者チャンネル）も手動で「OFF」に設定する必要があります。');
  }
  if (hasDmConflict) {
    depIssues.push('「個別メッセージ機能」をOFFにする場合、子機能（保護者との個別メッセージ）も手動で「OFF」に設定する必要があります。');
  }

  const hasConflict = depIssues.length > 0;
  if (depWarn && depMsg) {
    if (hasConflict) {
      depMsg.textContent = depIssues.join(' ') + ' アラートの出ている項目を「OFF」に設定してください。';
      depWarn.style.display = 'block';
    } else {
      depWarn.style.display = 'none';
    }
  }

  if (btnCheckDiff) {
    btnCheckDiff.disabled = hasConflict;
  }
  if (btnConfirm) {
    // 依存関係矛盾があるか、または設定が未確認(dirty / unverified)の場合は確定ボタンを無効化
    btnConfirm.disabled = hasConflict || editorDirty || !previewVerified;
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
  const isTimelineOff = currentDraftSettings['timelineChannel'] === 'OFF';
  const allChannelVal = currentDraftSettings['allChannel'];
  const parentChannelVal = currentDraftSettings['parentChannel'];
  if (isTimelineOff && (allChannelVal !== 'OFF' || parentChannelVal !== 'OFF')) {
    alert('【設定エラー】\nタイムライン・チャンネル機能がOFFのため、全体チャンネル・保護者チャンネルを手動で「OFF」に設定してください。');
    return;
  }

  const isDmOff = currentDraftSettings['directMessage'] === 'OFF';
  const parentDmVal = currentDraftSettings['parentDirectMessage'];
  if (isDmOff && parentDmVal !== 'OFF') {
    alert('【設定エラー】\n個別メッセージ機能がOFFのため、保護者との個別メッセージを手動で「OFF」に設定してください。');
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
      const hasTimelineConflict = isTimelineOff && (allChannelVal !== 'OFF' || parentChannelVal !== 'OFF');
      const hasDmConflict = isDmOff && parentDmVal !== 'OFF';
      checkEditorWarnings(hasTimelineConflict, hasDmConflict);

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
      btn.textContent = '事前検証(ドライラン巡回)を実行する';
    }
  }
}

// 最終確認 (ドライラン巡回) を省略し、直接本番反映画面へ進む
async function confirmProfileAndGoToApply() {
  if (editorDirty || !previewVerified) {
    alert('【確認エラー】\n設定が変更されているか、プレビューが最新ではありません。先に「この設定での差分を確認」を実行してください。');
    return;
  }
  if (!draftProfile) {
    alert('設定内容の準備が完了していません。設定値を指定して差分を確認してください。');
    return;
  }

  const btn = document.getElementById('profileDirectApplyBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '設定を確定中...';
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
        btn.textContent = 'この内容で本番反映へ進む (最終チェック省略) →';
      }
      return;
    }

    activeProfileSnapshot = data.profileSnapshot;

    // 2. ドライランをスキップして直接本番反映画面へ切り替え
    switchTab('apply');
    updateApplyGate(null);
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'この内容で本番反映へ進む (最終チェック省略) →';
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
async function ensurePreviewPlan() {
  if (previewPlan) return previewPlan;
  if (!observationSnapshot || !draftProfile) return null;
  try {
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
    if (prevRes.ok) {
      previewPlan = await prevRes.json();
      return previewPlan;
    }
  } catch {}
  return null;
}

async function updateApplyGate(report) {
  const badge = document.getElementById('applyGateBadge');
  const alertBox = document.getElementById('applyGateAlert');
  const statusText = document.getElementById('applyGateStatusText');
  const applyBtn = document.getElementById('applyExecuteBtn');

  if (!report || report.status !== 'COMPLETE') {
    // previewPlan が未ロードなら自動補完
    if (!previewPlan) {
      await ensurePreviewPlan();
    }

    // Preflight が未実行でも、previewPlan があれば直接反映可能
    if (previewPlan && (activeProfileSnapshot || draftProfile)) {
      if (badge) {
        badge.textContent = '直接反映準備完了';
        badge.className = 'badge badge-success';
      }
      if (alertBox) alertBox.className = 'alert-box alert-success mb-3';
      if (statusText) statusText.textContent = '現状調査（STEP 2）の確認結果に基づき、直接本番反映を開始できます（事前ドライラン省略モード）。';

      const allowDestructiveCheckbox = document.getElementById('applyAllowDestructiveCheckbox');
      const isAllowDestructiveChecked = Boolean(allowDestructiveCheckbox && allowDestructiveCheckbox.checked);
      updateApplyGateCounts(null, isAllowDestructiveChecked);

      const destructiveSchools = previewPlan.destructiveCount || 0;
      const desRiskContainer = document.getElementById('destructiveRiskContainer');
      if (destructiveSchools > 0) {
        if (desRiskContainer) desRiskContainer.style.display = 'block';
      } else {
        if (desRiskContainer) desRiskContainer.style.display = 'none';
      }

      if (applyBtn) applyBtn.disabled = false;
      return;
    }

    if (badge) {
      badge.textContent = 'チェック未完了';
      badge.className = 'badge badge-warning';
    }
    if (statusText) statusText.textContent = '最終確認が完了していません。先にSTEP 3で設定の差分確認・確定を行ってください。';
    if (applyBtn) applyBtn.disabled = true;
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

  // 集計カードの更新 (Phase 6B: allowDestructive チェック状態を反映)
  const allowDestructiveCheckbox = document.getElementById('applyAllowDestructiveCheckbox');
  const isAllowDestructiveChecked = Boolean(allowDestructiveCheckbox && allowDestructiveCheckbox.checked);

  updateApplyGateCounts(report, isAllowDestructiveChecked);

  // 予約投稿削除リスクの案内表示制御
  const destructiveSchools = report.destructiveChangeSchools !== undefined ? report.destructiveChangeSchools : (report.destructiveSchoolsCount || report.destructiveSchools || 0);
  const desRiskContainer = document.getElementById('destructiveRiskContainer');
  if (destructiveSchools > 0) {
    if (desRiskContainer) desRiskContainer.style.display = 'block';
  } else {
    if (desRiskContainer) desRiskContainer.style.display = 'none';
  }

  // 実行ボタンの制御 (Server SSOT: serverApplyReady)
  if (applyBtn) {
    applyBtn.disabled = !serverApplyReady || hasFailures || hasBlocks;
  }
}

// Phase 6B: 画面4の集計カード動的更新
function updateApplyGateCounts(report, isAllowDestructiveChecked) {
  const source = report || previewPlan;
  if (!source) return;

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  const totalRequiresChange = source.requiresChange !== undefined ? source.requiresChange : (source.targetCount || source.writeEligibleCount || 0);
  const totalDestructive = source.destructiveChangeSchools !== undefined ? source.destructiveChangeSchools : (source.destructiveCount || source.destructiveSchoolsCount || 0);
  const alreadyCount = source.alreadyConfigured !== undefined ? source.alreadyConfigured : (source.alreadyConfiguredCount || 0);

  let targetCount = 0;
  let skippedCount = 0;

  if (isAllowDestructiveChecked) {
    // 破壊的変更も合意の上で反映: 変更対象校すべてが反映対象
    targetCount = totalRequiresChange;
    skippedCount = 0;
  } else {
    // 破壊的変更は自動除外 (非破壊のみ反映)
    targetCount = Math.max(0, totalRequiresChange - totalDestructive);
    skippedCount = totalDestructive;
  }

  setVal('applyTargetCountVal', `${targetCount} 校`);
  setVal('applySkippedDestructiveVal', `${skippedCount} 校`);
  setVal('applyAlreadyConfiguredVal', `${alreadyCount} 校`);

  const skippedCard = document.getElementById('applySkippedDestructiveCard');
  if (skippedCard) {
    skippedCard.style.opacity = skippedCount > 0 ? '1.0' : '0.6';
  }
}

// Phase 6B: チェックボックス切り替えイベント
function onAllowDestructiveToggled(isChecked) {
  updateApplyGateCounts(activeFinalPreflightReport || previewPlan, isChecked);
}

async function onApplyExecuteClicked() {
  const btn = document.getElementById('applyExecuteBtn');
  if (btn) btn.disabled = true;

  const allowDestructiveCheckbox = document.getElementById('applyAllowDestructiveCheckbox');
  const allowDestructive = Boolean(allowDestructiveCheckbox && allowDestructiveCheckbox.checked);
  const isDirect = !activeFinalPreflightReport && Boolean(previewPlan);

  try {
    // 1. 自動で適用準備 (承認トークン発行) を呼び出し (Phase 6B: allowDestructive & directApply を送信)
    const res = await fetch('/api/apply/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({
        allowDestructive,
        directApply: isDirect
      })
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

    // Phase 6B: モーダル内の破壊的変更警告と同意チェックボックス制御
    const modalDestructiveAlert = document.getElementById('modalDestructiveAlert');
    const modalNonDestructiveNote = document.getElementById('modalNonDestructiveNote');
    const modalDestructiveConfirmCheckbox = document.getElementById('modalDestructiveConfirmCheckbox');
    const modalStartBtn = document.getElementById('modalApplyStartBtn');

    const destructiveCount = activeFinalPreflightReport?.destructiveChangeSchools || previewPlan?.destructiveCount || 0;
    if (allowDestructive && destructiveCount > 0) {
      if (modalDestructiveAlert) modalDestructiveAlert.style.display = 'block';
      if (modalNonDestructiveNote) modalNonDestructiveNote.style.display = 'none';
      setVal('modalDestructiveIncludedCount', destructiveCount);

      if (modalDestructiveConfirmCheckbox) {
        modalDestructiveConfirmCheckbox.checked = false;
      }
      if (modalStartBtn) {
        modalStartBtn.disabled = true; // 同意チェックを入れるまでボタン無効化
      }
    } else {
      if (modalDestructiveAlert) modalDestructiveAlert.style.display = 'none';
      if (modalNonDestructiveNote) modalNonDestructiveNote.style.display = 'block';
      if (modalStartBtn) {
        modalStartBtn.disabled = false;
      }
    }

    // 3. 画面中央に確認モーダルを表示
    const modal = document.getElementById('applyConfirmModal');
    if (modal) modal.style.display = 'flex';
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Phase 6B: モーダル内の承諾チェックボックス変更ハンドラ
function updateModalApplyStartBtn() {
  const checkbox = document.getElementById('modalDestructiveConfirmCheckbox');
  const btn = document.getElementById('modalApplyStartBtn');
  if (btn && checkbox) {
    btn.disabled = !checkbox.checked;
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

  let logBuffer = [];
  let logFlushTimer = null;
  const MAX_LOG_LINES = 250;

  function appendLog(line) {
    logBuffer.push(line);
    if (!logFlushTimer) {
      logFlushTimer = setTimeout(() => {
        const chunk = logBuffer.join('\n') + '\n';
        logBuffer = [];
        logFlushTimer = null;

        const updateBox = (id) => {
          const box = document.getElementById(id);
          if (box) {
            box.textContent += chunk;
            const lines = box.textContent.split('\n');
            if (lines.length > MAX_LOG_LINES) {
              box.textContent = lines.slice(-MAX_LOG_LINES).join('\n');
            }
            box.scrollTop = box.scrollHeight;
          }
        };

        updateBox('observeLogOutput');
        updateBox('applyLogConsole');
      }, 100);
    }
  }

  eventSource.addEventListener('log', (e) => {
    let text = e.data;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.line === 'string') {
        text = parsed.line;
      }
    } catch {}
    appendLog(text);
  });

  // AI-Governed Platform SSE Events
  eventSource.addEventListener('platformEvent', (e) => {
    try {
      const data = JSON.parse(e.data);
      handlePlatformEvent(data);
    } catch (err) {
      console.error('Failed to parse platformEvent', err);
    }
  });

  eventSource.addEventListener('platformProgress', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.summary) {
        updateProgressDashboard(data.summary);
      }
      if (data.event) {
        handlePlatformEvent(data.event);
      }
    } catch (err) {
      console.error('Failed to parse platformProgress', err);
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

/* =============================================================================
 * AI-Governed Browser Platform Controller (自然な日本語UX・対話型AI計画・実Backend進捗同期)
 * ============================================================================= */
let platformCurrentJobId = null;
let platformTargetSet = null;
let platformPlan = null;
let platformPolicy = null;
let platformActiveRunResults = [];

function switchAppMode(mode) {
  const platContainer = document.getElementById('platformContainer');
  const legContainer = document.getElementById('legacyContainer');
  const btnPlat = document.getElementById('modePlatformBtn');
  const btnLeg = document.getElementById('modeLegacyBtn');

  if (mode === 'platform') {
    if (platContainer) platContainer.style.display = 'block';
    if (legContainer) legContainer.style.display = 'none';
    btnPlat?.classList.add('active');
    btnLeg?.classList.remove('active');
  } else {
    if (platContainer) platContainer.style.display = 'none';
    if (legContainer) legContainer.style.display = 'block';
    btnLeg?.classList.add('active');
    btnPlat?.classList.remove('active');
  }
}

function switchWizardStep(stepNum) {
  [1, 2, 3].forEach((s) => {
    const btn = document.getElementById(`wizStep${s}Btn`);
    const screen = document.getElementById(`wizScreenStep${s}`);
    if (s === stepNum) {
      btn?.classList.add('active');
      if (screen) {
        screen.style.display = 'block';
        screen.classList.add('active');
      }
    } else {
      btn?.classList.remove('active');
      if (screen) {
        screen.style.display = 'none';
        screen.classList.remove('active');
      }
    }
  });
}

// -----------------------------------------------------------------------------
// リアルタイム進捗イベントハンドラー (実Backend State同期)
// -----------------------------------------------------------------------------
function handlePlatformEvent(event) {
  if (!event) return;
  const stage = event.stage || 'PROCESSING';
  const msg = event.message || '';
  const now = new Date().toLocaleTimeString();

  // グローバルバナー更新
  const banner = document.getElementById('platformGlobalEventBanner');
  const badge = document.getElementById('platformGlobalStageBadge');
  const text = document.getElementById('platformGlobalMessageText');
  const time = document.getElementById('platformGlobalTimeText');
  const spinner = document.getElementById('platformGlobalSpinner');

  if (banner && text) {
    banner.style.display = 'block';
    if (badge) badge.textContent = stage;
    text.textContent = msg;
    if (time) time.textContent = now;

    if (stage.includes('SUCCESS') || stage.includes('READY') || stage === 'COMPLETED') {
      banner.style.borderLeftColor = '#10b981';
      banner.style.background = '#ecfdf5';
      banner.style.color = '#065f46';
      if (badge) badge.style.background = '#10b981';
      if (spinner) spinner.style.display = 'none';
    } else if (stage.includes('FAILED') || stage.includes('ERROR') || stage.includes('REJECTED')) {
      banner.style.borderLeftColor = '#ef4444';
      banner.style.background = '#fef2f2';
      banner.style.color = '#991b1b';
      if (badge) badge.style.background = '#ef4444';
      if (spinner) spinner.style.display = 'none';
    } else {
      banner.style.borderLeftColor = '#0284c7';
      banner.style.background = '#f0f9ff';
      banner.style.color = '#0369a1';
      if (badge) badge.style.background = '#0284c7';
      if (spinner) spinner.style.display = 'inline-block';
    }
  }

  // ステップごとの補助テキスト更新
  if (stage === 'TARGET_PARSING' || stage === 'TARGET_PARSED') {
    const el = document.getElementById('parseStatusText');
    if (el) el.textContent = msg;
  }
  if (stage.startsWith('LOGIN_') || stage === 'IDENTITY_VERIFY') {
    const el = document.getElementById('loginValidationStatusText');
    if (el) el.textContent = msg;
  }
  if (stage === 'AI_PLANNING' || stage === 'PLAN_READY') {
    const el1 = document.getElementById('planGeneratingStatusText');
    const el2 = document.getElementById('refineStatusText');
    if (el1) el1.textContent = msg;
    if (el2) el2.textContent = msg;
  }
  if (stage.startsWith('DRY_RUN_')) {
    const el = document.getElementById('dryRunStatusLabel');
    if (el) el.textContent = msg;
  }
  if (stage.startsWith('CANARY_') || stage.startsWith('FULL_') || stage === 'COMPLETED') {
    const el = document.getElementById('runActionStatusText');
    if (el) el.textContent = msg;
  }
}

// -----------------------------------------------------------------------------
// Step 1: 対象学校の入力・読み取り・ログイン確認 (上→下フロー)
// -----------------------------------------------------------------------------
async function executeParseTargets() {
  const rawText = document.getElementById('targetRawTextInput')?.value || '';
  const btn = document.getElementById('btnParseTargets');
  const status = document.getElementById('parseStatusText');
  if (btn) btn.disabled = true;
  if (status) status.textContent = '入力内容を読み取り・整理しています...';

  try {
    const res = await fetch('/api/platform/targets/parse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({ rawText })
    });
    const data = await res.json();
    if (data.targetSet) {
      platformTargetSet = data.targetSet;
      renderTargetSummary(data.targetSet);
      if (status) status.textContent = '読み取りが完了しました。続けてログイン確認を行ってください。';
    } else {
      alert('学校リストの読み取りに失敗しました: ' + (data.message || data.error));
    }
  } catch (err) {
    alert('通信エラーが発生しました: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderTargetSummary(targetSet) {
  const card = document.getElementById('targetSummaryCard');
  if (card) card.style.display = 'block';

  document.getElementById('statTargetTotal').textContent = targetSet.summary.total;
  document.getElementById('statTargetReady').textContent = targetSet.summary.ready;
  document.getElementById('statTargetMissing').textContent = targetSet.summary.missing;
  document.getElementById('statTargetAmbiguous').textContent = targetSet.summary.ambiguous;

  const tbody = document.getElementById('targetSchoolsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  targetSet.schools.forEach((s) => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #e2e8f0';

    let badgeClass = 'badge-success';
    let statusLabel = '準備完了';
    if (s.validationStatus === 'MISSING') {
      badgeClass = 'badge-warning';
      statusLabel = '情報不足';
    } else if (s.validationStatus === 'AMBIGUOUS') {
      badgeClass = 'badge-danger';
      statusLabel = '重複・競合';
    }

    let note = '全必須項目正常';
    if (s.missingFields && s.missingFields.length > 0) {
      note = `不足項目: ${s.missingFields.join(', ')}`;
    }
    if (s.ambiguityReason) {
      note = s.ambiguityReason;
    }

    tr.innerHTML = `
      <td style="padding: 8px;"><code>${escapeHtml(s.schoolCode)}</code></td>
      <td style="padding: 8px; font-weight: bold;">${escapeHtml(s.schoolName)}</td>
      <td style="padding: 8px; font-family: monospace; color: #64748b;">${escapeHtml(s.credentialRef || '未設定')}</td>
      <td style="padding: 8px;"><span class="badge ${badgeClass}">${escapeHtml(statusLabel)}</span></td>
      <td style="padding: 8px; font-size: 0.85rem; color: #64748b;">${escapeHtml(note)}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function executeValidateLogin() {
  if (!platformTargetSet) return;
  const btn = document.getElementById('btnValidateLogin');
  const status = document.getElementById('loginValidationStatusText');
  if (btn) btn.disabled = true;
  if (status) status.textContent = '実ブラウザでログイン確認を開始しています...';

  try {
    const res = await fetch('/api/platform/targets/validate-login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({ targetSet: platformTargetSet })
    });
    const data = await res.json();
    const box = document.getElementById('loginValidationResultsBox');
    const text = document.getElementById('loginValidationResultsText');
    if (box && text) {
      box.style.display = 'block';
      text.innerHTML = `対象 <strong>${data.total}</strong> 校中、<strong>${data.valid}</strong> 校でログインおよび学校所属・権限確認（Strict Identity Verify）に成功しました。`;
    }
    if (status) status.textContent = 'ログイン確認完了';

    // テーブルの補足列を更新
    if (data.results && Array.isArray(data.results)) {
      const tbody = document.getElementById('targetSchoolsTableBody');
      if (tbody) {
        data.results.forEach((r, idx) => {
          const row = tbody.children[idx];
          if (row) {
            const noteCell = row.children[4];
            if (noteCell) {
              noteCell.innerHTML = r.status === 'VALID'
                ? `<span style="color: #10b981; font-weight: bold;">✓ ログイン確認済</span> (${escapeHtml(r.message)})`
                : `<span style="color: #ef4444; font-weight: bold;">✗ ログイン失敗</span> (${escapeHtml(r.message)})`;
            }
          }
        });
      }
    }
  } catch (err) {
    alert('ログイン確認中に通信エラーが発生しました: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// -----------------------------------------------------------------------------
// Claude API キー管理 (Claude Haiku 5.5)
// -----------------------------------------------------------------------------
async function checkApiKeyStatus() {
  try {
    const res = await fetch('/api/platform/config/api-key-status');
    if (!res.ok) return;
    const data = await res.json();
    const badge = document.getElementById('apiKeyStatusBadge');
    const input = document.getElementById('inputClaudeApiKey');
    if (!badge) return;

    if (data.configured) {
      badge.textContent = `✅ 設定済み (${data.model || 'Claude Haiku 5.5'})`;
      badge.style.background = '#10b981';
      badge.style.color = '#fff';
      if (input && data.maskedKey) {
        input.placeholder = `設定済み: ${data.maskedKey}`;
      }
    } else {
      badge.textContent = '⚠️ 未設定 (要入力)';
      badge.style.background = '#f59e0b';
      badge.style.color = '#fff';
    }
  } catch (err) {
    console.warn('API key status check failed:', err.message);
  }
}

async function saveClaudeApiKey() {
  const input = document.getElementById('inputClaudeApiKey');
  const msg = document.getElementById('apiKeySaveMsg');
  const btn = document.getElementById('btnSaveApiKey');
  const key = input?.value?.trim() || '';

  if (!key) {
    alert('Claude APIキー (sk-ant-...) を入力してください。');
    return;
  }

  if (btn) btn.disabled = true;
  if (msg) msg.textContent = 'APIキーを検証・保存しています...';

  try {
    const res = await fetch('/api/platform/config/api-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({ apiKey: key })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      if (msg) {
        msg.innerHTML = `<span style="color: #10b981; font-weight: bold;">✓ ${escapeHtml(data.message)}</span>`;
      }
      if (input) input.value = '';
      await checkApiKeyStatus();
      // エラーアラートを消去
      const alertBox = document.getElementById('planErrorAlertBox');
      if (alertBox) alertBox.style.display = 'none';
    } else {
      if (msg) {
        msg.innerHTML = `<span style="color: #ef4444; font-weight: bold;">✗ 保存失敗: ${escapeHtml(data.message || data.error)}</span>`;
      }
    }
  } catch (err) {
    if (msg) msg.textContent = '通信エラー: ' + err.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// -----------------------------------------------------------------------------
// Step 2: 作業手順の計画 (対話型AI計画 & 差分表示)
// -----------------------------------------------------------------------------
async function executeGeneratePlan() {
  if (!platformTargetSet) {
    alert('先にStep 1で対象学校の読み取りを行ってください。');
    return;
  }
  const userInstruction = document.getElementById('taskInstructionInput')?.value || '';
  const btn = document.getElementById('btnGeneratePlan');
  const status = document.getElementById('planGeneratingStatusText');
  const alertBox = document.getElementById('planErrorAlertBox');
  const alertMsg = document.getElementById('planErrorAlertMessage');
  const container = document.getElementById('planPreviewContainer');

  if (alertBox) alertBox.style.display = 'none';
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Claude Haiku 5.5 が指示を分析し、作業計画を作成しています...';

  try {
    const res = await fetch('/api/platform/plan/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({
        targetSet: platformTargetSet,
        userInstruction
      })
    });
    const data = await res.json();

    if (!res.ok || data.error || data.executionPlan?.status === 'PLAN_AI_UNAVAILABLE') {
      const errMsg = data.message || data.error || '計画の立案に失敗しました。';
      if (status) status.textContent = '⚠️ 計画立案が中断されました';
      if (alertBox && alertMsg) {
        alertBox.style.display = 'block';
        alertMsg.innerHTML = `${escapeHtml(errMsg)}`;
      }
      if (container) container.style.display = 'none';
      return;
    }

    if (data.executionPlan) {
      platformCurrentJobId = data.jobId;
      platformPlan = data.executionPlan;
      platformPolicy = data.policy;

      // 差分カードは非表示 (新規作成のため)
      const diffCard = document.getElementById('planDiffCard');
      if (diffCard) diffCard.style.display = 'none';

      renderExecutionPlan(data.executionPlan, data.timeEstimate, data.costEstimate);
      if (status) status.textContent = '作業計画が完成しました。内容をご確認ください。';
    }
  } catch (err) {
    if (status) status.textContent = '通信エラーが発生しました';
    if (alertBox && alertMsg) {
      alertBox.style.display = 'block';
      alertMsg.textContent = '通信エラー: ' + err.message;
    }
    if (container) container.style.display = 'none';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function executeRefinePlan() {
  if (!platformTargetSet || !platformCurrentJobId) {
    alert('先に作業計画を作成してください。');
    return;
  }
  const refinementInstruction = document.getElementById('planRefinementInput')?.value || '';
  if (!refinementInstruction.trim()) {
    alert('追加や変更したい指示を入力してください。');
    return;
  }

  const btn = document.getElementById('btnRefinePlan');
  const status = document.getElementById('refineStatusText');
  const alertBox = document.getElementById('planErrorAlertBox');
  const alertMsg = document.getElementById('planErrorAlertMessage');
  if (alertBox) alertBox.style.display = 'none';

  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Claude Haiku 5.5 が修正指示を反映して再計画しています...';

  try {
    const res = await fetch('/api/platform/plan/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({
        targetSet: platformTargetSet,
        previousJobId: platformCurrentJobId,
        refinementInstruction
      })
    });
    const data = await res.json();
    if (!res.ok) {
      alert('計画の再作成に失敗しました: ' + (data.message || data.error));
      return;
    }

    if (data.executionPlan) {
      platformCurrentJobId = data.jobId;
      platformPlan = data.executionPlan;
      platformPolicy = data.policy;

      // 古い承認・シミュレーションの無効化 (Invalidation)
      resetApprovalsForNewPlan();

      renderExecutionPlan(data.executionPlan, data.timeEstimate, data.costEstimate);

      // 新旧差分 (PlanDiff) の描画
      if (data.executionPlan.planDiff) {
        renderPlanDiff(data.executionPlan.planDiff);
      }

      if (status) status.textContent = '修正指示が反映されました。差分と新しい計画をご確認ください。';
      // 入力欄をクリア
      const input = document.getElementById('planRefinementInput');
      if (input) input.value = '';
    }
  } catch (err) {
    alert('再計画の通信エラー: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function resetApprovalsForNewPlan() {
  const chkGate1 = document.getElementById('chkGate1Plan');
  const chkGate2 = document.getElementById('chkGate2DryRun');
  const btnDry = document.getElementById('btnRunDryRun');
  const btnStep3 = document.getElementById('btnGoToStep3');

  if (chkGate1) {
    chkGate1.checked = false;
    chkGate1.disabled = false;
  }
  if (chkGate2) {
    chkGate2.checked = false;
    chkGate2.disabled = true;
  }
  if (btnDry) btnDry.disabled = true;
  if (btnStep3) btnStep3.disabled = true;

  const dryStatus = document.getElementById('dryRunStatusLabel');
  if (dryStatus) dryStatus.textContent = '作業計画が更新されたため、再シミュレーションと再承認が必要です';
}

function renderPlanDiff(diff) {
  const card = document.getElementById('planDiffCard');
  if (!card || !diff) return;

  card.style.display = 'block';
  document.getElementById('planDiffSummaryText').textContent = diff.summaryText || diff.summaryOfChanges || '計画が更新されました。';

  const list = document.getElementById('planDiffDetailsList');
  if (!list) return;
  list.innerHTML = '';

  const addedList = diff.added || diff.addedOperations || [];
  addedList.forEach(op => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>追加された操作:</strong> ${escapeHtml(op)}`;
    list.appendChild(li);
  });

  const removedList = diff.removed || diff.removedOperations || [];
  removedList.forEach(op => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>削除された操作:</strong> <del>${escapeHtml(op)}</del>`;
    list.appendChild(li);
  });

  const modifiedList = diff.modifiedParameters || [];
  modifiedList.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>設定値の変更:</strong> ${escapeHtml(p)}`;
    list.appendChild(li);
  });

  const scope = diff.scopeChanges || (diff.unchanged && diff.unchanged.length > 0 ? `変更なし: ${diff.unchanged.join(', ')}` : null);
  if (scope) {
    const li = document.createElement('li');
    li.innerHTML = `<strong>対象範囲・維持項目:</strong> ${escapeHtml(scope)}`;
    list.appendChild(li);
  }
}

function renderExecutionPlan(plan, timeEst, costEst) {
  const container = document.getElementById('planPreviewContainer');
  if (container) container.style.display = 'block';

  document.getElementById('planIdLabel').textContent = plan.planId;
  document.getElementById('planAffectedSchoolsLabel').textContent = plan.estimatedAffectedSchools;

  // Haiku 作業まとめカード
  const sum = plan.humanSummary;
  const humanCard = document.getElementById('planHumanSummaryCard');
  if (humanCard && sum) {
    humanCard.style.display = 'block';
    document.getElementById('summaryOriginalText').textContent = plan.userInstruction || '-';
    document.getElementById('summaryInterpretedIntent').textContent = sum.interpretedIntent || '-';
    document.getElementById('summaryTargetScope').textContent = sum.targetScope || '指定された学校';
    document.getElementById('summaryAction').textContent = sum.actionSummary || '-';
    document.getElementById('summarySettingValue').textContent = sum.settingValueSummary || '-';
    document.getElementById('summarySkipBehavior').textContent = sum.skipBehavior || '設定済みなら安全にスキップ';
    document.getElementById('summaryCapability').textContent = sum.capabilityUsed || '-';
    document.getElementById('summaryRisk').textContent = sum.riskLevel || plan.riskLevel;
  }

  const riskBadge = document.getElementById('planRiskBadge');
  if (riskBadge) {
    let riskLabel = '安全な読み取りのみ';
    if (plan.riskLevel === 'REVERSIBLE_WRITE') riskLabel = '安全な変更 (可逆)';
    if (plan.riskLevel === 'SENSITIVE_WRITE') riskLabel = '重要な設定変更';
    if (plan.riskLevel === 'DESTRUCTIVE_WRITE') riskLabel = '注意が必要な変更';

    riskBadge.textContent = riskLabel;
    riskBadge.className = 'risk-badge ' + (
      plan.riskLevel === 'READ_ONLY' ? 'risk-read-only' :
      plan.riskLevel === 'REVERSIBLE_WRITE' ? 'risk-reversible-write' :
      plan.riskLevel === 'SENSITIVE_WRITE' ? 'risk-sensitive-write' : 'risk-destructive-write'
    );
  }

  // 具体的な実行ステップリスト
  const opList = document.getElementById('planOperationsList');
  if (opList) {
    opList.innerHTML = '';
    plan.operations.forEach((op, idx) => {
      const card = document.createElement('div');
      card.className = 'operation-card';
      let opRiskName = op.riskClass === 'READ_ONLY' ? '読み取り' : '安全な変更';
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong>ステップ ${idx + 1}: ${escapeHtml(op.operationType)}</strong>
          <span class="risk-badge ${op.riskClass === 'READ_ONLY' ? 'risk-read-only' : 'risk-reversible-write'}">${opRiskName}</span>
        </div>
        <div class="mt-2" style="font-size: 0.85rem; color: #475569; line-height: 1.5;">
          <div>設定内容: <code>${JSON.stringify(op.inputMapping)}</code></div>
          <div>事前確認: ${op.preconditions.map(p => escapeHtml(p.description)).join(', ') || 'なし'}</div>
          <div>反映後確認: ${op.verification.map(v => escapeHtml(v.description)).join(', ') || '設定完了を確認'}</div>
        </div>
      `;
      opList.appendChild(card);
    });
  }

  // 前提事項
  const asmList = document.getElementById('planAssumptionsList');
  if (asmList) {
    asmList.innerHTML = '';
    (plan.assumptions || []).forEach((a) => {
      const li = document.createElement('li');
      li.textContent = a.description;
      asmList.appendChild(li);
    });
  }

  // 予測所要時間 & AIコスト試算
  if (timeEst) {
    document.getElementById('estDurationDisplay').textContent = timeEst.displayFormatted;
    document.getElementById('estP95Display').textContent = `${timeEst.p95DurationSec}秒`;
  }
  if (costEst) {
    document.getElementById('estAiCostDisplay').textContent = `約 ¥${costEst.estimatedCostJpy}`;
    document.getElementById('estTokensDisplay').textContent = `${(costEst.estimatedInputTokens + costEst.estimatedOutputTokens).toLocaleString()} トークン`;
  }

  // 動的先行検証スコープ提案 (Step 3 への反映)
  if (plan.validationScopeProposal) {
    const prop = plan.validationScopeProposal;
    const count = prop.count !== undefined ? prop.count : (prop.proposedCount || 1);
    const unit = prop.unit === 'SCHOOL' ? '学校' : (prop.unit === 'ACCOUNT' ? 'アカウント' : (prop.targetUnit || prop.unit || '対象'));
    const reason = prop.description || prop.selectionReasoning || '本番反映の前に表示崩れや入力エラーがないかを安全に確かめるため';

    const countBox = document.getElementById('proposalScopeCounts');
    const unitBox = document.getElementById('proposalScopeUnit');
    const reasonBox = document.getElementById('proposalScopeReason');
    if (countBox) countBox.textContent = `${count} ${unit} (全体 ${plan.estimatedAffectedSchools || 0} ${unit}中)`;
    if (unitBox) unitBox.textContent = unit;
    if (reasonBox) reasonBox.textContent = reason;

    const lblGate3 = document.getElementById('labelGate3Canary');
    if (lblGate3) {
      lblGate3.textContent = `【確認 3】先行検証の実行を承認する（${count} ${unit}で安全確認を行います）`;
    }
  }
}

async function toggleGateApproval(gateId) {
  if (!platformCurrentJobId) return;
  const chk = document.getElementById(
    gateId === 'GATE_1_PLAN' ? 'chkGate1Plan' :
    gateId === 'GATE_2_DRY_RUN' ? 'chkGate2DryRun' :
    gateId === 'GATE_3_CANARY' ? 'chkGate3Canary' : 'chkGate4Full'
  );

  if (chk && chk.checked) {
    try {
      const res = await fetch('/api/platform/policy/approve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Nonce': csrfToken
        },
        body: JSON.stringify({
          jobId: platformCurrentJobId,
          gateId
        })
      });
      const data = await res.json();
      platformPolicy = data.policy;

      if (gateId === 'GATE_1_PLAN') {
        const btnDry = document.getElementById('btnRunDryRun');
        if (btnDry) btnDry.disabled = false;
        document.getElementById('dryRunStatusLabel').textContent = '【確認 1】承認済み。事前シミュレーションを実行できます';
      }
      if (gateId === 'GATE_2_DRY_RUN') {
        const btnStep3 = document.getElementById('btnGoToStep3');
        if (btnStep3) btnStep3.disabled = false;
      }
      if (gateId === 'GATE_3_CANARY') {
        const btnCanary = document.getElementById('btnRunCanary');
        if (btnCanary) btnCanary.disabled = false;
      }
      if (gateId === 'GATE_4_FULL_PRODUCTION') {
        const btnFull = document.getElementById('btnRunFull');
        if (btnFull) btnFull.disabled = false;
      }
    } catch (err) {
      alert('承認の更新に失敗しました: ' + err.message);
    }
  }
}

async function executeDryRun() {
  if (!platformCurrentJobId) return;
  const btn = document.getElementById('btnRunDryRun');
  const status = document.getElementById('dryRunStatusLabel');
  if (btn) btn.disabled = true;
  if (status) status.textContent = '事前シミュレーションを実行中（読み取りのみ・設定変更なし）...';

  try {
    const res = await fetch('/api/platform/jobs/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({
        jobId: platformCurrentJobId,
        mode: 'LOGICAL_DRY_RUN'
      })
    });
    const data = await res.json();
    if (data.summary) {
      if (status) {
        status.innerHTML = `<span style="color: #10b981; font-weight: bold;">✓ シミュレーション完了:</span> 全 ${data.summary.totalSchools} 校中 ${data.summary.successCount} 校で確認成功。本番書き込み実行: 0件（安全確認済）`;
      }
      const chkGate2 = document.getElementById('chkGate2DryRun');
      if (chkGate2) chkGate2.disabled = false;
    } else if (data.error) {
      alert('シミュレーション停止: ' + data.message);
    }
  } catch (err) {
    alert('シミュレーション実行エラー: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// -----------------------------------------------------------------------------
// Step 3: 自動実行ダッシュボード
// -----------------------------------------------------------------------------
async function executeJobRun(mode) {
  if (!platformCurrentJobId) return;
  const stopBtn = document.getElementById('btnEmergencyStop');
  const status = document.getElementById('runActionStatusText');
  if (stopBtn) stopBtn.style.display = 'inline-block';
  if (status) status.textContent = mode === 'CANARY_VALIDATION' ? '先行検証を実行中...' : '全体適用を実行中...';

  try {
    const res = await fetch('/api/platform/jobs/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({
        jobId: platformCurrentJobId,
        mode
      })
    });
    const data = await res.json();
    if (data.summary) {
      platformActiveRunResults = data.results || [];
      updateProgressDashboard(data.summary);
      renderResultsTable(data.results || []);
      if (data.analysis) {
        renderAnalystReport(data.analysis);
      }
      if (status) status.textContent = '実行が安全に完了しました。結果をご確認ください。';
    } else if (data.error) {
      alert('安全装置により停止しました: ' + (data.message || data.error));
      if (status) status.textContent = '停止: ' + data.message;
    }
  } catch (err) {
    alert('実行中にエラーが発生しました: ' + err.message);
  } finally {
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

function updateProgressDashboard(summary) {
  if (!summary) return;
  const total = summary.totalSchools || 0;
  const processed = summary.processedCount || 0;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;

  document.getElementById('progSchoolsCount').textContent = `${processed} / ${total}`;
  const bar = document.getElementById('progBarInner');
  if (bar) bar.style.width = `${pct}%`;

  document.getElementById('progSuccessCount').textContent = summary.successCount || 0;
  document.getElementById('progSkippedCount').textContent = (summary.alreadyConfiguredCount || 0) + (summary.skippedCount || 0);
  document.getElementById('progBlockedCount').textContent = summary.blockedCount || 0;
  document.getElementById('progFailedCount').textContent = summary.failedCount || 0;

  document.getElementById('progCurrentSchool').textContent = summary.currentSchool || '完了';
  document.getElementById('progCurrentOp').textContent = summary.currentOperation || 'なし';
  document.getElementById('progElapsed').textContent = `${summary.elapsedSeconds || 0}秒`;
  document.getElementById('progEtaLabel').textContent = summary.etaSeconds ? `${summary.etaSeconds}秒` : '完了';
  document.getElementById('progAiCost').textContent = `¥${summary.accumulatedAiCostJpy || 0}`;

  const cbText = summary.circuitBreakerState === 'CLOSED' ? '正常 (待機中)' : '作動中 (安全停止)';
  document.getElementById('progCircuitBreaker').textContent = cbText;

  const healthBadge = document.getElementById('platformRuntimeHealthBadge');
  if (healthBadge) {
    healthBadge.textContent = summary.runtimeHealth === 'HEALTHY' ? '稼働状態: 正常' : '稼働状態: 異常検知';
    healthBadge.style.background = summary.runtimeHealth === 'HEALTHY' ? '#10b981' : '#ef4444';
  }
}

function renderResultsTable(results) {
  const tbody = document.getElementById('resultsSchoolsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  results.forEach((r) => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #e2e8f0';

    let badgeClass = 'badge-success';
    let label = '成功';
    if (r.status === 'BLOCKED') {
      badgeClass = 'badge-warning';
      label = '安全一時停止';
    } else if (r.status === 'FAILED') {
      badgeClass = 'badge-danger';
      label = '失敗';
    } else if (r.status === 'ALREADY_CONFIGURED') {
      badgeClass = 'badge-idle';
      label = '設定済 (スキップ)';
    }

    tr.innerHTML = `
      <td style="padding: 8px;"><code>${escapeHtml(r.schoolCode)}</code></td>
      <td style="padding: 8px; font-weight: bold;">${escapeHtml(r.schoolName)}</td>
      <td style="padding: 8px;"><span class="badge ${badgeClass}">${escapeHtml(label)}</span></td>
      <td style="padding: 8px;">${(r.planned || []).map(p => `<code>${escapeHtml(p)}</code>`).join(' ')}</td>
      <td style="padding: 8px; font-size: 0.85rem; color: #475569;">
        ${r.error ? '<span class="text-danger">' + escapeHtml(r.error) + '</span>' : '設定正常反映'}
      </td>
      <td style="padding: 8px;">${r.verificationPassed ? '✅ 確認済' : '❌ 未確認'}</td>
      <td style="padding: 8px;">${Math.round((r.durationMs || 0) / 100) / 10}秒</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderAnalystReport(analysis) {
  const box = document.getElementById('analystReportCard');
  if (box) box.style.display = 'block';

  document.getElementById('analystHeadline').textContent = analysis.headlineSummary;

  const fList = document.getElementById('analystFindingsList');
  if (fList) {
    fList.innerHTML = '';
    analysis.keyFindings.forEach((f) => {
      const li = document.createElement('li');
      li.textContent = f;
      fList.appendChild(li);
    });
  }

  const rList = document.getElementById('analystRecsList');
  if (rList) {
    rList.innerHTML = '';
    analysis.recommendations.forEach((r) => {
      const li = document.createElement('li');
      li.textContent = r;
      rList.appendChild(li);
    });
  }
}

async function executeEmergencyStop() {
  try {
    await fetch('/api/platform/jobs/stop', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      }
    });
    alert('緊急停止信号を送信しました。ブラウザ操作は安全に中断されます。');
  } catch (err) {
    alert('停止要求の送信に失敗しました: ' + err.message);
  }
}

function exportResults(format) {
  if (platformActiveRunResults.length === 0) {
    alert('保存可能な実行結果がありません。');
    return;
  }

  if (format === 'json') {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(platformActiveRunResults, null, 2));
    const dl = document.createElement('a');
    dl.setAttribute('href', dataStr);
    dl.setAttribute('download', `実行結果_${Date.now()}.json`);
    dl.click();
  } else if (format === 'csv') {
    let csv = '学校コード,学校名,ステータス,画面確認,所要時間ミリ秒\n';
    platformActiveRunResults.forEach((r) => {
      csv += `"${r.schoolCode}","${r.schoolName}","${r.status}","${r.verificationPassed}","${r.durationMs}"\n`;
    });
    const dataStr = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    const dl = document.createElement('a');
    dl.setAttribute('href', dataStr);
    dl.setAttribute('download', `実行結果_${Date.now()}.csv`);
    dl.click();
  }
}

function toggleAutoProceedFull() {
  // Policy update if needed
}
