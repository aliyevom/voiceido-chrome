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
  type CaptureResultBundle,
  type ExtractedList,
  type CaptureSessionGetRequest,
  type CaptureSessionGetResponse,
  type CaptureSessionReleaseRequest,
} from '../utils/messages';
import { getCaptureImage } from '../utils/capture_store';
import { planReadableSlices } from '../utils/canvas_constraints';
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
  selectedIndex: number;
  rendered: RenderedImage[];
  apiSettings: ApiSettings;
}

const ICONS = {
  pdf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm-1 1.5L18.5 9H13z"/></svg>',
  png: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m-1.5 12H6.5l3.2-4.1 2.3 2.9 1.6-2 3.9 3.2"/></svg>',
  ocr: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 5h16v2H4zm0 4h10v2H4zm0 4h16v2H4zm0 4h10v2H4z"/></svg>',
  analyze:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3 9.5 8.5 4 9.2l4.2 3.8L7 19l5-2.8L17 19l-1.2-6L20 9.2 14.5 8.5z"/></svg>',
};

const state: PageState = {
  bundle: null,
  fullBundle: null,
  part: null,
  parts: null,
  selectedIndex: 0,
  rendered: [],
  apiSettings: { baseUrl: '', apiKey: '' },
};

void main();

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const sourceUrl = params.get('url') ?? '';
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
    state.bundle = fullBundle;
    state.parts = fullBundle.images.length;
    state.part = 1;
    document.title = `Voiceido — ${fullBundle.baseName}`;
    renderContentsRail(fullBundle);
    await renderBook(fullBundle);
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

async function renderBook(bundle: CaptureResultBundle): Promise<void> {
  state.rendered = [];
  for (let i = 0; i < bundle.images.length; i++) {
    const meta = bundle.images[i];
    if (!meta) continue;
    const blob = await getCaptureImage(bundle.id, meta.index);
    state.rendered.push({ width: meta.width, height: meta.height, blob });
  }
  renderCatalog(bundle);
}

function showError(title: string, detail: string): void {
  const stack = mustGet<HTMLDivElement>('catalog-track');
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

function renderContentsRail(fullBundle: CaptureResultBundle): void {
  const rail = mustGet<HTMLElement>('browse-rail');
  const meta = mustGet<HTMLSpanElement>('folder-meta');
  const allActions = mustGet<HTMLElement>('all-actions');
  const savePhotos = mustGet<HTMLButtonElement>('btn-list-photos');
  const extracted = fullBundle.list;
  const photoCount = extracted?.items.reduce((n, item) => n + item.images.length, 0) ?? 0;
  const hasContents = Boolean(extracted && extracted.items.length > 0);
  allActions.hidden = fullBundle.images.length <= 1;
  if (!hasContents) {
    rail.hidden = true;
    return;
  }
  rail.hidden = false;
  meta.textContent = `${extracted?.items.length ?? 0} items · ${photoCount} photos`;
  renderContents(extracted);
  savePhotos.hidden = photoCount === 0;
}

function renderCatalog(bundle: CaptureResultBundle): void {
  const track = mustGet<HTMLDivElement>('catalog-track');
  track.innerHTML = '';
  const total = bundle.images.length;
  for (let i = 0; i < total; i++) {
    const page = state.rendered[i];
    const card = document.createElement('article');
    card.className = 'catalog-card';
    card.dataset.index = String(i);

    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'catalog-hit';
    hit.setAttribute('aria-label', `Preview page ${i + 1}`);
    const img = document.createElement('img');
    img.className = 'catalog-thumb';
    img.alt = '';
    if (page) img.src = URL.createObjectURL(page.blob);
    hit.append(img);
    hit.addEventListener('click', () => openPreview(i));

    const num = document.createElement('span');
    num.className = 'catalog-num';
    num.textContent = String(i + 1);

    const actions = document.createElement('div');
    actions.className = 'catalog-actions';
    actions.append(
      catalogAction('PDF', ICONS.pdf, `Save page ${i + 1} as PDF`, () => savePagePdf(i)),
      catalogAction('PNG', ICONS.png, `Save page ${i + 1} as PNG`, () => savePagePng(i)),
      catalogAction('OCR', ICONS.ocr, `OCR page ${i + 1}`, () => savePageJob(i, 'ocr')),
      catalogAction('Analyze', ICONS.analyze, `Analyze page ${i + 1}`, () => savePageJob(i, 'analyze')),
    );

    card.append(num, hit, actions);
    track.appendChild(card);
  }
}

function catalogAction(
  label: string,
  icon: string,
  tip: string,
  handler: () => void | Promise<void>,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cat-act';
  btn.dataset.tip = tip;
  btn.setAttribute('aria-label', tip);
  btn.innerHTML = `${icon}<span>${label}</span>`;
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    void runWithBusy(btn, handler);
  });
  return btn;
}

function openPreview(index: number): void {
  const page = pageImage(index);
  state.selectedIndex = index;
  state.part = index + 1;
  for (const card of document.querySelectorAll<HTMLElement>('.catalog-card')) {
    card.classList.toggle('current', Number(card.dataset.index) === index);
  }
  const pop = mustGet<HTMLElement>('preview-pop');
  const title = mustGet<HTMLSpanElement>('preview-pop-title');
  const body = mustGet<HTMLElement>('preview-pop-body');
  title.textContent = `Page ${index + 1} of ${state.rendered.length}`;
  body.innerHTML = '';
  const sheet = document.createElement('div');
  sheet.className = 'preview-sheet';
  const img = new Image();
  img.alt = `Capture page ${index + 1}`;
  img.src = URL.createObjectURL(page.blob);
  sheet.appendChild(img);
  body.appendChild(sheet);
  pop.hidden = false;
  document.body.classList.add('preview-open');
  clearPreviewSmoke();
}

function closePreview(): void {
  const pop = mustGet<HTMLElement>('preview-pop');
  pop.hidden = true;
  mustGet<HTMLElement>('preview-pop-body').innerHTML = '';
  clearPreviewSmoke();
  document.body.classList.remove('preview-open');
}

function clearPreviewSmoke(): void {
  const smoke = document.getElementById('preview-smoke');
  const jet = document.getElementById('preview-smoke-jet');
  if (!smoke) return;
  for (const puff of [...smoke.querySelectorAll('.preview-smoke-puff')]) {
    puff.remove();
  }
  jet?.classList.remove('on');
}

function bindPreviewSmoke(): void {
  const body = mustGet<HTMLElement>('preview-pop-body');
  const smoke = mustGet<HTMLElement>('preview-smoke');
  const jet = mustGet<HTMLElement>('preview-smoke-jet');
  let lastTop = 0;
  let lastAt = 0;
  let jetTimer = 0;
  body.addEventListener(
    'scroll',
    () => {
      const now = performance.now();
      const dy = body.scrollTop - lastTop;
      const dt = Math.max(8, now - lastAt);
      lastTop = body.scrollTop;
      lastAt = now;
      const range = body.scrollHeight - body.clientHeight;
      if (range <= 0) return;
      const thumbH = Math.max(28, (body.clientHeight / body.scrollHeight) * body.clientHeight);
      const thumbTop = (body.scrollTop / range) * (body.clientHeight - thumbH);
      const mid = thumbTop + thumbH / 2;
      jet.style.top = `${mid}px`;
      jet.classList.add('on');
      window.clearTimeout(jetTimer);
      jetTimer = window.setTimeout(() => jet.classList.remove('on'), 220);

      const speed = Math.min(1, (Math.abs(dy) / dt) * 10);
      const count = 1 + Math.round(speed * 5);
      for (let i = 0; i < count; i++) {
        const puff = document.createElement('span');
        puff.className = 'preview-smoke-puff';
        const streak = (i / count) * Math.sign(dy || 1) * Math.min(Math.abs(dy) * 0.12, 40);
        puff.style.top = `${mid - streak}px`;
        puff.style.setProperty('--drift', `${-36 - speed * 28 - Math.random() * 18}px`);
        puff.style.setProperty('--rise', `${(Math.random() - 0.5) * 16}px`);
        puff.style.setProperty('--scale', `${1.4 + speed * 0.9 + Math.random() * 0.3}`);
        smoke.appendChild(puff);
        puff.addEventListener('animationend', () => puff.remove());
      }
      while (smoke.querySelectorAll('.preview-smoke-puff').length > 36) {
        smoke.querySelector('.preview-smoke-puff')?.remove();
      }
    },
    { passive: true },
  );
}

function renderContents(list: ExtractedList | undefined): void {
  const cards = mustGet<HTMLDivElement>('list-cards');
  const sub = mustGet<HTMLParagraphElement>('list-board-sub');
  if (!list || list.items.length === 0) {
    sub.textContent = 'No photos or items extracted from this section.';
    cards.innerHTML = '';
    return;
  }
  const photoCount = list.items.reduce((n, item) => n + item.images.length, 0);
  sub.textContent = `${list.items.length} items · ${photoCount} photos`;
  cards.innerHTML = '';
  for (const item of list.items) {
    const openUrl = itemOpenUrl(item);
    const card = document.createElement(openUrl ? 'a' : 'article');
    card.className = `list-card${openUrl ? ' is-openable' : ''}`;
    if (card instanceof HTMLAnchorElement && openUrl) {
      card.href = openUrl;
      card.target = '_blank';
      card.rel = 'noreferrer';
      card.title = openUrl;
    }

    const thumb = document.createElement('div');
    thumb.className = 'list-card-thumb';
    const firstPhoto = item.images[0];
    if (firstPhoto) {
      const img = document.createElement('img');
      img.src = firstPhoto.dataUrl || firstPhoto.url;
      img.alt = firstPhoto.alt || item.title;
      img.loading = 'lazy';
      thumb.appendChild(img);
      if (item.images.length > 1) {
        const more = document.createElement('span');
        more.className = 'list-card-more';
        more.textContent = `+${item.images.length - 1}`;
        thumb.appendChild(more);
      }
    } else {
      thumb.classList.add('is-link');
      thumb.textContent = '↗';
    }

    const body = document.createElement('div');
    body.className = 'list-card-body';
    const title = document.createElement('p');
    title.className = 'list-card-title';
    title.textContent = compactTitle(item.title);
    body.appendChild(title);
    const meta = document.createElement('p');
    meta.className = 'list-card-meta';
    if (item.href) {
      meta.textContent = compactHost(item.href);
    } else if (item.detail) {
      meta.textContent = compactTitle(item.detail);
    } else {
      meta.textContent = item.images.length ? 'Photo' : 'Item';
    }
    body.appendChild(meta);

    card.append(thumb, body);
    cards.appendChild(card);
  }
}

function itemOpenUrl(item: ExtractedList['items'][number]): string | undefined {
  if (item.href && isNavigableUrl(item.href)) return item.href;
  const image = item.images[0];
  if (!image) return undefined;
  if (isNavigableUrl(image.url)) return image.url;
  if (image.dataUrl) return image.dataUrl;
  return undefined;
}

function isNavigableUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:image/');
}

function compactTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 88);
}

function compactHost(href: string): string {
  try {
    const url = new URL(href);
    const path = url.pathname.replace(/\/$/, '');
    const short = path.length > 28 ? `${path.slice(0, 26)}…` : path;
    return `${url.hostname.replace(/^www\./, '')}${short}`;
  } catch {
    return href.slice(0, 64);
  }
}

function sanitizePathPart(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return cleaned || 'item';
}

function extensionFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const match = /\.(avif|bmp|gif|jpe?g|png|webp)$/i.exec(path);
    if (match?.[1]) return `.${match[1].toLowerCase().replace('jpeg', 'jpg')}`;
  } catch {
    /* ignore */
  }
  return '.jpg';
}

async function handleSaveListPhotos(): Promise<void> {
  const list = state.fullBundle?.list;
  const base = state.fullBundle?.baseName ?? 'capture';
  if (!list || list.items.length === 0) {
    throw new Error('No photos in Contents for this capture.');
  }
  const pad = String(list.items.length).length;
  let saved = 0;
  for (const item of list.items) {
    const folder = `${base}-contents/${String(item.index + 1).padStart(pad, '0')}-${sanitizePathPart(item.title)}`;
    for (let i = 0; i < item.images.length; i++) {
      const image = item.images[i];
      if (!image) continue;
      const filename = `${folder}/${String(i + 1).padStart(2, '0')}${extensionFromUrl(image.url)}`;
      await chrome.downloads.download({
        url: image.url,
        filename,
        saveAs: false,
        conflictAction: 'uniquify',
      });
      saved += 1;
    }
  }
  toast(`Saved ${saved} list photos.`, 'success');
}

function bindToolbar(): void {
  bindAction('btn-pdf-all', handleDownloadPdfAll);
  bindAction('btn-image-all', handleDownloadImagesZip);
  bindAction('btn-ocr-all', () => handleCloudJobAll('ocr'));
  bindAction('btn-analyze-all', () => handleCloudJobAll('analyze'));
  bindAction('btn-list-photos', handleSaveListPhotos);
  bindAction('btn-debug', handleDebugDump);
  bindAction('btn-settings', openSettings);
  mustGet<HTMLButtonElement>('preview-pop-close').addEventListener('click', () => closePreview());
  mustGet<HTMLElement>('preview-pop').addEventListener('click', (event) => {
    const body = mustGet<HTMLElement>('preview-pop-body');
    if (event.target === event.currentTarget || event.target === body) closePreview();
  });
  bindPreviewSmoke();

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePreview();
      return;
    }
    const popOpen = !mustGet<HTMLElement>('preview-pop').hidden;
    if (e.metaKey || e.ctrlKey) {
      if (e.key === 's') {
        e.preventDefault();
        void savePagePng(state.selectedIndex);
      } else if (e.key === 'p') {
        e.preventDefault();
        void savePagePdf(state.selectedIndex);
      }
      return;
    }
    if (!popOpen) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      openPreview(Math.min(state.selectedIndex + 1, state.rendered.length - 1));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      openPreview(Math.max(state.selectedIndex - 1, 0));
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

async function handleDebugDump(): Promise<void> {
  const bundle = state.fullBundle ?? state.bundle;
  if (!bundle) throw new Error('No capture loaded.');
  const dump = {
    id: bundle.id,
    sourceUrl: bundle.sourceUrl,
    baseName: bundle.baseName,
    capturedAt: bundle.capturedAt,
    part: state.part,
    parts: state.parts,
    previewUrl: window.location.href,
    images: bundle.images,
    list: bundle.list
      ? {
          items: bundle.list.items.map((item) => ({
            index: item.index,
            title: item.title,
            detail: item.detail,
            href: item.href,
            images: item.images.map((image) => ({
              url: image.url.startsWith('data:') ? '(data URL)' : image.url,
              alt: image.alt,
              width: image.width,
              height: image.height,
              inlinedBytes: image.dataUrl
                ? Math.ceil((image.dataUrl.length * 3) / 4)
                : 0,
            })),
          })),
        }
      : null,
  };
  console.info('[voiceido debug]', dump);
  const json = `${JSON.stringify(dump, null, 2)}\n`;
  await downloadBlob(
    `${bundle.baseName}.debug.json`,
    new Blob([json], { type: 'application/json' }),
  );
  toast('Debug JSON saved. Details also logged to the console.', 'success');
}

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
    const pdfBytes = buildPdfBytes(await pngToJpegPages(item));
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
  const zip = await runCloudJobZip(job, images, { includeContents: true });
  const base = state.fullBundle?.baseName ?? 'capture';
  await downloadBlob(`${base}-${job}.zip`, new Blob([zip as BlobPart], { type: 'application/zip' }));
  toast(`${job === 'ocr' ? 'OCR' : 'Analyze'}: saved zip with images.`, 'success');
}

function pageImage(index: number): RenderedImage {
  const item = state.rendered[index];
  if (!item) throw new Error(`Page ${index + 1} is not loaded.`);
  return item;
}

async function savePagePng(index: number): Promise<void> {
  const item = pageImage(index);
  const filename = `${partFileStem(index, state.rendered.length)}.png`;
  const url = URL.createObjectURL(item.blob);
  try {
    await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    toast(`Saved ${filename}.`, 'success');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

async function savePagePdf(index: number): Promise<void> {
  const item = pageImage(index);
  toast('Encoding PDF…');
  const pdfBytes = buildPdfBytes(await pngToJpegPages(item));
  await downloadBlob(
    `${partFileStem(index, state.rendered.length)}.pdf`,
    new Blob([pdfBytes as BlobPart], { type: 'application/pdf' }),
  );
  toast('PDF saved.', 'success');
}

async function savePageJob(index: number, job: CloudJob): Promise<void> {
  if (!isApiConfigured(state.apiSettings)) {
    toast('Configure the backend API first (gear icon).', 'error');
    openSettings();
    return;
  }
  const item = pageImage(index);
  const zip = await runCloudJobZip(job, [item], { includeContents: false, pageOffset: index });
  const stem = partFileStem(index, state.rendered.length);
  await downloadBlob(`${stem}-${job}.zip`, new Blob([zip as BlobPart], { type: 'application/zip' }));
  toast(`${job === 'ocr' ? 'OCR' : 'Analyze'}: saved zip.`, 'success');
}

// ---------------------------------------------------------------------------
// PDF download — custom minimal builder, embeds JPEG bytes per page
// ---------------------------------------------------------------------------

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
async function pngToJpegPages(r: RenderedImage): Promise<JpegPage[]> {
  const url = URL.createObjectURL(r.blob);
  try {
    const img = await loadImage(url);
    const width = img.naturalWidth || r.width;
    const height = img.naturalHeight || r.height;
    if (!width || !height) {
      throw new Error('Capture image has zero dimensions.');
    }
    const slices = planReadableSlices(width, height);
    const pages: JpegPage[] = [];
    for (const slice of slices) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = slice.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable.');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, slice.height);
      ctx.drawImage(
        img,
        0,
        slice.top,
        width,
        slice.height,
        0,
        0,
        width,
        slice.height,
      );
      const jpegBlob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
      const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
      if (jpegBytes.length === 0) {
        throw new Error('JPEG encoder returned empty buffer.');
      }
      pages.push({ width, height: slice.height, jpegBytes });
    }
    return pages;
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

async function runCloudJobZip(
  job: CloudJob,
  images: RenderedImage[],
  opts: { includeContents: boolean; pageOffset?: number },
): Promise<Uint8Array> {
  const label = job === 'ocr' ? 'OCR' : 'Analyze';
  const enc = new TextEncoder();
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  const sections: Array<{ source: string; text: string }> = [];
  const totalPages = Math.max(state.rendered.length, images.length);
  const pad = String(totalPages).length;
  const offset = opts.pageOffset ?? 0;

  for (let i = 0; i < images.length; i++) {
    const item = images[i];
    if (!item) continue;
    const pageNo = offset + i + 1;
    toast(`${label} page ${pageNo}…`);
    const text = await callCloudJobOnCapture(job, item);
    const meaningful = job === 'analyze' || hasMeaningfulOcr(text);
    if (!meaningful) {
      toast(`Page ${pageNo}: no readable text — skipped for OCR.`);
      continue;
    }
    const stem = `pages/page-${String(pageNo).padStart(pad, '0')}`;
    entries.push({
      name: `${stem}.png`,
      data: new Uint8Array(await item.blob.arrayBuffer()),
    });
    entries.push({
      name: `${stem}.${job}.txt`,
      data: enc.encode(text.trim()),
    });
    sections.push({ source: `${stem}.${job}.txt`, text: text.trim() });
  }

  if (opts.includeContents) {
    await appendContentsEntries(job, entries, sections);
  }

  if (entries.length === 0) {
    throw new Error(
      job === 'ocr'
        ? 'OCR found no readable text in this capture.'
        : `${label} returned no files.`,
    );
  }

  const list = state.fullBundle?.list;
  const combined = formatCombinedFromZip(
    label,
    sections,
    opts.includeContents ? list : undefined,
  );
  const base = state.fullBundle?.baseName ?? state.bundle?.baseName ?? 'capture';
  entries.push({
    name: `${base}.${job}.combined.txt`,
    data: enc.encode(combined),
  });

  toast(`${label}: zipping ${entries.length} files…`);
  return buildZip(entries);
}

function hasMeaningfulOcr(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length < 16) return false;
  const letters = (normalized.match(/\p{L}/gu) ?? []).join('');
  if (letters.length < 12) return false;
  const words = normalized
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
  if (words.length >= 8) return true;
  const unique = new Set(words);
  if (unique.size <= 1 && letters.length < 48) return false;
  return words.length >= 3;
}

async function appendContentsEntries(
  job: CloudJob,
  entries: Array<{ name: string; data: Uint8Array }>,
  sections: Array<{ source: string; text: string }>,
): Promise<void> {
  const list = state.fullBundle?.list;
  if (!list || list.items.length === 0) return;

  const enc = new TextEncoder();
  entries.push({
    name: 'contents/index.txt',
    data: enc.encode(formatContentsIndex(list)),
  });

  const photos: Array<{ path: string; blob: Blob; title: string }> = [];
  const itemPad = String(list.items.length).length;
  for (const item of list.items) {
    const folder = `${String(item.index + 1).padStart(itemPad, '0')}-${sanitizePathPart(item.title)}`;
    for (let i = 0; i < item.images.length; i++) {
      const image = item.images[i];
      if (!image?.dataUrl) continue;
      const blob = blobFromDataUrl(image.dataUrl);
      if (!blob) continue;
      const ext = extensionFromMime(blob.type) || extensionFromUrl(image.url);
      photos.push({
        path: `contents/${folder}/${String(i + 1).padStart(2, '0')}${ext}`,
        blob,
        title: image.alt || item.title,
      });
    }
  }

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    if (!photo) continue;
    toast(`${job === 'ocr' ? 'OCR' : 'Analyze'} photo ${i + 1}/${photos.length}…`);
    const bytes = new Uint8Array(await photo.blob.arrayBuffer());
    let text = '';
    try {
      text = await callCloudJob(job, photo.blob);
    } catch (error) {
      console.warn(`[${job}] contents photo failed`, photo.path, error);
      if (job === 'ocr') continue;
      text = `${job} failed for this photo. The image is still included.`;
    }
    if (job === 'ocr' && !hasMeaningfulOcr(text)) {
      continue;
    }
    entries.push({ name: photo.path, data: bytes });
    const txtName = photo.path.replace(/\.[^.]+$/, `.${job}.txt`);
    entries.push({ name: txtName, data: enc.encode(text.trim()) });
    sections.push({ source: txtName, text: text.trim() });
  }
}

function formatContentsIndex(list: ExtractedList): string {
  const lines: string[] = [`${list.items.length} items in this section`, ''];
  const pad = String(list.items.length).length;
  for (const item of list.items) {
    lines.push(`${String(item.index + 1).padStart(pad, '0')}. ${compactTitle(item.title)}`);
    const detail = item.detail ? compactTitle(item.detail) : '';
    if (detail && detail !== compactTitle(item.title)) lines.push(`   ${detail}`);
    if (item.href && !item.href.startsWith('data:')) lines.push(`   ${item.href}`);
    for (const image of item.images) {
      const ref = publicPhotoRef(image.url);
      if (ref) lines.push(`   photo: ${ref}`);
      else lines.push('   photo: (embedded)');
    }
    lines.push('');
  }
  return lines.join('\n');
}

function publicPhotoRef(url: string): string | undefined {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return undefined;
  return url;
}

function blobFromDataUrl(dataUrl: string): Blob | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: match[1] });
  } catch {
    return undefined;
  }
}

function extensionFromMime(mime: string): string {
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('avif')) return '.avif';
  if (mime.includes('bmp')) return '.bmp';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  return '';
}

function formatCombinedFromZip(
  label: string,
  sections: Array<{ source: string; text: string }>,
  list: ExtractedList | undefined,
): string {
  const parts: string[] = [
    `Voiceido ${label} — combined from this zip.`,
    'This file concatenates the analyses already saved next to each image.',
    'It is not a new essay.',
    '',
  ];
  if (list && list.items.length > 0) {
    parts.push('===== contents/index.txt =====', '', formatContentsIndex(list).trim(), '');
  }
  if (sections.length === 0) {
    parts.push(`(${label} returned empty result)`);
    return parts.join('\n').trim();
  }
  for (const section of sections) {
    parts.push(`===== ${section.source} =====`, '', section.text.trim() || `(empty)`, '');
  }
  return parts.join('\n').trim();
}

async function callCloudJobOnCapture(job: CloudJob, image: RenderedImage): Promise<string> {
  const slices = await sliceCaptureBlobs(image);
  const parts: string[] = [];
  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    if (!slice) continue;
    if (slices.length > 1) {
      toast(`${job === 'ocr' ? 'OCR' : 'Analyze'} band ${i + 1}/${slices.length}…`);
    }
    const text = (await callCloudJob(job, slice)).trim();
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

async function sliceCaptureBlobs(image: RenderedImage): Promise<Blob[]> {
  const url = URL.createObjectURL(image.blob);
  try {
    const img = await loadImage(url);
    const width = img.naturalWidth || image.width;
    const height = img.naturalHeight || image.height;
    const slices = planReadableSlices(width, height);
    if (slices.length <= 1) return [image.blob];
    const out: Blob[] = [];
    for (const slice of slices) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = slice.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable.');
      ctx.drawImage(img, 0, slice.top, width, slice.height, 0, 0, width, slice.height);
      out.push(await canvasToBlob(canvas, 'image/png', 1));
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
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
