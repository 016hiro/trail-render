// HTTP API + static UI for the web renderer. Wraps src/job-runner.js so the
// browser can drive the same pipeline as the CLI. Lives on port 8080 by
// default; runJob still spins up its own map server on 3456 per job.
//
// Endpoints:
//   GET    /                          → public/app/index.html (the UI)
//   POST   /api/render?…              → enqueue a job, returns { jobId, queuePosition }
//                                       body = raw GPX bytes (Content-Type ignored)
//                                       query = fps, width, height, title, end,
//                                               name, pace, intro, duration
//   GET    /api/jobs/:id              → { status, queuePosition?, events, output? }
//   GET    /api/jobs/:id/events       → SSE stream of progress events
//   GET    /api/jobs/:id/download     → MP4 file (HTTP Range supported)
//   DELETE /api/jobs/:id              → cancel a queued or running job
//   GET    /api/status                → { busy, busyJobId, queue: [ids], queueDepth, jobCount }
//
// Concurrency: one running job at a time. Additional submits queue FIFO.
// Cancellation: AbortSignal flows through job-runner → captureFrames →
// browser.close() + ffmpeg SIGTERM.
// Persistence: in-memory only. Server restart drops queue + history; on-disk
// MP4 artifacts survive via the disk-fallback download endpoint.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { runJob } from './job-runner.js';

const API_KEY = process.env.MAPTILER_KEY;
const UI_PORT = parseInt(process.env.PORT || '8080');
const RENDER_PORT = 3456;
const REPO = path.resolve(import.meta.dir, '..');
const JOBS_DIR = path.join(REPO, 'output', 'jobs');
// Days after which a finished job's directory is purged at server startup.
// Override via JOB_TTL_DAYS=… (set to 0 to disable).
const JOB_TTL_DAYS = parseFloat(process.env.JOB_TTL_DAYS || '30');

if (!API_KEY) {
  console.warn('⚠  MAPTILER_KEY not set — the UI will load but /api/render will 503 until it is. Get a key at https://www.maptiler.com/');
}

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {'queued'|'running'|'done'|'error'|'cancelled'} status
 * @property {object[]} events
 * @property {Set} subscribers
 * @property {string|null} output
 * @property {string|null} error
 * @property {number} createdAt
 * @property {number|null} startedAt
 * @property {number|null} finishedAt
 * @property {AbortController} abort
 * @property {object} params
 * @property {import('node:fs').WriteStream|null} logStream
 */

/** @type {Map<string, Job>} */
const jobs = new Map();
/** @type {string[]} */
const queue = [];
let runningJobId = null;

function newJobId() {
  return Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
}

function emitEvent(job, evt) {
  const enriched = { ...evt, at: Date.now() };
  job.events.push(enriched);
  const line = `data: ${JSON.stringify(enriched)}\n\n`;
  for (const res of job.subscribers) {
    try { res.write(line); } catch { /* dropped subscriber */ }
  }
  // Persist to disk so finished jobs keep an audit trail.
  if (job.logStream && !job.logStream.destroyed) {
    try { job.logStream.write(JSON.stringify(enriched) + '\n'); } catch { /* ignore */ }
  }
}

function closeSubscribers(job) {
  for (const res of job.subscribers) {
    try { res.end(); } catch { /* ignore */ }
  }
  job.subscribers.clear();
}

function closeLog(job) {
  if (job.logStream && !job.logStream.destroyed) {
    try { job.logStream.end(); } catch { /* ignore */ }
  }
  job.logStream = null;
}

function jobView(job) {
  return {
    id: job.id,
    status: job.status,
    output: job.output ? `/api/jobs/${job.id}/download` : null,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    queuePosition: job.status === 'queued' ? queuePositionOf(job.id) : null,
    events: job.events,
  };
}

function queuePositionOf(id) {
  // 1-based position. Position 1 means "next to run after the current one
  // (or immediately if nothing is running)".
  const idx = queue.indexOf(id);
  return idx < 0 ? null : idx + 1;
}

function parseNumber(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/* =================================================================
   Job lifecycle: enqueue → tryStartNext → run → settle → tryStartNext
   ================================================================= */

async function enqueueJob({ gpxBuffer, params }) {
  const id = newJobId();
  const jobDir = path.join(JOBS_DIR, id);
  const gpxPath = path.join(jobDir, 'input.gpx');
  const output  = path.join(jobDir, 'trail.mp4');
  const logPath = path.join(jobDir, 'log.jsonl');

  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(gpxPath, gpxBuffer);

  const job = {
    id,
    status: 'queued',
    events: [],
    subscribers: new Set(),
    output: null,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    abort: new AbortController(),
    params: { ...params, gpxPath, output },
    logStream: createWriteStream(logPath, { flags: 'a' }),
  };
  jobs.set(id, job);
  queue.push(id);
  emitEvent(job, { type: 'phase', phase: 'queued', jobId: id, queuePosition: queuePositionOf(id) });

  tryStartNext();
  return id;
}

function tryStartNext() {
  if (runningJobId) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job || job.status !== 'queued') { tryStartNext(); return; }
  startRunning(job);
  // Notify everyone still queued that their position dropped.
  for (const qid of queue) {
    const qj = jobs.get(qid);
    if (qj) emitEvent(qj, { type: 'queue', queuePosition: queuePositionOf(qid) });
  }
}

function startRunning(job) {
  runningJobId = job.id;
  job.status = 'running';
  job.startedAt = Date.now();
  emitEvent(job, { type: 'phase', phase: 'running' });

  runJob({
    apiKey: API_KEY,
    port: RENDER_PORT,
    gpxPath: job.params.gpxPath,
    output: job.params.output,
    fps: job.params.fps,
    width: job.params.width,
    height: job.params.height,
    duration: job.params.duration,
    title: job.params.title,
    end: job.params.end,
    name: job.params.name,
    pace: job.params.pace,
    intro: job.params.intro,
    onProgress: (evt) => emitEvent(job, evt),
    signal: job.abort.signal,
  })
  .then((result) => {
    job.status = 'done';
    job.output = result.outputFile;
    job.finishedAt = Date.now();
    emitEvent(job, { type: 'phase', phase: 'done', output: `/api/jobs/${job.id}/download` });
  })
  .catch((err) => {
    job.finishedAt = Date.now();
    if (err?.cancelled || err?.name === 'AbortError' || job.abort.signal.aborted) {
      job.status = 'cancelled';
      emitEvent(job, { type: 'phase', phase: 'cancelled' });
    } else {
      job.status = 'error';
      job.error = err?.message || String(err);
      emitEvent(job, { type: 'error', message: job.error });
    }
  })
  .finally(() => {
    closeSubscribers(job);
    closeLog(job);
    if (runningJobId === job.id) runningJobId = null;
    tryStartNext();
  });
}

/* =================================================================
   Express app
   ================================================================= */

const app = express();
app.use(express.static(path.join(REPO, 'public', 'app')));

app.post('/api/render', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'Server is missing MAPTILER_KEY' });
  if (!req.body || req.body.length === 0) return res.status(400).json({ error: 'GPX body is empty' });

  const q = req.query;
  const params = {
    fps:      parseInt(parseNumber(q.fps, 30)),
    width:    parseInt(parseNumber(q.width, 1920)),
    height:   parseInt(parseNumber(q.height, 1080)),
    duration: q.duration ? parseInt(parseNumber(q.duration)) : undefined,
    title:    q.title ? String(q.title) : undefined,
    end:      q.end ? String(q.end) : undefined,
    name:     q.name ? String(q.name) : undefined,
    pace:     q.pace != null && q.pace !== '' ? parseNumber(q.pace) : undefined,
    intro:    q.intro != null && q.intro !== '' ? parseNumber(q.intro) : undefined,
  };

  const id = await enqueueJob({ gpxBuffer: req.body, params });
  const job = jobs.get(id);
  res.status(202).json({
    jobId: id,
    status: job.status,
    queuePosition: job.status === 'queued' ? queuePositionOf(id) : null,
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  res.json(jobView(job));
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  if (job.status === 'queued') {
    const idx = queue.indexOf(job.id);
    if (idx >= 0) queue.splice(idx, 1);
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    emitEvent(job, { type: 'phase', phase: 'cancelled' });
    closeSubscribers(job);
    closeLog(job);
    return res.json({ status: 'cancelled' });
  }
  if (job.status === 'running') {
    job.abort.abort();  // settle path runs in the runJob .catch above
    return res.json({ status: 'cancelling' });
  }
  return res.status(409).json({ error: `Cannot cancel job in status=${job.status}` });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  for (const evt of job.events) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  if (['done', 'error', 'cancelled'].includes(job.status)) {
    res.end();
    return;
  }

  job.subscribers.add(res);
  req.on('close', () => job.subscribers.delete(res));
});

// Serve the rendered MP4. Uses res.sendFile so HTTP Range requests are
// handled — the <video> element relies on Range to seek and to keep playing
// past its initial buffer. Disk fallback covers jobs whose in-memory record
// is gone (server restart) but whose artifact still exists.
app.get('/api/jobs/:id/download', async (req, res) => {
  const id = req.params.id;
  let outputPath = jobs.get(id)?.output;
  if (!outputPath) {
    const fallback = path.join(JOBS_DIR, id, 'trail.mp4');
    try { await fs.access(fallback); outputPath = fallback; } catch { /* fall through */ }
  }
  if (!outputPath) return res.status(404).json({ error: 'No artifact for this job id' });
  res.sendFile(outputPath, {
    headers: { 'Content-Type': 'video/mp4' },
    acceptRanges: true,
    cacheControl: false,
  });
});

app.get('/api/status', (_req, res) => {
  res.json({
    busy: Boolean(runningJobId),
    busyJobId: runningJobId,
    queue: [...queue],
    queueDepth: queue.length,
    jobCount: jobs.size,
  });
});

/* =================================================================
   Output cleanup: delete output/jobs/<id>/ dirs older than TTL.
   Runs once at startup. Cheap; if it grows expensive later, move to
   a background timer.
   ================================================================= */

async function purgeOldJobs() {
  if (!Number.isFinite(JOB_TTL_DAYS) || JOB_TTL_DAYS <= 0) return;
  const cutoff = Date.now() - JOB_TTL_DAYS * 24 * 60 * 60 * 1000;
  let dirs;
  try {
    dirs = await fs.readdir(JOBS_DIR, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`output/jobs scan failed: ${e.message}`);
    return;
  }
  let purged = 0;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(JOBS_DIR, d.name);
    try {
      const stat = await fs.stat(dirPath);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(dirPath, { recursive: true, force: true });
        purged++;
      }
    } catch (e) {
      console.warn(`Could not purge ${d.name}: ${e.message}`);
    }
  }
  if (purged > 0) console.log(`Purged ${purged} job director${purged === 1 ? 'y' : 'ies'} older than ${JOB_TTL_DAYS}d.`);
}

await purgeOldJobs();

app.listen(UI_PORT, () => {
  console.log(`trail-render web UI on http://localhost:${UI_PORT}`);
});
