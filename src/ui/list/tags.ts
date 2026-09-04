/**
 * Edytor tagów: mały panel zakotwiczony przy karcie.
 *
 * Panel jest pozycjonowany absolutnie nad listą, a nie wstawiany w kartę -
 * karty muszą mieć stałą wysokość, inaczej wirtualizacja przestaje liczyć
 * pozycje wierszy poprawnie.
 */
import { normalizeTags } from '@/lib/db';

export interface TagEditorOptions {
  host: HTMLElement;
  anchor: HTMLElement;
  tags: readonly string[];
  /** Wszystkie tagi w bazie - źródło podpowiedzi. */
  known: readonly string[];
  apply: (tags: string[]) => void;
  closed?: () => void;
}

let close: (() => void) | undefined;

export function closeTagEditor(): void {
  close?.();
}

export function openTagEditor(options: TagEditorOptions): void {
  closeTagEditor();

  const { host, anchor } = options;
  let current = [...options.tags];

  const chips = document.createElement('div');
  chips.className = 'tag-editor__chips';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-editor__input';
  input.placeholder = 'Dodaj tag i Enter';
  input.setAttribute('aria-label', 'Dodaj tag');
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
      empty.textContent = 'Brak tagów';
      chips.append(empty);
      return;
    }
    for (const tag of current) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip chip--removable';
      chip.textContent = `#${tag} ✕`;
      chip.title = `Usuń tag #${tag}`;
      chip.addEventListener('click', () => {
        commit(current.filter((value) => value !== tag));
      });
      chips.append(chip);
    }
  }

  function renderSuggestions(): void {
    const query = input.value.trim().toLowerCase();
    const matches = options.known
      .filter((tag) => !current.includes(tag) && (query === '' || tag.includes(query)))
      .slice(0, 8);

    suggestions.replaceChildren();
    for (const tag of matches) {
      const suggestion = document.createElement('button');
      suggestion.type = 'button';
      suggestion.className = 'chip';
      suggestion.textContent = `#${tag}`;
      suggestion.addEventListener('click', () => {
        input.value = '';
        commit([...current, tag]);
        input.focus();
      });
      suggestions.append(suggestion);
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
    // Reszta klawiszy zostaje w polu - globalne skróty nie mogą tu działać.
    event.stopPropagation();
  });

  host.replaceChildren(chips, input, suggestions);
  host.hidden = false;
  renderChips();
  renderSuggestions();

  // Zakotwiczenie: pod przyciskiem, ale nigdy poza prawą krawędzią okna.
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(280, document.documentElement.clientWidth - 16);
  host.style.width = `${String(width)}px`;
  host.style.left = `${String(Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 8)))}px`;
  host.style.top = `${String(Math.min(rect.bottom + 4, document.documentElement.clientHeight - 8))}px`;

  input.focus();

  const onOutside = (event: MouseEvent): void => {
    if (!host.contains(event.target as Node)) closeTagEditor();
  };
  // `setTimeout`, bo kliknięcie otwierające panel wciąż się propaguje.
  const handle = setTimeout(() => {
    document.addEventListener('mousedown', onOutside);
  }, 0);

  close = () => {
    clearTimeout(handle);
    document.removeEventListener('mousedown', onOutside);
    host.hidden = true;
    host.replaceChildren();
    close = undefined;
    options.closed?.();
  };
}
