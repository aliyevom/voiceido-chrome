/**
 * URL helpers shared across contexts. These mirror the conservative URL
 * filter that GoFullPage uses — `chrome.tabs.captureVisibleTab` only works
 * for normal http(s)/file/ftp URLs, never for chrome://, chrome.google.com
 * /webstore (Web Store policy) or about: pages.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'file:']);

const DENY_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/chrome\.google\.com\/webstore(\/|$)/i,
  /^https?:\/\/chromewebstore\.google\.com(\/|$)/i,
  /^chrome:\/\//i,
  /^edge:\/\//i,
  /^about:/i,
  /^chrome-extension:\/\//i,
  /^devtools:\/\//i,
  /^view-source:/i,
];

export function isCapturableUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  for (const denied of DENY_PATTERNS) {
    if (denied.test(rawUrl)) return false;
  }
  try {
    const url = new URL(rawUrl);
    return ALLOWED_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Build a friendly default filename for a downloaded screenshot.
 *
 * `screencapture-<host-and-path>-<timestamp>.png`
 */
export function buildScreenshotFilename(rawUrl: string): string {
  let suffix = '';
  try {
    const url = new URL(rawUrl);
    const compact = `${url.hostname}${url.pathname}`
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '');
    if (compact) suffix = `-${compact}`;
  } catch {
    // ignore — we'll just use a plain timestamp
  }
  return `voiceido-capture${suffix}-${Date.now()}.png`;
}

export function withIndexSuffix(filename: string, index: number, total: number): string {
  if (total <= 1) return filename;
  const dot = filename.lastIndexOf('.');
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const ext = dot === -1 ? '' : filename.slice(dot);
  const padWidth = String(total).length;
  return `${stem}-${String(index + 1).padStart(padWidth, '0')}${ext}`;
}
