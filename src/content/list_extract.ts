/**
 * Structured list + photo extraction for inner-section capture.
 *
 * Google Maps-style result panes (and similar feeds) render a *list* whose
 * photos are tiny thumbnails in the screenshot. We walk the selected
 * container (including open/closed shadow roots), group repeating cards,
 * and resolve the largest image URL we can find. Blob URLs (Teams media)
 * are inlined as data URLs so the preview page can display them.
 * We do not click cards — that navigates Maps / SPAs and would abort capture.
 */

import type {
  ExtractedList,
  ExtractedListImage,
  ExtractedListItem,
} from '../utils/messages';

export type { ExtractedList, ExtractedListItem };

const MIN_PHOTO_PX = 40;
const ICON_HINT = /sprite|emoji|pixel|tracking|1x1/i;
const IMAGE_EXT = /\.(avif|bmp|gif|jpe?g|png|webp)(\?|#|$)/i;
const SVG_DATA = /^data:image\/svg/i;
const RASTER_DATA = /^data:image\/(png|jpe?g|gif|webp|bmp|avif)/i;
const GOOGLE_SIZE = /=(s|w)\d+(-h\d+)?(-[a-z0-9-]+)*/i;
const ITEM_ROOT_SEL = [
  '[role="listitem"]',
  '[role="article"]',
  'article',
  'li',
  '[data-tid="chat-pane-item"]',
  '[data-tid="chat-pane-message"]',
  '[data-tid*="message"]',
  '[class*="fui-ChatItem"]',
  '[class*="ui-chat__item"]',
  '[data-tid="media-card"]',
  '[data-tid="message-body"]',
].join(', ');

export function mergeExtractedList(
  bag: Map<string, ExtractedListItem>,
  container: HTMLElement,
): void {
  for (const item of extractListItems(container)) {
    const key = itemKey(item);
    if (!key) continue;
    const existing = bag.get(key);
    if (!existing) {
      bag.set(key, item);
      continue;
    }
    mergeItem(existing, item);
  }
}

export function freezeExtractedList(bag: Map<string, ExtractedListItem>): ExtractedList {
  const items = [...bag.values()].map((item, index) => ({ ...item, index }));
  return { items };
}

/** Fetch photo bytes in page context (cookies / referrer / blob: URLs) so
 *  the preview zip and Contents rail can embed them. */
export async function inlineExtractedPhotos(list: ExtractedList): Promise<void> {
  const MAX_TOTAL = 40 * 1024 * 1024;
  const MAX_ONE = 12 * 1024 * 1024;
  let used = 0;
  const cache = new Map<string, string>();

  for (const item of list.items) {
    for (const image of item.images) {
      if (image.dataUrl) continue;
      const cached = cache.get(image.url);
      if (cached) {
        image.dataUrl = cached;
        continue;
      }
      if (used >= MAX_TOTAL) continue;
      const dataUrl = await fetchPhotoDataUrl(image.url, Math.min(MAX_ONE, MAX_TOTAL - used));
      if (!dataUrl) continue;
      const approx = Math.ceil((dataUrl.length * 3) / 4);
      used += approx;
      cache.set(image.url, dataUrl);
      image.dataUrl = dataUrl;
    }
  }
}

async function fetchPhotoDataUrl(url: string, maxBytes: number): Promise<string | undefined> {
  if (RASTER_DATA.test(url)) return url;
  if (!isFetchablePhotoUrl(url)) return undefined;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    if (blob.size < 64 || blob.size > maxBytes) return undefined;
    if (blob.type && (!blob.type.startsWith('image/') || blob.type.includes('svg'))) {
      return undefined;
    }
    return await blobToDataUrl(blob);
  } catch {
    return undefined;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('readAsDataURL failed'));
    reader.readAsDataURL(blob);
  });
}

function extractListItems(container: HTMLElement): ExtractedListItem[] {
  const bag = new Map<string, ExtractedListItem>();
  const add = (item: ExtractedListItem): void => {
    if (!isUsefulItem(item)) return;
    const key = itemKey(item);
    if (!key) return;
    const existing = bag.get(key);
    if (!existing) {
      bag.set(key, item);
      return;
    }
    mergeItem(existing, item);
  };

  for (const root of findItemRoots(container)) {
    add(readItem(root));
  }
  for (const image of collectImages(container)) {
    add({
      index: 0,
      title: image.alt || nearbyCaption(container, image.url) || 'Image',
      detail: '',
      images: [image],
    });
  }
  for (const link of collectContentLinks(container)) {
    add(link);
  }
  return [...bag.values()];
}

function itemKey(item: ExtractedListItem): string {
  if (item.href) return `href:${item.href}`;
  if (item.images[0]?.url) return `img:${item.images[0].url}`;
  return item.title.trim();
}

function mergeItem(existing: ExtractedListItem, incoming: ExtractedListItem): void {
  for (const image of incoming.images) {
    if (!existing.images.some((candidate) => candidate.url === image.url)) {
      existing.images.push(image);
    }
  }
  if (incoming.detail.length > existing.detail.length) existing.detail = incoming.detail;
  if (!existing.href && incoming.href) existing.href = incoming.href;
  if (incoming.title.length > existing.title.length && existing.title.length < 8) {
    existing.title = incoming.title;
  }
}

function isUsefulItem(item: ExtractedListItem): boolean {
  if (item.images.length > 0) return true;
  return Boolean(item.href && isContentHref(item.href));
}

function findItemRoots(container: HTMLElement): HTMLElement[] {
  const area = container.clientWidth * container.clientHeight || 1;
  const semantic = uniqueTop(
    deepQueryAll<HTMLElement>(container, ITEM_ROOT_SEL).filter((el) => {
      if (el === container || el.closest('#__voiceido-picker-root')) return false;
      const elArea = el.clientWidth * el.clientHeight;
      return elArea === 0 || elArea < area * 0.9;
    }),
  );
  if (semantic.length >= 2) return semantic;

  const kids = [...container.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
  const cardish = kids.filter(looksLikeCard);
  if (cardish.length >= 2) return cardish;

  for (const kid of kids) {
    const grand = [...kid.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
    const nested = grand.filter(looksLikeCard);
    if (nested.length >= 2) return nested;
  }
  return semantic;
}

function uniqueTop(elements: HTMLElement[]): HTMLElement[] {
  return elements.filter((el) => !elements.some((other) => other !== el && other.contains(el)));
}

function looksLikeCard(el: HTMLElement): boolean {
  if (el.id === '__voiceido-picker-root') return false;
  const hasMedia = deepQueryAll(el, 'img, picture, a[href]').length > 0;
  const text = (el.innerText ?? '').replace(/\s+/g, ' ').trim();
  return hasMedia && text.length >= 4;
}

function readItem(root: HTMLElement): ExtractedListItem {
  const text = (root.innerText ?? '').replace(/\s+/g, ' ').trim();
  const heading =
    deepQueryAll(root, 'h1, h2, h3, h4, [role="heading"]')[0]?.textContent?.trim() ??
    root.getAttribute('aria-label')?.trim() ??
    '';
  const title = (heading || firstSentence(text)).slice(0, 160);
  const detail = stripTitle(text, title).slice(0, 320);
  const href = firstHttpHref(root);
  const item: ExtractedListItem = {
    index: 0,
    title: title || (href ? hostLabel(href) : 'Untitled'),
    detail,
    images: collectImages(root),
  };
  if (href) item.href = href;
  return item;
}

function firstSentence(text: string): string {
  const line = text.split(/[\n•|]/)[0]?.trim() ?? text;
  return line.slice(0, 120);
}

function stripTitle(text: string, title: string): string {
  if (!title) return text;
  return text.startsWith(title) ? text.slice(title.length).trim() : text;
}

function collectContentLinks(root: HTMLElement): ExtractedListItem[] {
  const items: ExtractedListItem[] = [];
  const seen = new Set<string>();
  for (const link of deepQueryAll<HTMLAnchorElement>(root, 'a[href]')) {
    if (link.closest('button') || link.closest('#__voiceido-picker-root')) continue;
    const href = absoluteHttp(link.href);
    if (!href || !isContentHref(href) || seen.has(href)) continue;
    seen.add(href);
    const title =
      (link.getAttribute('aria-label') || link.innerText || link.title || hostLabel(href))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160) || hostLabel(href);
    items.push({
      index: 0,
      title,
      detail: href,
      href,
      images: collectImages(link),
    });
  }
  return items;
}

function firstHttpHref(root: HTMLElement): string | undefined {
  for (const link of deepQueryAll<HTMLAnchorElement>(root, 'a[href]')) {
    if (link.closest('button')) continue;
    const href = absoluteHttp(link.href);
    if (href && isContentHref(href)) return href;
  }
  return undefined;
}

function absoluteHttp(raw: string): string | undefined {
  if (!raw || raw.startsWith('javascript:') || raw.startsWith('mailto:')) return undefined;
  try {
    const url = new URL(raw, location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    return undefined;
  }
  return undefined;
}

function isContentHref(href: string): boolean {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (/accounts\.google|login\.microsoftonline|about:blank/i.test(url.href)) return false;
    if (/(^|\.)teams\.microsoft\.com$/i.test(url.hostname)) {
      return IMAGE_EXT.test(url.pathname);
    }
    if (url.origin === location.origin) {
      return IMAGE_EXT.test(url.pathname);
    }
    return true;
  } catch {
    return false;
  }
}

function hostLabel(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href.slice(0, 80);
  }
}

function collectImages(root: HTMLElement): ExtractedListImage[] {
  const found: ExtractedListImage[] = [];
  const seen = new Set<string>();

  const push = (rawUrl: string, alt: string, width: number, height: number): void => {
    const url = upgradeImageUrl(absolutize(rawUrl));
    if (!url || seen.has(url) || !isUsablePhotoUrl(url)) return;
    if (!url.startsWith('blob:') && !url.startsWith('data:') && ICON_HINT.test(url)) return;
    seen.add(url);
    found.push({ url, alt: alt.slice(0, 160), width, height });
  };

  for (const img of deepQueryAll<HTMLImageElement>(root, 'img')) {
    if (!isPhotoSized(img.naturalWidth || img.width, img.naturalHeight || img.height, img)) {
      continue;
    }
    const url = bestImgUrl(img);
    if (url) push(url, img.alt || img.title || '', img.naturalWidth || img.width, img.naturalHeight || img.height);
  }

  for (const source of deepQueryAll<HTMLSourceElement>(root, 'source[srcset]')) {
    const url = largestSrcset(source.getAttribute('srcset') ?? '');
    if (url) push(url, '', 0, 0);
  }

  for (const el of deepQueryAll<HTMLElement>(root, '*')) {
    const full =
      el.getAttribute('data-full-src') ||
      el.getAttribute('data-full') ||
      el.getAttribute('data-zoom-src') ||
      el.getAttribute('data-large-src') ||
      el.getAttribute('data-original') ||
      el.getAttribute('data-src');
    if (full && (IMAGE_EXT.test(full) || full.startsWith('blob:') || full.startsWith('http'))) {
      push(full, '', 0, 0);
    }

    const bg = backgroundImageUrl(el);
    if (bg) push(bg, '', el.clientWidth, el.clientHeight);

    if (el instanceof HTMLAnchorElement) {
      const href = el.href;
      if (IMAGE_EXT.test(href) || /\.(avif|bmp|gif|jpe?g|png|webp)(\?|#|$)/i.test(href)) {
        push(href, el.textContent?.trim() ?? '', 0, 0);
      }
    }
  }

  return found;
}

function isFetchablePhotoUrl(url: string): boolean {
  return (
    url.startsWith('blob:') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    RASTER_DATA.test(url)
  );
}

function isUsablePhotoUrl(url: string): boolean {
  if (SVG_DATA.test(url) || /\.svg(\?|#|$)/i.test(url)) return false;
  if (url.startsWith('blob:')) return true;
  if (url.startsWith('data:')) return RASTER_DATA.test(url);
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'blob:';
  } catch {
    return false;
  }
}

function nearbyCaption(container: HTMLElement, url: string): string {
  const img = deepQueryAll<HTMLImageElement>(container, 'img').find((node) => {
    const src = node.currentSrc || node.src;
    return src === url || upgradeImageUrl(absolutize(src)) === url;
  });
  const host = img?.closest(
    '[role="listitem"], [role="article"], article, li, [data-tid*="message"], a[href]',
  );
  const text = (host instanceof HTMLElement ? host.innerText : img?.alt) ?? '';
  return firstSentence(text.replace(/\s+/g, ' ').trim()).slice(0, 120);
}

function isPhotoSized(naturalW: number, naturalH: number, img: HTMLImageElement): boolean {
  const w = Math.max(naturalW, img.clientWidth);
  const h = Math.max(naturalH, img.clientHeight);
  if (w > 0 && w < MIN_PHOTO_PX && h > 0 && h < MIN_PHOTO_PX) return false;
  if (ICON_HINT.test(img.className) || ICON_HINT.test(img.alt)) return false;
  return true;
}

function bestImgUrl(img: HTMLImageElement): string {
  const attrFull =
    img.getAttribute('data-full-src') ||
    img.getAttribute('data-zoom-src') ||
    img.getAttribute('data-large-src') ||
    img.getAttribute('data-original');
  if (attrFull) return attrFull;
  const srcset = img.currentSrc || largestSrcset(img.getAttribute('srcset') ?? '') || img.src;
  const parent = img.closest('a[href]');
  if (parent instanceof HTMLAnchorElement && IMAGE_EXT.test(parent.href)) {
    return parent.href;
  }
  return srcset;
}

function largestSrcset(srcset: string): string {
  if (!srcset.trim()) return '';
  let bestUrl = '';
  let bestScore = -1;
  for (const part of srcset.split(',')) {
    const bits = part.trim().split(/\s+/);
    const url = bits[0];
    if (!url) continue;
    const desc = bits[1] ?? '1x';
    const score = desc.endsWith('w')
      ? Number.parseInt(desc, 10)
      : desc.endsWith('x')
        ? Number.parseFloat(desc) * 1000
        : 1;
    if (score > bestScore) {
      bestScore = score;
      bestUrl = url;
    }
  }
  return bestUrl;
}

function backgroundImageUrl(el: HTMLElement): string | undefined {
  const bg = window.getComputedStyle(el).backgroundImage;
  const match = /url\((['"]?)([^)'"]+)\1\)/i.exec(bg);
  const raw = match?.[2];
  if (!raw || raw === 'none') return undefined;
  return raw;
}

function absolutize(raw: string): string {
  try {
    return new URL(raw, location.href).href;
  } catch {
    return '';
  }
}

function deepQueryAll<T extends Element>(root: ParentNode, selector: string): T[] {
  const seen = new Set<T>();
  const visit = (node: ParentNode): void => {
    if (node instanceof Element) {
      try {
        if (node.matches(selector)) seen.add(node as T);
      } catch {
        /* invalid selector on this node */
      }
    }
    let children: NodeListOf<Element>;
    try {
      children = node.querySelectorAll('*');
    } catch {
      return;
    }
    for (const el of children) {
      try {
        if (el.matches(selector)) seen.add(el as T);
      } catch {
        /* ignore */
      }
      const shadow = pierceShadow(el);
      if (shadow) visit(shadow);
    }
  };
  visit(root);
  return [...seen];
}

function pierceShadow(el: Element): ShadowRoot | null {
  try {
    const chromeDom = (
      chrome as typeof chrome & {
        dom?: { openOrClosedShadowRoot?: (element: Element) => ShadowRoot | null };
      }
    ).dom;
    if (typeof chromeDom?.openOrClosedShadowRoot === 'function') {
      return chromeDom.openOrClosedShadowRoot(el) ?? el.shadowRoot;
    }
  } catch {
    /* not available */
  }
  return el.shadowRoot;
}

/**
 * Maps / Google user content thumbnails encode size as `=w80-h80-k-no`.
 * Bumping to s1600 usually returns the underlying photo.
 */
export function upgradeImageUrl(url: string): string {
  if (!url) return '';
  if (GOOGLE_SIZE.test(url) && /googleusercontent\.com|ggpht\.com|google\.com/i.test(url)) {
    return url.replace(GOOGLE_SIZE, '=s1600-k-no');
  }
  return url.replace(/\/s\d+\//, '/s1600/');
}
