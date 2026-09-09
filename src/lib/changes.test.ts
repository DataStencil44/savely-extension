/**
 * The change channel. Two things have to hold for it to be worth having: a
 * context must not answer its own announcement (it drew the change already,
 * and re-reading the database on every one of its own writes would undo the
 * point of keeping the list in memory), and a listener must actually hear
 * someone else's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type StorageListener = (
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  areaName: string,
) => void;

/** The polyfill checks `chrome.runtime.id` as soon as the module loads. */
const stub = vi.hoisted(() => {
  const written: Record<string, unknown>[] = [];
  const listeners: StorageListener[] = [];

  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: { id: 'test', lastError: null },
      storage: {
        local: {
          set: (items: Record<string, unknown>, callback: () => void) => {
            written.push(items);
            callback();
          },
        },
        onChanged: {
          addListener: (listener: StorageListener) => listeners.push(listener),
        },
      },
    },
  });

  return { written, listeners };
});

const { announceChange, onDataChanged } = await import('./changes');

/** The notice out of a recorded write, checked the way the module checks it. */
function noticeOf(items: Record<string, unknown> | undefined): { at: number; source: string } {
  const value = items?.['savely:changed'];
  if (typeof value !== 'object' || value === null) throw new Error('nothing was announced');
  const { at, source } = value as Record<string, unknown>;
  if (typeof at !== 'number' || typeof source !== 'string') {
    throw new Error('the notice is not a notice');
  }
  return { at, source };
}

/** Replays what the browser does after a `storage.local.set` in some context. */
function deliverLastWrite(): void {
  const items = stub.written.at(-1);
  if (items === undefined) throw new Error('nothing was announced');
  const changes = Object.fromEntries(
    Object.entries(items).map(([key, newValue]) => [key, { newValue }]),
  );
  for (const listener of stub.listeners) listener(changes, 'local');
}

/** The same, but written by a context that is not this one. */
function deliverFrom(source: string): void {
  for (const listener of stub.listeners) {
    listener({ 'savely:changed': { newValue: { at: Date.now(), source } } }, 'local');
  }
}

beforeEach(() => {
  stub.written.length = 0;
  stub.listeners.length = 0;
  vi.useFakeTimers();
});

describe('announcing a change', () => {
  it('writes one small notice, with who wrote it', () => {
    announceChange();

    expect(stub.written).toHaveLength(1);
    const notice = noticeOf(stub.written[0]);
    expect(notice.at).toBeGreaterThan(0);
    expect(notice.source).not.toBe('');
  });
});

describe('listening for changes', () => {
  it('ignores the announcement this context made itself', () => {
    const heard = vi.fn();
    onDataChanged(heard);

    announceChange();
    deliverLastWrite();
    vi.runAllTimers();

    expect(heard).not.toHaveBeenCalled();
  });

  it('hears another context', () => {
    const heard = vi.fn();
    onDataChanged(heard);

    deliverFrom('another-context');
    vi.runAllTimers();

    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('answers a burst of writes once', () => {
    const heard = vi.fn();
    onDataChanged(heard);

    deliverFrom('another-context');
    deliverFrom('another-context');
    deliverFrom('another-context');
    vi.runAllTimers();

    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('leaves every other storage write alone', () => {
    const heard = vi.fn();
    onDataChanged(heard);

    for (const listener of stub.listeners) {
      // A settings write, in the area this channel does not use, and one that
      // is neither.
      listener({ 'reader-settings': { newValue: { theme: 'dark' } } }, 'local');
      listener({ 'savely:changed': { newValue: { at: 1, source: 'x' } } }, 'sync');
      listener({ 'savely:changed': { newValue: 'not a notice' } }, 'local');
    }
    vi.runAllTimers();

    expect(heard).not.toHaveBeenCalled();
  });
});
