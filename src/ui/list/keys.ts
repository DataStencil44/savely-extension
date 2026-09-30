import type { TabId } from './store';

export type PageCommand =
  | { kind: 'focus-search' }
  | { kind: 'toggle-help' }
  | { kind: 'select'; to: 'next' | 'previous' | 'first' | 'last' }
  | { kind: 'tab'; tab: TabId }
  | { kind: 'cycle-theme' };

export type ItemCommand =
  | 'open-reader'
  | 'open-original'
  | 'toggle-archive'
  | 'toggle-favorite'
  | 'edit-tags'
  | 'delete';

export type KeyBinding =
  | { scope: 'page'; command: PageCommand; preventDefault: boolean }
  | { scope: 'item'; command: ItemCommand; preventDefault: boolean };

function page(command: PageCommand, preventDefault = true): KeyBinding {
  return { scope: 'page', command, preventDefault };
}

function item(command: ItemCommand, preventDefault = false): KeyBinding {
  return { scope: 'item', command, preventDefault };
}

const KEYMAP: ReadonlyMap<string, KeyBinding> = new Map([
  ['/', page({ kind: 'focus-search' })],
  ['?', page({ kind: 'toggle-help' })],
  ['ArrowDown', page({ kind: 'select', to: 'next' })],
  ['ArrowUp', page({ kind: 'select', to: 'previous' })],
  ['Home', page({ kind: 'select', to: 'first' })],
  ['End', page({ kind: 'select', to: 'last' })],
  ['1', page({ kind: 'tab', tab: 'inbox' }, false)],
  ['2', page({ kind: 'tab', tab: 'favorite' }, false)],
  ['3', page({ kind: 'tab', tab: 'archive' }, false)],
  ['d', page({ kind: 'cycle-theme' }, false)],
  ['Enter', item('open-reader', true)],
  ['o', item('open-original')],
  ['a', item('toggle-archive')],
  ['f', item('toggle-favorite')],
  ['t', item('edit-tags', true)],
  ['Delete', item('delete', true)],
  ['Backspace', item('delete', true)],
]);

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

export function bindingFor(press: KeyPress): KeyBinding | undefined {
  const { target } = press;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
  if (typing || press.ctrlKey || press.metaKey || press.altKey) return undefined;
  if ((press.key === 'Enter' || press.key === ' ') && target instanceof HTMLButtonElement) {
    return undefined;
  }
  return KEYMAP.get(press.key);
}
