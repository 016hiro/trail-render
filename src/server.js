import express from 'express';
import path from 'node:path';

const __dirname = import.meta.dir;

export function startServer(trackData, apiKey, port = 3456, introFrames = 360, opts = {}) {
  const app = express();

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/track', (_req, res) => res.json(trackData));
  app.get('/api/config', (_req, res) => res.json({ apiKey, introFrames, ...opts }));

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
      resolve(server);
    });
  });
}
