/**
 * Offscreen document. Invisible page used by the service worker to perform
 * DOM-only canvas work — decoding `<img>` tiles, stitching them onto one or
 * more HTMLCanvasElement(s), and producing PNG blobs.
 *
 * The document keeps state across messages for the lifetime of a single
 * capture session. The service worker explicitly resets state before each
 * new session.
 */

import { planCanvases, type CanvasTilePlan } from '../utils/canvas_constraints';
import { putCaptureImage } from '../utils/capture_store';
import {
  MESSAGE_TARGETS,
  isMessageFor,
  type OffscreenDrawCropRequest,
  type OffscreenDrawRequest,
  type OffscreenDrawResponse,
  type OffscreenFinalizeRequest,
  type OffscreenFinalizeResponse,
  type OffscreenInitRequest,
  type OffscreenInitResponse,
  type OffscreenResetRequest,
} from '../utils/messages';

interface CanvasSlot extends CanvasTilePlan {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

let canvases: CanvasSlot[] = [];
/** World (CSS or device-px) size the current canvases were planned for. */
let worldWidth = 0;
let worldHeight = 0;
/** After the first tile is painted, freeze the layout so later tiles cannot wipe it. */
let layoutLocked = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isMessageFor<OffscreenInitRequest>(message, MESSAGE_TARGETS.offscreen, 'OFFSCREEN_INIT')) {
    try {
      const response = handleInit(message);
      sendResponse(response satisfies OffscreenInitResponse);
    } catch (error) {
      console.error('[voiceido-offscreen] init failed', error);
      sendResponse({ ok: false, imageCount: 0 } satisfies OffscreenInitResponse);
    }
    return false;
  }

  if (isMessageFor<OffscreenDrawRequest>(message, MESSAGE_TARGETS.offscreen, 'OFFSCREEN_DRAW')) {
    void handleDraw(message)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => {
        console.error('[voiceido-offscreen] draw failed', error);
        sendResponse({ ok: false } satisfies OffscreenDrawResponse);
      });
    return true;
  }

  if (
    isMessageFor<OffscreenDrawCropRequest>(message, MESSAGE_TARGETS.offscreen, 'OFFSCREEN_DRAW_CROP')
  ) {
    void handleDrawCrop(message)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => {
        console.error('[voiceido-offscreen] crop draw failed', error);
        sendResponse({ ok: false } satisfies OffscreenDrawResponse);
      });
    return true;
  }

  if (
    isMessageFor<OffscreenFinalizeRequest>(
      message,
      MESSAGE_TARGETS.offscreen,
      'OFFSCREEN_FINALIZE',
    )
  ) {
    void handleFinalize(message)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => {
        console.error('[voiceido-offscreen] finalize failed', error);
        sendResponse({ ok: false, images: [] } satisfies OffscreenFinalizeResponse);
      });
    return true;
  }

  if (isMessageFor<OffscreenResetRequest>(message, MESSAGE_TARGETS.offscreen, 'OFFSCREEN_RESET')) {
    handleReset();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function handleInit(message: OffscreenInitRequest): OffscreenInitResponse {
  handleReset();
  allocateCanvases(message.totalWidth, message.totalHeight);
  return { ok: true, imageCount: canvases.length };
}

async function handleDraw(message: OffscreenDrawRequest): Promise<OffscreenDrawResponse> {
  if (canvases.length === 0) {
    return { ok: false };
  }

  const image = await loadImage(message.dataUrl);

  // The captured visible-tab image may be larger than the CSS-px viewport
  // (device pixel ratio, browser zoom, device-mode emulation). Scale the
  // tile geometry to match the actual image so destination drawing is
  // pixel-accurate.
  let { x, y } = message;
  let { totalWidth, totalHeight } = message;
  if (message.windowWidth !== image.width) {
    const scale = image.width / message.windowWidth;
    x *= scale;
    y *= scale;
    totalWidth *= scale;
    totalHeight *= scale;
  }

  layoutIfNeeded(totalWidth, totalHeight);

  for (const slot of canvases) {
    if (
      x < slot.right &&
      x + image.width > slot.left &&
      y < slot.bottom &&
      y + image.height > slot.top
    ) {
      slot.ctx.drawImage(image, x - slot.left, y - slot.top);
    }
  }

  layoutLocked = true;
  return { ok: true };
}

/**
 * Element-mode draw: crop the captured viewport image down to the element's
 * bounding box (after scaling for DPR / zoom), then paste it onto the
 * stitched canvas at the requested destination.
 */
async function handleDrawCrop(message: OffscreenDrawCropRequest): Promise<OffscreenDrawResponse> {
  if (canvases.length === 0) {
    return { ok: false };
  }

  const image = await loadImage(message.dataUrl);
  const scale = image.width / message.windowWidth;

  // Source rect in *device pixels* (image coordinate space).
  let srcX = message.bboxX * scale;
  let srcY = message.bboxY * scale;
  let srcW = message.bboxWidth * scale;
  let srcH = message.bboxHeight * scale;

  // Defensive clamping in case the live bbox extends slightly past the
  // viewport (sub-pixel rounding, scrollbar gutters, etc.).
  if (srcX < 0) {
    srcW += srcX;
    srcX = 0;
  }
  if (srcY < 0) {
    srcH += srcY;
    srcY = 0;
  }
  if (srcX + srcW > image.width) srcW = image.width - srcX;
  if (srcY + srcH > image.height) srcH = image.height - srcY;
  if (srcW <= 0 || srcH <= 0) return { ok: true };

  const destX = message.destX * scale;
  const destY = message.destY * scale;
  const destW = srcW;
  const destH = srcH;

  layoutIfNeeded(message.totalWidth * scale, message.totalHeight * scale);

  for (const slot of canvases) {
    const tileLeft = destX;
    const tileTop = destY;
    const tileRight = destX + destW;
    const tileBottom = destY + destH;
    if (
      tileLeft < slot.right &&
      tileRight > slot.left &&
      tileTop < slot.bottom &&
      tileBottom > slot.top
    ) {
      slot.ctx.drawImage(
        image,
        srcX,
        srcY,
        srcW,
        srcH,
        destX - slot.left,
        destY - slot.top,
        destW,
        destH,
      );
    }
  }

  layoutLocked = true;
  return { ok: true };
}

async function handleFinalize(message: OffscreenFinalizeRequest): Promise<OffscreenFinalizeResponse> {
  if (canvases.length === 0) {
    return { ok: false, images: [] };
  }
  const images: Array<{ width: number; height: number }> = [];
  for (let index = 0; index < canvases.length; index++) {
    const slot = canvases[index];
    if (!slot) continue;
    const blob = await canvasToBlob(slot.canvas);
    console.log(
      `[voiceido-offscreen] storing image ${index + 1}/${canvases.length} ` +
        `${slot.canvas.width}×${slot.canvas.height} (${blob.size} bytes)`,
    );
    await putCaptureImage(message.id, index, {
      blob,
      width: slot.canvas.width,
      height: slot.canvas.height,
    });
    images.push({ width: slot.canvas.width, height: slot.canvas.height });
    slot.canvas.width = 0;
    slot.canvas.height = 0;
  }
  canvases = [];
  return { ok: true, images };
}

function handleReset(): void {
  clearCanvases();
  worldWidth = 0;
  worldHeight = 0;
  layoutLocked = false;
}

/**
 * Re-plan when DPR/zoom makes the real stitch larger than the CSS-px init.
 * Only runs before the first tile is painted so later tiles cannot wipe work.
 */
function layoutIfNeeded(nextWorldWidth: number, nextWorldHeight: number): void {
  if (layoutLocked) return;
  if (
    canvases.length > 0 &&
    Math.abs(nextWorldWidth - worldWidth) < 1 &&
    Math.abs(nextWorldHeight - worldHeight) < 1
  ) {
    return;
  }
  allocateCanvases(nextWorldWidth, nextWorldHeight);
}

function allocateCanvases(width: number, height: number): void {
  clearCanvases();
  worldWidth = width;
  worldHeight = height;
  for (const plan of planCanvases(width, height)) {
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      throw new Error('failed to acquire 2d context');
    }
    canvases.push({ ...plan, canvas, ctx });
  }
}

function clearCanvases(): void {
  for (const slot of canvases) {
    slot.canvas.width = 0;
    slot.canvas.height = 0;
  }
  canvases = [];
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image decode failed'));
    image.src = dataUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}
