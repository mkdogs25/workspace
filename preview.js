/* File preview page: drag/drop viewer for markdown, text, PDF, images, code. */

function processFile(file) {
  const viewerArea = document.getElementById('viewerArea');
  const viewerContent = document.getElementById('viewerContent');
  document.getElementById('dropText').textContent = `📄 Loaded: ${file.name}`;
  document.getElementById('previewControls').style.display = 'flex';

  const reader = new FileReader();

  if (file.name.endsWith('.md') || file.name.endsWith('.txt')) {
    reader.onload = (e) => {
      let parsedHtml = marked.parse(e.target.result);
      parsedHtml = parsedHtml.replace(/\[(\d+\s*marks|\d+)\]/gi, '<span class="exam-marks">[$1]</span>');
      viewerContent.innerHTML = parsedHtml;
      renderMathInElement(viewerContent);
      viewerArea.style.display = 'block';
    };
    reader.readAsText(file);
  } else if (file.type.startsWith('image/')) {
    reader.onload = (e) => {
      viewerContent.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
      viewerArea.style.display = 'block';
    };
    reader.readAsDataURL(file);
  } else if (file.type === 'application/pdf') {
    reader.onload = (e) => {
      viewerContent.innerHTML = `<iframe src="${e.target.result}"></iframe>`;
      viewerArea.style.display = 'block';
    };
    reader.readAsDataURL(file);
  } else {
    reader.onload = (e) => {
      viewerContent.innerHTML = `<pre>${escapeHtml(e.target.result)}</pre>`;
      viewerArea.style.display = 'block';
    };
    reader.readAsText(file);
  }
}

function handleFileSelect(e) {
  if (e.target.files.length) processFile(e.target.files[0]);
}

function toggleFileFullscreen() {
  const viewerArea = document.getElementById('viewerArea');
  const btn = document.getElementById('fullscreenBtn');
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    (viewerArea.requestFullscreen || viewerArea.webkitRequestFullscreen).call(viewerArea);
    btn.textContent = '✕ Exit Fullscreen';
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    btn.textContent = '⛶ Fullscreen';
  }
}

document.addEventListener('fullscreenchange', () => {
  const btn = document.getElementById('fullscreenBtn');
  if (btn && !document.fullscreenElement) btn.textContent = '⛶ Fullscreen';
});

function closePreview() {
  const viewerArea = document.getElementById('viewerArea');
  if (document.fullscreenElement) document.exitFullscreen();
  viewerArea.style.display = 'none';
  document.getElementById('viewerContent').innerHTML = '';
  document.getElementById('previewControls').style.display = 'none';
  document.getElementById('dropText').textContent = 'Click to choose a file, or drag & drop it here — .md, .txt, code, PDF, or images';
  document.getElementById('fileInput').value = '';
}

window.addEventListener('DOMContentLoaded', async () => {
  await initCommonApp('preview');

  const dropZone = document.getElementById('dropZone');
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eName => dropZone.addEventListener(eName, e => e.preventDefault(), false));
  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length) processFile(e.dataTransfer.files[0]);
  });
});
