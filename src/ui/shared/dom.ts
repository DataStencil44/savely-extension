/**
 * The two lines every page was writing by hand.
 *
 * UI is built element by element (`createElement` + `textContent`) rather than
 * from HTML strings - that is what keeps the innerHTML rule of CLAUDE.md 3
 * cheap to obey. `element` is that pattern with the noise removed; it exists
 * so the alternative never looks tempting.
 */

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

/** A `<button type="button">` - the default `submit` is never what a page here means. */
export function button(
  className: string,
  label: string,
  onClick: (event: MouseEvent) => void,
): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/**
 * An element the page's own markup guarantees.
 *
 * Each page queries a fixed set of ids out of HTML that ships beside it, and
 * then checked every one of them for null at every use - a hundred and fifty
 * branches that could not be taken, and which hid the handful of `?.` that
 * stand for something that really can be absent. A missing id is a broken
 * build, not a state to render around: it fails here, once, naming what is
 * missing, rather than turning into a page where three buttons quietly do
 * nothing.
 */
export function required<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error(`[savely] the page has no ${selector}`);
  return node;
}
