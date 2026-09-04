/**
 * Matematyka wirtualizacji listy - bez DOM-u, wiec da sie ja przetestowac.
 *
 * Karty maja stala wysokosc (CSS je przycina), dzieki czemu pozycja kazdego
 * wiersza to zwykle mnozenie i nie musimy mierzyc niczego w ukladzie strony.
 * To jedyny powod, dla ktorego 5000 pozycji renderuje sie plynnie: w DOM-ie
 * siedzi zawsze kilkanascie wezlow, niezaleznie od dlugosci listy.
 */

export interface WindowInput {
  scrollTop: number;
  viewportHeight: number;
  total: number;
  rowHeight: number;
  /** Ile wierszy renderowac ponad ekranem z kazdej strony. */
  overscan: number;
}

export interface WindowRange {
  /** Indeks pierwszego renderowanego wiersza (wlacznie). */
  start: number;
  /** Indeks za ostatnim renderowanym wierszem. */
  end: number;
  /** Przesuniecie kontenera wierszy w pikselach. */
  offsetY: number;
  /** Wysokosc rozpychacza, zeby pasek przewijania byl prawdziwy. */
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
 * Nowy `scrollTop`, przy ktorym wiersz `index` jest w calosci widoczny.
 * `null`, gdy nic nie trzeba przewijac.
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
