/**
 * Strongly-typed message contracts shared across the popup, service worker,
 * content script and offscreen document.
 *
 * Keeping these in one module guarantees every sender + receiver agrees on
 * the shape of cross-context messages, which is the most common source of
 * bugs in MV3 extensions.
 */

export const MESSAGE_TARGETS = {
  background: 'background',
  content: 'content',
  offscreen: 'offscreen',
  popup: 'popup',
} as const;

export type MessageTarget = (typeof MESSAGE_TARGETS)[keyof typeof MESSAGE_TARGETS];

// --- Popup ⇄ Background -----------------------------------------------------

/**
 * `fullPage` — current behaviour: scroll the document and capture everything.
 * `innerSection` — find the nearest scrollable ancestor of the most recently
 *   clicked element on the page and capture *only* that container by
 *   scrolling its inner content tile-by-tile.
 */
export type CaptureMode = 'fullPage' | 'innerSection';

export interface CaptureOptions {
  mode: CaptureMode;
  /**
   * Only honoured in `fullPage` mode. When true, the content script
   * temporarily expands any inner scrollable containers so their full
   * content is laid out inline before capture. Restored after capture.
   */
  expandScrollables: boolean;
}

export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  mode: 'fullPage',
  expandScrollables: true,
};

export interface StartCaptureRequest {
  type: 'START_CAPTURE';
  target: typeof MESSAGE_TARGETS.background;
  options: CaptureOptions;
}

export interface CaptureProgressEvent {
  type: 'CAPTURE_PROGRESS';
  target: typeof MESSAGE_TARGETS.popup;
  /** 0..1 fraction of tiles captured so far. */
  complete: number;
  /** Number of stitched images that will be produced (>= 1). */
  imageCount: number;
}

export interface CaptureSplitNotice {
  type: 'CAPTURE_SPLIT';
  target: typeof MESSAGE_TARGETS.popup;
  imageCount: number;
}

export interface CaptureCompleteEvent {
  type: 'CAPTURE_COMPLETE';
  target: typeof MESSAGE_TARGETS.popup;
  imageCount: number;
}

export type CaptureFailureCode =
  | 'INVALID_URL'
  | 'NO_ACTIVE_TAB'
  | 'INJECT_FAILED'
  | 'CAPTURE_FAILED'
  | 'OFFSCREEN_FAILED'
  | 'PICKER_CANCELLED'
  | 'NO_SCROLL_ANCESTOR'
  | 'ELEMENT_TOO_TALL'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface CaptureErrorEvent {
  type: 'CAPTURE_ERROR';
  target: typeof MESSAGE_TARGETS.popup;
  code: CaptureFailureCode;
  detail?: string;
}

// --- Background ⇄ Content ---------------------------------------------------

export interface ScrollPageRequest {
  type: 'SCROLL_PAGE';
  target: typeof MESSAGE_TARGETS.content;
  options: CaptureOptions;
}

export interface CaptureTileRequest {
  type: 'CAPTURE_TILE';
  target: typeof MESSAGE_TARGETS.background;
  /** Logical scroll position of this tile in CSS px. */
  x: number;
  y: number;
  /** Total page dimensions in CSS px. */
  totalWidth: number;
  totalHeight: number;
  /** Visible viewport width in CSS px (excludes scrollbar). */
  windowWidth: number;
  windowHeight: number;
  devicePixelRatio: number;
  /** 0..1 progress fraction reported by the content script. */
  complete: number;
}

export interface CaptureTileResponse {
  ok: boolean;
  /** Set to true once the offscreen canvas plan has been initialised. */
  imageCount?: number;
  detail?: string;
}

/**
 * Element-mode tile request. The content script has scrolled an inner
 * container (not the page) to a new offset, and asks the background to
 * grab a viewport screenshot, crop it to the element's bounding box, and
 * paste it into the stitched output canvas at the given destination.
 */
export interface CaptureTileCropRequest {
  type: 'CAPTURE_TILE_CROP';
  target: typeof MESSAGE_TARGETS.background;
  /** Element bounding box in viewport CSS px (live, may shift mid-capture). */
  bboxX: number;
  bboxY: number;
  bboxWidth: number;
  bboxHeight: number;
  /** Destination on the stitched output canvas in CSS px. */
  destX: number;
  destY: number;
  /** Final stitched canvas size in CSS px. */
  totalWidth: number;
  totalHeight: number;
  windowWidth: number;
  windowHeight: number;
  devicePixelRatio: number;
  complete: number;
}

export interface ScrollDoneEvent {
  type: 'SCROLL_DONE';
  target: typeof MESSAGE_TARGETS.background;
}

// --- Background ⇄ Offscreen -------------------------------------------------

export interface OffscreenInitRequest {
  type: 'OFFSCREEN_INIT';
  target: typeof MESSAGE_TARGETS.offscreen;
  totalWidth: number;
  totalHeight: number;
}

export interface OffscreenInitResponse {
  ok: boolean;
  imageCount: number;
}

export interface OffscreenDrawRequest {
  type: 'OFFSCREEN_DRAW';
  target: typeof MESSAGE_TARGETS.offscreen;
  /** PNG data URL produced by chrome.tabs.captureVisibleTab. */
  dataUrl: string;
  /** Logical position in CSS px. */
  x: number;
  y: number;
  /** Page-wide scaling factor; the content script measured CSS px while the
   *  captured image may be in device px after zoom or DPR scaling. */
  windowWidth: number;
  totalWidth: number;
  totalHeight: number;
}

export interface OffscreenDrawResponse {
  ok: boolean;
}

/**
 * Element-mode draw — crops a sub-rectangle out of the captured viewport
 * image and pastes it into the stitched output canvas. Coordinates are in
 * CSS px; the offscreen document scales by `image.width / windowWidth`
 * (i.e. devicePixelRatio after zoom corrections) when drawing.
 */
export interface OffscreenDrawCropRequest {
  type: 'OFFSCREEN_DRAW_CROP';
  target: typeof MESSAGE_TARGETS.offscreen;
  dataUrl: string;
  windowWidth: number;
  totalWidth: number;
  totalHeight: number;
  bboxX: number;
  bboxY: number;
  bboxWidth: number;
  bboxHeight: number;
  destX: number;
  destY: number;
}

export interface OffscreenFinalizeRequest {
  type: 'OFFSCREEN_FINALIZE';
  target: typeof MESSAGE_TARGETS.offscreen;
}

export interface OffscreenFinalizeResponse {
  ok: boolean;
  /** Base64-encoded PNGs (no data: prefix) for each stitched image. */
  pngs: string[];
}

export interface OffscreenResetRequest {
  type: 'OFFSCREEN_RESET';
  target: typeof MESSAGE_TARGETS.offscreen;
}

// --- Capture-result preview page ⇄ Background ------------------------------

/**
 * Result of a finished capture, handed off to the in-extension preview page
 * (capture.html). PNG byte data is kept in the service worker so we don't
 * round-trip multi-MB images through chrome.storage.
 */
export interface CaptureResultBundle {
  /** Stable session id used by the preview page to fetch this result. */
  id: string;
  /** Tab URL that was captured (origin shown in the preview header). */
  sourceUrl: string;
  /** Suggested base filename, no extension. */
  baseName: string;
  /** ISO timestamp when capture finished. */
  capturedAt: string;
  /** One entry per stitched output image. Order = top-to-bottom of the page. */
  images: Array<{
    /** Base64-encoded PNG bytes (no `data:` prefix). */
    pngBase64: string;
    /** Pixel dimensions of the PNG. */
    width: number;
    height: number;
  }>;
}

/** Preview page → background: hand me the bundle for this session id. */
export interface CaptureSessionGetRequest {
  type: 'CAPTURE_SESSION_GET';
  target: typeof MESSAGE_TARGETS.background;
  id: string;
}

export interface CaptureSessionGetResponse {
  ok: boolean;
  bundle?: CaptureResultBundle;
  detail?: string;
}

/** Preview page → background: I'm done with this session, free its memory. */
export interface CaptureSessionReleaseRequest {
  type: 'CAPTURE_SESSION_RELEASE';
  target: typeof MESSAGE_TARGETS.background;
  id: string;
}

export type AnyMessage =
  | StartCaptureRequest
  | CaptureProgressEvent
  | CaptureSplitNotice
  | CaptureCompleteEvent
  | CaptureErrorEvent
  | ScrollPageRequest
  | CaptureTileRequest
  | CaptureTileCropRequest
  | ScrollDoneEvent
  | OffscreenInitRequest
  | OffscreenDrawRequest
  | OffscreenDrawCropRequest
  | OffscreenFinalizeRequest
  | OffscreenResetRequest
  | CaptureSessionGetRequest
  | CaptureSessionReleaseRequest;

/**
 * Type guard helper — confirms an inbound runtime message matches one of the
 * documented message shapes targeting the given recipient.
 */
export function isMessageFor<T extends AnyMessage>(
  message: unknown,
  target: MessageTarget,
  type: T['type'],
): message is T {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    'target' in message &&
    (message as AnyMessage).type === type &&
    (message as AnyMessage).target === target
  );
}
