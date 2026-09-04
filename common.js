/* ==========================================================================
   Workspace — shared layer used by every page.
   Data model (notes/tasks/apps), directory sync, timer engine, command
   palette, and nav wiring all live here so state stays consistent as the
   user moves between index.html / notes.html / tasks.html / settings.html /
   preview.html (all same-origin, so localStorage is already shared — this
   file just keeps the *behavior* consistent too).
   ========================================================================== */

const defaultApps = [
  { title: 'Obsidian', url: 'obsidian://' },
  { title: 'Claude', url: 'claude://' },
  { title: 'Routine.co', url: 'https://app.routine.co' },
  { title: 'Inkarnate', url: 'https://inkarnate.com' },
  { title: 'Behind the Name', url: 'https://www.behindthename.com' },
  { title: 'Desmos', url: 'https://www.desmos.com/calculator' },
  { title: 'PhET Simulations', url: 'https://phet.colorado.edu' },
  { title: 'WolframAlpha', url: 'https://www.wolframalpha.com' }
];

const defaultSuites = {
  writing: ['obsidian://', 'https://inkarnate.com', 'https://www.behindthename.com'],
  stem: ['obsidian://', 'claude://', 'https://www.desmos.com/calculator', 'https://phet.colorado.edu', 'https://www.wolframalpha.com']
};

let dirHandle = null;

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatSeconds(total) {
  total = Math.max(0, Math.round(total));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Timezone-safe YYYY-MM-DD (avoids the day-shift that new Date(...).toISOString() causes
// for local-midnight dates in positive-UTC-offset timezones).
function formatDateLocal(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return formatDateLocal(new Date()); }

// ============================================================
// NOTES DATA MODEL (multi-file, wiki-linked)
// ============================================================

function getNotes() { return JSON.parse(localStorage.getItem('workspace_notes') || '{}'); }
function setNotes(obj) { localStorage.setItem('workspace_notes', JSON.stringify(obj)); }
function getNoteContent(filename) { return getNotes()[filename] || ''; }

function getNoteMtimes() { return JSON.parse(localStorage.getItem('workspace_note_mtimes') || '{}'); }
function touchNoteMtime(filename) {
  const m = getNoteMtimes();
  m[filename] = Date.now();
  localStorage.setItem('workspace_note_mtimes', JSON.stringify(m));
}

function getRecentNotes(limit) {
  const mtimes = getNoteMtimes();
  const notes = getNotes();
  return Object.keys(notes)
    .sort((a, b) => (mtimes[b] || 0) - (mtimes[a] || 0))
    .slice(0, limit || 5);
}

function sanitizeFilename(title) {
  return (title || '').trim().replace(/[\\/:*?"<>|]/g, '-') || 'Untitled';
}

async function writeNoteToDirectory(filename, content) {
  if (!dirHandle) return;
  try {
    const fh = await dirHandle.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
  } catch (err) {
    console.error('Note write failed:', err);
  }
}

async function deleteNoteFile(filename) {
  if (!dirHandle) return;
  try { await dirHandle.removeEntry(filename); } catch (err) { /* not present, ignore */ }
}

async function setNoteContent(filename, content) {
  const notes = getNotes();
  notes[filename] = content;
  setNotes(notes);
  touchNoteMtime(filename);
  await writeNoteToDirectory(filename, content);
  await autoSaveToFileSystem();
}

async function createNote(title, template) {
  const filename = sanitizeFilename(title) + '.md';
  const notes = getNotes();
  if (notes[filename]) return filename;
  const content = template !== undefined ? template : `---\ntags: []\nstatus: \n---\n\n# ${title}\n\n`;
  notes[filename] = content;
  setNotes(notes);
  touchNoteMtime(filename);
  await writeNoteToDirectory(filename, content);
  await autoSaveToFileSystem();
  return filename;
}

async function deleteNote(filename) {
  const notes = getNotes();
  delete notes[filename];
  setNotes(notes);
  const m = getNoteMtimes();
  delete m[filename];
  localStorage.setItem('workspace_note_mtimes', JSON.stringify(m));
  await deleteNoteFile(filename);
  await autoSaveToFileSystem();
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: content };
  const yamlLines = match[1].split(/\r?\n/);
  const body = content.slice(match[0].length);
  const data = {};
  for (let i = 0; i < yamlLines.length; i++) {
    const kv = yamlLines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (val === '') {
      const listVals = [];
      let j = i + 1;
      while (j < yamlLines.length && /^\s*-\s+/.test(yamlLines[j])) {
        listVals.push(yamlLines[j].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
        j++;
      }
      if (listVals.length) { data[key] = listVals; i = j - 1; continue; }
      data[key] = '';
    } else if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      data[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { data, body };
}

function getNoteTags(content) {
  const { data } = parseFrontmatter(content);
  if (Array.isArray(data.tags)) return data.tags;
  if (typeof data.tags === 'string' && data.tags) return data.tags.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function getAllTags() {
  const notes = getNotes();
  const tagSet = new Set();
  Object.values(notes).forEach(c => getNoteTags(c).forEach(t => tagSet.add(t)));
  return Array.from(tagSet).sort();
}

function resolveWikiLinksHtml(html) {
  const notes = getNotes();
  const titleToFile = {};
  Object.keys(notes).forEach(f => { titleToFile[f.replace(/\.md$/i, '').toLowerCase()] = f; });
  return html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, title, alias) => {
    const key = title.trim().toLowerCase();
    const exists = !!titleToFile[key];
    const display = (alias || title).trim();
    const cls = exists ? 'wikilink' : 'wikilink wikilink-new';
    const safeTitle = title.trim().replace(/'/g, "\\'").replace(/"/g, '&quot;');
    return `<a href="#" class="${cls}" onclick="event.preventDefault(); openNoteByTitle('${safeTitle}')">${display}</a>`;
  });
}

function renderMathInElement(element) {
  if (typeof katex === 'undefined') return;
  element.innerHTML = element.innerHTML
    .replace(/\$\$(.*?)\$\$/gs, (match, expr) => katex.renderToString(expr, { displayMode: true, throwOnError: false }))
    .replace(/\$(.*?)\$/g, (match, expr) => katex.renderToString(expr, { displayMode: false, throwOnError: false }));
}

// Cross-page navigation: if notes.html has registered a same-page handler
// (window.openNoteInPage), use it to avoid a full reload; otherwise navigate.
function goToNote(filename) {
  if (typeof window.openNoteInPage === 'function') {
    window.openNoteInPage(filename);
  } else {
    location.href = 'notes.html?note=' + encodeURIComponent(filename);
  }
}

async function openNoteByTitle(title) {
  const notes = getNotes();
  const match = Object.keys(notes).find(f => f.replace(/\.md$/i, '').toLowerCase() === title.toLowerCase());
  const filename = match || await createNote(title);
  goToNote(filename);
}

async function quickNewNoteGlobal(presetTitle) {
  const title = presetTitle || prompt('New note title:');
  if (!title) return;
  const f = await createNote(title);
  goToNote(f);
}

async function openDailyNoteGlobal() {
  const today = todayStr();
  const filename = sanitizeFilename(today) + '.md';
  const notes = getNotes();
  if (!notes[filename]) {
    const template = `---\ntags: [daily]\nstatus: \n---\n\n# ${today}\n\n## Tasks\n- [ ] \n\n## Journal\n\n`;
    await createNote(today, template);
  }
  goToNote(filename);
}

async function migrateLegacyNotes() {
  const notes = getNotes();
  if (Object.keys(notes).length > 0) return;
  const legacyContent = localStorage.getItem('workspace_scratchpad');
  if (legacyContent) {
    notes['Scratchpad.md'] = legacyContent;
  } else {
    const today = todayStr();
    notes['Welcome.md'] = `---\ntags: [welcome]\n---\n\n# Welcome\n\nThis is your first note. Try linking to [[Another Note]] to auto-create it, or press Ctrl/Cmd+P to open the command palette.\n\n## Tasks\n- [ ] Try creating a task 📅 ${today} 🔺 high\n`;
  }
  setNotes(notes);
  const m = getNoteMtimes();
  Object.keys(notes).forEach(f => { if (!m[f]) m[f] = Date.now(); });
  localStorage.setItem('workspace_note_mtimes', JSON.stringify(m));
  await autoSaveToFileSystem();
}

async function loadNotesFromDirectory() {
  if (!dirHandle) return;
  const notes = getNotes();
  const mtimes = getNoteMtimes();
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file' && /\.md$/i.test(name)) {
        const file = await handle.getFile();
        notes[name] = await file.text();
        mtimes[name] = file.lastModified;
      }
    }
    setNotes(notes);
    localStorage.setItem('workspace_note_mtimes', JSON.stringify(mtimes));
  } catch (err) {
    console.error('Error scanning directory for notes:', err);
  }
}

// ============================================================
// DIRECTORY SYNC (File System Access API + IndexedDB handle store)
// ============================================================

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('WorkspaceDB', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeDirectoryHandle(handle) {
  const db = await openDB();
  const tx = db.transaction('handles', 'readwrite');
  tx.objectStore('handles').put(handle, 'projectFolder');
  return tx.complete;
}

async function getStoredDirectoryHandle() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get('projectFolder');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function selectProjectDirectory() {
  if (!('showDirectoryPicker' in window)) {
    alert('Direct folder writing is supported on Desktop Chrome, Edge, and Opera browsers.');
    return;
  }
  try {
    dirHandle = await window.showDirectoryPicker();
    await storeDirectoryHandle(dirHandle);
    updateFolderStatusUI(true);
    await loadDataFromDirectory();
    await autoSaveToFileSystem();
    if (window.onDirectoryLinked) window.onDirectoryLinked();
  } catch (err) {
    console.log('Directory selection cancelled or blocked.');
  }
}

function updateFolderStatusUI(connected) {
  const status = document.getElementById('fileSyncStatus');
  if (!status) return;
  if (connected && dirHandle) {
    status.innerHTML = `✅ Linked Folder: <strong>${dirHandle.name}</strong><br><small>Auto-saving <code>data.json</code> and each note as its own <code>.md</code> file directly here.</small>`;
  } else {
    status.innerHTML = `⚠️ No project folder linked. Notes & data are saving to browser cache.`;
  }
}

async function loadDataFromDirectory() {
  if (!dirHandle) return;
  try {
    await loadNotesFromDirectory();

    try {
      const dataFile = await dirHandle.getFileHandle('data.json');
      const file = await dataFile.getFile();
      const content = await file.text();
      const data = JSON.parse(content);

      if (data.apps) localStorage.setItem('workspace_registered_apps', JSON.stringify(data.apps));
      if (data.checkedBoxes) localStorage.setItem('workspace_checked_boxes', JSON.stringify(data.checkedBoxes));
      if (data.customSuites) localStorage.setItem('workspace_custom_suites', JSON.stringify(data.customSuites));
      if (data.activeFile) localStorage.setItem('workspace_active_file', data.activeFile);
      if (data.alarmSound) localStorage.setItem('workspace_alarm_sound', data.alarmSound);
      if (data.stats) localStorage.setItem('workspace_stats', JSON.stringify(data.stats));
      if (data.taskStatus) localStorage.setItem('workspace_task_status', JSON.stringify(data.taskStatus));
      if (data.widgetOrder) localStorage.setItem('workspace_widget_order', JSON.stringify(data.widgetOrder));
      if (data.widgetHidden) localStorage.setItem('workspace_widget_hidden', JSON.stringify(data.widgetHidden));
      if (data.widgetWide) localStorage.setItem('workspace_widget_wide', JSON.stringify(data.widgetWide));
      if (data.customCss !== undefined) localStorage.setItem('workspace_custom_css', data.customCss);
      if (data.googleFont) localStorage.setItem('workspace_google_font', data.googleFont);
      if (data.soundMixer) localStorage.setItem('workspace_sound_mixer', JSON.stringify(data.soundMixer));
      if (data.standaloneTasks) localStorage.setItem('workspace_standalone_tasks', JSON.stringify(data.standaloneTasks));
      if (data.dashboardColumns) localStorage.setItem('workspace_dashboard_columns', String(data.dashboardColumns));
    } catch (e) {
      await autoSaveToFileSystem();
    }
  } catch (err) {
    console.error('Error reading from project folder:', err);
  }
}

async function autoSaveToFileSystem() {
  if (!dirHandle) return;
  try {
    const payload = JSON.stringify({
      apps: getApps(),
      checkedBoxes: JSON.parse(localStorage.getItem('workspace_checked_boxes') || '[]'),
      customSuites: JSON.parse(localStorage.getItem('workspace_custom_suites') || '{}'),
      activeFile: localStorage.getItem('workspace_active_file') || '',
      alarmSound: localStorage.getItem('workspace_alarm_sound') || 'chime',
      stats: JSON.parse(localStorage.getItem('workspace_stats') || '{}'),
      taskStatus: JSON.parse(localStorage.getItem('workspace_task_status') || '{}'),
      widgetOrder: JSON.parse(localStorage.getItem('workspace_widget_order') || 'null'),
      widgetHidden: JSON.parse(localStorage.getItem('workspace_widget_hidden') || '{}'),
      widgetWide: JSON.parse(localStorage.getItem('workspace_widget_wide') || '{}'),
      customCss: localStorage.getItem('workspace_custom_css') || '',
      googleFont: localStorage.getItem('workspace_google_font') || '',
      soundMixer: JSON.parse(localStorage.getItem('workspace_sound_mixer') || '{}'),
      standaloneTasks: JSON.parse(localStorage.getItem('workspace_standalone_tasks') || '[]'),
      dashboardColumns: parseInt(localStorage.getItem('workspace_dashboard_columns') || '2', 10)
    }, null, 2);

    const dataFile = await dirHandle.getFileHandle('data.json', { create: true });
    const writable = await dataFile.createWritable();
    await writable.write(payload);
    await writable.close();
  } catch (err) {
    console.error('File autosave failed:', err);
  }
}

// ============================================================
// QUICK-LAUNCH APPS
// ============================================================

function getApps() {
  const stored = localStorage.getItem('workspace_registered_apps');
  return stored ? JSON.parse(stored) : defaultApps;
}

async function saveApps(apps) {
  localStorage.setItem('workspace_registered_apps', JSON.stringify(apps));
  await autoSaveToFileSystem();
}

async function saveActiveFile(value) {
  localStorage.setItem('workspace_active_file', value);
  await autoSaveToFileSystem();
}

async function saveCheckboxes(values) {
  localStorage.setItem('workspace_checked_boxes', JSON.stringify(values));
  await autoSaveToFileSystem();
}

// ============================================================
// FUZZY SEARCH + COMMAND PALETTE
// ============================================================

function fuzzyScore(query, text) {
  query = (query || '').toLowerCase();
  text = (text || '').toLowerCase();
  if (!query) return 1;
  let qi = 0, score = 0, lastMatch = -1;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) {
      score += (lastMatch === ti - 1) ? 3 : 1;
      lastMatch = ti;
      qi++;
    }
  }
  return qi === query.length ? score : -1;
}

function buildCommandList() {
  const notes = getNotes();
  const noteCmds = Object.keys(notes).map(f => ({ label: '📝 ' + f.replace(/\.md$/i, ''), action: () => goToNote(f) }));
  const navCmds = [
    { label: '🏠 Go to Dashboard', action: () => { location.href = 'index.html'; } },
    { label: '🗒️ Go to Notes', action: () => { location.href = 'notes.html'; } },
    { label: '📋 Go to Tasks', action: () => { location.href = 'tasks.html'; } },
    { label: '📄 Go to File Preview', action: () => { location.href = 'preview.html'; } },
    { label: '⚙️ Go to Settings', action: () => { location.href = 'settings.html'; } }
  ];
  const actionCmds = [
    { label: '➕ New Note', action: () => quickNewNoteGlobal() },
    { label: '📅 Open/Create Daily Note', action: () => openDailyNoteGlobal() },
    { label: '▶️ Start Timer', action: () => timerStart() },
    { label: '⏸ Pause Timer', action: () => timerPause() },
    { label: '🌓 Toggle Theme', action: () => toggleTheme() }
  ];
  return [...navCmds, ...actionCmds, ...noteCmds];
}

let paletteSelectedIndex = 0;
let paletteFiltered = [];

function openCommandPalette() {
  const modal = document.getElementById('paletteModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const input = document.getElementById('paletteInput');
  input.value = '';
  filterPalette();
  setTimeout(() => input.focus(), 30);
}

function closeCommandPalette() {
  const modal = document.getElementById('paletteModal');
  if (modal) modal.style.display = 'none';
}

function filterPalette() {
  const input = document.getElementById('paletteInput');
  const q = input ? input.value : '';
  const all = buildCommandList();
  if (!q) {
    paletteFiltered = all;
  } else {
    paletteFiltered = all.map(c => ({ ...c, score: fuzzyScore(q, c.label) })).filter(c => c.score >= 0).sort((a, b) => b.score - a.score);
    if (paletteFiltered.length === 0) {
      paletteFiltered = [{ label: `➕ Create note "${q}"`, action: () => quickNewNoteGlobal(q) }];
    }
  }
  paletteSelectedIndex = 0;
  renderPaletteList();
}

function renderPaletteList() {
  const list = document.getElementById('paletteList');
  if (!list) return;
  list.innerHTML = paletteFiltered.map((c, i) => `<div class="palette-item ${i === paletteSelectedIndex ? 'palette-active' : ''}" onmousedown="event.preventDefault(); runPaletteItem(${i})">${c.label}</div>`).join('') || '<div class="palette-item"><em>No results</em></div>';
}

function runPaletteItem(i) {
  const item = paletteFiltered[i];
  if (!item) return;
  closeCommandPalette();
  item.action();
}

document.addEventListener('keydown', (e) => {
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    openCommandPalette();
    return;
  }
  const modal = document.getElementById('paletteModal');
  const paletteOpen = modal && modal.style.display === 'flex';
  if (e.key === 'Escape') {
    if (paletteOpen) closeCommandPalette();
    return;
  }
  if (paletteOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteSelectedIndex = Math.min(paletteSelectedIndex + 1, paletteFiltered.length - 1); renderPaletteList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSelectedIndex = Math.max(paletteSelectedIndex - 1, 0); renderPaletteList(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(paletteSelectedIndex); }
  }
});

// ============================================================
// TASK ENGINE: parsing, status, recurrence, notifications
//
// Tasks come from two sources that are merged into one model:
//  - "note" tasks: `- [ ]` checkbox lines scanned out of your notes
//  - "standalone" tasks: created directly on the Tasks page, not tied to
//    any note
// A task with more indentation than the task line above it is treated as
// a *subtask* of that task (for notes) — subtasks are checklist items only
// and don't carry their own scheduling. Scheduling is unplanned / a single
// day / or a day-range (no specific time needed), expressed inline in note
// text as `📅 2026-09-01` or `📅 2026-09-01..2026-09-05`.
// ============================================================

function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function computeNextDate(dateStr, recurText) {
  const d = new Date(dateStr + 'T00:00:00');
  const m = recurText.match(/every\s+(?:(\d+)\s+)?(day|week|month|year)s?/i);
  if (!m) return dateStr;
  const n = parseInt(m[1] || '1', 10);
  const unit = m[2].toLowerCase();
  if (unit === 'day') d.setDate(d.getDate() + n);
  else if (unit === 'week') d.setDate(d.getDate() + 7 * n);
  else if (unit === 'month') d.setMonth(d.getMonth() + n);
  else if (unit === 'year') d.setFullYear(d.getFullYear() + n);
  return formatDateLocal(d);
}

function scheduleTypeOf(due, dueEnd) { return dueEnd ? 'range' : (due ? 'single' : 'unplanned'); }

// Note-derived tasks (flat — includes subtasks as their own entries with .parentId set)
function scanAllTasks() {
  const notes = getNotes();
  const tasks = [];
  Object.keys(notes).forEach(file => {
    const lines = notes[file].split('\n');
    let lastTopLevelId = null;
    let lastTopLevelIndent = 0;
    lines.forEach((line, idx) => {
      const m = line.match(/^(\s*)-\s\[( |x|X)\]\s+(.*)$/);
      if (!m) return;
      const indent = m[1].length;
      const done = m[2].toLowerCase() === 'x';
      const rawText = m[3];
      const dueMatch = rawText.match(/📅\s*(\d{4}-\d{2}-\d{2})(?:\s*\.\.\s*(\d{4}-\d{2}-\d{2}))?/);
      const recurMatch = rawText.match(/🔁\s*(every\s+[a-zA-Z0-9 ]+?)(?=\s*(?:📅|🔺|🔶|🔼|🔽|#|$))/i);
      let priority = null;
      if (/🔺/.test(rawText)) priority = 'high';
      else if (/🔶|🔼/.test(rawText)) priority = 'medium';
      else if (/🔽/.test(rawText)) priority = 'low';
      const tags = Array.from(rawText.matchAll(/#([\w-]+)/g)).map(x => x[1]);
      const cleanText = rawText
        .replace(/📅\s*\d{4}-\d{2}-\d{2}(?:\s*\.\.\s*\d{4}-\d{2}-\d{2})?/g, '')
        .replace(/🔁\s*every\s+[a-zA-Z0-9 ]+/gi, '')
        .replace(/[🔺🔶🔼🔽]/g, '')
        .replace(/#[\w-]+/g, '')
        .trim();
      const id = hashStr(file + '::' + cleanText);
      const due = dueMatch ? dueMatch[1] : null;
      const dueEnd = dueMatch && dueMatch[2] ? dueMatch[2] : null;

      let parentId = null;
      if (indent > lastTopLevelIndent && lastTopLevelId) parentId = lastTopLevelId;

      tasks.push({
        id, source: 'note', file, lineIndex: idx, indent, rawText, cleanText, done,
        due, dueEnd, scheduleType: scheduleTypeOf(due, dueEnd),
        priority, recurring: recurMatch ? recurMatch[1].trim() : null, tags, parentId
      });

      if (!parentId) { lastTopLevelId = id; lastTopLevelIndent = indent; }
    });
  });
  return tasks;
}

// Standalone tasks (not tied to any note)
function getStandaloneTasks() { return JSON.parse(localStorage.getItem('workspace_standalone_tasks') || '[]'); }
function saveStandaloneTasks(list) { localStorage.setItem('workspace_standalone_tasks', JSON.stringify(list)); }

async function createStandaloneTask(opts) {
  const list = getStandaloneTasks();
  const due = opts.due || null;
  const dueEnd = opts.dueEnd || null;
  const task = {
    id: hashStr('standalone::' + (opts.text || '') + '::' + Date.now() + '::' + Math.random()),
    source: 'standalone',
    text: opts.text || 'Untitled task',
    done: false,
    priority: opts.priority || null,
    tags: opts.tags || [],
    recurring: opts.recurring || null,
    due, dueEnd,
    scheduleType: scheduleTypeOf(due, dueEnd),
    subtasks: [],
    createdAt: Date.now()
  };
  list.push(task);
  saveStandaloneTasks(list);
  await autoSaveToFileSystem();
  return task;
}

async function deleteStandaloneTask(id) {
  saveStandaloneTasks(getStandaloneTasks().filter(t => t.id !== id));
  await autoSaveToFileSystem();
}

async function toggleStandaloneTaskDone(id, done) {
  const list = getStandaloneTasks();
  const t = list.find(x => x.id === id);
  if (!t) return;
  if (done && t.recurring && t.due) {
    const spanDays = t.dueEnd ? Math.round((new Date(t.dueEnd) - new Date(t.due)) / 86400000) : 0;
    const nextDue = computeNextDate(t.due, t.recurring);
    t.due = nextDue;
    if (t.dueEnd) {
      const d = new Date(nextDue + 'T00:00:00');
      d.setDate(d.getDate() + spanDays);
      t.dueEnd = formatDateLocal(d);
    }
    t.done = false;
  } else {
    t.done = done;
  }
  saveStandaloneTasks(list);
  await autoSaveToFileSystem();
}

async function addStandaloneSubtask(parentId, text) {
  const list = getStandaloneTasks();
  const t = list.find(x => x.id === parentId);
  if (!t || !text) return;
  t.subtasks = t.subtasks || [];
  t.subtasks.push({ id: hashStr(parentId + '::' + text + '::' + Date.now()), text, done: false });
  saveStandaloneTasks(list);
  await autoSaveToFileSystem();
}

async function toggleStandaloneSubtask(parentId, subId, done) {
  const list = getStandaloneTasks();
  const t = list.find(x => x.id === parentId);
  if (!t) return;
  const s = (t.subtasks || []).find(x => x.id === subId);
  if (s) s.done = done;
  saveStandaloneTasks(list);
  await autoSaveToFileSystem();
}

// Merged view: top-level tasks (note + standalone) with nested lightweight subtasks
function getTopLevelTasks() {
  const noteTasks = scanAllTasks();
  const byId = {};
  noteTasks.forEach(t => { byId[t.id] = t; t.subtasks = []; });
  const topLevel = [];
  noteTasks.forEach(t => {
    if (t.parentId && byId[t.parentId]) {
      byId[t.parentId].subtasks.push({ id: t.id, text: t.cleanText || t.rawText, done: t.done });
    } else {
      topLevel.push(t);
    }
  });
  getStandaloneTasks().forEach(t => topLevel.push({ ...t, subtasks: t.subtasks || [] }));
  return topLevel;
}

function getTaskStatusMap() { return JSON.parse(localStorage.getItem('workspace_task_status') || '{}'); }
function setTaskStatusMap(m) { localStorage.setItem('workspace_task_status', JSON.stringify(m)); }

function resolveStatus(task, statusMap) {
  if (task.done) return 'done';
  return statusMap[task.id] === 'inprogress' ? 'inprogress' : 'todo';
}

async function markTaskLineDone(task, done) {
  const notes = getNotes();
  const content = notes[task.file];
  if (content === undefined) return;
  const lines = content.split('\n');
  let line = lines[task.lineIndex];
  if (line === undefined) return;

  if (done && task.recurring && task.due) {
    const nextDue = computeNextDate(task.due, task.recurring);
    line = line.replace(/📅\s*\d{4}-\d{2}-\d{2}/, `📅 ${nextDue}`);
    line = line.replace(/^(\s*-\s\[)( |x|X)(\])/, '$1 $3');
  } else {
    line = line.replace(/^(\s*-\s\[)( |x|X)(\])/, (m0, p1, p2, p3) => p1 + (done ? 'x' : ' ') + p3);
  }
  lines[task.lineIndex] = line;
  await setNoteContent(task.file, lines.join('\n'));
}

async function toggleTaskCheckbox(id, checked) {
  const task = scanAllTasks().find(t => t.id === id);
  if (!task) return;
  await markTaskLineDone(task, checked);
  if (checked) {
    const statusMap = getTaskStatusMap();
    delete statusMap[id];
    setTaskStatusMap(statusMap);
  }
}

// Dispatches by task.source so callers don't need to care where a task came from.
async function setTaskDone(task, done) {
  if (task.source === 'standalone') await toggleStandaloneTaskDone(task.id, done);
  else await toggleTaskCheckbox(task.id, done);
}

async function setTaskColumn(task, col) {
  const statusMap = getTaskStatusMap();
  if (col === 'done') {
    await setTaskDone(task, true);
    delete statusMap[task.id];
  } else {
    if (task.done) await setTaskDone(task, false);
    statusMap[task.id] = col === 'inprogress' ? 'inprogress' : 'todo';
  }
  setTaskStatusMap(statusMap);
}

async function addSubtask(task, text) {
  if (!text) return;
  if (task.source === 'standalone') {
    await addStandaloneSubtask(task.id, text);
    return;
  }
  const notes = getNotes();
  const content = notes[task.file];
  if (content === undefined) return;
  const lines = content.split('\n');
  const parentIndent = (lines[task.lineIndex].match(/^(\s*)/)[1]).length;
  let insertAt = task.lineIndex + 1;
  while (insertAt < lines.length) {
    const cm = lines[insertAt].match(/^(\s*)-\s\[/);
    if (cm && cm[1].length > parentIndent) insertAt++;
    else break;
  }
  lines.splice(insertAt, 0, `${' '.repeat(parentIndent + 2)}- [ ] ${text}`);
  await setNoteContent(task.file, lines.join('\n'));
}

async function toggleSubtask(task, subtaskId, checked) {
  if (task.source === 'standalone') await toggleStandaloneSubtask(task.id, subtaskId, checked);
  else await toggleTaskCheckbox(subtaskId, checked);
}

async function deleteTask(task) {
  if (task.source === 'standalone') { await deleteStandaloneTask(task.id); return; }
  const notes = getNotes();
  const content = notes[task.file];
  if (content === undefined) return;
  const lines = content.split('\n');
  const parentIndent = (lines[task.lineIndex].match(/^(\s*)/)[1]).length;
  let endAt = task.lineIndex + 1;
  while (endAt < lines.length) {
    const cm = lines[endAt].match(/^(\s*)-\s\[/);
    if (cm && cm[1].length > parentIndent) endAt++;
    else break;
  }
  lines.splice(task.lineIndex, endAt - task.lineIndex);
  await setNoteContent(task.file, lines.join('\n'));
}

// Notifications are opt-in only (see Settings) — nothing in the app requests
// permission automatically, so the browser prompt never appears uninvited.
function getNotificationPermissionStatus() {
  return (typeof Notification === 'undefined') ? 'unsupported' : Notification.permission;
}

async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

function checkDueTaskNotifications() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const today = todayStr();
  const tasks = getTopLevelTasks().filter(t => !t.done && t.scheduleType !== 'unplanned' && t.due && t.due <= today);
  const notified = JSON.parse(localStorage.getItem('workspace_notified_tasks') || '{}');
  const todaysNotified = notified[today] || [];
  const toNotify = tasks.filter(t => !todaysNotified.includes(t.id));
  toNotify.forEach(t => {
    new Notification(t.due < today ? 'Overdue Task' : 'Task Due Today', { body: t.cleanText || t.text || t.rawText });
  });
  if (toNotify.length) {
    notified[today] = todaysNotified.concat(toNotify.map(t => t.id));
    localStorage.setItem('workspace_notified_tasks', JSON.stringify(notified));
  }
}

// ============================================================
// TIMER ENGINE (state persisted in localStorage so it survives navigation)
// ============================================================

function getTimerState() {
  const raw = localStorage.getItem('workspace_timer_state');
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { /* fall through */ }
  }
  return { running: false, endTime: null, remainingSeconds: 1500, durationSeconds: 1500 };
}
function setTimerState(s) { localStorage.setItem('workspace_timer_state', JSON.stringify(s)); }

function timerRemaining(state) {
  state = state || getTimerState();
  if (state.running && state.endTime) return Math.max(0, Math.round((state.endTime - Date.now()) / 1000));
  return state.remainingSeconds;
}

function timerSetSeconds(totalSeconds) {
  totalSeconds = Math.max(0, Math.round(totalSeconds));
  const state = getTimerState();
  state.running = false;
  state.endTime = null;
  state.remainingSeconds = totalSeconds;
  state.durationSeconds = totalSeconds;
  setTimerState(state);
  timerNotify();
}

function timerStart() {
  const state = getTimerState();
  if (state.running || state.remainingSeconds <= 0) return;
  state.running = true;
  state.endTime = Date.now() + state.remainingSeconds * 1000;
  setTimerState(state);
  timerNotify();
}

function timerPause() {
  const state = getTimerState();
  if (state.running) {
    state.remainingSeconds = timerRemaining(state);
    state.running = false;
    state.endTime = null;
    setTimerState(state);
  }
  timerNotify();
}

function timerReset() {
  const state = getTimerState();
  state.running = false;
  state.endTime = null;
  state.remainingSeconds = state.durationSeconds;
  setTimerState(state);
  timerNotify();
}

let _timerListeners = [];
function onTimerTick(fn) {
  _timerListeners.push(fn);
  return () => { _timerListeners = _timerListeners.filter(f => f !== fn); };
}
function timerNotify() {
  const state = getTimerState();
  const remaining = timerRemaining(state);
  _timerListeners.forEach(fn => { try { fn(state, remaining); } catch (e) { console.error(e); } });
}

let _timerCompleting = false;
async function _timerLoop() {
  const state = getTimerState();
  if (state.running) {
    const remaining = timerRemaining(state);
    if (remaining <= 0 && !_timerCompleting) {
      _timerCompleting = true;
      await _completeTimer(state);
      _timerCompleting = false;
    } else {
      timerNotify();
    }
  }
}
setInterval(_timerLoop, 1000);

async function _completeTimer(state) {
  const finishedDuration = state.durationSeconds;
  state.running = false;
  state.endTime = null;
  state.remainingSeconds = state.durationSeconds;
  setTimerState(state);
  timerNotify();
  playAlertSound();
  const activeProject = localStorage.getItem('workspace_active_file') || '';
  const durationMins = Math.round(finishedDuration / 60);
  await generateSessionFile(activeProject, durationMins);
  const bodyText = activeProject ? `Great work on "${activeProject}"!` : 'Time for a break.';
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification('Focus Timer Complete!', { body: bodyText });
  }
  await recordSession(durationMins);
}

async function generateSessionFile(projectTitle, durationMinutes) {
  const now = new Date();
  const timestamp = now.toLocaleString();
  const dateString = formatDateLocal(now);
  const fileContent = `FOCUS SESSION LOG\n==============================\nDate & Time: ${timestamp}\nProject Title: ${projectTitle || 'Untitled Session'}\nSession Duration: ${durationMinutes} minute(s)\nStatus: Completed\n==============================`;

  if (dirHandle) {
    try {
      const logFile = await dirHandle.getFileHandle(`Focus_Session_${dateString}.txt`, { create: true });
      const writable = await logFile.createWritable();
      await writable.write(fileContent);
      await writable.close();
      return;
    } catch (err) {
      console.error('Session file creation in project folder failed:', err);
    }
  }

  const blob = new Blob([fileContent], { type: 'text/plain' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `Focus_Session_${dateString}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

async function recordSession(minutes) {
  const today = todayStr();
  const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let stats = JSON.parse(localStorage.getItem('workspace_stats') || '{}');
  if (!stats[today]) stats[today] = { sessions: 0, minutes: 0, history: [] };
  if (!stats[today].history) stats[today].history = [];
  stats[today].sessions += 1;
  stats[today].minutes += minutes;
  stats[today].history.push({ time: nowStr, minutes });
  localStorage.setItem('workspace_stats', JSON.stringify(stats));
  await autoSaveToFileSystem();
  if (window.onSessionRecorded) window.onSessionRecorded();
}

function playAlertSound() {
  const type = localStorage.getItem('workspace_alarm_sound') || 'chime';
  if (type === 'silent') return;
  if (type === 'custom') {
    const dataUrl = localStorage.getItem('workspace_custom_alarm');
    if (dataUrl) { new Audio(dataUrl).play().catch(() => {}); return; }
  }

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  if (type === 'beep') {
    osc.type = 'square';
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
  } else if (type === 'bell') {
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);
  } else {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.8);
  }

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 1.0);
}

// ============================================================
// THEME / ACCENT
// ============================================================

function applyStoredTheme() {
  const saved = localStorage.getItem('workspace_theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = document.documentElement.getAttribute('data-theme') === 'light' ? '🌙' : '☀️';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const target = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', target);
  localStorage.setItem('workspace_theme', target);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = target === 'light' ? '🌙' : '☀️';
}

function getOrangeLighterColor(hex, percent = 20) {
  let num = parseInt(hex.replace('#', ''), 16),
      amt = Math.round(2.55 * percent);
  let R = (num >> 16) + amt + 5,
      G = (num >> 8 & 0x00FF) + amt + 10,
      B = (num & 0x0000FF) + Math.round(amt * 0.4);
  return '#' + (0x1000000 + (R < 255 ? (R < 1 ? 0 : R) : 255) * 0x10000 + (G < 255 ? (G < 1 ? 0 : G) : 255) * 0x100 + (B < 255 ? (B < 1 ? 0 : B) : 255)).toString(16).slice(1);
}

function updateAccentColor(colorHex, persist) {
  const light = getOrangeLighterColor(colorHex, 20);
  document.documentElement.style.setProperty('--accent', colorHex);
  document.documentElement.style.setProperty('--accent-light', light);
  if (persist !== false) localStorage.setItem('workspace_accent_color', colorHex);
}

function applyStoredAccent() {
  const saved = localStorage.getItem('workspace_accent_color') || '#B13F2B';
  updateAccentColor(saved, false);
  const picker = document.getElementById('accentPicker');
  if (picker) picker.value = saved;
}

// ============================================================
// AESTHETICS: custom CSS + Google Fonts (data + DOM injection, shared)
// ============================================================

function applyCustomCss() {
  let styleTag = document.getElementById('customCssTag');
  if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = 'customCssTag';
    document.head.appendChild(styleTag);
  }
  styleTag.textContent = localStorage.getItem('workspace_custom_css') || '';
}

function applyGoogleFont(name) {
  let linkTag = document.getElementById('googleFontLink');
  if (!linkTag) {
    linkTag = document.createElement('link');
    linkTag.id = 'googleFontLink';
    linkTag.rel = 'stylesheet';
    document.head.appendChild(linkTag);
  }
  linkTag.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}:wght@400;600;700&display=swap`;
  document.documentElement.style.setProperty('--custom-font', `'${name}', 'Charter', 'Bitstream Charter', Georgia, serif`);
  localStorage.setItem('workspace_google_font', name);
}

// ============================================================
// NAV: active link + timer badge
// ============================================================

function highlightActiveNavLink(pageName) {
  document.querySelectorAll('.topnav-link').forEach(a => {
    a.classList.toggle('active', a.dataset.nav === pageName);
  });
}

function renderNavTimerBadge() {
  const badge = document.getElementById('timerBadge');
  if (!badge) return;
  badge.onclick = () => { location.href = 'index.html'; };
  onTimerTick((state, remaining) => {
    if (state.running) {
      badge.style.display = 'inline-flex';
      badge.textContent = '⏱ ' + formatSeconds(remaining);
    } else if (state.remainingSeconds < state.durationSeconds && state.remainingSeconds > 0) {
      badge.style.display = 'inline-flex';
      badge.textContent = '⏸ ' + formatSeconds(state.remainingSeconds);
    } else {
      badge.style.display = 'none';
    }
  });
  timerNotify();
}

// ============================================================
// SHARED PAGE INIT — call once from every page's DOMContentLoaded
// ============================================================

async function initCommonApp(pageName) {
  document.body.dataset.page = pageName;
  applyStoredTheme();
  applyStoredAccent();
  highlightActiveNavLink(pageName);
  renderNavTimerBadge();

  const storedHandle = await getStoredDirectoryHandle();
  if (storedHandle) {
    try {
      let permission = await storedHandle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') permission = await storedHandle.requestPermission({ mode: 'readwrite' });
      if (permission === 'granted') {
        dirHandle = storedHandle;
        updateFolderStatusUI(true);
        await loadDataFromDirectory();
      } else {
        updateFolderStatusUI(false);
      }
    } catch (e) {
      updateFolderStatusUI(false);
    }
  } else {
    updateFolderStatusUI(false);
  }

  if (Object.keys(getNotes()).length === 0) {
    await migrateLegacyNotes();
  }

  applyCustomCss();
  const savedFont = localStorage.getItem('workspace_google_font');
  if (savedFont) applyGoogleFont(savedFont);

  checkDueTaskNotifications();
  setInterval(checkDueTaskNotifications, 15 * 60 * 1000);
}
