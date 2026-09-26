let csrfToken = '';
let currentJobState = 'IDLE';
let eventSource = null;

document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();
  subscribeSse();
  loadLatestResults();
});

function switchTab(tabName) {
  const tabs = ['setup', 'progress', 'results'];
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

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();
    csrfToken = data.csrfToken;
    updateJobStateBadge(data.jobState);

    if (data.snapshot) {
      updateSnapshotUi(data.snapshot);
      document.getElementById('btnStartPreflight').disabled = false;
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

  badge.textContent = state;
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

function updateSnapshotUi(snap) {
  document.getElementById('enabledSchoolsVal').textContent = `${snap.enabledSchoolCount} 校 / 全 ${snap.totalSchoolCount} 校`;
  document.getElementById('schoolsHashVal').textContent = snap.schoolsHash.substring(0, 16) + '...';
  document.getElementById('credResolvedVal').textContent = `${snap.resolvedCredentialsCount} / ${snap.enabledSchoolCount} 解決完了 (100%)`;
  document.getElementById('credMissingVal').textContent = '0';
  document.getElementById('profileHashVal').textContent = snap.profileHash.substring(0, 16) + '...';
  document.getElementById('toolVersionLabel').textContent = `Tool: ${snap.toolVersion} (${snap.toolFingerprint.substring(0, 8)})`;
}

async function runValidation() {
  const alertBox = document.getElementById('validationAlert');
  alertBox.style.display = 'none';
  document.getElementById('btnValidate').disabled = true;
  document.getElementById('btnStartPreflight').disabled = true;

  try {
    const res = await fetch('/api/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Nonce': csrfToken
      },
      body: JSON.stringify({})
    });

    const data = await res.json();
    if (data.status === 'PASS') {
      alertBox.className = 'alert-box alert-success mt-3';
      alertBox.textContent = `✓ 入力検証に合格しました (Validation PASS: ${data.enabledCount} 校有効 / 資格情報 100% 解決)。Preflight を開始できます。`;
      alertBox.style.display = 'block';

      updateSnapshotUi(data.snapshot);
      renderProfileItems(data.profileItems);
      document.getElementById('btnStartPreflight').disabled = false;
    } else {
      alertBox.className = 'alert-box alert-danger mt-3';
      alertBox.innerHTML = `<strong>✗ 入力検証エラー (${data.error?.code || 'VALIDATION_FAILED'})</strong>: ${escapeHtml(data.error?.message || '不明なエラー')}`;
      alertBox.style.display = 'block';
      document.getElementById('btnStartPreflight').disabled = true;
    }
  } catch (err) {
    alertBox.className = 'alert-box alert-danger mt-3';
    alertBox.textContent = `通信エラー: ${err.message}`;
    alertBox.style.display = 'block';
  } finally {
    document.getElementById('btnValidate').disabled = false;
  }
}

function renderProfileItems(items) {
  const tbody = document.getElementById('profileItemsBody');
  if (!tbody || !items) return;

  tbody.innerHTML = '';
  for (const item of items) {
    const tr = document.createElement('tr');
    const statusClass = item.status === 'MANAGED' ? 'text-primary font-bold' : 'text-muted';
    const valClass = item.status === 'MANAGED' ? 'font-mono font-bold' : 'text-muted';
    tr.innerHTML = `
      <td>${escapeHtml(item.label)}</td>
      <td class="${statusClass}">${item.status}</td>
      <td class="${valClass}">${item.value ? escapeHtml(item.value) : '(変更なし)'}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function startPreflight() {
  if (!confirm('【確認】Read-only Preflight を開始しますか？\n※ 本処理は読み取り専用であり、設定変更・保存は行いません。')) {
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
    if (data.state === 'COMPLETED' || data.state === 'FAILED') {
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
  });
}

function updateProgressUi(prog) {
  document.getElementById('progressCountLabel').textContent = `${prog.processed} / ${prog.total} 校`;
  document.getElementById('progressPercentLabel').textContent = `${prog.percentage}%`;
  document.getElementById('progressBarFill').style.width = `${prog.percentage}%`;

  document.getElementById('metricSuccess').textContent = prog.success;
  document.getElementById('metricFailed').textContent = prog.failed;
  document.getElementById('metricRemaining').textContent = prog.remaining;

  document.getElementById('metricElapsed').textContent = formatSeconds(prog.elapsedSeconds);
  document.getElementById('metricEta').textContent = prog.estimatedRemainingSeconds !== null
    ? formatSeconds(prog.estimatedRemainingSeconds)
    : '--:--:--';

  const schoolLabel = document.getElementById('currentSchoolLabel');
  if (prog.currentSchool) {
    schoolLabel.textContent = `[${prog.currentSchool.schoolCode}] ${prog.currentSchool.schoolName}`;
  } else if (prog.remaining === 0) {
    schoolLabel.textContent = '全校処理完了';
  }
}

async function loadLatestResults() {
  try {
    const res = await fetch('/api/reports/latest');
    if (!res.ok) return;
    const data = await res.json();

    const report = data.preflight || data.summary;
    if (!report) return;

    renderSummaryMetrics(report);
    renderActionsDistribution(report);
    renderCurrentStateDistribution(report);
    renderPlannedChangeDistribution(report);
    renderDestructiveWarnings(report);
    renderFailedSchools(report);
  } catch (err) {
    console.error('Failed to load latest results:', err);
  }
}

function renderSummaryMetrics(r) {
  const s = r.summary || r;
  document.getElementById('resTotal').textContent = s.totalSchools || 0;
  document.getElementById('resReadSuccess').textContent = s.readSuccess || 0;
  document.getElementById('resReadFailed').textContent = s.readFailed || 0;
  document.getElementById('resAlreadyConfigured').textContent = s.alreadyConfigured || 0;
  document.getElementById('resRequiresChange').textContent = s.requiresChange || 0;
  document.getElementById('resPlanBlocked').textContent = s.planBlocked || 0;
  document.getElementById('resDestructiveSchools').textContent = s.destructiveChangeSchools || 0;
  document.getElementById('resWriteEligible').textContent = s.writeEligibleNonDestructive || 0;
}

function renderActionsDistribution(r) {
  const dist = (r.summary || r).actionsDistribution || {};
  document.getElementById('dist0').textContent = `${dist['0'] || 0} 校`;
  document.getElementById('dist1').textContent = `${dist['1'] || 0} 校`;
  document.getElementById('dist2').textContent = `${dist['2'] || 0} 校`;
  document.getElementById('dist3Plus').textContent = `${dist['3+'] || 0} 校`;
}

function renderCurrentStateDistribution(r) {
  const tbody = document.getElementById('currentStateTableBody');
  const dist = (r.summary || r).currentStateDistribution;
  if (!tbody || !dist) return;

  tbody.innerHTML = '';
  for (const [key, counts] of Object.entries(dist)) {
    const tr = document.createElement('tr');
    const countsStr = Object.entries(counts)
      .map(([val, cnt]) => `<strong>${escapeHtml(val)}</strong>: ${cnt}校`)
      .join(' / ');
    tr.innerHTML = `
      <td><strong>${escapeHtml(key)}</strong></td>
      <td>${countsStr}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderPlannedChangeDistribution(r) {
  const tbody = document.getElementById('plannedChangeTableBody');
  const dist = (r.summary || r).plannedChangeDistribution;
  if (!tbody || !dist) return;

  tbody.innerHTML = '';
  for (const [key, counts] of Object.entries(dist)) {
    const tr = document.createElement('tr');
    const countsStr = Object.entries(counts)
      .map(([val, cnt]) => `<strong>${escapeHtml(val)}</strong>: ${cnt}校`)
      .join(' / ');
    tr.innerHTML = `
      <td><strong>${escapeHtml(key)}</strong></td>
      <td>${countsStr}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderDestructiveWarnings(r) {
  const alertBox = document.getElementById('destructiveAlertBox');
  const count = (r.summary || r).destructiveChangeSchools || 0;

  if (count > 0) {
    alertBox.style.display = 'block';
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

function renderFailedSchools(r) {
  const tbody = document.getElementById('failedSchoolsTableBody');
  if (!tbody) return;

  const schools = (r.schools || []).filter((s) => s.status === 'FAILED');
  if (schools.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">読取失敗校はありません (全校読取成功)</td></tr>';
    return;
  }

  tbody.innerHTML = schools.map((s) => `
    <tr>
      <td>${escapeHtml(s.schoolCode)}</td>
      <td>${escapeHtml(s.schoolName)}</td>
      <td><span class="badge badge-danger">${escapeHtml(s.executionStatus || 'FAILED')}</span></td>
      <td>${escapeHtml(s.errorDetails?.message || 'エラー')}</td>
    </tr>
  `).join('');
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
