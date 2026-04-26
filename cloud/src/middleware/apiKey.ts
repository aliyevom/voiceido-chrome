import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

/**
 * Constant-time API-key check. Returns 503 if the server hasn't been wired
 * with `API_KEY` (rather than a confusing 401), so misconfigurations are
 * easy to spot in Cloud Run logs.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) {
    res.status(503).json({ error: 'Server not configured: API_KEY missing' });
    return;
  }
  const provided = req.header('x-api-key') ?? '';
  if (!safeEqual(provided, config.apiKey)) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }
  next();
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
