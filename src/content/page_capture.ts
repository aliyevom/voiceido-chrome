/**
 * Content script: orchestrates the per-tile scroll loop inside the target
 * page. Injected on demand by the service worker via `chrome.scripting
 * .executeScript`.
 *
 * Two capture modes are supported:
 *
 * `fullPage` — measure the document, walk a grid of viewport-sized
 *   positions, and ask the background to grab each viewport via
 *   `captureVisibleTab`. Optionally first expand any inner scrollable
 *   containers so their content is fully laid out.
 *
 * `innerSection` — show an in-page picker overlay with a blue ring that
 *   tracks whichever scrollable element the user is hovering, then on
 *   click scroll *that element* (not the page) tile-by-tile while asking
 *   the background to grab + crop each viewport down to the element's
 *   bounding box. The resulting stitched image contains only the element's
 *   content. Esc cancels the picker without taking a screenshot.
 */

import {
  MESSAGE_TARGETS,
  isMessageFor,
  type CaptureOptions,
  type CaptureTileCropRequest,
  type CaptureTileRequest,
  type CaptureTileResponse,
  type ScrollPageRequest,
} from '../utils/messages';

// Rough delay (ms) to let layout / lazy-loaded images settle before capture.
const TILE_SETTLE_MS = 180;
// Padding (CSS px) to reserve at the top so sticky headers don't repeat.
const STICKY_HEADER_PAD = 200;
// Safety net: if the background never replies we still tidy up the page.
const TILE_RESPONSE_TIMEOUT_MS = 4000;
// Minimum amount of hidden inner scroll content (CSS px) before we bother
// expanding (or recognising as a scrollable target).
const MIN_HIDDEN_SCROLL_PX = 50;
// Settle delay after expanding scrollables / scrolling element so layout
// (including images, virtualised lists) can reflow.
const EXPANSION_SETTLE_MS = 350;
// Highlight ring colour (Voiceido brand purple).
const PICKER_RING_COLOR = '#5b65f4';
// Confirmation flash colour (success green).
const PICKER_CONFIRM_COLOR = '#22c55e';
// Brief delay so the user perceives the green confirmation flash.
const PICKER_CONFIRM_FLASH_MS = 220;

interface PageDimensions {
  fullWidth: number;
  fullHeight: number;
  windowWidth: number;
  windowHeight: number;
}

interface RestoreSnapshot {
  bodyOverflowY: string;
  htmlOverflow: string;
  scrollX: number;
  scrollY: number;
}

interface ExpansionRecord {
  element: HTMLElement;
  originalCssText: string;
  scrollTop: number;
  scrollLeft: number;
}

if (!window.__voiceidoContentLoaded) {
  window.__voiceidoContentLoaded = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isMessageFor<ScrollPageRequest>(message, MESSAGE_TARGETS.content, 'SCROLL_PAGE')) {
      void runCapture(message.options)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => {
          console.error('[voiceido] capture failed', error);
          sendResponse({ ok: false, detail: stringifyError(error), code: extractCode(error) });
        });
      return true;
    }
    return false;
  });
}

async function runCapture(options: CaptureOptions): Promise<void> {
  if (options.mode === 'innerSection') {
    await runElementCapture();
    return;
  }
  await runFullPageCapture(options);
}

// ===========================================================================
// FULL PAGE MODE
// ===========================================================================

async function runFullPageCapture(options: CaptureOptions): Promise<void> {
  const expansions: ExpansionRecord[] = options.expandScrollables
    ? expandInnerScrollables()
    : [];
  if (expansions.length > 0) await sleep(EXPANSION_SETTLE_MS);

  const snapshot = freezeScroll();

  try {
    const dimensions = measurePage();
    const arrangements = buildTileGrid(dimensions);
    const totalTiles = arrangements.length;

    for (let i = 0; i < totalTiles; i++) {
      const tile = arrangements[i];
      if (!tile) continue;
      const [x, y] = tile;
      window.scrollTo(x, y);
      await sleep(TILE_SETTLE_MS);

      const message: CaptureTileRequest = {
        type: 'CAPTURE_TILE',
        target: MESSAGE_TARGETS.background,
        x: window.scrollX,
        y: window.scrollY,
        totalWidth: dimensions.fullWidth,
        totalHeight: dimensions.fullHeight,
        windowWidth: dimensions.windowWidth,
        windowHeight: dimensions.windowHeight,
        devicePixelRatio: window.devicePixelRatio,
        complete: (i + 1) / totalTiles,
      };

      const response = await sendTile(message);
      if (!response.ok) {
        throw new Error(response.detail ?? 'capture tile rejected by background');
      }
    }
  } finally {
    restoreScroll(snapshot);
    restoreInnerScrollables(expansions);
  }
}

function measurePage(): PageDimensions {
  const body = document.body;
  const docEl = document.documentElement;
  const heightCandidates = [
    docEl.clientHeight,
    body?.scrollHeight ?? 0,
    docEl.scrollHeight,
    body?.offsetHeight ?? 0,
    docEl.offsetHeight,
  ];
  const widthCandidates = [
    docEl.clientWidth,
    body?.scrollWidth ?? 0,
    docEl.scrollWidth,
    body?.offsetWidth ?? 0,
    docEl.offsetWidth,
  ];
  return {
    fullHeight: Math.max(...heightCandidates.filter((n) => Number.isFinite(n) && n > 0)),
    fullWidth: Math.max(...widthCandidates.filter((n) => Number.isFinite(n) && n > 0)),
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
  };
}

function freezeScroll(): RestoreSnapshot {
  const body = document.body;
  const snapshot: RestoreSnapshot = {
    bodyOverflowY: body?.style.overflowY ?? '',
    htmlOverflow: document.documentElement.style.overflow,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
  if (body) body.style.overflowY = 'visible';
  document.documentElement.style.overflow = 'hidden';
  return snapshot;
}

function restoreScroll(snapshot: RestoreSnapshot): void {
  document.documentElement.style.overflow = snapshot.htmlOverflow;
  if (document.body) document.body.style.overflowY = snapshot.bodyOverflowY;
  window.scrollTo(snapshot.scrollX, snapshot.scrollY);
}

function buildTileGrid(dimensions: PageDimensions): Array<[number, number]> {
  const { fullWidth, fullHeight, windowWidth, windowHeight } = dimensions;
  const yDelta = windowHeight - (windowHeight > STICKY_HEADER_PAD ? STICKY_HEADER_PAD : 0);
  const xDelta = windowWidth;
  const arrangements: Array<[number, number]> = [];

  const effectiveWidth = fullWidth <= xDelta + 1 ? xDelta : fullWidth;

  let yPos = fullHeight - windowHeight;
  while (yPos > -yDelta) {
    let xPos = 0;
    while (xPos < effectiveWidth) {
      arrangements.push([xPos, yPos]);
      xPos += xDelta;
    }
    yPos -= yDelta;
  }
  return arrangements;
}

// ===========================================================================
// INNER SCROLLABLE EXPANSION (used by full page mode)
// ===========================================================================

function findInnerScrollables(): HTMLElement[] {
  const out: HTMLElement[] = [];
  const all = document.querySelectorAll<HTMLElement>('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!el || el === document.body || el === document.documentElement) continue;
    const style = window.getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'sticky') continue;
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    const scrollableY =
      (overflowY === 'auto' || overflowY === 'scroll') &&
      el.scrollHeight - el.clientHeight > MIN_HIDDEN_SCROLL_PX;
    const scrollableX =
      (overflowX === 'auto' || overflowX === 'scroll') &&
      el.scrollWidth - el.clientWidth > MIN_HIDDEN_SCROLL_PX;
    if (!scrollableY && !scrollableX) continue;

    out.push(el);
  }
  return out;
}

function expandInnerScrollables(): ExpansionRecord[] {
  const targets = findInnerScrollables();
  const records: ExpansionRecord[] = [];
  for (const element of targets) {
    records.push({
      element,
      originalCssText: element.style.cssText,
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
    });
    element.style.setProperty('max-height', 'none', 'important');
    element.style.setProperty('max-width', 'none', 'important');
    element.style.setProperty('height', 'auto', 'important');
    element.style.setProperty('overflow', 'visible', 'important');
  }
  if (records.length > 0) {
    console.log(`[voiceido] expanded ${records.length} inner scrollable container(s)`);
  }
  return records;
}

function restoreInnerScrollables(records: ExpansionRecord[]): void {
  for (const record of records) {
    record.element.style.cssText = record.originalCssText;
    record.element.scrollTop = record.scrollTop;
    record.element.scrollLeft = record.scrollLeft;
  }
}

// ===========================================================================
// INNER SECTION (ELEMENT) MODE
// ===========================================================================

class CaptureCodedError extends Error {
  constructor(
    public code: 'PICKER_CANCELLED' | 'NO_SCROLL_ANCESTOR' | 'ELEMENT_TOO_TALL',
    message: string,
  ) {
    super(message);
  }
}

async function runElementCapture(): Promise<void> {
  const target = await runPickerOverlay();
  if (!target) {
    throw new CaptureCodedError('PICKER_CANCELLED', 'Capture cancelled.');
  }
  await captureElement(target);
}

/**
 * Walk up from the hovered element until we find an ancestor that actually
 * scrolls (non-trivially). Used to decide which element to ring around.
 */
function findScrollableSelfOrAncestor(start: Element): HTMLElement | null {
  let node: Element | null = start;
  while (node && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const scrollsY =
        (overflowY === 'auto' || overflowY === 'scroll') &&
        node.scrollHeight - node.clientHeight > MIN_HIDDEN_SCROLL_PX;
      const scrollsX =
        (overflowX === 'auto' || overflowX === 'scroll') &&
        node.scrollWidth - node.clientWidth > MIN_HIDDEN_SCROLL_PX;
      if (scrollsY || scrollsX) return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Build and show the picker overlay. The overlay itself has
 * `pointer-events: none` so the cursor's hit-test naturally lands on the
 * underlying page element. We attach capture-phase listeners on the
 * document so we can intercept clicks BEFORE the page sees them and
 * suppress link navigation, button activation, etc.
 *
 * Resolves with the chosen element on click, or `null` if the user pressed
 * Esc to cancel.
 */
function runPickerOverlay(): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.id = '__voiceido-picker-root';
    root.setAttribute('aria-hidden', 'true');

    const styleEl = document.createElement('style');
    styleEl.textContent = `
      #__voiceido-picker-root {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        pointer-events: none;
        font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      }
      #__voiceido-picker-root .vio-dim {
        position: absolute;
        inset: 0;
        background: rgba(8, 11, 28, 0.18);
      }
      #__voiceido-picker-root .vio-banner {
        position: absolute;
        top: 18px;
        left: 50%;
        transform: translateX(-50%);
        padding: 11px 22px;
        background: linear-gradient(135deg, ${PICKER_RING_COLOR}, #8a7bff);
        color: #fff;
        border-radius: 999px;
        box-shadow: 0 18px 36px rgba(91, 101, 244, 0.42);
        letter-spacing: 0.01em;
        white-space: nowrap;
        max-width: 92vw;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #__voiceido-picker-root .vio-banner kbd {
        background: rgba(255, 255, 255, 0.22);
        border-radius: 5px;
        padding: 1px 6px;
        margin: 0 4px;
        font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
        font-size: 11px;
        font-weight: 700;
        color: #fff;
      }
      #__voiceido-picker-root .vio-ring {
        position: absolute;
        box-sizing: border-box;
        border: 3px solid ${PICKER_RING_COLOR};
        border-radius: 10px;
        box-shadow:
          0 0 0 4px rgba(91, 101, 244, 0.28),
          0 26px 56px rgba(15, 16, 32, 0.4);
        transition:
          top 90ms ease,
          left 90ms ease,
          width 90ms ease,
          height 90ms ease,
          opacity 100ms ease,
          border-color 120ms ease,
          box-shadow 120ms ease;
        opacity: 0;
        pointer-events: none;
      }
      #__voiceido-picker-root .vio-ring.visible { opacity: 1; }
      #__voiceido-picker-root .vio-ring-label {
        position: absolute;
        top: -28px;
        left: 0;
        background: ${PICKER_RING_COLOR};
        color: #fff;
        font-size: 11px;
        padding: 4px 10px;
        border-radius: 6px;
        white-space: nowrap;
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: background 120ms ease;
      }
      @media (prefers-reduced-motion: reduce) {
        #__voiceido-picker-root .vio-ring { transition: opacity 100ms ease; }
      }
    `;

    const dim = document.createElement('div');
    dim.className = 'vio-dim';

    const banner = document.createElement('div');
    banner.className = 'vio-banner';
    banner.innerHTML =
      'Click the scroll box you want to capture · <kbd>Esc</kbd> to cancel';

    const ring = document.createElement('div');
    ring.className = 'vio-ring';
    const ringLabel = document.createElement('div');
    ringLabel.className = 'vio-ring-label';
    ring.appendChild(ringLabel);

    root.append(styleEl, dim, banner, ring);
    (document.body ?? document.documentElement).appendChild(root);

    const previousCursor = document.body?.style.cursor ?? '';
    if (document.body) document.body.style.cursor = 'crosshair';

    let currentTarget: HTMLElement | null = null;

    const updateRing = (target: HTMLElement | null): void => {
      if (!target) {
        ring.classList.remove('visible');
        return;
      }
      const rect = target.getBoundingClientRect();
      ring.classList.add('visible');
      ring.style.top = `${rect.top - 3}px`;
      ring.style.left = `${rect.left - 3}px`;
      ring.style.width = `${rect.width + 6}px`;
      ring.style.height = `${rect.height + 6}px`;
      ringLabel.textContent = describeElement(target);
    };

    const onMove = (e: MouseEvent): void => {
      const t = e.target;
      if (!(t instanceof Element) || root.contains(t)) return;
      const scrollable = findScrollableSelfOrAncestor(t);
      currentTarget = scrollable;
      updateRing(scrollable);
    };

    const onMouseDown = (e: MouseEvent): void => {
      const t = e.target;
      if (!(t instanceof Element) || root.contains(t)) return;
      // Suppress text-selection / focus shifts on the original target.
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
    };

    const onClick = (e: MouseEvent): void => {
      const t = e.target;
      if (!(t instanceof Element) || root.contains(t)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (!currentTarget) return;

      // Confirmation flash: ring turns green for ~220ms before the picker
      // tears down, so the user sees a clear "got it" beat.
      ring.style.borderColor = PICKER_CONFIRM_COLOR;
      ring.style.boxShadow = `0 0 0 4px rgba(34, 197, 94, 0.32), 0 26px 56px rgba(15, 16, 32, 0.4)`;
      ringLabel.style.background = PICKER_CONFIRM_COLOR;
      const target = currentTarget;
      window.setTimeout(() => finalize(target), PICKER_CONFIRM_FLASH_MS);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        finalize(null);
      }
    };

    const refreshRing = (): void => {
      if (currentTarget && document.contains(currentTarget)) updateRing(currentTarget);
      else updateRing(null);
    };

    const finalize = (target: HTMLElement | null): void => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', refreshRing);
      window.removeEventListener('scroll', refreshRing, true);
      root.remove();
      if (document.body) document.body.style.cursor = previousCursor;
      resolve(target);
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', refreshRing);
    window.addEventListener('scroll', refreshRing, true);
  });
}

/** Short human-readable label shown above the picker ring. */
function describeElement(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls =
    typeof el.className === 'string' && el.className.trim().length > 0
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
  return `${tag}${id}${cls} · ${el.scrollWidth}×${el.scrollHeight}px`;
}

async function captureElement(element: HTMLElement): Promise<void> {
  // Bring the element into the viewport. Snap to the top so we have the
  // maximum vertical room available for tiling. Some browsers honour
  // `behavior: 'instant'` while others need the synchronous fallback.
  const originalPageScroll = { x: window.scrollX, y: window.scrollY };
  const originalElScroll = { top: element.scrollTop, left: element.scrollLeft };

  try {
    element.scrollIntoView({ block: 'start', inline: 'start' });
    await sleep(TILE_SETTLE_MS);

    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    // If the element box is taller than the viewport we can't see it all
    // in one captureVisibleTab call. We could two-axis tile through the
    // page as well, but the simpler 99%-case fix is to refuse and tell
    // the user to zoom out / make the window larger.
    if (element.clientHeight > viewportH - 20) {
      throw new CaptureCodedError(
        'ELEMENT_TOO_TALL',
        `The selected element (${element.clientHeight}px) is taller than the visible window (${viewportH}px). Zoom out, enlarge the window, or pick a smaller container.`,
      );
    }
    if (element.clientWidth > viewportW - 20) {
      throw new CaptureCodedError(
        'ELEMENT_TOO_TALL',
        `The selected element (${element.clientWidth}px wide) is wider than the visible window. Zoom out and try again.`,
      );
    }

    const totalWidth = element.scrollWidth;
    const totalHeight = element.scrollHeight;
    const tileH = element.clientHeight;
    const numTiles = Math.max(1, Math.ceil(totalHeight / tileH));

    console.log(
      `[voiceido] inner-section capture: ${totalWidth}×${totalHeight} via ${numTiles} tile(s) of ${element.clientWidth}×${tileH}`,
    );

    for (let i = 0; i < numTiles; i++) {
      const desiredTop = i * tileH;
      const actualTop = Math.min(desiredTop, totalHeight - tileH);
      element.scrollTop = actualTop;
      await sleep(TILE_SETTLE_MS);

      // Re-read bbox each iteration in case the page reflowed.
      const live = element.getBoundingClientRect();
      const bboxX = clamp(live.left, 0, viewportW);
      const bboxY = clamp(live.top, 0, viewportH);
      const bboxWidth = clamp(live.width, 1, viewportW - bboxX);
      const bboxHeight = clamp(live.height, 1, viewportH - bboxY);

      const message: CaptureTileCropRequest = {
        type: 'CAPTURE_TILE_CROP',
        target: MESSAGE_TARGETS.background,
        bboxX,
        bboxY,
        bboxWidth,
        bboxHeight,
        destX: 0,
        destY: actualTop,
        totalWidth,
        totalHeight,
        windowWidth: viewportW,
        windowHeight: viewportH,
        devicePixelRatio: window.devicePixelRatio,
        complete: (i + 1) / numTiles,
      };

      const response = await sendCropTile(message);
      if (!response.ok) {
        throw new Error(response.detail ?? 'crop tile rejected by background');
      }
    }
  } finally {
    element.scrollTop = originalElScroll.top;
    element.scrollLeft = originalElScroll.left;
    window.scrollTo(originalPageScroll.x, originalPageScroll.y);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ===========================================================================
// MESSAGING HELPERS
// ===========================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function sendTile(message: CaptureTileRequest): Promise<CaptureTileResponse> {
  return runtimeRequest(message);
}

function sendCropTile(message: CaptureTileCropRequest): Promise<CaptureTileResponse> {
  return runtimeRequest(message);
}

function runtimeRequest(message: object): Promise<CaptureTileResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('background did not respond in time'));
    }, TILE_RESPONSE_TIMEOUT_MS);

    chrome.runtime.sendMessage(message, (response: CaptureTileResponse | undefined) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('empty response from background'));
        return;
      }
      resolve(response);
    });
  });
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

function extractCode(error: unknown): string | undefined {
  if (error instanceof CaptureCodedError) return error.code;
  return undefined;
}
