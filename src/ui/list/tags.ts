import { normalizeTags } from '@/lib/url';

import { tagChip } from './chips';

export interface TagEditorOptions {
  host: HTMLElement;
  anchor: HTMLElement;
  key: string;
  tags: readonly string[];
  known: readonly string[];
  apply: (tags: string[]) => void;
  closed?: () => void;
}

let close: (() => void) | undefined;
let openKey: string | undefined;

export function closeTagEditor(): void {
  close?.();
}

export function openTagEditor(options: TagEditorOptions): void {
  if (close !== undefined && openKey === options.key) {
    closeTagEditor();
    return;
  }
  closeTagEditor();

  const { host, anchor, key } = options;
  openKey = key;
  let current = [...options.tags];

  const chips = document.createElement('div');
  chips.className = 'tag-editor__chips';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-editor__input';
  input.placeholder = 'Add a tag and press Enter';
  input.setAttribute('aria-label', 'Add a tag');
  input.autocomplete = 'off';

  const suggestions = document.createElement('div');
  suggestions.className = 'tag-editor__suggestions';

  function commit(next: string[]): void {
    current = normalizeTags(next);
    options.apply(current);
    renderChips();
    renderSuggestions();
  }

  function renderChips(): void {
    chips.replaceChildren();
    if (current.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tag-editor__empty';
      empty.textContent = 'No tags';
      chips.append(empty);
      return;
    }
    for (const tag of current) {
      chips.append(
        tagChip(tag, {
          title: `Remove the #${tag} tag`,
          removable: true,
          onClick: () => {
            commit(current.filter((value) => value !== tag));
          },
        }),
      );
    }
  }

  function renderSuggestions(): void {
    const query = input.value.trim().toLowerCase();
    const matches = options.known
      .filter((tag) => !current.includes(tag) && (query === '' || tag.includes(query)))
      .slice(0, 8);

    suggestions.replaceChildren();
    for (const tag of matches) {
      suggestions.append(
        tagChip(tag, {
          title: `Add the #${tag} tag`,
          onClick: () => {
            input.value = '';
            commit([...current, tag]);
            input.focus();
          },
        }),
      );
    }
  }

  input.addEventListener('input', renderSuggestions);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = input.value.trim();
      if (value === '') return;
      input.value = '';
      commit([...current, value]);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeTagEditor();
    }
    event.stopPropagation();
  });

  host.replaceChildren(chips, input, suggestions);
  host.hidden = false;
  renderChips();
  renderSuggestions();

  const rect = anchor.getBoundingClientRect();
  const width = Math.min(280, document.documentElement.clientWidth - 16);
  host.style.width = `${String(width)}px`;
  host.style.left = `${String(Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 8)))}px`;
  host.style.top = `${String(Math.min(rect.bottom + 4, document.documentElement.clientHeight - 8))}px`;

  input.focus();

  const onOutside = (event: MouseEvent): void => {
    const target = event.target as Node;
    if (host.contains(target)) return;
    const button = target instanceof Element ? target.closest('[data-tags-for]') : null;
    if (button?.getAttribute('data-tags-for') === key) return;
    closeTagEditor();
  };
  const handle = setTimeout(() => {
    document.addEventListener('mousedown', onOutside);
  }, 0);

  close = () => {
    clearTimeout(handle);
    document.removeEventListener('mousedown', onOutside);
    host.hidden = true;
    host.replaceChildren();
    close = undefined;
    openKey = undefined;
    options.closed?.();
  };
}
