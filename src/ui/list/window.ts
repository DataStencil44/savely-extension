/**
 * The maths of list virtualization - no DOM, so it can be tested.
 *
 * Cards have a fixed height (the CSS clips them), which makes every row's
 * position plain multiplication and means we never measure anything in the
 * page layout. That is the only reason 5000 items render smoothly: the DOM
 * always holds a dozen or so nodes, whatever the length of the list.
 */

export interface WindowInput {
  scrollTop: number;
  viewportHeight: number;
  total: number;
  rowHeight: number;
  /** How many rows to render beyond the viewport on each side. */
  overscan: number;
}

export interface WindowRange {
  /** The index of the first rendered row (inclusive). */
  start: number;
  /** The index just past the last rendered row. */
  end: number;
  /** The row container's offset in pixels. */
  offsetY: number;
  /** The spacer's height, so the scrollbar tells the truth. */
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

/**
 * The new `scrollTop` at which row `index` is fully visible.
 * `null` when no scrolling is needed.
 */
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
