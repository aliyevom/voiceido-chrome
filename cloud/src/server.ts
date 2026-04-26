/**
 * Voiceido cloud microservice — exposes:
 *
 *   GET  /health         — liveness probe (no auth)
 *   POST /api/ocr        — OCR via GCP Vision (auth: X-API-Key)
 *   POST /api/analyze    — Diagram analysis via OpenRouter (auth: X-API-Key)
 *
 * Deployed to Cloud Run via cloud/deploy.sh. Auto-scales to zero so cost
 * tracks usage. The service account on the deployment must have:
 *   - roles/cloudvision.user        (for /api/ocr)
 *   - roles/secretmanager.secretAccessor (for API_KEY + OPENROUTER_API_KEY)
 */

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import { config } from './config.js';
import { requireApiKey } from './middleware/apiKey.js';
import { ocrImage } from './services/vision.js';
import { analyzeImage } from './services/analyze.js';

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

const app = express();

/**
 * CORS — origin: true reflects the request's Origin header, which is the
 * only thing that works for chrome-extension://<id> origins (they're
 * opaque from the perspective of cors string-matching). The X-API-Key
 * header still gates the actual work below.
 */
app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key'],
    maxAge: 600,
  }),
);

app.use((req, _res, next) => {
  log(`→ ${req.method} ${req.originalUrl}`);
  next();
});

/** Memory storage — captures are small enough; avoids disk I/O on the
 *  ephemeral Cloud Run filesystem and keeps cold starts fast. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileBytes },
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    model: config.analysisModel,
    apiKeyConfigured: Boolean(config.apiKey),
    openRouterConfigured: Boolean(config.openRouterApiKey),
  });
});

app.post(
  '/api/ocr',
  requireApiKey,
  upload.single('file'),
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Missing file (multipart field "file")' });
      return;
    }
    const preserveLayout = String(req.body.preserveLayout ?? 'false') === 'true';
    log('[ocr] start', file.size, 'bytes', preserveLayout ? '(layout)' : '(text)');
    try {
      const text = await ocrImage(file.buffer, preserveLayout);
      log('[ocr] done', text.length, 'chars');
      res.json({ text });
    } catch (e) {
      const err = e as Error;
      log('[ocr] error', err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

app.post(
  '/api/analyze',
  requireApiKey,
  upload.single('file'),
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Missing file (multipart field "file")' });
      return;
    }
    const mime = file.mimetype || 'image/png';
    log('[analyze] start', file.size, 'bytes', mime);
    try {
      const analysis = await analyzeImage(file.buffer, mime);
      log('[analyze] done', analysis.length, 'chars');
      res.json({ analysis });
    } catch (e) {
      const err = e as Error;
      log('[analyze] error', err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// Catch-all 404 keeps logs tidy when probes/scanners hit unrelated paths.
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

const server = app.listen(config.port, () => {
  log(`Voiceido cloud API listening on :${config.port}`);
});

// Cloud Run sends SIGTERM 10s before shutting down — drain quickly so
// in-flight requests finish.
process.on('SIGTERM', () => {
  log('SIGTERM received — draining…');
  server.close(() => {
    log('Server closed.');
    process.exit(0);
  });
});

server.timeout = 5 * 60_000;
