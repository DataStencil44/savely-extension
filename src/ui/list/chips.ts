import { button, element } from '@/ui/shared/dom';

export interface ChipOptions {
  title: string;
  onClick: (event: MouseEvent) => void;
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

export function moreChip(count: number): HTMLSpanElement {
  return element('span', 'chip chip--muted', `+${String(count)}`);
}
