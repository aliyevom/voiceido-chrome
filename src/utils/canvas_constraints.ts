/**
 * Chrome canvases have a hard maximum dimension (~16384px in modern Chrome
 * for HTMLCanvasElement, but per-image-decoder limits drop the safe area).
 * The original GoFullPage implementation used 30000 × 8000 as a safe pair.
 * We mirror that here and cap the total area as well.
 */

export const MAX_PRIMARY_DIMENSION = 15000 * 2; // 30000
export const MAX_SECONDARY_DIMENSION = 4000 * 2; // 8000
export const MAX_AREA = MAX_PRIMARY_DIMENSION * MAX_SECONDARY_DIMENSION;

/**
 * Target page height as a multiple of width (~4:3 screenshot). A 1703×30000
 * stitch displayed "fit to window" becomes ~58px wide; slicing to this height
 * keeps PNG/PDF/OCR at full capture width.
 */
const READABLE_HEIGHT_RATIO = 4 / 3;
const MIN_READABLE_PAGE_HEIGHT = 1600;

export function readablePageHeight(width: number): number {
  const w = Math.max(1, Math.round(width));
  return Math.max(MIN_READABLE_PAGE_HEIGHT, Math.round(w * READABLE_HEIGHT_RATIO));
}

export function planReadableSlices(
  width: number,
  height: number,
): Array<{ top: number; height: number }> {
  const pageH = readablePageHeight(width);
  if (height <= Math.round(pageH * 1.15)) {
    return [{ top: 0, height }];
  }
  const count = Math.max(1, Math.ceil(height / pageH));
  const sliceH = Math.ceil(height / count);
  const slices: Array<{ top: number; height: number }> = [];
  let top = 0;
  while (top < height) {
    const h = Math.min(sliceH, height - top);
    slices.push({ top, height: h });
    top += h;
  }
  return slices;
}

export interface CanvasTilePlan {
  index: number;
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Decide how many canvases (and their geometry) we need to tile a screenshot
 * of `totalWidth × totalHeight`. Returns one entry per canvas in row-major
 * order. The shape mirrors GoFullPage's algorithm but is expressed as pure
 * data so it can be reused in tests.
 */
export function planCanvases(totalWidth: number, totalHeight: number): CanvasTilePlan[] {
  const tooBig =
    totalHeight > MAX_PRIMARY_DIMENSION ||
    totalWidth > MAX_PRIMARY_DIMENSION ||
    totalHeight * totalWidth > MAX_AREA;

  const widerThanTall = totalWidth > totalHeight;
  const maxWidth = !tooBig
    ? totalWidth
    : widerThanTall
      ? MAX_PRIMARY_DIMENSION
      : MAX_SECONDARY_DIMENSION;
  const maxHeight = !tooBig
    ? totalHeight
    : widerThanTall
      ? MAX_SECONDARY_DIMENSION
      : MAX_PRIMARY_DIMENSION;

  const numCols = Math.max(1, Math.ceil(totalWidth / maxWidth));
  const numRows = Math.max(1, Math.ceil(totalHeight / maxHeight));
  const plans: CanvasTilePlan[] = [];

  let index = 0;
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const isLastCol = col === numCols - 1;
      const isLastRow = row === numRows - 1;
      const width = isLastCol ? totalWidth - col * maxWidth || maxWidth : maxWidth;
      const height = isLastRow ? totalHeight - row * maxHeight || maxHeight : maxHeight;
      const left = col * maxWidth;
      const top = row * maxHeight;
      plans.push({
        index: index++,
        width,
        height,
        left,
        top,
        right: left + width,
        bottom: top + height,
      });
    }
  }

  return plans;
}
