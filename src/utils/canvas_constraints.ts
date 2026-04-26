/**
 * Chrome canvases have a hard maximum dimension (~16384px in modern Chrome
 * for HTMLCanvasElement, but per-image-decoder limits drop the safe area).
 * The original GoFullPage implementation used 30000 × 8000 as a safe pair.
 * We mirror that here and cap the total area as well.
 */

export const MAX_PRIMARY_DIMENSION = 15000 * 2; // 30000
export const MAX_SECONDARY_DIMENSION = 4000 * 2; // 8000
export const MAX_AREA = MAX_PRIMARY_DIMENSION * MAX_SECONDARY_DIMENSION;

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
