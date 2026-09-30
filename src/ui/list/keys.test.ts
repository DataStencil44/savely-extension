// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { bindingFor, type KeyPress } from './keys';

function press(key: string, overrides: Partial<KeyPress> = {}): KeyPress {
  return { key, ctrlKey: false, metaKey: false, altKey: false, target: document.body, ...overrides };
}

describe('bindingFor', () => {
  it('maps the page keys whether or not anything is selected', () => {
    expect(bindingFor(press('/'))).toEqual({
      scope: 'page',
      command: { kind: 'focus-search' },
      preventDefault: true,
    });
    expect(bindingFor(press('2'))?.command).toEqual({ kind: 'tab', tab: 'favorite' });
    expect(bindingFor(press('End'))?.command).toEqual({ kind: 'select', to: 'last' });
  });

  it('marks the item keys as needing a selection', () => {
    expect(bindingFor(press('Enter'))).toEqual({
      scope: 'item',
      command: 'open-reader',
      preventDefault: true,
    });
    expect(bindingFor(press('Backspace'))?.command).toBe('delete');
    expect(bindingFor(press('Delete'))?.command).toBe('delete');
  });

  it('leaves typing, modifiers and unknown keys alone', () => {
    const input = document.createElement('input');
    expect(bindingFor(press('a', { target: input }))).toBeUndefined();
    expect(bindingFor(press('d', { ctrlKey: true }))).toBeUndefined();
    expect(bindingFor(press('f', { metaKey: true }))).toBeUndefined();
    expect(bindingFor(press('z'))).toBeUndefined();
  });

  it('lets a focused button answer Enter and Space itself', () => {
    const button = document.createElement('button');
    expect(bindingFor(press('Enter', { target: button }))).toBeUndefined();
    expect(bindingFor(press(' ', { target: button }))).toBeUndefined();
    expect(bindingFor(press('a', { target: button }))?.command).toBe('toggle-archive');
  });
});
