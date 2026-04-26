/**
 * Runtime configuration for the Voiceido cloud microservice.
 *
 * Cloud Run injects:
 *   - PORT                  — port to listen on (always 8080)
 *   - API_KEY               — shared secret expected in `X-API-Key`
 *   - OPENROUTER_API_KEY    — API key for OpenRouter (used by /api/analyze)
 *   - OPENROUTER_MODEL      — multimodal model slug (default gpt-4o-mini)
 */

/**
 * Strip whitespace and ASCII control characters from a secret value.
 *
 * Secrets pasted into Secret Manager often pick up trailing newlines or stray
 * escape bytes. Those characters are illegal inside HTTP header values and
 * cause `Headers.append` to throw, so we sanitize once at startup.
 */
function cleanSecret(raw: string | undefined): string {
  if (!raw) return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001F\u007F\s]+/g, '').trim();
}

export const config = {
  port: Number(process.env.PORT) || 8080,
  apiKey: cleanSecret(process.env.API_KEY),
  openRouterApiKey: cleanSecret(process.env.OPENROUTER_API_KEY),
  openRouterUrl: 'https://openrouter.ai/api/v1/chat/completions',
  analysisModel: (process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini').trim(),
  /** Limit per-request payload — captures are PNGs and rarely > 10 MB. */
  maxFileBytes: Number(process.env.MAX_FILE_BYTES) || 30 * 1024 * 1024,
} as const;
