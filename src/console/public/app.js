let csrfToken = '';
let currentJobState = 'IDLE';
let eventSource = null;
let currentInputSource = 'UPLOAD';
let currentSnapshotData = null;
let settingDefinitions = [];
let profilePresets = [];
let currentProfileSettings = {};
let currentConfirmationToken = null;
let currentApplyManifest = null;
let includeDestructiveSchools = false;

document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();
  subscribeSse();
  loadLatestResults();
  setupDragAndDrop();
  loadProfileDefinitionsAndPresets();
});

function switchTab(tabName) {
  const tabs = ['setup', 'progress', 'results', 'apply'];
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

async function onSourceChange(source) {
  currentInputSource = source;
  const uploadContainer = document.getElementById('uploadContainer');
  const sourceValEl = document.getElementById('currentSourceVal');

  if (source === 'UPLOAD') {
    uploadContainer.style.display = 'block';
    if (sourceValEl) sourceValEl.textContent = 'CSV アップロード (1本化)';
  } else {
    uploadContainer.style.display = 'none';
    if (sourceValEl) sourceValEl.textContent = 'ローカル既定ファイル (config/schools.live.csv)';
  }

  // ソース変更時は Validation Snapshot を即座に無効化
  invalidateSnapshot('入力ソースが変更されました。再度「入力を検証」を実行してください。');

  try {
    await fetch('/api/source/select', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({ source })
    });
  } catch (err) {
    console.error('Failed to select source:', err);
  }
}

async function onFileSelected(files) {
  if (!files || files.length === 0) return;
  const file = files[0];

  // .xlsx 対象外チェック
  if (!file.name.toLowerCase().endsWith('.csv')) {
    alert('【ファイル形式エラー】\n選択されたファイルは .csv ではありません。\nExcel で「CSV UTF-8（コンマ区切り）（*.csv）」として保存した .csv ファイルをご利用ください（.xlsx は対象外です）。');
    return;
  }

  // 最大 5MB チェック
  if (file.size > 5 * 1024 * 1024) {
    alert('【サイズ超過エラー】\nファイルサイズが上限 (5MB) を超過しています。');
    return;
  }

  const alertBox = document.getElementById('validationAlert');
  if (alertBox) alertBox.style.display = 'none';

  try {
    const csvText = await file.text();

    const res = await fetch('/api/schools/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'X-CSRF-Nonce': csrfToken,
        'X-Filename': encodeURIComponent(file.name)
      },
      body: csvText
    });

    const data = await res.json();
    if (!res.ok) {
      alert(`CSV アップロードエラー: ${data.message || data.error}`);
      return;
    }

    // 秘密情報を一切返さない安全な表示
    document.getElementById('uploadFileInfo').style.display = 'block';
    document.getElementById('uploadFileNameVal').textContent = data.originalFileName;
    document.getElementById('uploadFileSizeVal').textContent = `(${(data.fileSize / 1024).toFixed(1)} KB)`;
    document.getElementById('uploadParsedStatsVal').textContent = `全 ${data.totalSchools} 校 (有効: ${data.enabledSchools} 校) / 認証情報: 解決完了`;

    const sourceValEl = document.getElementById('currentSourceVal');
    if (sourceValEl) sourceValEl.textContent = 'CSV アップロード (1本化)';

    // Preview テーブル描画 (schoolCode / schoolName のみ、パスワードは非表示)
    const previewBody = document.getElementById('uploadPreviewBody');
    if (previewBody) {
      previewBody.innerHTML = '';
      (data.preview || []).forEach((s, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${idx + 1}</td>
          <td><strong>${escapeHtml(s.schoolCode)}</strong></td>
          <td>${escapeHtml(s.schoolName)}</td>
          <td><span class="badge badge-success">OK (解決済)</span></td>
        `;
        previewBody.appendChild(tr);
      });
    }

    // 新規 Upload 時は自動的に入力検証を実行
    await runValidation();
  } catch (err) {
    alert(`アップロード通信エラー: ${err.message}`);
  }
}

function invalidateSnapshot(reasonMessage) {
  currentSnapshotData = null;
  const btnPreflight = document.getElementById('btnStartPreflight');
  if (btnPreflight) btnPreflight.disabled = true;
  const elEnabled = document.getElementById('enabledSchoolsVal');
  if (elEnabled) elEnabled.textContent = '-';
  const elSchoolsHash = document.getElementById('schoolsHashVal');
  if (elSchoolsHash) elSchoolsHash.textContent = '-';
  const elCredResolved = document.getElementById('credResolvedVal');
  if (elCredResolved) elCredResolved.textContent = '-';
  const elCredMissing = document.getElementById('credMissingVal');
  if (elCredMissing) elCredMissing.textContent = '-';
  const elProfileHash = document.getElementById('profileHashVal');
  if (elProfileHash) elProfileHash.textContent = '-';

  if (reasonMessage) {
    const alertBox = document.getElementById('validationAlert');
    if (alertBox) {
      alertBox.className = 'alert-box alert-warning mt-3';
      alertBox.textContent = `⚠️ ${reasonMessage}`;
      alertBox.style.display = 'block';
    }
  }
}

function onExpectedCountInput() {
  // 誤操作防止チェック削除に伴い安全な no-op
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();
    csrfToken = data.csrfToken;
    updateJobStateBadge(data.jobState);

    if (data.inputSource) {
      currentInputSource = data.inputSource;
    }

    if (data.activeUpload) {
      const uploadFileInfo = document.getElementById('uploadFileInfo');
      if (uploadFileInfo) uploadFileInfo.style.display = 'block';
      const uploadFileNameVal = document.getElementById('uploadFileNameVal');
      if (uploadFileNameVal) uploadFileNameVal.textContent = data.activeUpload.originalFileName;
      const uploadFileSizeVal = document.getElementById('uploadFileSizeVal');
      if (uploadFileSizeVal) uploadFileSizeVal.textContent = `(${(data.activeUpload.fileSize / 1024).toFixed(1)} KB)`;
      const uploadParsedStatsVal = document.getElementById('uploadParsedStatsVal');
      if (uploadParsedStatsVal) uploadParsedStatsVal.textContent = `全 ${data.activeUpload.totalSchools} 校 (有効: ${data.activeUpload.enabledSchools} 校) / ログイン情報: 確認完了`;

      const sourceValEl = document.getElementById('currentSourceVal');
      if (sourceValEl) {
        sourceValEl.textContent = 'CSVファイル アップロード';
      }
    } else if (data.snapshot) {
      const sourceValEl = document.getElementById('currentSourceVal');
      if (sourceValEl) {
        sourceValEl.textContent = data.inputSource === 'UPLOAD'
          ? 'CSVファイル アップロード'
          : 'ローカル既定ファイル (config/schools.live.csv)';
      }
    }

    if (data.snapshot) {
      currentSnapshotData = data.snapshot;
      updateSnapshotUi(data.snapshot);
      const btnPreflight = document.getElementById('btnStartPreflight');
      if (btnPreflight) btnPreflight.disabled = false;
    }

    if (data.recentLogs && data.recentLogs.length > 0) {
      const consoleEl = document.getElementById('logConsole');
      if (consoleEl) {
        consoleEl.textContent = data.recentLogs.join('\n') + '\n';
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }
    }
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

function updateJobStateBadge(state) {
  currentJobState = state;
  const badge = document.getElementById('jobStateBadge');
  if (!badge) return;

  const stateLabels = {
    'IDLE': '待機中 (IDLE)',
    'RUNNING': '実行中 (RUNNING)',
    'COMPLETED': '完了 (COMPLETED)',
    'READY': '準備完了 (READY)',
    'FAILED': 'エラー停止 (FAILED)'
  };

  badge.textContent = stateLabels[state] || state;
  badge.className = 'badge';

  if (state === 'RUNNING') {
    badge.classList.add('badge-running');
    document.getElementById('btnStopPreflight').disabled = false;
    document.getElementById('btnValidate').disabled = true;
    document.getElementById('btnStartPreflight').disabled = true;
  } else if (state === 'COMPLETED' || state === 'READY') {
    badge.classList.add('badge-success');
    document.getElementById('btnStopPreflight').disabled = true;
    document.getElementById('btnValidate').disabled = false;
  } else if (state === 'FAILED') {
    badge.classList.add('badge-danger');
    document.getElementById('btnStopPreflight').disabled = true;
    document.getElementById('btnValidate').disabled = false;
  } else {
    badge.classList.add('badge-idle');
    document.getElementById('btnStopPreflight').disabled = true;
    document.getElementById('btnValidate').disabled = false;
  }
}

function updateSnapshotUi(snap, schoolsPath) {
  const displaySource = snap.sourceName || schoolsPath || document.getElementById('schoolsFileVal').textContent;
  document.getElementById('schoolsFileVal').textContent = displaySource;
  document.getElementById('enabledSchoolsVal').textContent = `${snap.enabledSchoolCount} 校 / 全 ${snap.totalSchoolCount} 校`;
  document.getElementById('schoolsHashVal').textContent = snap.schoolsHash.substring(0, 16) + '...';
  document.getElementById('credResolvedVal').textContent = `${snap.resolvedCredentialsCount} / ${snap.enabledSchoolCount} 解決完了 (100%)`;
  document.getElementById('credMissingVal').textContent = '0';
  document.getElementById('profileHashVal').textContent = snap.profileHash.substring(0, 16) + '...';
  if (snap.profileSnapshotId) {
    document.getElementById('profileSnapshotIdVal').textContent = `(Snapshot: ${snap.profileSnapshotId})`;
  } else {
    document.getElementById('profileSnapshotIdVal').textContent = '';
  }
  document.getElementById('toolVersionLabel').textContent = `Tool: ${snap.toolVersion} (${snap.toolFingerprint.substring(0, 8)})`;
}

async function loadProfileDefinitionsAndPresets() {
  try {
    const [defsRes, presetsRes] = await Promise.all([
      fetch('/api/profile/definitions'),
      fetch('/api/profile/presets')
    ]);
    if (defsRes.ok) {
      const data = await defsRes.json();
      settingDefinitions = data.definitions || [];
    }
    if (presetsRes.ok) {
      const data = await presetsRes.json();
      profilePresets = data.presets || [];
    }

    // 推奨設定プリセットを初期値としてロード
    const recommended = profilePresets.find((p) => p.id === 'RECOMMENDED');
    if (recommended && recommended.settings) {
      currentProfileSettings = { ...recommended.settings };
    } else {
      currentProfileSettings = {};
      settingDefinitions.forEach((d) => {
        currentProfileSettings[d.key] = d.defaultValue;
      });
    }

    renderProfileEditor();
  } catch (err) {
    console.error('Failed to load profile definitions or presets:', err);
  }
}

function renderProfileEditor() {
  const tbody = document.getElementById('profileEditorTableBody');
  if (!tbody || settingDefinitions.length === 0) return;

  tbody.innerHTML = '';
  const destructiveKeys = [];

  // タイムライン機能がOFFかどうか (依存判定用)
  const isTimelineOff = currentProfileSettings['timelineChannel'] === 'OFF';

  settingDefinitions.forEach((def) => {
    const tr = document.createElement('tr');
    const currentVal = currentProfileSettings[def.key];
    const isUnmanaged = currentVal === undefined || currentVal === null;

    // 破壊的変更リスクの判定 (指示1)
    const isDestructive = def.destructiveWhenOff && currentVal === 'OFF';
    if (isDestructive) {
      destructiveKeys.push(def.label);
    }

    // 依存関係メッセージ (指示8)
    let dependencyNote = '';
    if (isTimelineOff && (def.key === 'allChannel' || def.key === 'parentChannel')) {
      dependencyNote = `<span class="badge badge-danger" style="margin-left: 0.5rem;">※タイムラインOFF連動</span>`;
    }

    // オプション選択肢HTML
    const optionsHtml = [
      `<option value="__UNMANAGED__" ${isUnmanaged ? 'selected' : ''}>UNMANAGED (変更しない)</option>`,
      ...def.options.map((opt) => {
        const isSelected = !isUnmanaged && String(currentVal) === String(opt.value);
        return `<option value="${escapeHtml(opt.value)}" ${isSelected ? 'selected' : ''}>${escapeHtml(opt.label)} (${escapeHtml(opt.value)})</option>`;
      })
    ].join('');

    // ステータス / リスク表示HTML
    let statusHtml = '';
    if (isUnmanaged) {
      statusHtml = `<span class="text-muted font-bold">変更しない (UNMANAGED)</span>`;
    } else if (isDestructive) {
      statusHtml = `<span class="badge badge-danger">⚠️ 予約投稿削除リスク</span>`;
    } else {
      statusHtml = `<span class="badge badge-success">変更する (MANAGED)</span>`;
    }

    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(def.label)}</strong>
        <div class="text-muted" style="font-size: 0.8rem; font-family: monospace;">${escapeHtml(def.key)}</div>
      </td>
      <td>
        <select class="input-select" onchange="onSettingChange('${def.key}', this.value)" style="width: 100%; font-size: 15px;">
          ${optionsHtml}
        </select>
      </td>
      <td>
        <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
          ${statusHtml}
          ${dependencyNote}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // 破壊的変更リスクリアルタイム警告バナーの制御
  const warningEl = document.getElementById('editorDestructiveWarning');
  const listEl = document.getElementById('editorDestructiveFieldsList');
  if (warningEl && listEl) {
    if (destructiveKeys.length > 0) {
      listEl.textContent = ` ${destructiveKeys.join(', ')}`;
      warningEl.style.display = 'block';
    } else {
      warningEl.style.display = 'none';
    }
  }

  // 親子機能の依存関係リアルタイムチェック (タイムラインOFFなのにチャンネルON)
  const hasDependencyConflict = isTimelineOff && (currentProfileSettings['allChannel'] === 'ON' || currentProfileSettings['parentChannel'] === 'ON');
  const depWarningEl = document.getElementById('editorDependencyWarning');
  if (depWarningEl) {
    depWarningEl.style.display = hasDependencyConflict ? 'block' : 'none';
  }
  const preflightDepWarningEl = document.getElementById('preflightDependencyWarning');
  if (preflightDepWarningEl) {
    preflightDepWarningEl.style.display = hasDependencyConflict ? 'block' : 'none';
  }
  const btnStartPreflight = document.getElementById('btnStartPreflight');
  if (btnStartPreflight && hasDependencyConflict) {
    btnStartPreflight.disabled = true;
  }
}

async function onSettingChange(key, value) {
  if (value === '__UNMANAGED__') {
    currentProfileSettings[key] = null;
  } else {
    currentProfileSettings[key] = value;
  }

  // サーバーへ即座に Invalidation を通知
  try {
    await fetch('/api/profile/invalidate', {
      method: 'POST',
      headers: { 'X-CSRF-Nonce': csrfToken }
    });
  } catch (err) {
    console.error('Failed to notify invalidate:', err);
  }

  renderProfileEditor();

  // 学校一覧が読み込まれている場合は自動で再検証を実行
  const hasSchoolSource = document.getElementById('uploadFileInfo')?.style.display !== 'none' ||
    currentInputSource === 'LOCAL_LIVE' || currentSnapshotData !== null;
  if (hasSchoolSource) {
    await runValidation();
  }
}

async function applyPreset(presetId) {
  const preset = profilePresets.find((p) => p.id === presetId);
  if (preset && preset.settings) {
    currentProfileSettings = { ...preset.settings };
  } else if (presetId === 'RECOMMENDED' || presetId === 'DEFAULT') {
    currentProfileSettings = {};
    settingDefinitions.forEach((d) => {
      currentProfileSettings[d.key] = d.defaultValue;
    });
  } else if (presetId === 'UNMANAGED_ALL') {
    currentProfileSettings = {};
    settingDefinitions.forEach((d) => {
      currentProfileSettings[d.key] = null;
    });
  } else {
    return;
  }

  // サーバーへ即座に Invalidation を通知
  try {
    await fetch('/api/profile/invalidate', {
      method: 'POST',
      headers: { 'X-CSRF-Nonce': csrfToken }
    });
  } catch (err) {
    console.error('Failed to notify invalidate:', err);
  }

  renderProfileEditor();

  // 学校一覧が読み込まれている場合は自動で再検証を実行
  const hasSchoolSource = document.getElementById('uploadFileInfo')?.style.display !== 'none' ||
    currentInputSource === 'LOCAL_LIVE' || currentSnapshotData !== null;
  if (hasSchoolSource) {
    await runValidation();
  }
}

async function exportProfileJson() {
  try {
    const res = await fetch('/api/profile/export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({ profile: currentProfileSettings })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`エクスポートエラー: ${data.message || data.error}`);
      return;
    }

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `production-profile-${data.profileHash.substring(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`エクスポート通信エラー: ${err.message}`);
  }
}

async function onProfileJsonSelected(files) {
  if (!files || files.length === 0) return;
  const file = files[0];
  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    const profileData = raw.requestedSettings || raw;

    // 設定値の反映
    const newSettings = {};
    for (const def of settingDefinitions) {
      if (profileData[def.key] !== undefined) {
        newSettings[def.key] = profileData[def.key];
      } else {
        newSettings[def.key] = null;
      }
    }
    currentProfileSettings = newSettings;

    // サーバーへ即座に Invalidation を通知 (指示4)
    await fetch('/api/profile/invalidate', {
      method: 'POST',
      headers: { 'X-CSRF-Nonce': csrfToken }
    });

    invalidateSnapshot(`プロファイル設定 JSON (${file.name}) をインポートしました。Preflight を開始する前に「入力を検証」を実行してください。`);
    renderProfileEditor();
  } catch (err) {
    alert(`JSON インポートエラー: ${err.message}`);
  }
}

async function runValidation() {
  const alertBox = document.getElementById('validationAlert');
  if (alertBox) alertBox.style.display = 'none';
  document.getElementById('btnValidate').disabled = true;
  document.getElementById('btnStartPreflight').disabled = true;

  // 親子機能の依存関係チェック（早期拒絶）
  if (currentProfileSettings['timelineChannel'] === 'OFF' &&
      (currentProfileSettings['allChannel'] === 'ON' || currentProfileSettings['parentChannel'] === 'ON')) {
    currentSnapshotData = null;
    if (alertBox) {
      alertBox.className = 'alert-box alert-danger mt-3';
      alertBox.innerHTML = '<strong>✗ 入力設定エラー (DEPENDENCY_CONFLICT)</strong>: 「タイムライン・チャンネル機能」がOFFの場合、子機能（全体チャンネル・保護者チャンネル）をONに設定することはできません。設定を見直してください。';
      alertBox.style.display = 'block';
    }
    document.getElementById('btnStartPreflight').disabled = true;
    document.getElementById('btnValidate').disabled = false;
    return;
  }

  const bodyPayload = {
    profile: currentProfileSettings
  };

  try {
    const res = await fetch('/api/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify(bodyPayload)
    });

    const data = await res.json();
    if (data.status === 'PASS') {
      currentSnapshotData = data.snapshot;
      if (alertBox) {
        alertBox.className = 'alert-box alert-success mt-3';
        alertBox.textContent = `✓ 入力検証に合格しました (Validation PASS: ${data.enabledCount} 校有効 / 資格情報 100% 解決)。事前検証を開始できます。`;
        alertBox.style.display = 'block';
      }

      updateSnapshotUi(data.snapshot, data.schoolsPath);
      document.getElementById('btnStartPreflight').disabled = false;
    } else {
      currentSnapshotData = null;
      if (alertBox) {
        alertBox.className = 'alert-box alert-danger mt-3';
        alertBox.innerHTML = `<strong>✗ 入力検証エラー (${data.error?.code || 'VALIDATION_FAILED'})</strong>: ${escapeHtml(data.error?.message || data.message || '不明なエラー')}`;
        alertBox.style.display = 'block';
      }
      document.getElementById('btnStartPreflight').disabled = true;
    }
  } catch (err) {
    currentSnapshotData = null;
    if (alertBox) {
      alertBox.className = 'alert-box alert-danger mt-3';
      alertBox.textContent = `通信エラー: ${err.message}`;
      alertBox.style.display = 'block';
    }
  } finally {
    document.getElementById('btnValidate').disabled = false;
  }
}

async function startPreflight() {
  const fileName = currentSnapshotData?.sourceName || document.getElementById('schoolsFileVal').textContent || '未定';
  const enabledCount = currentSnapshotData?.enabledSchoolCount ?? '-';
  const schoolsHash = currentSnapshotData?.schoolsHash ? currentSnapshotData.schoolsHash.substring(0, 16) + '...' : '-';

  const confirmMsg =
    `【Preflight 開始確認】\n` +
    `以下の設定で Read-only Preflight を開始しますか？\n\n` +
    `・対象ファイル: ${fileName}\n` +
    `・有効学校数: ${enabledCount} 校\n` +
    `・Schools Hash: ${schoolsHash}\n\n` +
    `※ 本処理は読み取り専用であり、設定変更・保存は一切行いません。`;

  if (!confirm(confirmMsg)) {
    return;
  }

  try {
    const res = await fetch('/api/preflight/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({})
    });

    const data = await res.json();
    if (res.ok) {
      updateJobStateBadge('RUNNING');
      switchTab('progress');
    } else {
      alert(`Preflight開始エラー: ${data.message || data.error}`);
    }
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
}

async function stopPreflight() {
  if (!confirm('実行中の Preflight 処理を安全に停止しますか？\n（現在の学校処理が完了した段階で安全に停止し、チェックポイントが保存されます）')) {
    return;
  }

  try {
    const res = await fetch('/api/preflight/stop', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({})
    });

    const data = await res.json();
    if (res.ok) {
      updateJobStateBadge('STOPPING');
    } else {
      alert(`停止要求エラー: ${data.message || data.error}`);
    }
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
}

async function resumePreflight() {
  if (!confirm('Preflight を再開しますか？\n（SUCCESS 済みの学校はスキップされ、未処理校のみ実行されます）')) {
    return;
  }

  try {
    const res = await fetch('/api/preflight/resume', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({})
    });

    const data = await res.json();
    if (res.ok) {
      updateJobStateBadge('RUNNING');
      switchTab('progress');
    } else {
      alert(`再開エラー: ${data.message || data.error}`);
    }
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
}

async function retryFailedPreflight() {
  if (!confirm('読取に失敗した学校のみ再読取を実行しますか？')) {
    return;
  }

  try {
    const res = await fetch('/api/preflight/retry-failed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({})
    });

    const data = await res.json();
    if (res.ok) {
      updateJobStateBadge('RUNNING');
      switchTab('progress');
    } else {
      alert(`再読取エラー: ${data.message || data.error}`);
    }
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
}

function subscribeSse() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/api/preflight/events');

  eventSource.addEventListener('stateChange', (e) => {
    const data = JSON.parse(e.data);
    updateJobStateBadge(data.state);
    if (data.state === 'COMPLETED') {
      loadLatestResults();
      const progressScreen = document.getElementById('screenProgress');
      if (progressScreen && progressScreen.classList.contains('active')) {
        switchTab('results');
      }
    } else if (data.state === 'FAILED') {
      loadLatestResults();
    }
  });

  eventSource.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    updateProgressUi(data);
  });

  eventSource.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    const consoleEl = document.getElementById('logConsole');
    if (consoleEl) {
      consoleEl.textContent += data.line + '\n';
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
    const applyConsoleEl = document.getElementById('applyLogConsole');
    if (applyConsoleEl) {
      applyConsoleEl.textContent += data.line + '\n';
      applyConsoleEl.scrollTop = applyConsoleEl.scrollHeight;
    }
  });
}

function updateProgressUi(prog) {
  // Preflight Progress 画面の更新
  const pCount = document.getElementById('progressCountLabel');
  if (pCount) pCount.textContent = `${prog.processed} / ${prog.total} 校`;
  const pPercent = document.getElementById('progressPercentLabel');
  if (pPercent) pPercent.textContent = `${prog.percentage}%`;
  const pBar = document.getElementById('progressBarFill');
  if (pBar) pBar.style.width = `${prog.percentage}%`;

  // Production Apply 画面の進捗更新
  const aCount = document.getElementById('applyProgressCountLabel');
  if (aCount) aCount.textContent = `${prog.processed} / ${prog.total} 校`;
  const aPercent = document.getElementById('applyProgressPercentLabel');
  if (aPercent) aPercent.textContent = `${prog.percentage}%`;
  const aBar = document.getElementById('applyProgressBarFill');
  if (aBar) aBar.style.width = `${prog.percentage}%`;

  const mSuccess = document.getElementById('metricSuccess');
  if (mSuccess) mSuccess.textContent = prog.success;
  const mFailed = document.getElementById('metricFailed');
  if (mFailed) mFailed.textContent = prog.failed;
  const mRemaining = document.getElementById('metricRemaining');
  if (mRemaining) mRemaining.textContent = prog.remaining;

  const mElapsed = document.getElementById('metricElapsed');
  if (mElapsed) mElapsed.textContent = formatSeconds(prog.elapsedSeconds);
  const mEta = document.getElementById('metricEta');
  if (mEta) {
    mEta.textContent = prog.estimatedRemainingSeconds !== null
      ? formatSeconds(prog.estimatedRemainingSeconds)
      : '--:--:--';
  }

  const schoolLabel = document.getElementById('currentSchoolLabel');
  if (schoolLabel) {
    if (prog.currentSchool) {
      schoolLabel.textContent = `[${prog.currentSchool.schoolCode}] ${prog.currentSchool.schoolName}`;
    } else if (prog.remaining === 0) {
      schoolLabel.textContent = '全校処理完了';
    }
  }
}

async function loadLatestResults() {
  try {
    const res = await fetch('/api/reports/latest');
    if (!res.ok) return;
    const data = await res.json();

    const report = data.normalized || data.preflight || data.summary;
    if (!report) {
      clearResultsUi();
      return;
    }

    const staleAlertBox = document.getElementById('resultsStaleAlertBox');
    const isStale = Boolean(data.isStale || report.isStale);
    if (staleAlertBox) {
      if (isStale) {
        staleAlertBox.style.display = 'block';
        const msgEl = document.getElementById('resultsStaleAlertMsg');
        if (msgEl) {
          msgEl.textContent = `現在選択中の入力ソースと過去の実行レポートのハッシュが一致していません (${data.staleReason || report.staleReason || 'ハッシュ不一致'})。現在の入力に対する結果を確認するには、再度「入力を検証」を行ってから Preflight を実行してください。`;
        }
      } else {
        staleAlertBox.style.display = 'none';
      }
    }

    if (report.inconsistent) {
      console.warn('【RESULTS_INCONSISTENT】レポート間のメタデータ不整合を検知しました:', report.inconsistentReason);
      const alertBox = document.getElementById('destructiveAlertBox');
      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.className = 'alert-box alert-warning mt-3';
        document.getElementById('destructiveAlertMsg').textContent =
          `⚠️ レポートメタデータ不整合 (RESULTS_INCONSISTENT): ${report.inconsistentReason || ''}`;
      }
    }

    renderSummaryMetrics(report);
    renderActionsDistribution(report);
    renderMergedDistribution(report);
    renderCurrentStateDistribution(report);
    renderPlannedChangeDistribution(report);
    renderDestructiveWarnings(report);
    renderUncontractedAlerts(report);
    renderFailedSchools(report);
    renderGlobalGateAndApplyStatus(report, data);
  } catch (err) {
    console.error('Failed to load latest results:', err);
  }
}

function renderSummaryMetrics(r) {
  const s = r;
  const formatVal = (v) => (v !== undefined && v !== null ? v : 'N/A');
  const setEl = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = formatVal(val);
  };

  setEl('resTotal', s.totalSchools ?? s.total);
  setEl('resReadSuccess', s.readSuccess);
  setEl('resReadFailed', s.readFailed);
  setEl('resAlreadyConfigured', s.alreadyConfigured);
  setEl('resRequiresChange', s.requiresChange);
  setEl('resPlanBlocked', s.planBlocked);
  setEl('resDestructiveSchools', s.destructiveChangeSchools);
  setEl('resWriteEligible', s.writeEligible ?? s.writeEligibleNonDestructive);
}

function renderMergedDistribution(r) {
  const tbody = document.getElementById('mergedDistributionTableBody');
  if (!tbody) return;

  const curDist = r.currentStateDistribution || {};
  const planDist = r.plannedChangeDistribution || {};

  const keys = settingDefinitions.length > 0
    ? settingDefinitions.map((d) => d.key)
    : Array.from(new Set([...Object.keys(curDist), ...Object.keys(planDist)]));

  if (keys.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">データなし</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  keys.forEach((key) => {
    const def = settingDefinitions.find((d) => d.key === key);
    const displayLabel = def ? def.label : key;

    const curEntries = Object.entries(curDist[key] || {});
    const curStr = curEntries.length > 0
      ? curEntries.map(([val, cnt]) => `<strong>${escapeHtml(val)}</strong>: ${cnt}校`).join(' / ')
      : '<span class="text-muted">なし (0校)</span>';

    const planEntries = Object.entries(planDist[key] || {});
    const planStr = planEntries.length > 0
      ? planEntries.map(([val, cnt]) => `<strong>${escapeHtml(val)}</strong>: ${cnt}校`).join(' / ')
      : '<span class="text-muted">なし (0校)</span>';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(displayLabel)}</strong>
        <div class="text-muted" style="font-size: 0.8rem; font-family: monospace;">${escapeHtml(key)}</div>
      </td>
      <td>${curStr}</td>
      <td>${planStr}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderActionsDistribution(r) {
  const dist = r.actionsDistribution || {};
  const formatDist = (v1, v2) => {
    const v = v1 !== undefined ? v1 : v2;
    return v !== undefined && v !== null ? `${v} 校` : 'N/A';
  };
  document.getElementById('dist0').textContent = formatDist(dist.zero, dist['0']);
  document.getElementById('dist1').textContent = formatDist(dist.one, dist['1']);
  document.getElementById('dist2').textContent = formatDist(dist.two, dist['2']);
  document.getElementById('dist3Plus').textContent = formatDist(dist.threePlus, dist['3+']);
}

function renderCurrentStateDistribution(r) {
  const tbody = document.getElementById('currentStateTableBody');
  const dist = r.currentStateDistribution;
  if (!tbody) return;

  if (!dist || Object.keys(dist).length === 0) {
    tbody.innerHTML = '<tr><td colspan="2" class="text-center text-muted">データなし</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  for (const [key, counts] of Object.entries(dist)) {
    const tr = document.createElement('tr');
    const entries = Object.entries(counts);
    const def = settingDefinitions.find((d) => d.key === key);
    const displayLabel = def ? def.label : key;
    const countsStr = entries.length > 0
      ? entries.map(([val, cnt]) => `<strong>${escapeHtml(val)}</strong>: ${cnt}校`).join(' / ')
      : '<span class="text-muted">なし (0校)</span>';
    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(displayLabel)}</strong>
        <div class="text-muted" style="font-size: 0.8rem; font-family: monospace;">${escapeHtml(key)}</div>
      </td>
      <td>${countsStr}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderPlannedChangeDistribution(r) {
  const tbody = document.getElementById('plannedChangeTableBody');
  const dist = r.plannedChangeDistribution;
  if (!tbody) return;

  if (!dist || Object.keys(dist).length === 0) {
    tbody.innerHTML = '<tr><td colspan="2" class="text-center text-muted">データなし</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  for (const [key, counts] of Object.entries(dist)) {
    const tr = document.createElement('tr');
    const entries = Object.entries(counts);
    const def = settingDefinitions.find((d) => d.key === key);
    const displayLabel = def ? def.label : key;
    const countsStr = entries.length > 0
      ? entries.map(([val, cnt]) => `<strong>${escapeHtml(val)}</strong>: ${cnt}校`).join(' / ')
      : '<span class="text-muted">なし (0校)</span>';
    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(displayLabel)}</strong>
        <div class="text-muted" style="font-size: 0.8rem; font-family: monospace;">${escapeHtml(key)}</div>
      </td>
      <td>${countsStr}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderDestructiveWarnings(r) {
  const alertBox = document.getElementById('destructiveAlertBox');
  const count = r.destructiveChangeSchools || 0;

  if (count > 0) {
    alertBox.style.display = 'block';
    alertBox.className = 'alert-box alert-danger mt-3';
    document.getElementById('destructiveAlertMsg').textContent = `破壊的変更（予約投稿削除リスク）の対象となる学校が ${count} 校存在します。本番 Write 実行時は厳格な事前確認が必要です。`;

    // 該当校の表示
    const container = document.getElementById('destructiveSchoolsTableContainer');
    const schools = (r.schools || []).filter((s) => s.hasDestructiveChanges);
    if (schools.length > 0) {
      container.innerHTML = `
        <table class="data-table mt-2">
          <thead>
            <tr><th>学校コード</th><th>学校名</th><th>変更内容 / リスク</th></tr>
          </thead>
          <tbody>
            ${schools.slice(0, 10).map((s) => `
              <tr>
                <td>${escapeHtml(s.schoolCode)}</td>
                <td>${escapeHtml(s.schoolName)}</td>
                <td><span class="badge badge-danger">SCHEDULED_POSTS_MAY_BE_DELETED</span></td>
              </tr>
            `).join('')}
            ${schools.length > 10 ? `<tr><td colspan="3" class="text-center text-muted">他 ${schools.length - 10} 校...</td></tr>` : ''}
          </tbody>
        </table>
      `;
    }
  } else {
    alertBox.style.display = 'none';
  }
}

function renderUncontractedAlerts(r) {
  const alertBox = document.getElementById('uncontractedAlertBox');
  if (!alertBox) return;

  const uncontractedSchools = (r.schools || []).filter((s) => {
    const msg = (s.errorMessage || s.errorDetails?.message || s.error || '');
    return msg.includes('未契約') || msg.includes('CONTRACT_NOT_AVAILABLE') || msg.includes('契約上非表示');
  });

  if (uncontractedSchools.length > 0) {
    alertBox.style.display = 'block';
    const msgEl = document.getElementById('uncontractedAlertMsg');
    if (msgEl) {
      msgEl.textContent = `「心の健康観察機能」等の未契約設定に対して有効化 (ON) 要求が指定されているため、計画ブロック (Blocked) となった学校が ${uncontractedSchools.length} 校存在します。未契約校を有効化することはできないため、プロファイル設定で「利用しない (OFF)」または「変更なし (UNMANAGED)」を選択してください。`;
    }
    const container = document.getElementById('uncontractedSchoolsTableContainer');
    if (container) {
      container.innerHTML = `
        <table class="data-table mt-2">
          <thead>
            <tr><th>学校コード</th><th>学校名</th><th>未契約機能 / 理由</th></tr>
          </thead>
          <tbody>
            ${uncontractedSchools.map((s) => `
              <tr>
                <td>${escapeHtml(s.schoolCode)}</td>
                <td>${escapeHtml(s.schoolName)}</td>
                <td><span class="badge badge-warning">心の健康観察機能 (未契約のためON不可)</span><div class="text-sm text-muted mt-1">${escapeHtml(s.errorMessage || '')}</div></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }
  } else {
    alertBox.style.display = 'none';
  }
}

function renderFailedSchools(r) {
  const tbody = document.getElementById('failedSchoolsTableBody');
  if (!tbody) return;

  // 読取失敗校 (FAILED) および 計画ブロック校 (planExecutable === false) の両方を対象にする
  const schools = (r.schools || []).filter((s) => s.readStatus === 'FAILED' || s.status === 'FAILED' || s.planExecutable === false);
  if (schools.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">読取失敗・ブロック校はありません (全校正常)</td></tr>';
    return;
  }

  tbody.innerHTML = schools.map((s) => {
    const isBlocked = s.planExecutable === false;
    const badgeClass = isBlocked ? 'badge badge-warning' : 'badge badge-danger';
    const badgeText = isBlocked ? 'BLOCKED' : (s.executionStatus || s.readStatus || s.status || 'FAILED');
    return `
      <tr>
        <td>${escapeHtml(s.schoolCode)}</td>
        <td>${escapeHtml(s.schoolName)}</td>
        <td><span class="${badgeClass}">${escapeHtml(badgeText)}</span></td>
        <td>${escapeHtml(s.errorMessage || s.errorDetails?.message || s.error || (isBlocked ? '計画ブロック' : 'エラー'))}</td>
      </tr>
    `;
  }).join('');
}

function formatSeconds(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function clearResultsUi() {
  const staleAlertBox = document.getElementById('resultsStaleAlertBox');
  if (staleAlertBox) staleAlertBox.style.display = 'none';

  const alertBox = document.getElementById('destructiveAlertBox');
  if (alertBox) alertBox.style.display = 'none';

  const uncontractedBox = document.getElementById('uncontractedAlertBox');
  if (uncontractedBox) uncontractedBox.style.display = 'none';

  ['resTotal', 'resReadSuccess', 'resReadFailed', 'resAlreadyConfigured', 'resRequiresChange', 'resPlanBlocked', 'resDestructiveSchools', 'resWriteEligible'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '0';
  });

  ['dist0', 'dist1', 'dist2', 'dist3Plus'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '0 校';
  });

  const mergedBody = document.getElementById('mergedDistributionTableBody');
  if (mergedBody) mergedBody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">事前検証が完了するとここに集計が表示されます</td></tr>';

  const curBody = document.getElementById('currentStateTableBody');
  if (curBody) curBody.innerHTML = '<tr><td colspan="2" class="text-center text-muted">事前検証が完了するとここに集計が表示されます</td></tr>';

  const planBody = document.getElementById('plannedChangeTableBody');
  if (planBody) planBody.innerHTML = '<tr><td colspan="2" class="text-center text-muted">事前検証が完了するとここに集計が表示されます</td></tr>';

  const failBody = document.getElementById('failedSchoolsTableBody');
  if (failBody) failBody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">失敗校はありません</td></tr>';
}

function renderGlobalGateAndApplyStatus(report, data) {
  const tabApplyBtn = document.getElementById('tabApplyBtn');
  const gateBadge = document.getElementById('applyGateBadge');
  const gateIcon = document.getElementById('applyGateIcon');
  const gateSummary = document.getElementById('applyGateSummary');
  const btnPrepare = document.getElementById('btnPrepareApply');
  const manifestBox = document.getElementById('manifestSummaryBox');

  if (!report || report.status !== 'COMPLETE') {
    if (tabApplyBtn) tabApplyBtn.disabled = true;
    if (gateBadge) {
      gateBadge.textContent = '事前検証 未完了';
      gateBadge.className = 'badge badge-idle';
    }
    if (gateIcon) gateIcon.textContent = '⏳';
    if (gateSummary) gateSummary.textContent = '事前検証が完了していません。先に「事前検証を開始する」を行ってください。';
    if (btnPrepare) btnPrepare.disabled = true;
    if (manifestBox) manifestBox.style.display = 'none';
    return;
  }

  const isStale = Boolean(data && data.isStale);
  const hasFailures = (report.readFailed || 0) > 0 || !report.allReadSucceeded;
  const hasBlocks = (report.planBlocked || 0) > 0 || !report.allPlansExecutable;

  if (isStale || hasFailures || hasBlocks) {
    if (tabApplyBtn) tabApplyBtn.disabled = true;
    if (gateBadge) {
      gateBadge.textContent = 'チェック不合格 (反映不可)';
      gateBadge.className = 'badge badge-danger';
    }
    if (gateIcon) gateIcon.textContent = '❌';
    let reasons = [];
    if (isStale) reasons.push('学校一覧または設定目標値が検証後に変更されています');
    if (hasFailures) reasons.push(`読み取り失敗校が存在します (${report.readFailed}校)`);
    if (hasBlocks) reasons.push(`計画ブロック校が存在します (${report.planBlocked}校)`);
    if (gateSummary) gateSummary.textContent = `本番反映を開始できません: ${reasons.join('、')}`;
    if (btnPrepare) btnPrepare.disabled = true;
    if (manifestBox) manifestBox.style.display = 'none';
    return;
  }

  // 合格
  if (tabApplyBtn) tabApplyBtn.disabled = false;
  if (gateBadge) {
    gateBadge.textContent = 'チェック合格 (反映可能)';
    gateBadge.className = 'badge badge-success';
  }
  if (gateIcon) gateIcon.textContent = '✅';
  
  const eligibleCount = includeDestructiveSchools
    ? (report.writeEligible ?? 0) + (report.destructiveChangeSchools ?? 0)
    : (report.writeEligible ?? 0);

  if (gateSummary) {
    gateSummary.textContent = `反映前チェックに合格しました。安全に変更可能な対象校 (${eligibleCount}校) への設定反映が可能です。`;
  }
  if (btnPrepare) btnPrepare.disabled = false;

  // 概要表示
  if (manifestBox) {
    manifestBox.style.display = 'block';
    const targetCountEl = document.getElementById('applyTargetCountVal');
    const skippedEl = document.getElementById('applySkippedDestructiveVal');
    const alreadyEl = document.getElementById('applyAlreadyConfiguredVal');
    const hashEl = document.getElementById('applyTargetHashVal');

    if (targetCountEl) targetCountEl.textContent = `${eligibleCount} 校`;
    if (skippedEl) skippedEl.textContent = includeDestructiveSchools ? '0 校 (許可済)' : `${report.destructiveChangeSchools ?? 0} 校`;
    if (alreadyEl) alreadyEl.textContent = `${report.alreadyConfigured ?? 0} 校`;
    if (hashEl) hashEl.textContent = report.applyTargetHash || '(反映準備時に確定)';
  }
}

function onAllowDestructiveChanged(checked) {
  includeDestructiveSchools = Boolean(checked);
  // 表示の即時再同期
  loadLatestResults();
}

async function prepareProductionApply() {
  const btn = document.getElementById('btnPrepareApply');
  const alertBox = document.getElementById('applyAlert');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/apply/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-nonce': csrfToken
      },
      body: JSON.stringify({ includeDestructiveSchools })
    });

    const data = await res.json();
    if (!res.ok) {
      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.className = 'alert-box alert-danger mt-3';
        alertBox.textContent = `【準備エラー】${data.message || data.error}`;
      }
      return;
    }

    currentConfirmationToken = data.confirmationToken;
    currentApplyManifest = data.manifest;

    // モーダルを開いて値を反映
    const modalTargetCount = document.getElementById('modalTargetCount');
    if (modalTargetCount) modalTargetCount.textContent = `${data.targetCount} 校`;
    const modalSkippedDestructive = document.getElementById('modalSkippedDestructive');
    if (modalSkippedDestructive) modalSkippedDestructive.textContent = `${data.skippedDestructiveCount} 校`;
    const modalAlreadyConfigured = document.getElementById('modalAlreadyConfigured');
    if (modalAlreadyConfigured) modalAlreadyConfigured.textContent = `${data.alreadyConfiguredCount} 校`;

    const riskWarningEl = document.getElementById('modalRiskWarningText');
    if (riskWarningEl) {
      riskWarningEl.textContent = includeDestructiveSchools
        ? '⚠️ 予約投稿削除リスクの学校も含めて本番反映を行います。チャンネル非表示化により予約投稿が自動削除される可能性があります。'
        : '実際の環境への設定変更を書き込みます（予約投稿削除リスクの学校は安全のため除外されます）。';
    }

    const modalApplyHash = document.getElementById('modalApplyTargetHashVal');
    if (modalApplyHash) modalApplyHash.textContent = data.manifest.applyTargetHash;
    const modalProfileHash = document.getElementById('modalProfileHashVal');
    if (modalProfileHash) modalProfileHash.textContent = data.manifest.profileHash;

    const chk = document.getElementById('modalConfirmCheckbox');
    if (chk) chk.checked = false;
    const btnExecute = document.getElementById('btnExecuteApply');
    if (btnExecute) btnExecute.disabled = true;

    const modalAlert = document.getElementById('modalAlert');
    if (modalAlert) modalAlert.style.display = 'none';

    document.getElementById('applyConfirmModal').style.display = 'flex';
  } catch (err) {
    if (alertBox) {
      alertBox.style.display = 'block';
      alertBox.className = 'alert-box alert-danger mt-3';
      alertBox.textContent = `通信エラー: ${err.message}`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function onModalCheckboxChanged(checked) {
  const btn = document.getElementById('btnExecuteApply');
  if (btn) btn.disabled = !checked;
}

function closeApplyModal() {
  const modal = document.getElementById('applyConfirmModal');
  if (modal) modal.style.display = 'none';
}

async function executeProductionApply() {
  if (!currentConfirmationToken) {
    alert('confirmationToken が存在しません。再度「反映内容を確認する」を実行してください。');
    return;
  }

  const btn = document.getElementById('btnExecuteApply');
  const modalAlert = document.getElementById('modalAlert');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/apply/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-nonce': csrfToken
      },
      body: JSON.stringify({
        confirmationToken: currentConfirmationToken,
        includeDestructiveSchools
      })
    });

    const data = await res.json();
    if (!res.ok) {
      if (modalAlert) {
        modalAlert.style.display = 'block';
        modalAlert.className = 'alert-box alert-danger mt-3';
        modalAlert.textContent = `【適用開始エラー】${data.message || data.error}`;
      }
      if (btn) btn.disabled = false;
      return;
    }

    closeApplyModal();
    switchTab('apply');
    const applyProgress = document.getElementById('applyProgressSection');
    if (applyProgress) applyProgress.style.display = 'block';
    const applyLogConsole = document.getElementById('applyLogConsole');
    if (applyLogConsole) applyLogConsole.textContent = `[INFO] 本番設定反映を開始しました (RunId: ${data.runId})\n`;
  } catch (err) {
    if (modalAlert) {
      modalAlert.style.display = 'block';
      modalAlert.className = 'alert-box alert-danger mt-3';
      modalAlert.textContent = `通信エラー: ${err.message}`;
    }
    if (btn) btn.disabled = false;
  }
}

async function resetAllResults() {
  if (!confirm('過去の検証・反映結果およびレポートをリセットし、初期状態に戻しますか？\n（過去のログ・レポートファイルは archive フォルダーに安全に退避されます）')) {
    return;
  }

  try {
    const res = await fetch('/api/results/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      }
    });

    const data = await res.json();
    if (!res.ok) {
      alert(`リセットエラー: ${data.message || data.error}`);
      return;
    }

    clearResultsUi();
    invalidateSnapshot();
    const sourceValEl = document.getElementById('currentSourceVal');
    if (sourceValEl) sourceValEl.textContent = '-';
    const schoolsFileVal = document.getElementById('schoolsFileVal');
    if (schoolsFileVal) schoolsFileVal.textContent = '-';
    const uploadFileInfo = document.getElementById('uploadFileInfo');
    if (uploadFileInfo) uploadFileInfo.style.display = 'none';

    // ログコンソールもクリア
    const consoleEl = document.getElementById('logConsole');
    if (consoleEl) consoleEl.textContent = '';
    const applyConsoleEl = document.getElementById('applyLogConsole');
    if (applyConsoleEl) applyConsoleEl.textContent = '';

    await fetchStatus();
    switchTab('setup');
    alert('過去の実行結果をリセットしました。');
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
}
