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
let currentJobId = null;          // jobId of the active or last-finished render
const fileInput = $('#file-input');
const browseBtn = $('#browse-btn');
const clearBtn  = $('#clear-btn');
const renderBtn = $('#render-btn');
const cancelBtn = $('#cancel-btn');
const optsFieldset = $('#options-fieldset');

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
  optsFieldset.disabled = true;
  cancelBtn.disabled = false;

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
    currentJobId = jobId;
    history.replaceState(null, '', `?job=${jobId}`);
    $('#run-id').textContent = `JOB · ${jobId}`;
    if (j.queuePosition) showQueuePosition(j.queuePosition);
  } catch (e) {
    optsFieldset.disabled = false;
    renderBtn.disabled = false;
    showError(e.message || String(e));
    return;
  }

  subscribeEvents(jobId);
});

/* ---------- Cancel ---------- */
cancelBtn.addEventListener('click', async () => {
  if (!currentJobId) return;
  cancelBtn.disabled = true;
  cancelBtn.textContent = '▣ CANCELLING …';
  try {
    await fetch(`/api/jobs/${currentJobId}`, { method: 'DELETE' });
  } catch {
    cancelBtn.disabled = false;
    cancelBtn.textContent = '▣ CANCEL RENDER';
  }
  // The actual UI transition to the cancelled state happens when the
  // 'phase':'cancelled' event arrives via SSE, not here — that way
  // server-driven cancellation looks identical to button-driven.
});

/* ---------- SSE subscription with backoff reconnect ---------- */
function subscribeEvents(jobId) {
  const logBody = $('#run-log-body');
  const reconnectIndicator = $('#run-reconnect');
  let backoffMs = 1000;
  let terminal = false;
  let currentEs = null;

  const isTerminal = (evt) =>
    (evt.type === 'phase' && ['done', 'cancelled'].includes(evt.phase)) ||
    evt.type === 'error';

  function connect() {
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    currentEs = es;

    es.onopen = () => {
      backoffMs = 1000;
      reconnectIndicator.hidden = true;
    };

    es.onmessage = (ev) => {
      let evt;
      try { evt = JSON.parse(ev.data); } catch { return; }
      handleEvent(evt, jobId);
      if (evt.type === 'log' || (evt.message && evt.type !== 'phase')) {
        logBody.textContent += (evt.message || JSON.stringify(evt)) + '\n';
        logBody.scrollTop = logBody.scrollHeight;
      }
      // Close on terminal events to stop EventSource's auto-reconnect from
      // making the server replay the whole event history (which would
      // re-fire onDone and reset video.src — see devlog 2026-04-15 bug 3).
      if (isTerminal(evt)) {
        terminal = true;
        es.close();
      }
    };

    es.onerror = () => {
      es.close();
      if (terminal) return;
      // Genuine network blip (or server restart). Show a "reconnecting…"
      // hint and retry with exponential backoff capped at 30 s.
      reconnectIndicator.hidden = false;
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    };
  }

  connect();
  return () => { terminal = true; currentEs?.close(); };
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
      if (evt.phase === 'queued' && evt.queuePosition) showQueuePosition(evt.queuePosition);
      if (evt.phase === 'running') hideQueuePosition();
      if (evt.phase === 'done') onDone(jobId, evt.output);
      if (evt.phase === 'cancelled') onCancelled(jobId);
      break;
    case 'queue':
      showQueuePosition(evt.queuePosition);
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
      optsFieldset.disabled = false;
      showError(evt.message);
      break;
  }
}

function showQueuePosition(pos) {
  const el = $('#run-queue-pos');
  el.textContent = `QUEUED · POS ${pos}`;
  el.hidden = false;
}
function hideQueuePosition() {
  $('#run-queue-pos').hidden = true;
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

/* ---------- Done / Cancelled / Error ---------- */
let lastDoneJobId = null;
function onDone(jobId, output) {
  if (lastDoneJobId === jobId) return;  // idempotent — see devlog 2026-04-15 bug 3
  lastDoneJobId = jobId;

  stopTimer();
  optsFieldset.disabled = false;
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

let lastCancelledJobId = null;
function onCancelled(jobId) {
  if (lastCancelledJobId === jobId) return;  // same idempotency rationale as onDone
  lastCancelledJobId = jobId;
  stopTimer();
  optsFieldset.disabled = false;
  $('#cancel-meta').textContent = `JOB · ${jobId}`;
  showState('cancelled');
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
  hideQueuePosition();
  cancelBtn.textContent = '▣ CANCEL RENDER';
  cancelBtn.disabled = false;
  $('#run-reconnect').hidden = true;
}

/* ---------- Reset buttons ---------- */
function resetAll() {
  currentFile = null;
  currentJobId = null;
  fileInput.value = '';
  renderBtn.disabled = true;
  optsFieldset.disabled = false;
  history.replaceState(null, '', location.pathname);
  showState('empty');
}
$('#again-btn').addEventListener('click', resetAll);
$('#err-reset-btn').addEventListener('click', resetAll);
$('#cancel-reset-btn').addEventListener('click', resetAll);

/* ---------- Init ---------- */
showState('empty');

// Resume an in-progress (or already-finished) render via ?job=<id>. The
// URL is automatically rewritten on submit, so a refresh during a render
// drops back into the live view. Also doubles as a debug entry point —
// open ?job=<id> on any artifact still on disk to inspect it.
(async () => {
  const params = new URLSearchParams(location.search);
  const jobId = params.get('job');
  if (!jobId) return;

  currentJobId = jobId;
  const r = await fetch(`/api/jobs/${jobId}`).catch(() => null);

  if (r && r.ok) {
    const info = await r.json();
    if (info.status === 'done' && info.output)   { onDone(jobId, info.output); return; }
    if (info.status === 'cancelled')             { onCancelled(jobId); return; }
    if (info.status === 'error')                 { showError(info.error || 'Unknown error'); return; }
    // queued or running — replay history + subscribe live
    showState('running');
    optsFieldset.disabled = true;
    $('#run-id').textContent = `JOB · ${jobId}`;
    if (info.queuePosition) showQueuePosition(info.queuePosition);
    startTimer();
    renderBtn.disabled = true;
    subscribeEvents(jobId);
  } else {
    // No in-memory record. The artifact may still exist on disk via the
    // download fallback — show the done state pointing at it.
    const url = `/api/jobs/${jobId}/download`;
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
    if (head && head.ok) onDone(jobId, url);
    else showError(`No job '${jobId}' on server or disk`);
  }
})();
