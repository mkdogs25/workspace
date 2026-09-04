/* Tasks page: List (sortable/filterable, with subtasks), Kanban, Calendar — over merged note + standalone tasks. */

// ============================================================
// Tabs
// ============================================================

function setTasksTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('listView').style.display = tab === 'list' ? 'block' : 'none';
  document.getElementById('kanbanView').style.display = tab === 'kanban' ? 'block' : 'none';
  document.getElementById('calendarView').style.display = tab === 'calendar' ? 'block' : 'none';
  if (tab === 'calendar') renderCalendar();
  localStorage.setItem('workspace_tasks_tab', tab);
}

function refreshAllTaskViews() {
  renderTaskList();
  renderKanban();
  renderCalendar();
  populateTagFilterOptions();
}

function findTopLevelTask(id) { return getTopLevelTasks().find(t => t.id === id); }
function taskLabel(t) { return t.source === 'standalone' ? t.text : (t.cleanText || t.rawText); }

function scheduleBadgeHtml(t) {
  const today = todayStr();
  if (t.scheduleType === 'unplanned') return '<span class="schedule-pill">—</span>';
  if (t.scheduleType === 'range') {
    const overdue = !t.done && t.dueEnd < today;
    return `<span class="schedule-pill ${overdue ? 'overdue' : ''}">🗓️ ${t.due} → ${t.dueEnd}</span>`;
  }
  const overdue = !t.done && t.due < today;
  return `<span class="schedule-pill ${overdue ? 'overdue' : ''}">📅 ${t.due}</span>`;
}

// ============================================================
// New Task modal (standalone tasks)
// ============================================================

function toggleNewTaskModal(show) {
  document.getElementById('newTaskModal').style.display = show ? 'flex' : 'none';
  if (show) setTimeout(() => document.getElementById('newTaskText').focus(), 30);
}

function onNewTaskScheduleChange() {
  const val = document.querySelector('input[name="newTaskSchedule"]:checked').value;
  document.getElementById('newTaskDateRow').style.display = val === 'unplanned' ? 'none' : 'flex';
  document.getElementById('newTaskDueEndWrap').style.display = val === 'range' ? 'flex' : 'none';
}

function clearNewTaskForm() {
  document.getElementById('newTaskText').value = '';
  document.getElementById('newTaskPriority').value = '';
  document.getElementById('newTaskRecurring').value = '';
  document.getElementById('newTaskTags').value = '';
  document.getElementById('newTaskDue').value = '';
  document.getElementById('newTaskDueEnd').value = '';
  document.querySelector('input[name="newTaskSchedule"][value="unplanned"]').checked = true;
  onNewTaskScheduleChange();
}

async function submitNewTask() {
  const text = document.getElementById('newTaskText').value.trim();
  if (!text) { alert('Please enter a task description.'); return; }
  const priority = document.getElementById('newTaskPriority').value || null;
  const scheduleType = document.querySelector('input[name="newTaskSchedule"]:checked').value;
  const due = scheduleType !== 'unplanned' ? (document.getElementById('newTaskDue').value || null) : null;
  const dueEnd = scheduleType === 'range' ? (document.getElementById('newTaskDueEnd').value || null) : null;
  const recurring = document.getElementById('newTaskRecurring').value.trim() || null;
  const tags = document.getElementById('newTaskTags').value.split(',').map(s => s.trim()).filter(Boolean);

  await createStandaloneTask({ text, priority, due, dueEnd, recurring, tags });
  toggleNewTaskModal(false);
  clearNewTaskForm();
  refreshAllTaskViews();
}

// ============================================================
// Shared task actions (dispatch through common.js by source)
// ============================================================

async function onTaskDoneClick(id, checked) {
  const t = findTopLevelTask(id);
  if (!t) return;
  await setTaskDone(t, checked);
  refreshAllTaskViews();
}

async function onDeleteTaskClick(id) {
  const t = findTopLevelTask(id);
  if (!t) return;
  const msg = t.source === 'standalone' ? 'Delete this task?' : 'Remove this task line (and any subtasks) from its note?';
  if (!confirm(msg)) return;
  await deleteTask(t);
  refreshAllTaskViews();
}

async function onSubtaskDoneClick(parentId, subId, checked) {
  const t = findTopLevelTask(parentId);
  if (!t) return;
  await toggleSubtask(t, subId, checked);
  refreshAllTaskViews();
}

async function onAddSubtaskClick(parentId) {
  const input = document.getElementById('subtaskInput-' + parentId);
  const text = input.value.trim();
  if (!text) return;
  const t = findTopLevelTask(parentId);
  if (!t) return;
  await addSubtask(t, text);
  expandedTaskIds.add(parentId);
  refreshAllTaskViews();
}

let expandedTaskIds = new Set();
function toggleTaskExpand(id) {
  if (expandedTaskIds.has(id)) expandedTaskIds.delete(id);
  else expandedTaskIds.add(id);
  renderTaskList();
}

// ============================================================
// List view
// ============================================================

let listSort = { key: 'due', dir: 'asc' };
let listFilters = { status: 'all', tag: 'all', q: '' };

function populateTagFilterOptions() {
  const tasks = getTopLevelTasks();
  const tagSet = new Set();
  tasks.forEach(t => (t.tags || []).forEach(tag => tagSet.add(tag)));
  const select = document.getElementById('tagFilterSelect');
  const current = select.value;
  select.innerHTML = '<option value="all">All tags</option>' + Array.from(tagSet).sort().map(t => `<option value="${t}">#${t}</option>`).join('');
  select.value = Array.from(tagSet).includes(current) ? current : 'all';
}

function onListFilterChange() {
  listFilters.status = document.getElementById('statusFilterSelect').value;
  listFilters.tag = document.getElementById('tagFilterSelect').value;
  listFilters.q = document.getElementById('taskSearchInput').value;
  renderTaskList();
}

function sortListBy(key) {
  if (listSort.key === key) listSort.dir = listSort.dir === 'asc' ? 'desc' : 'asc';
  else { listSort.key = key; listSort.dir = 'asc'; }
  renderTaskList();
}

function renderTaskRowGroup(t) {
  const hasSubtasks = t.subtasks && t.subtasks.length > 0;
  const expanded = expandedTaskIds.has(t.id);
  const doneCount = hasSubtasks ? t.subtasks.filter(s => s.done).length : 0;

  let html = `<tr class="${t.done ? 'task-row-done' : ''}">
    <td>
      ${hasSubtasks ? `<button class="task-expand-btn" onclick="toggleTaskExpand('${t.id}')">${expanded ? '▾' : '▸'}</button>` : ''}
      <input type="checkbox" ${t.done ? 'checked' : ''} onclick="onTaskDoneClick('${t.id}', this.checked)">
    </td>
    <td class="task-row-text">${escapeHtml(taskLabel(t))} ${hasSubtasks ? `<span class="subtask-progress">${doneCount}/${t.subtasks.length}</span>` : ''}</td>
    <td>${t.priority ? `<span class="priority-pill ${t.priority}">${t.priority}</span>` : ''}</td>
    <td>${scheduleBadgeHtml(t)}</td>
    <td class="text-muted">${(t.tags || []).map(tag => '#' + tag).join(' ')}</td>
    <td>${t.source === 'standalone' ? '<span class="task-row-standalone">Standalone</span>' : `<span class="task-row-note" onclick="goToNote('${(t.file || '').replace(/'/g, "\\'")}')">${(t.file || '').replace(/\.md$/i, '')}</span>`}</td>
    <td><button class="btn-icon btn-icon-close" onclick="onDeleteTaskClick('${t.id}')" title="Delete">🗑</button></td>
  </tr>`;

  if (expanded) {
    html += `<tr class="subtask-row"><td colspan="7">
      ${(t.subtasks || []).map(s => `
        <div class="subtask-item ${s.done ? 'done' : ''}">
          <input type="checkbox" ${s.done ? 'checked' : ''} onclick="onSubtaskDoneClick('${t.id}','${s.id}', this.checked)">
          <span>${escapeHtml(s.text)}</span>
        </div>
      `).join('')}
      <div class="subtask-add-row">
        <input type="text" class="text-input" placeholder="Add a subtask..." id="subtaskInput-${t.id}" onkeydown="if(event.key==='Enter') onAddSubtaskClick('${t.id}')">
        <button class="btn-icon" onclick="onAddSubtaskClick('${t.id}')">Add</button>
      </div>
    </td></tr>`;
  }
  return html;
}

function renderTaskList() {
  const statusMap = getTaskStatusMap();
  let tasks = getTopLevelTasks().map(t => ({ ...t, status: resolveStatus(t, statusMap) }));

  if (listFilters.status !== 'all') tasks = tasks.filter(t => t.status === listFilters.status);
  if (listFilters.tag !== 'all') tasks = tasks.filter(t => (t.tags || []).includes(listFilters.tag));
  if (listFilters.q) tasks = tasks.filter(t => taskLabel(t).toLowerCase().includes(listFilters.q.toLowerCase()));

  const priorityRank = { high: 0, medium: 1, low: 2 };
  tasks.sort((a, b) => {
    let av, bv;
    if (listSort.key === 'due') { av = a.due || '9999-99-99'; bv = b.due || '9999-99-99'; }
    else if (listSort.key === 'priority') { av = priorityRank[a.priority] ?? 3; bv = priorityRank[b.priority] ?? 3; }
    else if (listSort.key === 'note') { av = (a.file || '').toLowerCase(); bv = (b.file || '').toLowerCase(); }
    else { av = taskLabel(a).toLowerCase(); bv = taskLabel(b).toLowerCase(); }
    if (av < bv) return listSort.dir === 'asc' ? -1 : 1;
    if (av > bv) return listSort.dir === 'asc' ? 1 : -1;
    return 0;
  });

  const tbody = document.getElementById('taskListBody');
  const empty = document.getElementById('taskListEmpty');
  if (!tasks.length) {
    empty.style.display = 'block';
    tbody.innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = tasks.map(renderTaskRowGroup).join('');
}

// ============================================================
// Kanban view
// ============================================================

function scheduleBadgeShort(t) { return t.scheduleType === 'range' ? `🗓️ ${t.due}→${t.dueEnd}` : `📅 ${t.due}`; }

function renderTaskCardHtml(t) {
  const prClass = t.priority ? 'task-pr-' + t.priority : '';
  const scheduleBadge = t.scheduleType !== 'unplanned' ? `<span class="task-due">${scheduleBadgeShort(t)}</span>` : '';
  const recurBadge = t.recurring ? `<span class="task-recur">🔁 ${t.recurring}</span>` : '';
  const subtaskBadge = (t.subtasks && t.subtasks.length) ? `<span class="subtask-progress">${t.subtasks.filter(s => s.done).length}/${t.subtasks.length}</span>` : '';
  const sourceHtml = t.source === 'standalone'
    ? '<span class="task-row-standalone">🗂️ Standalone</span>'
    : `<span onclick="goToNote('${t.file.replace(/'/g, "\\'")}')">📄 ${t.file.replace(/\.md$/i, '')}</span>`;

  return `<div class="kanban-card ${prClass}" draggable="true" data-task-id="${t.id}" ondragstart="onTaskDragStart(event, '${t.id}')">
    <div class="kanban-card-text">
      <input type="checkbox" ${t.done ? 'checked' : ''} onclick="event.stopPropagation(); onTaskDoneClick('${t.id}', this.checked)">
      <span>${escapeHtml(taskLabel(t))} ${subtaskBadge}</span>
    </div>
    <div class="kanban-card-meta">${scheduleBadge}${recurBadge}</div>
    <div class="kanban-card-source">${sourceHtml}</div>
  </div>`;
}

function renderKanban() {
  const tasks = getTopLevelTasks();
  const statusMap = getTaskStatusMap();
  const cols = { todo: [], inprogress: [], done: [] };
  tasks.forEach(t => cols[resolveStatus(t, statusMap)].push(t));
  ['todo', 'inprogress', 'done'].forEach(col => {
    document.getElementById('kanban-' + col).innerHTML = cols[col].map(renderTaskCardHtml).join('') || '<div class="kanban-empty"><em>Empty</em></div>';
    document.getElementById('kanban-count-' + col).textContent = cols[col].length;
  });
}

let draggedTaskId = null;
function onTaskDragStart(e, id) { draggedTaskId = id; e.dataTransfer.effectAllowed = 'move'; }

async function onColumnDrop(e, col) {
  e.preventDefault();
  document.querySelectorAll('.kanban-list').forEach(l => l.classList.remove('drag-over'));
  if (!draggedTaskId) return;
  const t = findTopLevelTask(draggedTaskId);
  if (t) await setTaskColumn(t, col);
  draggedTaskId = null;
  refreshAllTaskViews();
}

// ============================================================
// Calendar view — planned tasks only (single day or date range)
// ============================================================

let calendarViewDate = new Date();
let calendarMode = 'month';

function onCalendarTaskClick(taskId) {
  const t = findTopLevelTask(taskId);
  if (!t) return;
  if (t.source === 'standalone') {
    setTasksTab('list');
    document.getElementById('taskSearchInput').value = taskLabel(t);
    onListFilterChange();
  } else {
    goToNote(t.file);
  }
}

function renderCalendar() {
  const tasks = getTopLevelTasks().filter(t => t.scheduleType !== 'unplanned');
  const tasksByDate = {};
  tasks.forEach(t => {
    if (t.scheduleType === 'range') {
      let d = new Date(t.due + 'T00:00:00');
      const end = new Date(t.dueEnd + 'T00:00:00');
      while (d <= end) {
        const key = formatDateLocal(d);
        (tasksByDate[key] = tasksByDate[key] || []).push(t);
        d.setDate(d.getDate() + 1);
      }
    } else {
      (tasksByDate[t.due] = tasksByDate[t.due] || []).push(t);
    }
  });
  const stats = JSON.parse(localStorage.getItem('workspace_stats') || '{}');
  if (calendarMode === 'month') renderCalendarMonth(tasksByDate, stats);
  else renderCalendarWeek(tasksByDate, stats);
}

function renderCalendarMonth(tasksByDate, stats) {
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  document.getElementById('calendarLabel').textContent = calendarViewDate.toLocaleString('default', { month: 'long', year: 'numeric' });

  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  let html = '<div class="calendar-grid">';
  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(d => { html += `<div class="calendar-dow">${d}</div>`; });
  for (let i = 0; i < startOffset; i++) html += '<div class="calendar-cell calendar-cell-empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayTasks = tasksByDate[dateStr] || [];
    const dayStats = stats[dateStr];
    const isToday = dateStr === today;
    html += `<div class="calendar-cell ${isToday ? 'calendar-today' : ''}">
      <div class="calendar-date">${d}</div>
      ${dayTasks.slice(0, 3).map(t => `<div class="calendar-task ${t.done ? 'calendar-task-done' : ''}" onclick="onCalendarTaskClick('${t.id}')">${escapeHtml(taskLabel(t).slice(0, 22))}</div>`).join('')}
      ${dayTasks.length > 3 ? `<div class="calendar-more">+${dayTasks.length - 3} more</div>` : ''}
      ${dayStats ? `<div class="calendar-session">⏱ ${dayStats.sessions} session${dayStats.sessions === 1 ? '' : 's'}</div>` : ''}
    </div>`;
  }
  html += '</div>';
  document.getElementById('calendarContainer').innerHTML = html;
}

function renderCalendarWeek(tasksByDate, stats) {
  const d = new Date(calendarViewDate);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  document.getElementById('calendarLabel').textContent = 'Week of ' + d.toLocaleDateString();
  const today = todayStr();

  let html = '<div class="calendar-week-list">';
  for (let i = 0; i < 7; i++) {
    const dateStr = formatDateLocal(d);
    const dayTasks = tasksByDate[dateStr] || [];
    const dayStats = stats[dateStr];
    html += `<div class="calendar-week-day ${dateStr === today ? 'calendar-today' : ''}">
      <div class="calendar-week-date">${d.toLocaleDateString('default', { weekday: 'short', month: 'short', day: 'numeric' })}</div>
      ${dayTasks.map(t => `<div class="calendar-task ${t.done ? 'calendar-task-done' : ''}" onclick="onCalendarTaskClick('${t.id}')">${escapeHtml(taskLabel(t))}</div>`).join('') || '<div class="calendar-more"><em>No tasks</em></div>'}
      ${dayStats ? `<div class="calendar-session">⏱ ${dayStats.sessions} session${dayStats.sessions === 1 ? '' : 's'} (${dayStats.minutes}m)</div>` : ''}
    </div>`;
    d.setDate(d.getDate() + 1);
  }
  html += '</div>';
  document.getElementById('calendarContainer').innerHTML = html;
}

function calendarNav(delta) {
  if (calendarMode === 'month') calendarViewDate.setMonth(calendarViewDate.getMonth() + delta);
  else calendarViewDate.setDate(calendarViewDate.getDate() + 7 * delta);
  renderCalendar();
}

function calendarToday() { calendarViewDate = new Date(); renderCalendar(); }

function setCalendarMode(mode) {
  calendarMode = mode;
  document.querySelectorAll('.calendar-mode-btn').forEach(b => b.classList.toggle('calendar-mode-active', b.dataset.mode === mode));
  renderCalendar();
}

// ============================================================
// Init
// ============================================================

window.addEventListener('DOMContentLoaded', async () => {
  await initCommonApp('tasks');

  onNewTaskScheduleChange();
  populateTagFilterOptions();
  renderTaskList();
  renderKanban();
  renderCalendar();

  setTasksTab(localStorage.getItem('workspace_tasks_tab') || 'list');
});
