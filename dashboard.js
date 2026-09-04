/* Dashboard page: quick-launch apps, focus timer (+ PiP), today's tasks, recent notes. */

// ============================================================
// Quick-launch apps
// ============================================================

function renderChecklist() {
  const apps = getApps();
  const query = (document.getElementById('appSearchInput')?.value || '').toLowerCase();
  const container = document.getElementById('checklistContainer');
  const checkedValues = JSON.parse(localStorage.getItem('workspace_checked_boxes') || '[]');

  container.innerHTML = '';
  apps.filter(app => app.title.toLowerCase().includes(query) || app.url.toLowerCase().includes(query))
    .forEach(app => {
      const isChecked = checkedValues.includes(app.url);
      const label = document.createElement('label');
      label.className = 'check-item';
      label.innerHTML = `<input type="checkbox" value="${app.url}" ${isChecked ? 'checked' : ''} onchange="onAppCheckboxChange()"> ${app.icon ? app.icon + ' ' : ''}${app.title}`;
      container.appendChild(label);
    });

  if (!apps.length) container.innerHTML = '<div class="empty-state">No apps registered yet. Add some in Settings.</div>';
}

async function onAppCheckboxChange() {
  const checkedValues = Array.from(document.querySelectorAll('.checklist input:checked')).map(cb => cb.value);
  await saveCheckboxes(checkedValues);
}

function renderPresetSuiteButtons() {
  const container = document.getElementById('presetButtonsContainer');
  container.innerHTML = `
    <button class="btn btn-light" style="flex:1;" onclick="selectPresetSuite('writing')">Writing</button>
    <button class="btn btn-light" style="flex:1;" onclick="selectPresetSuite('stem')">STEM</button>
  `;
  const customSuites = JSON.parse(localStorage.getItem('workspace_custom_suites') || '{}');
  Object.keys(customSuites).forEach(key => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-light';
    btn.style.flex = '1';
    btn.textContent = key;
    btn.onclick = () => selectPresetSuite(key, true);
    container.appendChild(btn);
  });
}

async function selectPresetSuite(key, isCustom) {
  let urls = [];
  if (isCustom) {
    const cs = JSON.parse(localStorage.getItem('workspace_custom_suites') || '{}');
    urls = cs[key] || [];
  } else {
    urls = defaultSuites[key] || [];
  }
  document.querySelectorAll('.checklist input').forEach(cb => { cb.checked = urls.includes(cb.value); });
  await onAppCheckboxChange();
}

function launchSelected() {
  const selected = Array.from(document.querySelectorAll('.checklist input:checked')).map(cb => cb.value);
  if (!selected.length) { alert('Please select at least one tool to launch.'); return; }
  selected.forEach(url => window.open(url, '_blank'));
}

// ============================================================
// Focus timer (engine lives in common.js — this just renders it)
// ============================================================

function onTimerInputsChanged() {
  const hrs = parseInt(document.getElementById('hrsSlot').value) || 0;
  const mins = parseInt(document.getElementById('minsSlot').value) || 0;
  const secs = parseInt(document.getElementById('secsSlot').value) || 0;
  timerSetSeconds(hrs * 3600 + mins * 60 + secs);
}

function renderTimerDisplay(state, remaining) {
  const hrs = Math.floor(remaining / 3600), mins = Math.floor((remaining % 3600) / 60), secs = remaining % 60;
  document.getElementById('hrsSlot').value = pad(hrs);
  document.getElementById('minsSlot').value = pad(mins);
  document.getElementById('secsSlot').value = pad(secs);
  document.getElementById('hrsSlot').disabled = state.running;
  document.getElementById('minsSlot').disabled = state.running;
  document.getElementById('secsSlot').disabled = state.running;
  document.getElementById('startBtn').textContent = state.running ? 'Running…' : ((remaining < state.durationSeconds && remaining > 0) ? 'Resume' : 'Start');
  updateTimerCanvas(remaining);
}

function updateTimerCanvas(remaining) {
  const canvas = document.getElementById('timerCanvas');
  const ctx = canvas.getContext('2d');
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  ctx.fillStyle = isLight ? '#FDFAF2' : '#17181d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#B13F2B';
  ctx.lineWidth = 12;
  ctx.strokeRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = isLight ? '#2B2A27' : '#F3EFF0';
  ctx.font = '700 130px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatSeconds(remaining), canvas.width / 2, canvas.height / 2);
}

// "Pop out" the timer into its own always-on-top window with real Start/Stop/
// Reset buttons, using the Document Picture-in-Picture API (Chrome/Edge). Where
// that's unavailable, fall back to a video-in-PiP overlay (display only).

let pipWindowRef = null;
let pipUnsubscribe = null;

async function popoutTimer() {
  if ('documentPictureInPicture' in window) {
    await openDocumentPipTimer();
  } else {
    await openLegacyVideoPip();
  }
}

async function openDocumentPipTimer() {
  if (pipWindowRef && !pipWindowRef.closed) { pipWindowRef.focus(); return; }
  try {
    const pipWindow = await documentPictureInPicture.requestWindow({ width: 300, height: 210 });
    pipWindowRef = pipWindow;

    [...document.styleSheets].forEach(sheet => {
      try {
        const rules = [...sheet.cssRules].map(r => r.cssText).join('');
        const style = pipWindow.document.createElement('style');
        style.textContent = rules;
        pipWindow.document.head.appendChild(style);
      } catch (e) { /* cross-origin stylesheet, skip */ }
    });
    pipWindow.document.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') || '');
    pipWindow.document.title = 'Focus Timer';
    pipWindow.document.body.style.margin = '0';
    pipWindow.document.body.style.background = 'var(--bg)';
    pipWindow.document.body.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; height:100vh; box-sizing:border-box; padding:16px; background:var(--bg); color:var(--text);">
        <div id="pipDigits" style="font-size:2.6rem; font-weight:700; font-variant-numeric:tabular-nums;">25:00</div>
        <div style="display:flex; gap:8px;">
          <button id="pipStart" class="btn" style="width:auto; padding:9px 18px;">Start</button>
          <button id="pipStop" class="btn btn-light" style="width:auto; padding:9px 18px;">Stop</button>
          <button id="pipReset" class="btn btn-ghost" style="width:auto; padding:9px 18px;">Reset</button>
        </div>
      </div>
    `;

    const digitsEl = pipWindow.document.getElementById('pipDigits');
    pipWindow.document.getElementById('pipStart').addEventListener('click', () => timerStart());
    pipWindow.document.getElementById('pipStop').addEventListener('click', () => timerPause());
    pipWindow.document.getElementById('pipReset').addEventListener('click', () => timerReset());

    pipUnsubscribe = onTimerTick((state, remaining) => {
      if (pipWindowRef && !pipWindowRef.closed) digitsEl.textContent = formatSeconds(remaining);
    });
    timerNotify();

    documentPictureInPicture.addEventListener('leavepictureinpicture', () => {
      if (pipUnsubscribe) { pipUnsubscribe(); pipUnsubscribe = null; }
      pipWindowRef = null;
    }, { once: true });
  } catch (err) {
    console.error('Document Picture-in-Picture failed, falling back.', err);
    await openLegacyVideoPip();
  }
}

async function openLegacyVideoPip() {
  const canvas = document.getElementById('timerCanvas');
  const video = document.getElementById('timerVideo');
  try {
    updateTimerCanvas(timerRemaining());
    if (!video.srcObject) video.srcObject = canvas.captureStream(30);
    await video.play();
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch (err) {
    alert('Picture-in-Picture overlay was blocked or is unsupported in this browser window.');
  }
}

function renderStats() {
  const today = todayStr();
  const todayData = JSON.parse(localStorage.getItem('workspace_stats') || '{}')[today] || { sessions: 0, minutes: 0, history: [] };
  document.getElementById('statsDisplay').textContent = `Today: ${todayData.sessions} session${todayData.sessions === 1 ? '' : 's'} completed (${todayData.minutes} mins)`;
  const logContainer = document.getElementById('sessionHistoryLog');
  logContainer.innerHTML = (todayData.history && todayData.history.length)
    ? todayData.history.map((item, idx) => `<div>#${idx + 1} @ ${item.time} — ${item.minutes} mins</div>`).join('')
    : `<div><em>No completed sessions yet today.</em></div>`;
}

window.onSessionRecorded = () => { renderStats(); renderDashboardStats(); renderTodayTasks(); };

// ============================================================
// Today's Tasks + Recent Notes widgets
// ============================================================

function renderTodayTasks() {
  const today = todayStr();
  const tasks = getTopLevelTasks()
    .filter(t => !t.done && t.scheduleType !== 'unplanned' && t.due && t.due <= today)
    .sort((a, b) => a.due.localeCompare(b.due));
  const container = document.getElementById('todayTasksList');
  if (!tasks.length) {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">🎉</span>Nothing due today. Nice.</div>';
    return;
  }
  container.innerHTML = tasks.slice(0, 6).map(t => `
    <div class="mini-list-item">
      <input type="checkbox" onclick="onTodayTaskDoneClick('${t.id}', this.checked)">
      ${t.priority ? `<span class="priority-dot ${t.priority}"></span>` : ''}
      <span class="mini-title" ${t.source === 'standalone' ? '' : `onclick="goToNote('${t.file.replace(/'/g, "\\'")}')"`}>${escapeHtml(taskLabel(t))}</span>
      <span class="mini-meta">${t.due < today ? 'Overdue' : 'Today'}</span>
    </div>
  `).join('');
}

function taskLabel(t) { return t.source === 'standalone' ? t.text : (t.cleanText || t.rawText); }

async function onTodayTaskDoneClick(id, checked) {
  const t = getTopLevelTasks().find(x => x.id === id);
  if (!t) return;
  await setTaskDone(t, checked);
  renderTodayTasks();
}

function renderRecentNotes() {
  const files = getRecentNotes(6);
  const container = document.getElementById('recentNotesList');
  container.innerHTML = files.length
    ? files.map(f => `<div class="mini-list-item" onclick="goToNote('${f.replace(/'/g, "\\'")}')"><span class="mini-title">${f.replace(/\.md$/i, '')}</span></div>`).join('')
    : '<div class="empty-state"><span class="empty-icon">🗒️</span>No notes yet — head to Notes to create one.</div>';
  renderDashboardStats();
}

function renderDashboardStats() {
  const stats = JSON.parse(localStorage.getItem('workspace_stats') || '{}');
  const todayData = stats[todayStr()] || { minutes: 0 };
  const noteCount = Object.keys(getNotes()).length;
  const openTasks = getTopLevelTasks().filter(t => !t.done).length;
  document.getElementById('dashboardStatTiles').innerHTML = `
    <div class="stat-tile"><div class="stat-num">${noteCount}</div><div class="stat-label">Notes</div></div>
    <div class="stat-tile"><div class="stat-num">${openTasks}</div><div class="stat-label">Open Tasks</div></div>
    <div class="stat-tile"><div class="stat-num">${todayData.minutes}</div><div class="stat-label">Mins Today</div></div>
  `;
}

// ============================================================
// Widget grid: drag-reorder, hide, resize (scoped to this page's #mainGrid)
// ============================================================

let draggedWidgetId = null;
function onWidgetDragStart(e, id) { draggedWidgetId = id; e.dataTransfer.effectAllowed = 'move'; }
function onWidgetDragOver(e) { e.preventDefault(); }

function onWidgetDrop(e, targetId) {
  e.preventDefault();
  if (!draggedWidgetId || draggedWidgetId === targetId) return;
  const container = document.getElementById('mainGrid');
  const draggedEl = container.querySelector(`[data-widget-id="${draggedWidgetId}"]`);
  const targetEl = container.querySelector(`[data-widget-id="${targetId}"]`);
  if (!draggedEl || !targetEl) return;
  const rect = targetEl.getBoundingClientRect();
  const before = (e.clientY - rect.top) < rect.height / 2;
  container.insertBefore(draggedEl, before ? targetEl : targetEl.nextSibling);
  saveWidgetOrder();
  draggedWidgetId = null;
}

function saveWidgetOrder() {
  const order = Array.from(document.querySelectorAll('#mainGrid .card')).map(c => c.dataset.widgetId);
  localStorage.setItem('workspace_widget_order', JSON.stringify(order));
}

function applyWidgetOrder() {
  const order = JSON.parse(localStorage.getItem('workspace_widget_order') || 'null');
  if (!order) return;
  const container = document.getElementById('mainGrid');
  order.forEach(id => {
    const el = container.querySelector(`[data-widget-id="${id}"]`);
    if (el) container.appendChild(el);
  });
}

function toggleWidgetHidden(id) {
  const hidden = JSON.parse(localStorage.getItem('workspace_widget_hidden') || '{}');
  hidden[id] = !hidden[id];
  localStorage.setItem('workspace_widget_hidden', JSON.stringify(hidden));
  applyWidgetVisibility();
  renderDashWidgetToggleList();
}

function applyWidgetVisibility() {
  const hidden = JSON.parse(localStorage.getItem('workspace_widget_hidden') || '{}');
  document.querySelectorAll('#mainGrid .card').forEach(c => {
    c.style.display = hidden[c.dataset.widgetId] ? 'none' : 'flex';
  });
}

function toggleWidgetWide(id) {
  const wide = JSON.parse(localStorage.getItem('workspace_widget_wide') || '{}');
  wide[id] = !wide[id];
  localStorage.setItem('workspace_widget_wide', JSON.stringify(wide));
  applyWidgetSpans();
}

function applyWidgetSpans() {
  const wide = JSON.parse(localStorage.getItem('workspace_widget_wide') || '{}');
  document.querySelectorAll('#mainGrid .card').forEach(c => {
    c.classList.toggle('card-wide', !!wide[c.dataset.widgetId]);
  });
}

// ============================================================
// Edit Layout: column count + widget show/hide, via the bottom-right FAB
// ============================================================

const dashboardWidgetNames = { launcher: 'Quick-Launch Apps', timer: 'Focus Timer', todaytasks: "Today's Tasks", recentnotes: 'Recent Notes' };
let dashEditActive = false;

function getDashboardColumns() { return parseInt(localStorage.getItem('workspace_dashboard_columns') || '2', 10); }

function applyDashboardColumns() {
  const n = getDashboardColumns();
  document.getElementById('mainGrid').style.gridTemplateColumns = `repeat(${n}, 1fr)`;
}

function setDashboardColumns(n) {
  localStorage.setItem('workspace_dashboard_columns', String(n));
  applyDashboardColumns();
  renderDashColButtons();
}

function renderDashColButtons() {
  const current = getDashboardColumns();
  document.getElementById('dashColButtons').innerHTML = [1, 2, 3, 4].map(n =>
    `<button class="dash-col-btn ${n === current ? 'active' : ''}" onclick="setDashboardColumns(${n})">${n}</button>`
  ).join('');
}

function renderDashWidgetToggleList() {
  const hidden = JSON.parse(localStorage.getItem('workspace_widget_hidden') || '{}');
  document.getElementById('dashWidgetToggleList').innerHTML = Object.keys(dashboardWidgetNames).map(id => `
    <div class="settings-item">
      <span class="item-label">${dashboardWidgetNames[id]}</span>
      <label class="flex-row" style="font-size: 0.8rem;">
        <input type="checkbox" ${hidden[id] ? '' : 'checked'} onchange="toggleWidgetHiddenFromPanel('${id}', this.checked)"> Visible
      </label>
    </div>
  `).join('');
}

function toggleWidgetHiddenFromPanel(id, visible) {
  const hidden = JSON.parse(localStorage.getItem('workspace_widget_hidden') || '{}');
  hidden[id] = !visible;
  localStorage.setItem('workspace_widget_hidden', JSON.stringify(hidden));
  applyWidgetVisibility();
}

function toggleDashEditMode() {
  dashEditActive = !dashEditActive;
  document.getElementById('mainGrid').classList.toggle('dashboard-editing', dashEditActive);
  document.getElementById('dashEditFab').classList.toggle('active', dashEditActive);
  document.getElementById('dashEditPanel').classList.toggle('open', dashEditActive);
  if (dashEditActive) {
    renderDashColButtons();
    renderDashWidgetToggleList();
  }
}

// ============================================================
// Init
// ============================================================

window.addEventListener('DOMContentLoaded', async () => {
  await initCommonApp('dashboard');

  const activeFileInput = document.getElementById('activeFile');
  activeFileInput.value = localStorage.getItem('workspace_active_file') || '';
  activeFileInput.addEventListener('input', () => saveActiveFile(activeFileInput.value));

  renderChecklist();
  renderPresetSuiteButtons();
  renderStats();
  renderTodayTasks();
  renderRecentNotes();

  applyWidgetOrder();
  applyWidgetVisibility();
  applyWidgetSpans();
  applyDashboardColumns();

  onTimerTick(renderTimerDisplay);
  timerNotify();
});
