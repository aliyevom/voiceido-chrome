/**
 * Background service worker (MV3).
 *
 * Responsibilities:
 *   - Receive START_CAPTURE from the popup (or react to the toolbar action).
 *   - Inject the content script into the active tab via chrome.scripting.
 *   - Capture each visible tile via chrome.tabs.captureVisibleTab and forward
 *     the data URL plus geometry to the offscreen document for stitching.
 *   - When the content script reports completion, ask the offscreen document
 *     for finalised PNGs, save them via chrome.downloads, and open each one
 *     in a new tab.
 *
 * Service workers cannot use the DOM directly, which is why all canvas work
 * happens in src/offscreen — the offscreen document gives us reliable
 * Image, HTMLCanvasElement and URL.createObjectURL semantics that downloads
 * accept without surprises.
 */

import {
  DEFAULT_CAPTURE_OPTIONS,
  MESSAGE_TARGETS,
  isMessageFor,
  type CaptureErrorEvent,
  type CaptureFailureCode,
  type CaptureOptions,
  type CaptureResultBundle,
  type CaptureSessionGetRequest,
  type CaptureSessionGetResponse,
  type CaptureSessionReleaseRequest,
  type CaptureTileCropRequest,
  type CaptureTileRequest,
  type CaptureTileResponse,
  type OffscreenDrawCropRequest,
  type OffscreenDrawRequest,
  type OffscreenDrawResponse,
  type OffscreenFinalizeRequest,
  type OffscreenFinalizeResponse,
  type OffscreenInitRequest,
  type OffscreenInitResponse,
  type OffscreenResetRequest,
  type ScrollPageRequest,
  type StartCaptureRequest,
} from '../utils/messages';
import { buildScreenshotFilename, isCapturableUrl } from '../utils/url';

const OFFSCREEN_DOCUMENT_URL = 'offscreen/offscreen.html';
const CAPTURE_PAGE_URL = 'capture/capture.html';
/** Drop a stored bundle this long after the preview page handshakes — gives
 *  the preview tab enough time to fetch the data even if the user closes it
 *  immediately and reopens via Ctrl+Shift+T. */
const CAPTURE_BUNDLE_TTL_MS = 5 * 60_000;
// chrome.tabs.captureVisibleTab is throttled to ~2 calls per second per
// MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND. Add a small fixed delay between
// tiles so we never trip the quota and lose a frame mid-capture.
const TILE_THROTTLE_MS = 600;

interface CaptureSession {
  tabId: number;
  windowId: number;
  tabUrl: string;
  tilePlanCount: number;
}

interface StoredBundle {
  bundle: CaptureResultBundle;
  expiresAt: number;
}

let activeSession: CaptureSession | null = null;
let lastCaptureAt = 0;
/** id → bundle. The preview page fetches by id then releases; entries also
 *  self-evict after CAPTURE_BUNDLE_TTL_MS so a memory leak can't accumulate
 *  if the preview tab is closed before the handshake. */
const captureBundles = new Map<string, StoredBundle>();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isMessageFor<StartCaptureRequest>(message, MESSAGE_TARGETS.background, 'START_CAPTURE')) {
    const options: CaptureOptions = { ...DEFAULT_CAPTURE_OPTIONS, ...message.options };
    void handleStartCapture(options)
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => {
        console.error('[voiceido] START_CAPTURE failed', error);
        sendResponse({ ok: false, detail: stringifyError(error) });
      });
    return true;
  }

  if (isMessageFor<CaptureTileRequest>(message, MESSAGE_TARGETS.background, 'CAPTURE_TILE')) {
    void handleCaptureTile(message, sender)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => {
        console.error('[voiceido] CAPTURE_TILE failed', error);
        sendResponse({ ok: false, detail: stringifyError(error) } satisfies CaptureTileResponse);
      });
    return true;
  }

  if (
    isMessageFor<CaptureTileCropRequest>(message, MESSAGE_TARGETS.background, 'CAPTURE_TILE_CROP')
  ) {
    void handleCaptureTileCrop(message, sender)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => {
        console.error('[voiceido] CAPTURE_TILE_CROP failed', error);
        sendResponse({ ok: false, detail: stringifyError(error) } satisfies CaptureTileResponse);
      });
    return true;
  }

  if (
    isMessageFor<CaptureSessionGetRequest>(
      message,
      MESSAGE_TARGETS.background,
      'CAPTURE_SESSION_GET',
    )
  ) {
    const entry = captureBundles.get(message.id);
    const response: CaptureSessionGetResponse = entry
      ? { ok: true, bundle: entry.bundle }
      : { ok: false, detail: 'session expired or unknown' };
    sendResponse(response);
    return false;
  }

  if (
    isMessageFor<CaptureSessionReleaseRequest>(
      message,
      MESSAGE_TARGETS.background,
      'CAPTURE_SESSION_RELEASE',
    )
  ) {
    captureBundles.delete(message.id);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

/** Toolbar shortcut (Alt+Shift+P) reuses the popup-driven flow. */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== '_execute_action') return;
  // The popup will open automatically because it's the action's default
  // popup; this listener exists in case future commands skip the popup.
});

/**
 * Top-level capture orchestration. Resolves once we've kicked off the
 * content-script driven scroll loop; the rest of the pipeline runs through
 * onMessage callbacks.
 */
async function handleStartCapture(options: CaptureOptions): Promise<void> {
  if (activeSession) {
    throw new Error('another capture is already in progress');
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || tab.windowId === undefined) {
    await emitError('NO_ACTIVE_TAB');
    throw new Error('no active tab');
  }

  if (!isCapturableUrl(tab.url)) {
    await emitError('INVALID_URL', tab.url);
    throw new Error(`URL not capturable: ${tab.url}`);
  }

  activeSession = {
    tabId: tab.id,
    windowId: tab.windowId,
    tabUrl: tab.url,
    tilePlanCount: 0,
  };

  try {
    await ensureOffscreenDocument();
    await resetOffscreenState();
    await injectContentScript(tab.id);
    await runScrollLoop(tab.id, options);
    await finaliseAndDeliver();
  } catch (error) {
    // `runScrollLoop` already emits coded errors itself, in which case we
    // tag the thrown error and skip the generic UNKNOWN emit below.
    if (!(error instanceof Error && (error as { __codedEmitted?: boolean }).__codedEmitted)) {
      await emitError('UNKNOWN', stringifyError(error));
    }
    throw error;
  } finally {
    activeSession = null;
  }
}

async function injectContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content/page_capture.js'],
    });
  } catch (error) {
    await emitError('INJECT_FAILED', stringifyError(error));
    throw error;
  }
}

async function runScrollLoop(tabId: number, options: CaptureOptions): Promise<void> {
  const message: ScrollPageRequest = {
    type: 'SCROLL_PAGE',
    target: MESSAGE_TARGETS.content,
    options,
  };
  const response = (await chrome.tabs.sendMessage(tabId, message)) as
    | { ok: boolean; detail?: string; code?: string }
    | undefined;
  if (!response?.ok) {
    const code = (response?.code as CaptureFailureCode | undefined) ?? 'UNKNOWN';
    const detail = response?.detail ?? 'content script reported failure';
    // Surface the coded error directly so the popup can render the right
    // friendly message (e.g. "picker cancelled", "element too tall").
    if (code !== 'UNKNOWN') {
      await emitError(code, detail);
      const err = new Error(detail) as Error & { __codedEmitted?: boolean };
      err.__codedEmitted = true;
      throw err;
    }
    throw new Error(detail);
  }
}

async function handleCaptureTile(
  message: CaptureTileRequest,
  sender: chrome.runtime.MessageSender,
): Promise<CaptureTileResponse> {
  if (!activeSession) {
    return { ok: false, detail: 'no active capture session' };
  }
  if (sender.tab?.id !== activeSession.tabId) {
    return { ok: false, detail: 'tile from unexpected tab' };
  }

  await throttleCapture();

  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(activeSession.windowId, { format: 'png' });
  } catch (error) {
    await emitError('CAPTURE_FAILED', stringifyError(error));
    return { ok: false, detail: stringifyError(error) };
  }

  if (activeSession.tilePlanCount === 0) {
    const initRequest: OffscreenInitRequest = {
      type: 'OFFSCREEN_INIT',
      target: MESSAGE_TARGETS.offscreen,
      totalWidth: message.totalWidth,
      totalHeight: message.totalHeight,
    };
    const initResponse = (await chrome.runtime.sendMessage(initRequest)) as
      | OffscreenInitResponse
      | undefined;
    if (!initResponse?.ok) {
      await emitError('OFFSCREEN_FAILED', 'init rejected');
      return { ok: false, detail: 'offscreen init failed' };
    }
    activeSession.tilePlanCount = initResponse.imageCount;
    if (initResponse.imageCount > 1) {
      await sendToPopup({
        type: 'CAPTURE_SPLIT',
        target: MESSAGE_TARGETS.popup,
        imageCount: initResponse.imageCount,
      });
    }
  }

  const drawRequest: OffscreenDrawRequest = {
    type: 'OFFSCREEN_DRAW',
    target: MESSAGE_TARGETS.offscreen,
    dataUrl,
    x: message.x,
    y: message.y,
    windowWidth: message.windowWidth,
    totalWidth: message.totalWidth,
    totalHeight: message.totalHeight,
  };
  const drawResponse = (await chrome.runtime.sendMessage(drawRequest)) as
    | OffscreenDrawResponse
    | undefined;
  if (!drawResponse?.ok) {
    await emitError('OFFSCREEN_FAILED', 'draw rejected');
    return { ok: false, detail: 'offscreen draw failed' };
  }

  await sendToPopup({
    type: 'CAPTURE_PROGRESS',
    target: MESSAGE_TARGETS.popup,
    complete: message.complete,
    imageCount: activeSession.tilePlanCount,
  });

  return { ok: true, imageCount: activeSession.tilePlanCount };
}

async function handleCaptureTileCrop(
  message: CaptureTileCropRequest,
  sender: chrome.runtime.MessageSender,
): Promise<CaptureTileResponse> {
  if (!activeSession) return { ok: false, detail: 'no active capture session' };
  if (sender.tab?.id !== activeSession.tabId) {
    return { ok: false, detail: 'crop tile from unexpected tab' };
  }

  await throttleCapture();

  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(activeSession.windowId, { format: 'png' });
  } catch (error) {
    await emitError('CAPTURE_FAILED', stringifyError(error));
    return { ok: false, detail: stringifyError(error) };
  }

  if (activeSession.tilePlanCount === 0) {
    const initRequest: OffscreenInitRequest = {
      type: 'OFFSCREEN_INIT',
      target: MESSAGE_TARGETS.offscreen,
      totalWidth: message.totalWidth,
      totalHeight: message.totalHeight,
    };
    const initResponse = (await chrome.runtime.sendMessage(initRequest)) as
      | OffscreenInitResponse
      | undefined;
    if (!initResponse?.ok) {
      await emitError('OFFSCREEN_FAILED', 'init rejected');
      return { ok: false, detail: 'offscreen init failed' };
    }
    activeSession.tilePlanCount = initResponse.imageCount;
    if (initResponse.imageCount > 1) {
      await sendToPopup({
        type: 'CAPTURE_SPLIT',
        target: MESSAGE_TARGETS.popup,
        imageCount: initResponse.imageCount,
      });
    }
  }

  const drawRequest: OffscreenDrawCropRequest = {
    type: 'OFFSCREEN_DRAW_CROP',
    target: MESSAGE_TARGETS.offscreen,
    dataUrl,
    windowWidth: message.windowWidth,
    totalWidth: message.totalWidth,
    totalHeight: message.totalHeight,
    bboxX: message.bboxX,
    bboxY: message.bboxY,
    bboxWidth: message.bboxWidth,
    bboxHeight: message.bboxHeight,
    destX: message.destX,
    destY: message.destY,
  };
  const drawResponse = (await chrome.runtime.sendMessage(drawRequest)) as
    | OffscreenDrawResponse
    | undefined;
  if (!drawResponse?.ok) {
    await emitError('OFFSCREEN_FAILED', 'crop draw rejected');
    return { ok: false, detail: 'offscreen crop draw failed' };
  }

  await sendToPopup({
    type: 'CAPTURE_PROGRESS',
    target: MESSAGE_TARGETS.popup,
    complete: message.complete,
    imageCount: activeSession.tilePlanCount,
  });

  return { ok: true, imageCount: activeSession.tilePlanCount };
}

async function finaliseAndDeliver(): Promise<void> {
  if (!activeSession) return;
  const finalizeRequest: OffscreenFinalizeRequest = {
    type: 'OFFSCREEN_FINALIZE',
    target: MESSAGE_TARGETS.offscreen,
  };
  const result = (await chrome.runtime.sendMessage(finalizeRequest)) as
    | OffscreenFinalizeResponse
    | undefined;
  if (!result?.ok || result.pngs.length === 0) {
    await emitError('OFFSCREEN_FAILED', 'finalize returned no images');
    return;
  }

  const baseFilename = buildScreenshotFilename(activeSession.tabUrl);
  // Strip .png so the preview page can append the right extension per format.
  const baseName = baseFilename.replace(/\.png$/i, '');
  const total = result.pngs.length;

  // Decode each PNG once just to record dimensions — handy for the preview
  // page's PDF export so we don't ship 1000×1000 pages for a 320×240 image.
  const images: CaptureResultBundle['images'] = [];
  for (const pngBase64 of result.pngs) {
    if (!pngBase64) continue;
    const dim = decodePngDimensions(pngBase64);
    images.push({ pngBase64, width: dim.width, height: dim.height });
  }

  const id = crypto.randomUUID();
  const bundle: CaptureResultBundle = {
    id,
    sourceUrl: activeSession.tabUrl,
    baseName,
    capturedAt: new Date().toISOString(),
    images,
  };
  captureBundles.set(id, { bundle, expiresAt: Date.now() + CAPTURE_BUNDLE_TTL_MS });
  scheduleBundleEviction(id);

  // Open the preview tab next to the source tab so the user lands on it.
  const previewUrl = `${chrome.runtime.getURL(CAPTURE_PAGE_URL)}?id=${encodeURIComponent(id)}&url=${encodeURIComponent(activeSession.tabUrl)}`;
  try {
    await chrome.tabs.create({ url: previewUrl, active: true });
  } catch (error) {
    // Fallback: if tab open fails (extremely unusual), just notify the popup
    // so the user can recover.
    console.error('[voiceido] failed to open capture preview', error);
    await emitError('UNKNOWN', 'failed to open preview tab');
  }

  await sendToPopup({
    type: 'CAPTURE_COMPLETE',
    target: MESSAGE_TARGETS.popup,
    imageCount: total,
  });
}

function scheduleBundleEviction(id: string): void {
  setTimeout(() => {
    const entry = captureBundles.get(id);
    if (!entry) return;
    if (Date.now() >= entry.expiresAt) captureBundles.delete(id);
  }, CAPTURE_BUNDLE_TTL_MS + 1_000);
}

/**
 * Cheap PNG dimension reader — IHDR is always at byte offset 16..24 in a
 * valid PNG. Saves us from instantiating an Image() in the service worker
 * (which has no DOM) just to read width / height.
 */
function decodePngDimensions(base64: string): { width: number; height: number } {
  // Decode just the first 24 bytes; chunk header lives in the first IHDR.
  const header = atob(base64.slice(0, 64));
  if (header.length < 24) return { width: 0, height: 0 };
  const view = new DataView(
    Uint8Array.from(header, (c) => c.charCodeAt(0)).buffer,
  );
  // PNG signature is 8 bytes, then 4-byte length, then 'IHDR' (4), then
  // width (4 BE), height (4 BE).
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return { width, height };
}

// --- Offscreen document plumbing -------------------------------------------

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_URL,
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: 'Stitch captured tiles into one or more PNG images.',
  });
}

async function hasOffscreenDocument(): Promise<boolean> {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_URL);
  // `self` is a ServiceWorkerGlobalScope at runtime; the cast is needed
  // because tsc treats overlapping DOM + WebWorker libs as Window.
  const sw = self as unknown as ServiceWorkerGlobalScope;
  const matchedClients = await sw.clients.matchAll();
  return matchedClients.some((client: Client) => client.url === offscreenUrl);
}

async function resetOffscreenState(): Promise<void> {
  const reset: OffscreenResetRequest = {
    type: 'OFFSCREEN_RESET',
    target: MESSAGE_TARGETS.offscreen,
  };
  try {
    await chrome.runtime.sendMessage(reset);
  } catch {
    // Document may not have its listener registered yet on first use.
  }
}

// --- Helpers ---------------------------------------------------------------

async function throttleCapture(): Promise<void> {
  const elapsed = Date.now() - lastCaptureAt;
  const wait = Math.max(0, TILE_THROTTLE_MS - elapsed);
  if (wait > 0) await delay(wait);
  lastCaptureAt = Date.now();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function emitError(code: CaptureErrorEvent['code'], detail?: string): Promise<void> {
  const payload: CaptureErrorEvent = detail
    ? { type: 'CAPTURE_ERROR', target: MESSAGE_TARGETS.popup, code, detail }
    : { type: 'CAPTURE_ERROR', target: MESSAGE_TARGETS.popup, code };
  await sendToPopup(payload);
}

async function sendToPopup(message: object): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // Popup may have closed — that's fine, the offscreen + downloads keep
    // running. We log nothing because closed-popup is the common case.
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'unknown error';
  }
}
