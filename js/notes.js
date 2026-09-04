/* Notes page: sidebar switcher, Source / Live Preview / Reading modes, wikilinks, backlinks, graph. */

let activeNoteFile = null;
let activeTagFilter = null;
let notesMode = 'live';
let notesPopoutWindow = null;

// ============================================================
// Mode switching
//   Source       — raw markdown in a plain textarea
//   Live Preview — default; whole note renders as formatted text, but the
//                  line your cursor is in reveals its raw markdown (Obsidian-style)
//   Reading      — clean, fully rendered, read-only view
// ============================================================

function setNotesMode(mode) {
  if (notesMode === 'live' && mode !== 'live') {
    clearTimeout(lpSaveTimer);
    lpPersist();
  }
  notesMode = mode;
  document.querySelectorAll('.notes-mode-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('noteEditorTextarea').style.display = mode === 'source' ? 'block' : 'none';
  document.getElementById('lpContainer').style.display = mode === 'live' ? 'block' : 'none';
  document.getElementById('notePreviewWrapper').style.display = mode === 'reading' ? 'block' : 'none';
  document.getElementById('wikilinkSuggestBox').style.display = 'none';

  if (mode === 'source') {
    document.getElementById('noteEditorTextarea').value = lpFrontmatter + lpLines.join('\n');
    document.getElementById('noteEditorTextarea').focus();
  } else if (mode === 'live') {
    lpActiveLineIndex = -1;
    renderLivePreview();
  } else if (mode === 'reading') {
    renderNotePreview();
  }
}

// ============================================================
// Rendering (Reading mode / Source mode)
// ============================================================

function renderNotePreview() {
  const previewEl = document.getElementById('notePreviewContent');
  if (!activeNoteFile) { previewEl.innerHTML = '<div class="empty-state"><span class="empty-icon">🗒️</span>Select a note on the left, or create a new one.</div>'; return; }
  const raw = getNoteContent(activeNoteFile);
  const { body } = parseFrontmatter(raw);
  let html = marked.parse(body);
  html = html.replace(/\[(\d+\s*marks|\d+)\]/gi, '<span class="exam-marks">[$1]</span>');
  html = resolveWikiLinksHtml(html);
  previewEl.innerHTML = html;
  renderMathInElement(previewEl);
}

function renderBacklinks() {
  const container = document.getElementById('linkedReferences');
  if (!activeNoteFile) { container.innerHTML = '<em>No note selected.</em>'; return; }
  const currentTitle = activeNoteFile.replace(/\.md$/i, '');
  const notes = getNotes();
  const refs = [];
  Object.keys(notes).forEach(f => {
    if (f === activeNoteFile) return;
    const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let m;
    while ((m = re.exec(notes[f]))) {
      if (m[1].trim().toLowerCase() === currentTitle.toLowerCase()) { refs.push(f); break; }
    }
  });
  container.innerHTML = refs.length
    ? refs.map(f => `<div class="backlink-item" onclick="openNoteInPage('${f.replace(/'/g, "\\'")}')">🔗 ${f.replace(/\.md$/i, '')}</div>`).join('')
    : '<em>No linked references yet.</em>';
}

function openNote(filename) {
  activeNoteFile = filename;
  localStorage.setItem('workspace_active_note', filename);
  const raw = getNoteContent(filename);
  const { body } = parseFrontmatter(raw);
  lpFrontmatter = raw.slice(0, raw.length - body.length);
  lpLines = body.split('\n');
  lpActiveLineIndex = -1;
  document.getElementById('noteEditorTextarea').value = raw;
  document.getElementById('noteTitleDisplay').textContent = filename.replace(/\.md$/i, '');
  if (notesMode === 'live') renderLivePreview();
  else if (notesMode === 'reading') renderNotePreview();
  renderBacklinks();
}

async function onNoteEdit() {
  if (!activeNoteFile) return;
  const val = document.getElementById('noteEditorTextarea').value;
  await setNoteContent(activeNoteFile, val);
  const { body } = parseFrontmatter(val);
  lpFrontmatter = val.slice(0, val.length - body.length);
  lpLines = body.split('\n');
  if (notesMode !== 'source') renderNotePreview();
  renderBacklinks();
  syncPopoutNote(val);
}

function handleNoteEditorInput() { onNoteEdit(); checkWikiLinkAutosuggest(); }

function checkWikiLinkAutosuggest() {
  const ta = document.getElementById('noteEditorTextarea');
  if (notesMode !== 'source') return;
  const pos = ta.selectionStart;
  const textBefore = ta.value.slice(0, pos);
  const match = textBefore.match(/\[\[([^\]\n]*)$/);
  const box = document.getElementById('wikilinkSuggestBox');
  if (match) {
    const query = match[1];
    const titles = Object.keys(getNotes()).map(f => f.replace(/\.md$/i, ''));
    const scored = titles
      .map(t => ({ t, score: fuzzyScore(query, t) }))
      .filter(x => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    if (scored.length) {
      box.innerHTML = scored.map(({ t }) => `<div class="wikilink-suggest-item" onmousedown="event.preventDefault(); insertWikiLink('${t.replace(/'/g, "\\'")}')">${t}</div>`).join('');
      box.style.top = (ta.offsetTop + 30) + 'px';
      box.style.left = ta.offsetLeft + 'px';
      box.style.display = 'block';
      return;
    }
  }
  box.style.display = 'none';
}

function insertWikiLink(title) {
  const ta = document.getElementById('noteEditorTextarea');
  const pos = ta.selectionStart;
  const textBefore = ta.value.slice(0, pos);
  const match = textBefore.match(/\[\[([^\]\n]*)$/);
  if (!match) return;
  const startIdx = match.index + 2;
  const before = ta.value.slice(0, startIdx);
  const after = ta.value.slice(pos);
  const newVal = before + title + ']]' + after;
  ta.value = newVal;
  const newPos = (before + title + ']]').length;
  ta.selectionStart = ta.selectionEnd = newPos;
  document.getElementById('wikilinkSuggestBox').style.display = 'none';
  onNoteEdit();
  ta.focus();
}

// ============================================================
// Live Preview engine
//   The whole note is one contenteditable region, one <div class="lp-line">
//   per line. The line the caret is in shows raw markdown text (plain,
//   editable); every other line shows its rendered formatting. Enter/
//   Backspace/Arrow keys are handled manually so re-renders stay predictable.
// ============================================================

let lpFrontmatter = '';
let lpLines = [''];
let lpActiveLineIndex = -1;
let lpSaveTimer = null;
let lpSuggestLineIdx = null;

function renderLivePreview() {
  const container = document.getElementById('lpContainer');
  if (!activeNoteFile) {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">🗒️</span>Select a note on the left, or create a new one.</div>';
    return;
  }
  let inCode = false;
  const html = lpLines.map((line, i) => {
    const isFence = /^\s*```/.test(line);
    if (i === lpActiveLineIndex) {
      if (isFence) inCode = !inCode;
      return `<div class="lp-line lp-line-active" contenteditable="true" data-line="${i}">${escapeHtml(line)}</div>`;
    }
    if (isFence) {
      inCode = !inCode;
      return `<div class="lp-line lp-code-line" data-line="${i}">${escapeHtml(line) || '<br>'}</div>`;
    }
    if (inCode) {
      return `<div class="lp-line lp-code-line" data-line="${i}">${escapeHtml(line) || '<br>'}</div>`;
    }
    return `<div class="lp-line" data-line="${i}">${renderLpLine(line) || '<br>'}</div>`;
  }).join('');
  container.innerHTML = html;
}

function renderLpLine(line) {
  let m = line.match(/^(\s*)-\s\[( |x|X)\]\s+(.*)$/);
  if (m) {
    const indent = m[1].length;
    const done = m[2].toLowerCase() === 'x';
    return `<span style="padding-left:${indent * 0.8}em; display:block;" class="lp-checkbox-line ${done ? 'lp-done' : ''}"><input type="checkbox" class="lp-checkbox" ${done ? 'checked' : ''}>${renderLpInline(m[3])}</span>`;
  }
  m = line.match(/^(#{1,3})\s+(.*)$/);
  if (m) return `<span class="lp-h${m[1].length}">${renderLpInline(m[2])}</span>`;
  m = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (m) return `<span class="lp-list-item" style="padding-left:${m[1].length * 0.8}em;">${renderLpInline(m[2])}</span>`;
  m = line.match(/^>\s?(.*)$/);
  if (m) return `<span class="lp-quote">${renderLpInline(m[1])}</span>`;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) return `<hr class="lp-hr">`;
  if (line.trim() === '') return '';
  return renderLpInline(line);
}

function renderLpInline(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = resolveWikiLinksHtml(html);
  html = html.replace(/(^|\s)#([\w-]+)/g, '$1<span style="color:var(--accent);">#$2</span>');
  return html;
}

function placeCaretInElement(el, offset) {
  el.focus();
  let node = el.firstChild;
  if (!node) { el.appendChild(document.createTextNode('')); node = el.firstChild; }
  const len = node.textContent ? node.textContent.length : 0;
  const range = document.createRange();
  range.setStart(node, Math.max(0, Math.min(offset, len)));
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function activateLpLine(idx, offset) {
  if (idx < 0 || idx >= lpLines.length) return;
  lpActiveLineIndex = idx;
  renderLivePreview();
  const lineDiv = document.querySelector(`#lpContainer .lp-line[data-line="${idx}"]`);
  if (lineDiv) placeCaretInElement(lineDiv, offset === undefined ? lpLines[idx].length : offset);
}

async function lpPersist() {
  if (!activeNoteFile) return;
  await setNoteContent(activeNoteFile, lpFrontmatter + lpLines.join('\n'));
  renderBacklinks();
}

async function lpPersistImmediate() {
  clearTimeout(lpSaveTimer);
  await lpPersist();
}

async function toggleLpCheckboxLine(idx) {
  const line = lpLines[idx];
  const m = line.match(/^(\s*-\s\[)( |x|X)(\].*)$/);
  if (!m) return;
  const nowChecked = m[2].toLowerCase() !== 'x';
  lpLines[idx] = m[1] + (nowChecked ? 'x' : ' ') + m[3];
  renderLivePreview();
  await lpPersistImmediate();
}

function checkWikiLinkAutosuggestLive(lineDiv) {
  const idx = parseInt(lineDiv.dataset.line, 10);
  const sel = window.getSelection();
  const caretPos = sel.anchorOffset;
  const text = lineDiv.textContent;
  const match = text.slice(0, caretPos).match(/\[\[([^\]\n]*)$/);
  const box = document.getElementById('wikilinkSuggestBox');
  if (match) {
    const query = match[1];
    const titles = Object.keys(getNotes()).map(f => f.replace(/\.md$/i, ''));
    const scored = titles.map(t => ({ t, score: fuzzyScore(query, t) })).filter(x => x.score >= 0).sort((a, b) => b.score - a.score).slice(0, 6);
    if (scored.length) {
      box.innerHTML = scored.map(({ t }) => `<div class="wikilink-suggest-item" onmousedown="event.preventDefault(); insertWikiLinkLive('${t.replace(/'/g, "\\'")}')">${t}</div>`).join('');
      box.style.top = (lineDiv.offsetTop + lineDiv.offsetHeight) + 'px';
      box.style.left = lineDiv.offsetLeft + 'px';
      box.style.display = 'block';
      lpSuggestLineIdx = idx;
      return;
    }
  }
  box.style.display = 'none';
}

function insertWikiLinkLive(title) {
  const idx = lpSuggestLineIdx;
  const lineDiv = document.querySelector(`#lpContainer .lp-line[data-line="${idx}"]`);
  if (!lineDiv) return;
  const sel = window.getSelection();
  const caretPos = sel.anchorOffset;
  const text = lineDiv.textContent;
  const match = text.slice(0, caretPos).match(/\[\[([^\]\n]*)$/);
  if (!match) return;
  const startIdx = match.index + 2;
  const newText = text.slice(0, startIdx) + title + ']]' + text.slice(caretPos);
  lineDiv.textContent = newText;
  lpLines[idx] = newText;
  document.getElementById('wikilinkSuggestBox').style.display = 'none';
  placeCaretInElement(lineDiv, startIdx + title.length + 2);
  lpPersistImmediate();
}

function onLpInput(e) {
  const lineDiv = e.target.closest('.lp-line');
  if (!lineDiv) return;
  const idx = parseInt(lineDiv.dataset.line, 10);
  if (idx !== lpActiveLineIndex) return;
  lpLines[idx] = lineDiv.textContent;
  checkWikiLinkAutosuggestLive(lineDiv);
  clearTimeout(lpSaveTimer);
  lpSaveTimer = setTimeout(lpPersist, 350);
}

function onLpKeydown(e) {
  const lineDiv = e.target.closest('.lp-line');
  if (!lineDiv) return;
  const idx = parseInt(lineDiv.dataset.line, 10);
  if (idx !== lpActiveLineIndex) return;
  const sel = window.getSelection();

  if (e.key === 'Enter') {
    e.preventDefault();
    const caretOffset = sel.anchorOffset;
    const fullText = lineDiv.textContent;
    lpLines[idx] = fullText.slice(0, caretOffset);
    lpLines.splice(idx + 1, 0, fullText.slice(caretOffset));
    activateLpLine(idx + 1, 0);
    lpPersistImmediate();
  } else if (e.key === 'Backspace' && sel.anchorOffset === 0 && idx > 0) {
    e.preventDefault();
    const prevLen = lpLines[idx - 1].length;
    lpLines[idx - 1] = lpLines[idx - 1] + lineDiv.textContent;
    lpLines.splice(idx, 1);
    activateLpLine(idx - 1, prevLen);
    lpPersistImmediate();
  } else if (e.key === 'ArrowDown' && idx < lpLines.length - 1) {
    e.preventDefault();
    activateLpLine(idx + 1, sel.anchorOffset);
  } else if (e.key === 'ArrowUp' && idx > 0) {
    e.preventDefault();
    activateLpLine(idx - 1, sel.anchorOffset);
  }
}

function initLivePreviewListeners() {
  const container = document.getElementById('lpContainer');

  container.addEventListener('mousedown', (e) => {
    if (e.target.closest('a.wikilink')) return;
    const checkbox = e.target.closest('.lp-checkbox');
    if (checkbox) {
      e.preventDefault();
      const lineDiv = e.target.closest('.lp-line');
      toggleLpCheckboxLine(parseInt(lineDiv.dataset.line, 10));
      return;
    }
    const lineDiv = e.target.closest('.lp-line');
    if (!lineDiv) return;
    const idx = parseInt(lineDiv.dataset.line, 10);
    if (idx === lpActiveLineIndex) return;
    e.preventDefault();
    let offset = lpLines[idx].length;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) offset = Math.min(r.startOffset, lpLines[idx].length);
    }
    activateLpLine(idx, offset);
  });

  container.addEventListener('input', onLpInput);
  container.addEventListener('keydown', onLpKeydown);

  container.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!container.contains(document.activeElement)) {
        lpActiveLineIndex = -1;
        renderLivePreview();
      }
    }, 0);
  });
}

// ============================================================
// Sidebar: search, tags, switcher list, create/delete
// ============================================================

function setTagFilter(tag) { activeTagFilter = tag; renderNotesSwitcherList(); }

function renderTagChips() {
  const tags = getAllTags();
  const container = document.getElementById('tagChipsContainer');
  container.innerHTML = ['<span class="tag-chip ' + (!activeTagFilter ? 'tag-chip-active' : '') + '" onclick="setTagFilter(null)">All</span>']
    .concat(tags.map(t => `<span class="tag-chip ${activeTagFilter === t ? 'tag-chip-active' : ''}" onclick="setTagFilter('${t.replace(/'/g, "\\'")}')">#${t}</span>`))
    .join('');
}

function renderNotesSwitcherList() {
  const q = document.getElementById('noteSearchInput').value;
  const notes = getNotes();
  let entries = Object.keys(notes);
  if (activeTagFilter) entries = entries.filter(f => getNoteTags(notes[f]).includes(activeTagFilter));

  const mtimes = getNoteMtimes();
  const scored = entries
    .map(f => ({ f, score: fuzzyScore(q, f.replace(/\.md$/i, '')) }))
    .filter(x => x.score >= 0)
    .sort((a, b) => b.score - a.score || (mtimes[b.f] || 0) - (mtimes[a.f] || 0));

  const container = document.getElementById('noteSwitcherList');
  container.innerHTML = scored.map(({ f }) => `
    <div class="note-switch-item ${f === activeNoteFile ? 'note-switch-active' : ''}" onclick="openNoteInPage('${f.replace(/'/g, "\\'")}')">
      <span class="note-switch-title">${f.replace(/\.md$/i, '')}</span>
      <button class="btn-icon btn-icon-close" onclick="event.stopPropagation(); confirmDeleteNote('${f.replace(/'/g, "\\'")}')">✕</button>
    </div>
  `).join('') || '<div class="note-switch-empty"><em>No notes found.</em></div>';

  renderTagChips();
}

function openNoteInPage(filename) { openNote(filename); renderNotesSwitcherList(); }

// ============================================================
// Import markdown files as new notes
// ============================================================

function uniqueNoteFilename(title) {
  const base = sanitizeFilename(title);
  const notes = getNotes();
  let filename = base + '.md';
  let n = 1;
  while (notes[filename]) {
    n++;
    filename = `${base} (${n}).md`;
  }
  return filename;
}

async function handleImportMarkdown(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  let lastFilename = null;
  for (const file of files) {
    const text = await file.text();
    const title = file.name.replace(/\.(md|markdown|txt)$/i, '');
    const filename = uniqueNoteFilename(title);
    await setNoteContent(filename, text);
    lastFilename = filename;
  }
  e.target.value = '';
  renderNotesSwitcherList();
  if (lastFilename) openNoteInPage(lastFilename);
}

async function confirmDeleteNote(f) {
  if (!confirm(`Delete note "${f}"? This cannot be undone.`)) return;
  await deleteNote(f);
  if (activeNoteFile === f) {
    activeNoteFile = null;
    lpFrontmatter = '';
    lpLines = [''];
    lpActiveLineIndex = -1;
    document.getElementById('noteEditorTextarea').value = '';
    document.getElementById('noteTitleDisplay').textContent = 'No note selected';
    renderNotePreview();
    renderLivePreview();
    renderBacklinks();
    const remaining = Object.keys(getNotes());
    if (remaining.length) openNote(remaining[0]);
  }
  renderNotesSwitcherList();
}

async function confirmDeleteActiveNote() {
  if (!activeNoteFile) return;
  await confirmDeleteNote(activeNoteFile);
}

// ============================================================
// Popout floating note window
// ============================================================

function popoutNotes() {
  if (!activeNoteFile) { alert('Open or create a note first.'); return; }
  if (notesPopoutWindow && !notesPopoutWindow.closed) { notesPopoutWindow.focus(); return; }

  notesPopoutWindow = window.open('', 'NotesPopout', 'width=460,height=520,resizable=yes');
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const bg = isLight ? '#FDFAF2' : '#17181d';
  const text = isLight ? '#2B2A27' : '#F3EFF0';
  const border = isLight ? 'rgba(43, 42, 39, 0.1)' : 'rgba(243, 239, 240, 0.08)';

  notesPopoutWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${activeNoteFile.replace(/\.md$/i, '')} — Workspace Notes</title>
      <style>
        body { margin: 0; padding: 16px; background: ${bg}; color: ${text}; font-family: monospace; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
        h3 { margin-top: 0; font-family: sans-serif; font-size: 1rem; color: #B13F2B; }
        textarea { flex: 1; width: 100%; background: ${bg}; color: ${text}; border: 1px solid ${border}; border-radius: 6px; padding: 12px; outline: none; resize: none; font-family: monospace; font-size: 0.95rem; }
        textarea:focus { border-color: #B13F2B; }
      </style>
    </head>
    <body>
      <h3>📝 ${activeNoteFile.replace(/\.md$/i, '')}</h3>
      <textarea id="popoutTextarea" placeholder="Start typing...">${document.getElementById('noteEditorTextarea').value}</textarea>
      <script>
        const textarea = document.getElementById('popoutTextarea');
        textarea.addEventListener('input', () => {
          window.opener.document.getElementById('noteEditorTextarea').value = textarea.value;
          window.opener.onNoteEdit();
        });
      <\/script>
    </body>
    </html>
  `);
}

function syncPopoutNote(val) {
  if (notesPopoutWindow && !notesPopoutWindow.closed) {
    const popoutArea = notesPopoutWindow.document.getElementById('popoutTextarea');
    if (popoutArea && popoutArea.value !== val) popoutArea.value = val;
  }
}

// ============================================================
// Graph view (force-directed layout)
// ============================================================

function toggleGraphModal(show) {
  document.getElementById('graphModal').style.display = show ? 'flex' : 'none';
  if (show) renderGraph();
}

function renderGraph() {
  const notes = getNotes();
  const files = Object.keys(notes);
  const titleToFile = {};
  files.forEach(f => { titleToFile[f.replace(/\.md$/i, '').toLowerCase()] = f; });

  const nodes = files.map(f => ({ id: f, title: f.replace(/\.md$/i, ''), x: Math.random() * 600 + 50, y: Math.random() * 400 + 50, vx: 0, vy: 0 }));
  const nodeIndex = {};
  nodes.forEach((n, i) => { nodeIndex[n.id] = i; });
  const edges = [];
  files.forEach(f => {
    const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let m;
    while ((m = re.exec(notes[f]))) {
      const target = titleToFile[m[1].trim().toLowerCase()];
      if (target && target !== f) edges.push({ source: f, target });
    }
  });

  for (let iter = 0; iter < 200; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let distSq = dx * dx + dy * dy || 0.01;
        let force = 2000 / distSq;
        let dist = Math.sqrt(distSq);
        dx /= dist; dy /= dist;
        a.vx += dx * force; a.vy += dy * force;
        b.vx -= dx * force; b.vy -= dy * force;
      }
    }
    edges.forEach(e => {
      const a = nodes[nodeIndex[e.source]], b = nodes[nodeIndex[e.target]];
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      let force = (dist - 120) * 0.02;
      dx /= dist; dy /= dist;
      a.vx += dx * force; a.vy += dy * force;
      b.vx -= dx * force; b.vy -= dy * force;
    });
    nodes.forEach(n => {
      n.vx += (350 - n.x) * 0.001;
      n.vy += (250 - n.y) * 0.001;
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(30, Math.min(670, n.x));
      n.y = Math.max(30, Math.min(470, n.y));
    });
  }

  const svg = document.getElementById('graphSvg');
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#B13F2B';
  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#F3EFF0';
  const cardBg = getComputedStyle(document.documentElement).getPropertyValue('--card-bg').trim() || '#16181d';

  if (!nodes.length) {
    svg.innerHTML = `<text x="350" y="250" text-anchor="middle" fill="${textColor}" font-size="14">No notes yet — create one to see the graph.</text>`;
    return;
  }

  let svgContent = edges.map(e => {
    const a = nodes[nodeIndex[e.source]], b = nodes[nodeIndex[e.target]];
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${accent}" stroke-opacity="0.35" stroke-width="1.5"/>`;
  }).join('');

  svgContent += nodes.map(n => `
    <g class="graph-node" onclick="openNoteByTitle('${n.title.replace(/'/g, "\\'")}'); toggleGraphModal(false);">
      <circle cx="${n.x}" cy="${n.y}" r="${n.id === activeNoteFile ? 10 : 7}" fill="${n.id === activeNoteFile ? accent : cardBg}" stroke="${accent}" stroke-width="2"/>
      <text x="${n.x}" y="${n.y - 12}" text-anchor="middle" font-size="11" fill="${textColor}">${n.title}</text>
    </g>
  `).join('');

  svg.innerHTML = svgContent;
}

// ============================================================
// Init
// ============================================================

window.addEventListener('DOMContentLoaded', async () => {
  await initCommonApp('notes');
  initLivePreviewListeners();

  const params = new URLSearchParams(location.search);
  const requestedNote = params.get('note');
  const notes = getNotes();
  let target = null;
  if (requestedNote && notes[requestedNote]) {
    target = requestedNote;
  } else {
    const saved = localStorage.getItem('workspace_active_note');
    target = (saved && notes[saved]) ? saved : Object.keys(notes)[0];
  }
  if (target) openNote(target);
  renderNotesSwitcherList();
  setNotesMode('live');

  if (params.get('graph') === '1') toggleGraphModal(true);
});
