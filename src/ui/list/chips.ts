/**
 * A tag, as something you can press.
 *
 * The same chip appears in four places on this page - on a card, in the row of
 * active filters, and twice in the tag editor - and it was written out four
 * times, each spelling `#${tag}` and the `✕` for itself. They had not drifted
 * yet, but the next chip would have had to be written a fifth time to match.
 *
 * What differs between them is only what a press means and what the title says,
 * which is what this takes as arguments.
 */
import { button, element } from '@/ui/shared/dom';

export interface ChipOptions {
  /** The tooltip - the one part that has to say what pressing it will do. */
  title: string;
  onClick: (event: MouseEvent) => void;
  /** Adds the `✕`: the chip stands for something the press takes away. */
  removable?: boolean;
}

export function tagChip(tag: string, options: ChipOptions): HTMLButtonElement {
  const removable = options.removable === true;
  const chip = button(
    removable ? 'chip chip--removable' : 'chip',
    removable ? `#${tag} ✕` : `#${tag}`,
    options.onClick,
  );
  chip.title = options.title;
  return chip;
}

/** The tags that did not fit, as a count. Not a button - there is nothing to press. */
export function moreChip(count: number): HTMLSpanElement {
  return element('span', 'chip chip--muted', `+${String(count)}`);
}
