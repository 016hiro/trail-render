// HTTP API + static UI for the web renderer. Wraps src/job-runner.js so the
// browser can drive the same pipeline as the CLI. Lives on port 8080 by
// default; runJob still spins up its own map server on 3456 per job.
//
// Endpoints:
//   GET  /                         → public/app/index.html (the UI)
//   POST /api/render?...           → start a job, returns { jobId }
//                                    body = raw GPX bytes (Content-Type ignored)
//                                    query = fps, width, height, title, end,
//                                            name, pace, intro, duration
//   GET  /api/jobs/:id             → { status, events, output? }
//   GET  /api/jobs/:id/events      → SSE stream of progress events
//   GET  /api/jobs/:id/download    → MP4 file, attachment
//
// Single-job lock: second concurrent POST /api/render returns 409.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { runJob } from './job-runner.js';

const API_KEY = process.env.MAPTILER_KEY;
const UI_PORT = parseInt(process.env.PORT || '8080');
const RENDER_PORT = 3456; // runJob's internal map-server port
const REPO = path.resolve(import.meta.dir, '..');
const JOBS_DIR = path.join(REPO, 'output', 'jobs');

if (!API_KEY) {
  console.warn('⚠  MAPTILER_KEY not set — the UI will load but /api/render will 503 until it is. Get a key at https://www.maptiler.com/');
}

/** @type {Map<string, Job>} */
const jobs = new Map();
let busyJobId = null;

function newJobId() {
  return Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
}

function createJob(id) {
  const job = {
    id,
    status: 'queued',
    events: [],
    subscribers: new Set(),
    output: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  return job;
}

function emitEvent(job, evt) {
  const enriched = { ...evt, at: Date.now() };
  job.events.push(enriched);
  const line = `data: ${JSON.stringify(enriched)}\n\n`;
  for (const res of job.subscribers) {
    try { res.write(line); } catch { /* subscriber disconnected */ }
  }
}

function closeSubscribers(job) {
  for (const res of job.subscribers) {
    try { res.end(); } catch { /* ignore */ }
  }
  job.subscribers.clear();
}

function parseNumber(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

const app = express();

app.use(express.static(path.join(REPO, 'public', 'app')));

app.post('/api/render', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  if (!API_KEY) {
    return res.status(503).json({ error: 'Server is missing MAPTILER_KEY' });
  }
  if (busyJobId) {
    return res.status(409).json({ error: 'Another render is in progress', busyJobId });
  }
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: 'GPX body is empty' });
  }

  const id = newJobId();
  const job = createJob(id);
  busyJobId = id;

  const q = req.query;
  const fps      = parseInt(parseNumber(q.fps, 30));
  const width    = parseInt(parseNumber(q.width, 1920));
  const height   = parseInt(parseNumber(q.height, 1080));
  const duration = q.duration ? parseInt(parseNumber(q.duration)) : undefined;
  const title    = q.title ? String(q.title) : undefined;
  const end      = q.end ? String(q.end) : undefined;
  const name     = q.name ? String(q.name) : undefined;
  const pace     = q.pace != null && q.pace !== '' ? parseNumber(q.pace) : undefined;
  const intro    = q.intro != null && q.intro !== '' ? parseNumber(q.intro) : undefined;

  const jobDir  = path.join(JOBS_DIR, id);
  const gpxPath = path.join(jobDir, 'input.gpx');
  const output  = path.join(jobDir, 'trail.mp4');

  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(gpxPath, req.body);

  res.status(202).json({ jobId: id, status: 'running' });

  job.status = 'running';
  emitEvent(job, { type: 'phase', phase: 'queued', jobId: id });

  runJob({
    gpxPath, output, apiKey: API_KEY,
    fps, width, height, duration,
    title, end, name, pace, intro,
    port: RENDER_PORT,
    onProgress: (evt) => emitEvent(job, evt),
  }).then((result) => {
    job.status = 'done';
    job.output = result.outputFile;
    job.finishedAt = Date.now();
    emitEvent(job, { type: 'phase', phase: 'done', output: `/api/jobs/${id}/download` });
    closeSubscribers(job);
  }).catch((err) => {
    job.status = 'error';
    job.error = err.message || String(err);
    job.finishedAt = Date.now();
    emitEvent(job, { type: 'error', message: job.error });
    closeSubscribers(job);
  }).finally(() => {
    if (busyJobId === id) busyJobId = null;
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  res.json({
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    output: job.output ? `/api/jobs/${job.id}/download` : null,
    events: job.events,
  });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay history
  for (const evt of job.events) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  if (job.status === 'done' || job.status === 'error') {
    res.end();
    return;
  }

  job.subscribers.add(res);
  req.on('close', () => job.subscribers.delete(res));
});

app.get('/api/jobs/:id/download', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  if (!job.output) return res.status(409).json({ error: `Job not done (status=${job.status})` });
  try {
    await fs.access(job.output);
  } catch {
    return res.status(410).json({ error: 'Output file missing' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="trail-${job.id}.mp4"`);
  createReadStream(job.output).pipe(res);
});

app.get('/api/status', (_req, res) => {
  res.json({
    busy: Boolean(busyJobId),
    busyJobId,
    jobCount: jobs.size,
  });
});

app.listen(UI_PORT, () => {
  console.log(`trail-render web UI on http://localhost:${UI_PORT}`);
});
