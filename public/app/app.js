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
// Cache the plan event so capture-frame events can compute per-subphase pct
// without re-walking the server log. introFrames/finishFrames are the only
// boundaries we need; trailFrames is derived.
let plan = { introFrames: 0, finishFrames: 0, totalFrames: 0 };

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
      plan = {
        introFrames: evt.introFrames,
        finishFrames: evt.finishFrames,
        totalFrames: evt.totalFrames,
      };
      $('#run-eta').textContent = `total ${evt.duration}s · ${evt.totalFrames} frames`;
      break;
    case 'prewarm':
      updatePrewarm(evt.pct);
      break;
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
  // Mark prewarm row complete the moment capture phase begins, so the user
  // sees the prewarm checkmark even if no prewarm:1.0 event arrived in time.
  if (phase === 'capture' || phase === 'encode' || phase === 'done') {
    completeRow('prewarm');
  }
}

function updatePrewarm(rawPct) {
  const pct = Math.max(0, Math.min(1, rawPct || 0)) * 100;
  const row = $('.cap-row[data-sub="prewarm"]');
  $('.cap-fill', row).style.width = `${pct}%`;
  $('.cap-num',  row).textContent = `${pct.toFixed(0)}%`;
}

function completeRow(sub) {
  const row = $(`.cap-row[data-sub="${sub}"]`);
  if (!row) return;
  $('.cap-fill', row).style.width = '100%';
  $('.cap-num',  row).textContent = '✓';
}

function updateCapture(evt) {
  // evt: { subphase, frame, totalFrames, elapsedMs }
  // Use plan boundaries to compute per-subphase pct.
  const total  = plan.totalFrames || evt.totalFrames;
  const intro  = plan.introFrames;
  const finish = plan.finishFrames;
  const trailEnd = total - finish;
  const trailFrames = trailEnd - intro;

  const subOrder = ['intro', 'trail', 'finish'];
  const curIdx = subOrder.indexOf(evt.subphase);
  // Mark every prior subphase as complete (✓)
  subOrder.slice(0, curIdx).forEach(completeRow);

  // Compute per-subphase numerator/denominator + pct
  let num, denom;
  switch (evt.subphase) {
    case 'intro':
      num = evt.frame + 1;
      denom = intro;
      break;
    case 'trail':
      num = evt.frame - intro + 1;
      denom = trailFrames;
      break;
    case 'finish':
      num = evt.frame - trailEnd + 1;
      denom = finish;
      break;
    default:
      return;
  }
  const pct = denom > 0 ? Math.min(100, (num / denom) * 100) : 0;
  const row = $(`.cap-row[data-sub="${evt.subphase}"]`);
  $('.cap-fill', row).style.width = `${pct}%`;
  $('.cap-num',  row).textContent = `${num}/${denom}`;

  // Foot: global frame counter + ETA from global elapsed time
  $('#run-frame').textContent = `frame ${evt.frame + 1} / ${total}`;
  const elapsedSec = (evt.elapsedMs || 0) / 1000;
  const perFrame = elapsedSec / (evt.frame + 1);
  const etaSec = (total - evt.frame - 1) * perFrame;
  $('#run-eta').textContent = `ETA ${fmtMMSS(etaSec)}`;
}

/* ---------- Done / Error ---------- */
function onDone(jobId, output) {
  stopTimer();
  ['prewarm', 'intro', 'trail', 'finish'].forEach(completeRow);
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
  plan = { introFrames: 0, finishFrames: 0, totalFrames: 0 };
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
