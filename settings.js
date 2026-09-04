/* Settings page: directory sync, app manager, appearance, timer/alarm, sound mixer. */

// ============================================================
// App manager
// ============================================================

function renderModalAppsList() {
  const apps = getApps();
  const container = document.getElementById('modalAppsList');
  container.innerHTML = apps.length ? '' : '<div class="empty-state">No apps registered yet.</div>';
  apps.forEach((app, idx) => {
    const item = document.createElement('div');
    item.className = 'settings-item';
    item.innerHTML = `
      <span class="item-label"><strong>${app.icon ? app.icon + ' ' : ''}${app.title}</strong> — ${app.url}</span>
      <button class="btn-icon btn-icon-close" onclick="deleteApp(${idx})">Remove</button>
    `;
    container.appendChild(item);
  });
}

async function addAppFromModal() {
  const title = document.getElementById('modalTitle').value.trim();
  const url = document.getElementById('modalUrl').value.trim();
  const icon = document.getElementById('modalIcon').value.trim();
  if (!title || !url) return;

  const apps = getApps();
  apps.push({ title, url, icon });
  await saveApps(apps);
  renderModalAppsList();

  document.getElementById('modalTitle').value = '';
  document.getElementById('modalUrl').value = '';
  document.getElementById('modalIcon').value = '';
}

async function deleteApp(index) {
  const apps = getApps();
  apps.splice(index, 1);
  await saveApps(apps);
  renderModalAppsList();
}

async function saveCustomSuiteFromSettings() {
  const name = document.getElementById('suiteNameInput').value.trim();
  if (!name) { alert('Please specify a name for your custom suite.'); return; }
  const checkedValues = JSON.parse(localStorage.getItem('workspace_checked_boxes') || '[]');
  if (!checkedValues.length) { alert('Please check at least one app on your Dashboard launcher first, then come back here to save it as a suite.'); return; }
  const customSuites = JSON.parse(localStorage.getItem('workspace_custom_suites') || '{}');
  customSuites[name] = checkedValues;
  localStorage.setItem('workspace_custom_suites', JSON.stringify(customSuites));
  document.getElementById('suiteNameInput').value = '';
  await autoSaveToFileSystem();
  alert(`Custom suite "${name}" saved! It now appears on your Dashboard launcher.`);
}

// ============================================================
// Timer / alarm
// ============================================================

function saveAlarmSound() {
  localStorage.setItem('workspace_alarm_sound', document.getElementById('alarmSoundSelect').value);
}

function handleCustomAlarmUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    localStorage.setItem('workspace_custom_alarm', ev.target.result);
    document.getElementById('customAlarmStatus').textContent = `Uploaded: ${file.name}`;
    const select = document.getElementById('alarmSoundSelect');
    if (![...select.options].some(o => o.value === 'custom')) {
      const opt = document.createElement('option');
      opt.value = 'custom';
      opt.textContent = 'Custom Uploaded Sound';
      select.appendChild(opt);
    }
    select.value = 'custom';
    saveAlarmSound();
  };
  reader.readAsDataURL(file);
}

// ============================================================
// Desktop notifications (explicit opt-in only — see common.js)
// ============================================================

function renderNotifPermissionButton() {
  const btn = document.getElementById('notifPermissionBtn');
  const status = getNotificationPermissionStatus();
  if (status === 'granted') {
    btn.textContent = '🔔 Notifications Enabled';
    btn.disabled = true;
  } else if (status === 'denied') {
    btn.textContent = '🔕 Notifications Blocked (change this in your browser settings)';
    btn.disabled = true;
  } else if (status === 'unsupported') {
    btn.textContent = '🔕 Notifications Not Supported';
    btn.disabled = true;
  } else {
    btn.textContent = '🔔 Enable Desktop Notifications';
    btn.disabled = false;
  }
}

async function onEnableNotificationsClick() {
  await requestNotificationPermission();
  renderNotifPermissionButton();
}

// ============================================================
// Appearance: custom CSS + Google Fonts (DOM injection lives in common.js)
// ============================================================

function saveCustomCss() {
  localStorage.setItem('workspace_custom_css', document.getElementById('customCssInput').value);
  applyCustomCss();
}

function applyGoogleFontFromInput() {
  const name = document.getElementById('googleFontInput').value.trim();
  if (!name) return;
  applyGoogleFont(name);
  document.getElementById('currentFontLabel').textContent = `Current: ${name}`;
  document.getElementById('googleFontInput').value = '';
}

// ============================================================
// Ambient sound mixer
// ============================================================

let soundNodes = {};

function createNoiseBuffer(ctx, colored) {
  const bufferSize = 2 * ctx.sampleRate;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let lastOut = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    if (colored) {
      lastOut = (lastOut + (0.02 * white)) / 1.02;
      data[i] = lastOut * 3.5;
    } else {
      data[i] = white;
    }
  }
  return buffer;
}

function getSoundMixerState() { return JSON.parse(localStorage.getItem('workspace_sound_mixer') || '{}'); }

function saveSoundMixerState() {
  const state = getSoundMixerState();
  ['rain', 'white'].forEach(k => { state[k] = { ...(state[k] || {}), on: !!soundNodes[k] }; });
  localStorage.setItem('workspace_sound_mixer', JSON.stringify(state));
}

function updateSoundMixerUI() {
  ['rain', 'white'].forEach(k => {
    const btn = document.getElementById('soundBtn-' + k);
    if (btn) btn.textContent = soundNodes[k] ? '⏸ Pause' : '▶ Play';
  });
}

function toggleAmbientSound(kind) {
  if (soundNodes[kind]) {
    soundNodes[kind].source.stop();
    soundNodes[kind].ctx.close();
    delete soundNodes[kind];
    updateSoundMixerUI();
    saveSoundMixerState();
    return;
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buffer = createNoiseBuffer(ctx, kind === 'rain');
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const gain = ctx.createGain();
  const savedVol = getSoundMixerState()[kind]?.vol ?? 0.3;
  gain.gain.value = savedVol;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.start();
  soundNodes[kind] = { ctx, source, gain };
  updateSoundMixerUI();
  saveSoundMixerState();
}

function setSoundVolume(kind, vol) {
  if (soundNodes[kind]) soundNodes[kind].gain.gain.value = parseFloat(vol);
  const state = getSoundMixerState();
  state[kind] = { ...(state[kind] || {}), vol: parseFloat(vol) };
  localStorage.setItem('workspace_sound_mixer', JSON.stringify(state));
}

// ============================================================
// Init
// ============================================================

window.addEventListener('DOMContentLoaded', async () => {
  await initCommonApp('settings');

  renderModalAppsList();
  renderNotifPermissionButton();

  document.getElementById('customCssInput').value = localStorage.getItem('workspace_custom_css') || '';

  const savedFont = localStorage.getItem('workspace_google_font');
  if (savedFont) document.getElementById('currentFontLabel').textContent = `Current: ${savedFont}`;

  const savedSound = localStorage.getItem('workspace_alarm_sound');
  if (localStorage.getItem('workspace_custom_alarm')) {
    const select = document.getElementById('alarmSoundSelect');
    const opt = document.createElement('option');
    opt.value = 'custom';
    opt.textContent = 'Custom Uploaded Sound';
    select.appendChild(opt);
    document.getElementById('customAlarmStatus').textContent = 'Custom sound restored from previous session.';
  }
  if (savedSound) document.getElementById('alarmSoundSelect').value = savedSound;

  const soundState = getSoundMixerState();
  ['rain', 'white'].forEach(k => {
    const slider = document.querySelector(`#soundBtn-${k}`)?.previousElementSibling;
    if (slider && soundState[k]?.vol !== undefined) slider.value = soundState[k].vol;
  });
});
