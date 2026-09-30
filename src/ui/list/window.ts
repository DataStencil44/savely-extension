export interface WindowInput {
  scrollTop: number;
  viewportHeight: number;
  total: number;
  rowHeight: number;
  overscan: number;
}

export interface WindowRange {
  start: number;
  end: number;
  offsetY: number;
  totalHeight: number;
}

export function computeWindow(input: WindowInput): WindowRange {
  const { scrollTop, viewportHeight, total, rowHeight, overscan } = input;
  const totalHeight = total * rowHeight;

  if (total === 0 || rowHeight <= 0) {
    return { start: 0, end: 0, offsetY: 0, totalHeight: Math.max(0, totalHeight) };
  }

  const clampedTop = Math.min(Math.max(scrollTop, 0), Math.max(0, totalHeight - viewportHeight));
  const firstVisible = Math.floor(clampedTop / rowHeight);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 1;

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(total, firstVisible + visibleCount + overscan);

  return { start, end, offsetY: start * rowHeight, totalHeight };
}

export function scrollTopFor(
  index: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
): number | null {
  const top = index * rowHeight;
  const bottom = top + rowHeight;

  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight;
  return null;
}
