/**
 * Capture preview page — opened in a new tab right after a successful
 * capture. Behaves like the GoFullPage preview tab: shows the stitched
 * image(s), and exposes four download flows:
 *
 *   - Download as multi-page PDF (built locally; no deps)
 *   - Download as PNG image(s)
 *   - Download cloud OCR result as `.txt`
 *   - Download cloud Analyze result as `.txt`
 *
 * OCR + Analyze hit the Cloud Run microservice deployed via `cloud/deploy.sh`.
 * The user configures the service URL + API key once via the settings gear.
 */

import {
  MESSAGE_TARGETS,
  type CaptureFocusPartRequest,
  type CaptureFocusPartResponse,
  type CaptureResultBundle,
  type CaptureSessionGetRequest,
  type CaptureSessionGetResponse,
  type CaptureSessionReleaseRequest,
} from '../utils/messages';
import { getCaptureImage } from '../utils/capture_store';
import { buildZip } from '../utils/zip';
import {
  loadApiSettings,
  saveApiSettings,
  isApiConfigured,
  type ApiSettings,
} from '../utils/preferences';

interface RenderedImage {
  width: number;
  height: number;
  blob: Blob;
}

interface PageState {
  bundle: CaptureResultBundle | null;
  fullBundle: CaptureResultBundle | null;
  part: number | null;
  parts: number | null;
  rendered: RenderedImage[];
  apiSettings: ApiSettings;
}

const state: PageState = {
  bundle: null,
  fullBundle: null,
  part: null,
  parts: null,
  rendered: [],
  apiSettings: { baseUrl: '', apiKey: '' },
};

void main();

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const sourceUrl = params.get('url') ?? '';
  const part = parsePositiveInt(params.get('part'));
  const parts = parsePositiveInt(params.get('parts'));
  state.part = part;
  state.parts = parts;
  setSourceLabel(sourceUrl);

  state.apiSettings = await loadApiSettings();
  bindToolbar();

  if (!id) {
    showError(
      'Missing capture id in URL.',
      'Re-run the capture from the toolbar to open a fresh preview.',
    );
    return;
  }

  try {
    const fullBundle = await fetchBundle(id);
    state.fullBundle = fullBundle;
    const bundle = sliceBundleForPart(fullBundle, part, parts);
    state.bundle = bundle;
    document.title =
      bundle.images.length === 1 && parts && parts > 1 && part
        ? `Voiceido — ${fullBundle.baseName} (${part}/${parts})`
        : `Voiceido — ${bundle.baseName}`;
    renderFolderNav(fullBundle, part, parts);
    await renderImages(bundle, part, parts);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    showError('Could not load capture.', message);
  }
}

// ---------------------------------------------------------------------------
// Bundle fetch + rendering
// ---------------------------------------------------------------------------

async function fetchBundle(id: string): Promise<CaptureResultBundle> {
  const request: CaptureSessionGetRequest = {
    type: 'CAPTURE_SESSION_GET',
    target: MESSAGE_TARGETS.background,
    id,
  };
  const response = (await chrome.runtime.sendMessage(request)) as
    | CaptureSessionGetResponse
    | undefined;
  if (!response?.ok || !response.bundle) {
    throw new Error(
      response?.detail ?? 'Capture data unavailable. The session may have expired.',
    );
  }
  return response.bundle;
}

async function renderImages(
  bundle: CaptureResultBundle,
  part: number | null,
  parts: number | null,
): Promise<void> {
  const stack = mustGet<HTMLDivElement>('image-stack');
  stack.innerHTML = '';
  stack.removeAttribute('aria-busy');

  const info = mustGet<HTMLDivElement>('page-info');
  if (part && parts && parts > 1) {
    info.textContent = `You are on part ${part} of ${parts}. Click another file in the folder to jump to that tab.`;
    info.hidden = false;
  } else if (bundle.images.length > 1) {
    info.textContent = `Captured in ${bundle.images.length} images (split at the canvas size limit so text stays readable).`;
    info.hidden = false;
  }

  state.rendered = [];
  for (let i = 0; i < bundle.images.length; i++) {
    const meta = bundle.images[i];
    if (!meta) continue;
    const blob = await getCaptureImage(bundle.id, meta.index);
    const url = URL.createObjectURL(blob);

    const img = new Image();
    img.alt =
      part && parts
        ? `Capture part ${part} of ${parts}`
        : `Capture ${i + 1} of ${bundle.images.length}`;
    img.src = url;
    stack.appendChild(img);

    state.rendered.push({
      width: meta.width,
      height: meta.height,
      blob,
    });
  }
}

function parsePositiveInt(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * When the worker opened one HTML tab per strip, keep existing download /
 * OCR / Analyze logic but only on this tab's slice.
 */
function sliceBundleForPart(
  bundle: CaptureResultBundle,
  part: number | null,
  parts: number | null,
): CaptureResultBundle {
  if (!part || !parts || parts <= 1) return bundle;
  const index = part - 1;
  const image = bundle.images[index];
  if (!image) {
    throw new Error(`Capture part ${part} of ${parts} is missing.`);
  }
  const pad = String(parts).length;
  return {
    ...bundle,
    baseName: `${bundle.baseName}-${String(part).padStart(pad, '0')}`,
    images: [image],
  };
}

function showError(title: string, detail: string): void {
  const stack = mustGet<HTMLDivElement>('image-stack');
  stack.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'error';
  const h = document.createElement('strong');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = detail;
  box.append(h, p);
  stack.appendChild(box);
}

function setSourceLabel(rawUrl: string): void {
  const el = mustGet<HTMLSpanElement>('source-label');
  if (!rawUrl) {
    el.textContent = '';
    el.title = '';
    return;
  }
  try {
    const url = new URL(rawUrl);
    el.textContent = `${url.hostname}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    el.textContent = rawUrl;
  }
  el.title = rawUrl;
}

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------

function renderFolderNav(
  fullBundle: CaptureResultBundle,
  part: number | null,
  parts: number | null,
): void {
  const rail = mustGet<HTMLElement>('folder-rail');
  const list = mustGet<HTMLDivElement>('folder-list');
  const meta = mustGet<HTMLSpanElement>('folder-meta');
  const allActions = mustGet<HTMLElement>('all-actions');
  const total = parts && parts > 1 ? parts : fullBundle.images.length;
  if (total <= 1) {
    rail.hidden = true;
    allActions.hidden = true;
    return;
  }

  rail.hidden = false;
  allActions.hidden = false;
  const pad = String(total).length;
  meta.textContent = `${total} HTML pages · you are on part ${part ?? 1}`;
  list.innerHTML = '';

  for (let i = 1; i <= total; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `folder-item${i === part ? ' current' : ''}`;
    btn.setAttribute('role', 'listitem');
    if (i === part) btn.setAttribute('aria-current', 'page');
    const name = document.createElement('span');
    name.className = 'folder-item-name';
    name.textContent = `Part ${String(i).padStart(pad, '0')}`;
    const file = document.createElement('span');
    file.className = 'folder-item-file';
    file.textContent = `${fullBundle.baseName}-${String(i).padStart(pad, '0')}.html`;
    btn.append(name, file);
    btn.addEventListener('click', () => {
      void focusPart(i);
    });
    list.appendChild(btn);
  }
}

async function focusPart(part: number): Promise<void> {
  if (!state.fullBundle) return;
  if (part === state.part) return;
  const request: CaptureFocusPartRequest = {
    type: 'CAPTURE_FOCUS_PART',
    target: MESSAGE_TARGETS.background,
    id: state.fullBundle.id,
    part,
  };
  const response = (await chrome.runtime.sendMessage(request)) as
    | CaptureFocusPartResponse
    | undefined;
  if (!response?.ok) {
    toast(response?.detail ?? 'Could not open that part.', 'error');
  }
}

function bindToolbar(): void {
  bindAction('btn-pdf', handleDownloadPdf);
  bindAction('btn-image', handleDownloadImage);
  bindAction('btn-ocr', () => handleCloudJob('ocr'));
  bindAction('btn-analyze', () => handleCloudJob('analyze'));
  bindAction('btn-pdf-all', handleDownloadPdfAll);
  bindAction('btn-image-all', handleDownloadImagesZip);
  bindAction('btn-ocr-all', () => handleCloudJobAll('ocr'));
  bindAction('btn-analyze-all', () => handleCloudJobAll('analyze'));
  bindAction('btn-settings', openSettings);

  // Cmd/Ctrl+S → image, Cmd/Ctrl+P → PDF (preventDefault to avoid native).
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === 's') {
      e.preventDefault();
      void handleDownloadImage();
    } else if (e.key === 'p') {
      e.preventDefault();
      void handleDownloadPdf();
    }
  });

  // Release the bundle from background memory when the tab closes — we've
  // already cached blobs locally so we don't need it any more.
  window.addEventListener('beforeunload', () => {
    if (!state.bundle) return;
    const release: CaptureSessionReleaseRequest = {
      type: 'CAPTURE_SESSION_RELEASE',
      target: MESSAGE_TARGETS.background,
      id: state.bundle.id,
    };
    // Fire-and-forget; promise won't necessarily resolve before unload.
    chrome.runtime.sendMessage(release).catch(() => {});
  });
}

function bindAction(id: string, handler: () => void | Promise<void>): void {
  const btn = mustGet<HTMLButtonElement>(id);
  btn.addEventListener('click', () => {
    void runWithBusy(btn, handler);
  });
}

async function runWithBusy(
  btn: HTMLButtonElement,
  handler: () => void | Promise<void>,
): Promise<void> {
  if (btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  btn.disabled = true;
  try {
    await handler();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    toast(message, 'error');
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Image download
// ---------------------------------------------------------------------------

async function downloadBlob(filename: string, blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

function partPad(total: number): number {
  return String(total).length;
}

function partFileStem(index: number, total: number): string {
  const base = state.fullBundle?.baseName ?? state.bundle?.baseName ?? 'capture';
  return `${base}-${String(index + 1).padStart(partPad(total), '0')}`;
}

async function loadAllRendered(): Promise<RenderedImage[]> {
  const full = state.fullBundle;
  if (!full || full.images.length === 0) {
    throw new Error('No capture parts loaded.');
  }
  const out: RenderedImage[] = [];
  for (const meta of full.images) {
    const blob = await getCaptureImage(full.id, meta.index);
    out.push({ width: meta.width, height: meta.height, blob });
  }
  return out;
}

async function handleDownloadImagesZip(): Promise<void> {
  const images = await loadAllRendered();
  toast(`Zipping ${images.length} images…`);
  const entries = await Promise.all(
    images.map(async (item, i) => ({
      name: `${partFileStem(i, images.length)}.png`,
      data: new Uint8Array(await item.blob.arrayBuffer()),
    })),
  );
  const zip = buildZip(entries);
  const base = state.fullBundle?.baseName ?? 'capture';
  await downloadBlob(`${base}-images.zip`, new Blob([zip as BlobPart], { type: 'application/zip' }));
  toast(`Saved ${images.length} images as zip.`, 'success');
}

async function handleDownloadPdfAll(): Promise<void> {
  const images = await loadAllRendered();
  toast(`Building ${images.length} PDFs…`);
  const entries = [];
  for (let i = 0; i < images.length; i++) {
    const item = images[i];
    if (!item) continue;
    toast(`PDF ${i + 1}/${images.length}…`);
    const pdfBytes = buildPdfBytes([await pngToJpegPage(item)]);
    entries.push({
      name: `${partFileStem(i, images.length)}.pdf`,
      data: pdfBytes,
    });
  }
  const zip = buildZip(entries);
  const base = state.fullBundle?.baseName ?? 'capture';
  await downloadBlob(`${base}-pdfs.zip`, new Blob([zip as BlobPart], { type: 'application/zip' }));
  toast(`Saved ${entries.length} PDFs as zip.`, 'success');
}

async function handleCloudJobAll(job: CloudJob): Promise<void> {
  if (!isApiConfigured(state.apiSettings)) {
    toast('Configure the backend API first (gear icon).', 'error');
    openSettings();
    return;
  }
  const images = await loadAllRendered();
  const label = job === 'ocr' ? 'OCR' : 'Analyze';
  const perImage: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < images.length; i++) {
    const item = images[i];
    if (!item) continue;
    toast(`${label} ${i + 1}/${images.length}…`);
    const text = await callCloudJob(job, item.blob);
    perImage.push({ index: i + 1, text });
  }

  let synthesis = '';
  if (job === 'analyze' && perImage.length > 1) {
    toast('Analyze: synthesising across parts…');
    synthesis = await callSynthesize(
      perImage.map((p) => ({ index: p.index, analysis: p.text })),
    ).catch((e: unknown) => {
      console.warn('[analyze] synthesis failed', e);
      return '';
    });
  }

  const enc = new TextEncoder();
  const entries = perImage.map((p, i) => ({
    name: `${partFileStem(i, images.length)}.${job}.txt`,
    data: enc.encode(p.text.trim() || `(${label} returned empty result)`),
  }));
  entries.push({
    name: `${state.fullBundle?.baseName ?? 'capture'}.${job}.combined.txt`,
    data: enc.encode(formatCombinedText(label, perImage, synthesis)),
  });
  const zip = buildZip(entries);
  const base = state.fullBundle?.baseName ?? 'capture';
  await downloadBlob(`${base}-${job}.zip`, new Blob([zip as BlobPart], { type: 'application/zip' }));
  toast(`${label}: saved ${perImage.length} files as zip.`, 'success');
}

async function handleDownloadImage(): Promise<void> {
  if (!state.bundle || state.rendered.length === 0) {
    throw new Error('No image data loaded yet.');
  }
  const { baseName } = state.bundle;
  const total = state.rendered.length;
  for (let i = 0; i < total; i++) {
    const item = state.rendered[i];
    if (!item) continue;
    const filename = withIndex(`${baseName}.png`, i, total);
    const url = URL.createObjectURL(item.blob);
    try {
      await chrome.downloads.download({
        url,
        filename,
        saveAs: false,
        conflictAction: 'uniquify',
      });
    } finally {
      // Revoke a tick later so the download has time to start.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  }
  toast(total > 1 ? `Saved ${total} images.` : 'Image saved.', 'success');
}

// ---------------------------------------------------------------------------
// PDF download — custom minimal builder, embeds JPEG bytes per page
// ---------------------------------------------------------------------------

async function handleDownloadPdf(): Promise<void> {
  if (!state.bundle || state.rendered.length === 0) {
    throw new Error('No image data loaded yet.');
  }
  toast('Encoding PDF…');
  const pages = await Promise.all(state.rendered.map((r) => pngToJpegPage(r)));
  const pdfBytes = buildPdfBytes(pages);
  const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: `${state.bundle.baseName}.pdf`,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    toast('PDF saved.', 'success');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

interface JpegPage {
  width: number;
  height: number;
  jpegBytes: Uint8Array;
}

/**
 * Decode a captured PNG into a JPEG suitable for embedding in a PDF
 * `/DCTDecode` image XObject. Uses a regular `<canvas>` (not
 * `OffscreenCanvas`) because:
 *   - it lives in a normal extension page, so paint cost is negligible;
 *   - `HTMLCanvasElement.toBlob()` is the most universally supported codec
 *     path and does not silently produce empty buffers the way some
 *     `OffscreenCanvas.convertToBlob()` paths can on stale Chrome builds —
 *     which is what produced empty/blank pages in earlier revisions.
 */
async function pngToJpegPage(r: RenderedImage): Promise<JpegPage> {
  const url = URL.createObjectURL(r.blob);
  try {
    const img = await loadImage(url);
    const width = img.naturalWidth || r.width;
    const height = img.naturalHeight || r.height;
    if (!width || !height) {
      throw new Error('Capture image has zero dimensions.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable.');
    // /DCTDecode is alpha-less — flatten transparent pixels onto white so
    // they don't render black when the JPEG is composited.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const jpegBlob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
    if (jpegBytes.length === 0) {
      throw new Error('JPEG encoder returned empty buffer.');
    }
    return { width, height, jpegBytes };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load capture image.'));
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error(`Canvas.toBlob produced no ${type} blob.`));
          return;
        }
        resolve(blob);
      },
      type,
      quality,
    );
  });
}

function buildPdfBytes(pages: JpegPage[]): Uint8Array {
  if (pages.length === 0) throw new Error('No pages to render.');
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  // 0 is the free entry; 1..N are actual objects.
  const objectOffsets: number[] = [];

  function add(part: string | Uint8Array): void {
    const bytes = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(bytes);
    offset += bytes.length;
  }
  function startObj(n: number): void {
    objectOffsets[n] = offset;
    add(`${n} 0 obj\n`);
  }
  function endObj(): void {
    add('\nendobj\n');
  }

  // Header — the four high-bit bytes after the comment are the PDF binary
  // marker recommended by §7.5.2 of ISO 32000 so naive transports treat
  // the file as binary. We emit them as raw bytes to avoid TextEncoder
  // turning each 0x80–0xFF code point into a 2-byte UTF-8 sequence, which
  // would corrupt the offsets we record in the xref table.
  add('%PDF-1.4\n');
  add(new Uint8Array([0x25, 0xc4, 0xe5, 0xf2, 0xe5, 0x0a]));

  // Object 1: Catalog
  startObj(1);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  endObj();

  // Object 2: Pages tree. Page i (1..N) lives at obj `3 + (i-1)*3`.
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  startObj(2);
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  endObj();

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!page) continue;
    const pageObj = 3 + i * 3;
    const imgObj = pageObj + 1;
    const contentObj = pageObj + 2;

    // Page object — MediaBox in default 72-dpi user space; using raw pixel
    // dimensions matches the GoFullPage convention so the PDF "feels" the
    // same size as the source screenshot in viewers.
    startObj(pageObj);
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}]` +
        ` /Resources << /XObject << /Im0 ${imgObj} 0 R >> >>` +
        ` /Contents ${contentObj} 0 R >>`,
    );
    endObj();

    // Image XObject (DCTDecode = JPEG, native to PDF).
    startObj(imgObj);
    add(
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height}` +
        ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode` +
        ` /Length ${page.jpegBytes.length} >>\nstream\n`,
    );
    add(page.jpegBytes);
    add('\nendstream');
    endObj();

    // Content stream — push CTM, scale unit-square to page dims, paint Im0.
    const stream = `q\n${page.width} 0 0 ${page.height} 0 0 cm\n/Im0 Do\nQ\n`;
    const streamBytes = enc.encode(stream);
    startObj(contentObj);
    add(`<< /Length ${streamBytes.length} >>\nstream\n`);
    add(streamBytes);
    add('endstream');
    endObj();
  }

  // xref
  const lastObj = 2 + 3 * pages.length;
  const xrefOffset = offset;
  const lines: string[] = [`xref\n0 ${lastObj + 1}\n`, '0000000000 65535 f \n'];
  for (let n = 1; n <= lastObj; n++) {
    const o = objectOffsets[n] ?? 0;
    lines.push(`${String(o).padStart(10, '0')} 00000 n \n`);
  }
  add(lines.join(''));

  // Trailer
  add(
    `trailer\n<< /Size ${lastObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  // Concatenate all chunks into a single Uint8Array.
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cloud OCR / Analyze
// ---------------------------------------------------------------------------

type CloudJob = 'ocr' | 'analyze';

async function handleCloudJob(job: CloudJob): Promise<void> {
  if (!state.bundle || state.rendered.length === 0) {
    throw new Error('No image data loaded yet.');
  }
  if (!isApiConfigured(state.apiSettings)) {
    toast('Configure the backend API first (gear icon).', 'error');
    openSettings();
    return;
  }

  const label = job === 'ocr' ? 'OCR' : 'Analyze';
  toast(
    state.rendered.length > 1
      ? `${label}: processing ${state.rendered.length} images…`
      : `${label}: contacting backend…`,
  );

  // Per-image pass.
  const perImage: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < state.rendered.length; i++) {
    const item = state.rendered[i];
    if (!item) continue;
    const text = await callCloudJob(job, item.blob);
    perImage.push({ index: i + 1, text });
  }

  // For Analyze with 2+ images, run the cross-image synthesis pass on the
  // backend so the saved .txt opens with one unified essay covering every
  // image, then keeps the per-image detail underneath.
  let synthesis = '';
  if (job === 'analyze' && perImage.length > 1) {
    toast('Analyze: synthesising across images…');
    synthesis = await callSynthesize(
      perImage.map((p) => ({ index: p.index, analysis: p.text })),
    ).catch((e: unknown) => {
      console.warn('[analyze] synthesis failed', e);
      return '';
    });
  }

  const combined = formatCombinedText(label, perImage, synthesis);

  const blob = new Blob([combined], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: `${state.bundle.baseName}.${job}.txt`,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    toast(`${label}: saved as .txt`, 'success');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

function formatCombinedText(
  label: string,
  perImage: Array<{ index: number; text: string }>,
  synthesis: string,
): string {
  if (perImage.length === 0) return `(${label} returned empty result)`;

  if (perImage.length === 1) {
    return perImage[0]!.text.trim() || `(${label} returned empty result)`;
  }

  const total = perImage.length;
  const sections: string[] = [];

  if (synthesis.trim()) {
    sections.push(
      `===== UNIFIED ANALYSIS (essay across all ${total} images) =====`,
      '',
      synthesis.trim(),
      '',
      '===== Per-Image Detail =====',
      '',
    );
  }

  sections.push(
    perImage
      .map((p) => `--- Image ${p.index} of ${total} ---\n\n${p.text.trim()}`)
      .join('\n\n'),
  );

  return sections.join('\n').trim() || `(${label} returned empty result)`;
}

async function callSynthesize(
  items: Array<{ index: number; analysis: string }>,
): Promise<string> {
  const { baseUrl, apiKey } = state.apiSettings;
  const endpoint = `${baseUrl}/api/analyze/synthesize`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(
      `synthesize failed (${res.status} ${res.statusText})${text ? `: ${text}` : ''}`,
    );
  }
  const data = (await res.json()) as { synthesis?: string; error?: string };
  if (data.error) throw new Error(data.error);
  return data.synthesis ?? '';
}

async function callCloudJob(job: CloudJob, image: Blob): Promise<string> {
  const { baseUrl, apiKey } = state.apiSettings;
  const endpoint = `${baseUrl}/api/${job}`;
  const form = new FormData();
  form.append('file', image, 'capture.png');
  if (job === 'ocr') form.append('preserveLayout', 'true');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey },
    body: form,
  });
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(
      `${job} failed (${res.status} ${res.statusText})${text ? `: ${text}` : ''}`,
    );
  }
  const data = (await res.json()) as { text?: string; analysis?: string; error?: string };
  if (data.error) throw new Error(data.error);
  return data.text ?? data.analysis ?? '';
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 240);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

function openSettings(): void {
  const dialog = mustGet<HTMLDialogElement>('settings-dialog');
  const url = mustGet<HTMLInputElement>('field-url');
  const key = mustGet<HTMLInputElement>('field-key');
  const test = mustGet<HTMLParagraphElement>('settings-test');
  const cancelBtn = mustGet<HTMLButtonElement>('settings-cancel');
  const testBtn = mustGet<HTMLButtonElement>('settings-test-btn');
  const form = mustGet<HTMLFormElement>('settings-form');

  url.value = state.apiSettings.baseUrl;
  key.value = state.apiSettings.apiKey;
  test.textContent = '';
  test.className = 'dialog-help dialog-test';

  const onSubmit = (e: Event): void => {
    e.preventDefault();
    void (async () => {
      const next: ApiSettings = { baseUrl: url.value.trim(), apiKey: key.value.trim() };
      await saveApiSettings(next);
      state.apiSettings = await loadApiSettings();
      dialog.close();
      toast('Backend settings saved.', 'success');
      cleanup();
    })();
  };
  const onCancel = (): void => {
    dialog.close();
    cleanup();
  };
  const onTest = (): void => {
    test.className = 'dialog-help dialog-test';
    test.textContent = 'Pinging…';
    testBtn.disabled = true;
    void (async () => {
      try {
        const probe: ApiSettings = {
          baseUrl: url.value.trim().replace(/\/+$/, ''),
          apiKey: key.value.trim(),
        };
        if (!probe.baseUrl) throw new Error('Enter a URL first.');
        const res = await fetch(`${probe.baseUrl}/health`, {
          method: 'GET',
          headers: probe.apiKey ? { 'X-API-Key': probe.apiKey } : {},
        });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = (await res.json().catch(() => ({}))) as { status?: string };
        test.className = 'dialog-help dialog-test success';
        test.textContent = `Connected · ${data.status ?? 'ok'}`;
      } catch (error) {
        test.className = 'dialog-help dialog-test error';
        test.textContent = `Unreachable: ${error instanceof Error ? error.message : 'unknown error'}`;
      } finally {
        testBtn.disabled = false;
      }
    })();
  };

  function cleanup(): void {
    form.removeEventListener('submit', onSubmit);
    cancelBtn.removeEventListener('click', onCancel);
    testBtn.removeEventListener('click', onTest);
  }

  form.addEventListener('submit', onSubmit);
  cancelBtn.addEventListener('click', onCancel);
  testBtn.addEventListener('click', onTest);
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

function withIndex(filename: string, index: number, total: number): string {
  if (total <= 1) return filename;
  const dot = filename.lastIndexOf('.');
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const ext = dot === -1 ? '' : filename.slice(dot);
  const pad = String(total).length;
  return `${stem}-${String(index + 1).padStart(pad, '0')}${ext}`;
}

let toastTimer: number | undefined;
function toast(message: string, kind?: 'success' | 'error'): void {
  const el = mustGet<HTMLDivElement>('toast');
  el.textContent = message;
  el.className = `toast${kind ? ` ${kind}` : ''}`;
  el.hidden = false;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, kind === 'error' ? 5_000 : 2_500);
}
