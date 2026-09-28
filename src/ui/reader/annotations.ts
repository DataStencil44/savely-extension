/**
 * Highlights and notes: everything between a selection in the article and a
 * row in the database.
 *
 * This was a third of `reader.ts`, sharing module variables with the settings,
 * the scroll progress and the header - four subjects with one set of globals
 * between them, where the only thing they truly share is the article element.
 * Kept together it is a small machine with one job: the popover it puts on
 * screen, the marks it paints into the content, and the highlights it holds
 * are the same subject, and nothing outside needs any of them.
 *
 * The page keeps the anchoring maths at arm's length (`highlight.ts`, pure and
 * tested) and the database at the other; what lives here is the part that has
 * to touch a live document.
 */
import {
  addHighlight,
  deleteHighlight,
  listHighlights,
  updateHighlight,
  type Highlight,
} from '@/lib/library';

import {
  buildTextMap,
  locate,
  makeAnchor,
  offsetsFromRange,
  unwrapHighlight,
  wrapRange,
  type Anchor,
} from './highlight';

export interface AnnotationsHost {
  /** The rendered article - what gets marked, and what a selection must be inside. */
  article: HTMLElement;
  /** The floating bar of actions over a selection or a mark. */
  popover: HTMLDivElement;
  /** How this tells the reader something happened. */
  notify: (message: string) => void;
}

/** Database record -> anchor for the highlight module (where the quote is called `quote`). */
function anchorOf(highlight: Highlight): Anchor {
  return {
    start: highlight.start,
    end: highlight.end,
    quote: highlight.text,
    prefix: highlight.prefix,
    suffix: highlight.suffix,
  };
}

function popoverButton(label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'popover__action';
  button.textContent = label;
  button.addEventListener('mousedown', (event) => {
    // `mousedown`, because clicking the button clears the selection before `click`.
    event.preventDefault();
    run();
  });
  return button;
}

export class Annotations {
  readonly #article: HTMLElement;
  readonly #popover: HTMLDivElement;
  readonly #notify: (message: string) => void;

  #highlights: Highlight[] = [];
  /** The item on screen. Nothing can be highlighted before it is known. */
  #itemId: string | null = null;

  constructor(host: AnnotationsHost) {
    this.#article = host.article;
    this.#popover = host.popover;
    this.#notify = host.notify;
  }

  /** Paints what was stored for this item onto the content just rendered. */
  async load(itemId: string): Promise<void> {
    this.#itemId = itemId;
    this.#highlights = await listHighlights(itemId);

    const lost = this.#highlights.filter((highlight) => !this.#paint(highlight)).length;
    if (lost > 0) {
      this.#notify(`Could not restore ${String(lost)} highlight(s) - the content has changed.`);
    }
  }

  /**
   * Re-reads the highlights after a change elsewhere - a sync, or this article
   * open in another tab - and repaints the marks. Quiet about any that no
   * longer anchor: `load` already said so once.
   */
  async reload(): Promise<void> {
    if (this.#itemId === null) return;
    const next = await listHighlights(this.#itemId);

    for (const highlight of this.#highlights) unwrapHighlight(this.#article, highlight.id);
    this.#highlights = next;
    for (const highlight of next) this.#paint(highlight);
  }

  /** Whether the popover is on screen - Escape and the `h` shortcut both ask. */
  get isOpen(): boolean {
    return !this.#popover.hidden;
  }

  /** True for a press inside the popover, which must not close it. */
  contains(node: Node): boolean {
    return this.#popover.contains(node);
  }

  hide(): void {
    this.#popover.hidden = true;
    this.#popover.replaceChildren();
  }

  /** A selection in the article offers to highlight, copy or annotate it. */
  onSelectionChange(): void {
    const selection = window.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (!this.#article.contains(range.commonAncestorContainer)) return;

    const text = selection.toString().trim();
    if (text === '') return;

    this.#show(range.getBoundingClientRect(), [
      popoverButton('Highlight', () => {
        void this.#create(range.cloneRange(), false);
      }),
      popoverButton('Copy', () => {
        void this.#copy(text);
        this.hide();
      }),
      popoverButton('Note', () => {
        void this.#create(range.cloneRange(), true);
      }),
    ]);
  }

  /** A press on an existing mark offers the other half: note, copy, remove. */
  onArticleClick(event: MouseEvent): void {
    const mark = (event.target as Element | null)?.closest<HTMLElement>('mark[data-highlight]');
    if (mark === null || mark === undefined) return;

    const id = mark.dataset['highlight'];
    const highlight = this.#highlights.find((entry) => entry.id === id);
    if (highlight === undefined) return;

    event.preventDefault();
    this.#show(mark.getBoundingClientRect(), [
      popoverButton('Note', () => {
        this.#show(mark.getBoundingClientRect(), [this.#noteEditor(highlight)]);
      }),
      popoverButton('Copy', () => {
        void this.#copy(highlight.text);
        this.hide();
      }),
      popoverButton('Delete', () => {
        void deleteHighlight(highlight.id).then(() => {
          this.#highlights = this.#highlights.filter((entry) => entry.id !== highlight.id);
          unwrapHighlight(this.#article, highlight.id);
          this.hide();
          this.#notify('Highlight removed.');
        });
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // The popover
  // -------------------------------------------------------------------------

  #show(rect: DOMRect, children: readonly HTMLElement[]): void {
    this.#popover.replaceChildren(...children);
    this.#popover.hidden = false;

    const width = this.#popover.offsetWidth;
    const left = Math.min(
      Math.max(8, rect.left + rect.width / 2 - width / 2),
      document.documentElement.clientWidth - width - 8,
    );
    const above = rect.top - this.#popover.offsetHeight - 8;
    this.#popover.style.left = `${String(left)}px`;
    this.#popover.style.top = `${String(above > 8 ? above : rect.bottom + 8)}px`;
  }

  async #copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.#notify('Copied.');
    } catch {
      this.#notify('The browser refused to copy.');
    }
  }

  #noteEditor(highlight: Highlight): HTMLElement {
    const form = document.createElement('form');
    form.className = 'popover__note';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'popover__input';
    input.placeholder = 'Note';
    input.value = highlight.note ?? '';
    input.setAttribute('aria-label', 'Note for the selection');

    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'popover__action';
    save.textContent = 'Save';

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const note = input.value.trim() === '' ? null : input.value.trim();
      void updateHighlight(highlight.id, { note }).then((updated) => {
        this.#highlights = this.#highlights.map((entry) =>
          entry.id === updated.id ? updated : entry,
        );
        this.#retitle(updated.id, note);
        this.hide();
        this.#notify(note === null ? 'Note removed.' : 'Note saved.');
      });
    });

    form.append(input, save);
    setTimeout(() => {
      input.focus();
    }, 0);
    return form;
  }

  // -------------------------------------------------------------------------
  // The marks
  // -------------------------------------------------------------------------

  /** Repaints one highlight in the content. `false` when the quote is gone. */
  #paint(highlight: Highlight): boolean {
    const map = buildTextMap(this.#article);
    const found = locate(map.text, anchorOf(highlight));
    if (found === null) return false;

    const marks = wrapRange(map, found, highlight.id);
    const note = highlight.note !== null && highlight.note !== '' ? highlight.note : null;
    for (const mark of marks) {
      if (note !== null) mark.title = note;
      mark.classList.toggle('hl--noted', note !== null);
    }
    return marks.length > 0;
  }

  /** A note applies to every mark the highlight was split into. */
  #retitle(id: string, note: string | null): void {
    for (const mark of this.#article.querySelectorAll<HTMLElement>(
      `mark[data-highlight="${id}"]`,
    )) {
      mark.title = note ?? '';
      mark.classList.toggle('hl--noted', note !== null);
    }
  }

  async #create(range: Range, withNote: boolean): Promise<void> {
    if (this.#itemId === null) return;

    const map = buildTextMap(this.#article);
    const offsets = offsetsFromRange(map, range);
    if (offsets === null) {
      this.#notify('This selection cannot be anchored.');
      return;
    }

    const anchor = makeAnchor(map, offsets);
    const highlight = await addHighlight({
      itemId: this.#itemId,
      text: anchor.quote,
      start: anchor.start,
      end: anchor.end,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    });

    this.#highlights = [...this.#highlights, highlight];
    window.getSelection()?.removeAllRanges();
    this.#paint(highlight);

    if (!withNote) {
      this.hide();
      this.#notify('Highlighted.');
      return;
    }

    const mark = this.#article.querySelector<HTMLElement>(
      `mark[data-highlight="${highlight.id}"]`,
    );
    if (mark === null) {
      this.hide();
      return;
    }
    this.#show(mark.getBoundingClientRect(), [this.#noteEditor(highlight)]);
  }
}
