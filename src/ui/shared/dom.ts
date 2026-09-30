
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

export function required<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error(`[savely] the page has no ${selector}`);
  return node;
}
