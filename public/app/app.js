// trail · render — browser UI client.
// Orchestrates: file drop → POST /api/render → SSE /api/jobs/:id/events
//               → live progress → download link.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- State machine ---------- */
const STATES = ['empty', 'loaded', 'running', 'done', 'error'];
const canvas = $('#canvas');

function showState(name) {
  $$('.state', canvas).forEach(el => {
    el.hidden = el.dataset.state !== name;
  });
}

/* ---------- File pick / drag-drop ---------- */
let currentFile = null;
const fileInput = $('#file-input');
const browseBtn = $('#browse-btn');
const clearBtn  = $('#clear-btn');
const renderBtn = $('#render-btn');

browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) setFile(e.target.files[0]);
});

canvas.addEventListener('dragover', (e) => {
  e.preventDefault();
  canvas.classList.add('drag-over');
});
canvas.addEventListener('dragleave', (e) => {
  if (e.target === canvas) canvas.classList.remove('drag-over');
});
canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  canvas.classList.remove('drag-over');
  const f = e.dataTransfer?.files?.[0];
  if (f) setFile(f);
});

clearBtn.addEventListener('click', () => {
  currentFile = null;
  fileInput.value = '';
  renderBtn.disabled = true;
  showState('empty');
});

function setFile(f) {
  if (!f.name.toLowerCase().endsWith('.gpx')) {
    alert('Please pick a .gpx file');
    return;
  }
  currentFile = f;
  $('#file-name').textContent = f.name;
  $('#stat-size').textContent = fmtBytes(f.size);
  $('#stat-points').textContent = '—';
  $('#stat-ready').textContent = 'ready';
  renderBtn.disabled = false;
  showState('loaded');
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------- Toggle groups (fps, resolution) ---------- */
const toggleState = { fps: '30', resolution: '1920x1080' };

$$('.toggle').forEach(group => {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $$('button', group).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    toggleState[group.dataset.name] = btn.dataset.value;
  });
});

/* ---------- Submit render ---------- */
const form = $('#options-form');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentFile) return;

  // Gather params
  const fd = new FormData(form);
  const title    = (fd.get('title') || '').trim();
  const end      = (fd.get('end') || '').trim();
  const name     = (fd.get('name') || '').trim();
  const pace     = (fd.get('pace') || '').trim();
  const intro    = (fd.get('intro') || '').trim();
  const duration = (fd.get('duration') || '').trim();
  const [width, height] = toggleState.resolution.split('x');

  const qs = new URLSearchParams();
  qs.set('fps', toggleState.fps);
  qs.set('width', width);
  qs.set('height', height);
  if (title)    qs.set('title', title);
  if (end)      qs.set('end', end);
  if (name)     qs.set('name', name);
  if (pace)     qs.set('pace', pace);
  if (intro)    qs.set('intro', intro);
  if (duration) qs.set('duration', duration);

  showState('running');
  resetRunUI();
  startTimer();
  renderBtn.disabled = true;

  let jobId;
  try {
    const res = await fetch(`/api/render?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gpx+xml' },
      body: currentFile,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const j = await res.json();
    jobId = j.jobId;
    $('#run-id').textContent = `JOB · ${jobId}`;
  } catch (e) {
    showError(e.message || String(e));
    return;
  }

  subscribeEvents(jobId);
});

/* ---------- SSE subscription ---------- */
function subscribeEvents(jobId) {
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  const logBody = $('#run-log-body');

  es.onmessage = (ev) => {
    let evt;
    try { evt = JSON.parse(ev.data); } catch { return; }
    handleEvent(evt, jobId);
    if (evt.type === 'log' || evt.message) {
      logBody.textContent += (evt.message || JSON.stringify(evt)) + '\n';
      logBody.scrollTop = logBody.scrollHeight;
    }
  };

  es.onerror = () => {
    // Stream closed — could be normal (server ended it after done/error)
    // or network hiccup. Nothing actionable here.
  };
}

/* ---------- Event handlers ---------- */
function handleEvent(evt, jobId) {
  switch (evt.type) {
    case 'phase':
      setPhase(evt.phase);
      if (evt.phase === 'done') onDone(jobId, evt.output);
      break;
    case 'track':
      $('#stat-points').textContent = `${evt.downsampled} pts · ${evt.distanceKm.toFixed(1)} km`;
      break;
    case 'plan':
      $('#run-eta').textContent = `total ${evt.duration}s · ${evt.totalFrames} frames`;
      break;
    case 'prewarm': {
      // Mirror prewarm progress onto all three bars — it's a pre-phase.
      const pct = Math.max(0, Math.min(1, evt.pct || 0)) * 100;
      $$('.cap-fill').forEach(el => el.style.width = `${pct}%`);
      $$('.cap-fill').forEach(el => el.style.background = 'var(--ink-mute)');
      $$('.cap-num').forEach((el) => el.textContent = `${pct.toFixed(0)}%`);
      break;
    }
    case 'capture':
      updateCapture(evt);
      break;
    case 'error':
      stopTimer();
      showError(evt.message);
      break;
  }
}

function setPhase(phase) {
  const ladder = $('#phase-ladder');
  const order = ['queued','parse','network','plan','prewarm','capture','encode','done'];
  const idx = order.indexOf(phase);
  if (idx < 0) return;
  $$('li', ladder).forEach((li, i) => {
    li.classList.remove('active', 'done');
    if (i < idx) li.classList.add('done');
    if (i === idx) li.classList.add('active');
  });
  if (phase === 'capture') {
    // Reset bar colors from any prewarm override
    $$('.cap-row[data-sub="intro"]  .cap-fill')[0].style.background = '';
    $$('.cap-row[data-sub="trail"]  .cap-fill')[0].style.background = '';
    $$('.cap-row[data-sub="finish"] .cap-fill')[0].style.background = '';
  }
}

function updateCapture(evt) {
  // evt: { subphase, frame, totalFrames, elapsedMs }
  const sub = evt.subphase;
  const row = $(`.cap-row[data-sub="${sub}"]`);
  if (!row) return;
  const fill = $('.cap-fill', row);
  const num  = $('.cap-num', row);

  // Compute per-phase pct using global frame index
  // introFrames + trailFrames + finishFrames === totalFrames (stored in plan)
  // We don't have exact boundaries client-side, so approximate by phase changes.
  // Simpler: fill the current phase proportionally, mark prior ones complete.
  const order = ['intro', 'trail', 'finish'];
  const curIdx = order.indexOf(sub);
  order.slice(0, curIdx).forEach(prior => {
    const r = $(`.cap-row[data-sub="${prior}"]`);
    $('.cap-fill', r).style.width = '100%';
    $('.cap-num', r).textContent = '✓';
  });

  // Phase pct: we approximate per-phase by assuming uniform per-frame time.
  // Server sends global frame index; for a rough visual we show overall pct in
  // the active row for now. Good enough — the exact split is visible in num.
  const globalPct = (evt.frame / evt.totalFrames) * 100;
  fill.style.width = `${globalPct}%`;
  num.textContent = `${evt.frame}/${evt.totalFrames}`;

  $('#run-frame').textContent = `frame ${evt.frame} / ${evt.totalFrames}`;

  const elapsedSec = (evt.elapsedMs || 0) / 1000;
  const perFrame = elapsedSec / (evt.frame + 1);
  const etaSec = (evt.totalFrames - evt.frame - 1) * perFrame;
  $('#run-eta').textContent = `ETA ${fmtMMSS(etaSec)}`;
}

/* ---------- Done / Error ---------- */
function onDone(jobId, output) {
  stopTimer();
  $('#phase-ladder li[data-phase="encode"]')?.classList.remove('active');
  $('#phase-ladder li[data-phase="encode"]')?.classList.add('done');
  $('#phase-ladder li[data-phase="done"]')?.classList.add('active');
  const url = output || `/api/jobs/${jobId}/download`;
  $('#done-video').src = url;
  $('#download-btn').href = url;
  $('#download-btn').setAttribute('download', `trail-${jobId}.mp4`);
  $('#done-meta').textContent = `JOB · ${jobId}`;
  showState('done');
}

function showError(msg) {
  $('#err-msg').textContent = msg;
  showState('error');
}

/* ---------- Timer ---------- */
let timerId = null, timerStart = 0;
function startTimer() {
  timerStart = Date.now();
  if (timerId) clearInterval(timerId);
  timerId = setInterval(() => {
    const s = (Date.now() - timerStart) / 1000;
    $('#run-timer').textContent = fmtMMSS(s);
  }, 500);
}
function stopTimer() {
  if (timerId) { clearInterval(timerId); timerId = null; }
}

function fmtMMSS(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function resetRunUI() {
  $$('.cap-fill').forEach(el => { el.style.width = '0%'; el.style.background = ''; });
  $$('.cap-num').forEach(el => el.textContent = '—');
  $('#run-frame').textContent = 'frame — / —';
  $('#run-eta').textContent = 'ETA —';
  $('#run-log-body').textContent = '';
  $$('#phase-ladder li').forEach(li => li.classList.remove('active', 'done'));
}

/* ---------- Reset buttons ---------- */
function resetAll() {
  currentFile = null;
  fileInput.value = '';
  renderBtn.disabled = true;
  showState('empty');
}
$('#again-btn').addEventListener('click', resetAll);
$('#err-reset-btn').addEventListener('click', resetAll);

/* ---------- Init ---------- */
showState('empty');
