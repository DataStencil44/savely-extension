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

/** A `<button type="button">` - never a submit button, since no page has a form. */
export function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}
