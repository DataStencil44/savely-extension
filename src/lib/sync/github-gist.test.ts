/**
 * Testy providera GitHub Gist z podstawionym `fetch`.
 *
 * Sprawdzamy trzy rzeczy, na których zależy najbardziej: token nie wychodzi
 * poza `storage.local`, prośba o dostęp do domeny wychodzi przed jakimkolwiek
 * zapytaniem, a wyścig dwóch urządzeń kończy się czytelnym błędem zamiast
 * cichym nadpisaniem cudzych danych.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const local: Record<string, unknown> = {};
  /** Zapisy do `storage.sync` - ma pozostać pusty przez cały test. */
  const sync: Record<string, unknown> = {};
  let granted = true;

  const noop = (): void => undefined;

  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: { id: 'test', getURL: (path: string) => path, lastError: null },
      storage: {
        local: {
          get: (keys: string | string[], callback: (items: Record<string, unknown>) => void) => {
            const key = Array.isArray(keys) ? keys[0] : keys;
            callback(key !== undefined && key in local ? { [key]: local[key] } : {});
          },
          set: (items: Record<string, unknown>, callback: () => void) => {
            Object.assign(local, items);
            callback();
          },
          remove: (key: string, callback: () => void) => {
            delete local[key];
            callback();
          },
        },
        sync: {
          get: (_keys: unknown, callback: (items: Record<string, unknown>) => void) => {
            callback({});
          },
          set: (items: Record<string, unknown>, callback: () => void) => {
            Object.assign(sync, items);
            callback();
          },
        },
        onChanged: { addListener: noop },
      },
      permissions: {
        request: (_options: unknown, callback: (result: boolean) => void) => {
          callback(granted);
        },
        contains: (_options: unknown, callback: (result: boolean) => void) => {
          callback(granted);
        },
      },
    },
  });

  return {
    local,
    sync,
    setGranted(value: boolean) {
      granted = value;
    },
  };
});

const { GitHubGistProvider } = await import('./github-gist');
const { METADATA_FILE } = await import('./types');
const { SyncAccessError, SyncConflictError } = await import('./types');

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const calls: Call[] = [];

/** Kolejka odpowiedzi: każde wywołanie `fetch` zdejmuje pierwszą z brzegu. */
let responses: { status?: number; body: unknown; text?: string }[] = [];

function mockFetch(): void {
  vi.stubGlobal(
    'fetch',
    (input: string, init?: { method?: string; body?: string }): Promise<Response> => {
      calls.push({
        url: input,
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? null : JSON.parse(init.body),
      });

      const next = responses.shift() ?? { body: {} };
      const status = next.status ?? 200;

      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(next.body),
        text: () => Promise.resolve(next.text ?? JSON.stringify(next.body)),
      } as Response);
    },
  );
}

beforeEach(() => {
  for (const key of Object.keys(storage.local)) delete storage.local[key];
  for (const key of Object.keys(storage.sync)) delete storage.sync[key];
  storage.setGranted(true);
  calls.length = 0;
  responses = [];
  mockFetch();
});

describe('połączenie', () => {
  it('token ląduje w storage.local i nigdy w storage.sync', async () => {
    responses = [{ body: { login: 'ktos' } }, { body: [] }];

    await new GitHubGistProvider().authorize('ghp_token');

    expect(storage.local['sync-github']).toEqual({ token: 'ghp_token', gistId: null });
    expect(storage.sync).toEqual({});
  });

  it('bez zgody na domenę nie leci ani jedno zapytanie', async () => {
    storage.setGranted(false);

    await expect(new GitHubGistProvider().authorize('ghp_token')).rejects.toThrow(SyncAccessError);
    expect(calls).toEqual([]);
    expect(storage.local['sync-github']).toBeUndefined();
  });

  it('pusty token odrzucamy przed pytaniem o cokolwiek', async () => {
    await expect(new GitHubGistProvider().authorize('   ')).rejects.toThrow(/Wklej token/);
    expect(calls).toEqual([]);
  });

  it('odrzucony token daje komunikat, a nie surowy błąd HTTP', async () => {
    responses = [{ status: 401, body: {} }];
    await expect(new GitHubGistProvider().authorize('zly')).rejects.toThrow(/odrzucił token/);
  });

  it('istniejący gist Savely jest odnajdywany zamiast tworzenia drugiego', async () => {
    responses = [
      { body: { login: 'ktos' } },
      { body: [{ id: 'inny', files: { 'notatki.txt': {} } }, { id: 'nasz', files: { [METADATA_FILE]: {} } }] },
    ];

    await new GitHubGistProvider().authorize('ghp_token');

    expect(storage.local['sync-github']).toEqual({ token: 'ghp_token', gistId: 'nasz' });
  });

  it('rozłączenie kasuje poświadczenia, ale nie rusza gista', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'nasz' };

    await new GitHubGistProvider().disconnect();

    expect(storage.local['sync-github']).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('pull', () => {
  it('bez gista oddaje pustkę zamiast błędu', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: null };

    expect(await new GitHubGistProvider().pull()).toEqual({ files: null, revision: null });
    expect(calls).toEqual([]);
  });

  it('czyta pliki i wersję z historii', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'nasz' };
    responses = [
      {
        body: {
          id: 'nasz',
          files: { [METADATA_FILE]: { content: '{"format":"savely-sync"}' } },
          history: [{ version: 'sha-2' }, { version: 'sha-1' }],
        },
      },
    ];

    const snapshot = await new GitHubGistProvider().pull();

    expect(snapshot.files?.[METADATA_FILE]).toBe('{"format":"savely-sync"}');
    expect(snapshot.revision).toBe('sha-2');
    expect(calls[0]?.url).toBe('https://api.github.com/gists/nasz');
  });

  it('plik ucięty przez API dociąga się z raw_url', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'nasz' };
    responses = [
      {
        body: {
          files: {
            [METADATA_FILE]: {
              truncated: true,
              content: 'ucięt…',
              raw_url: 'https://gist.githubusercontent.com/pelny',
            },
          },
          history: [{ version: 'sha-1' }],
        },
      },
      { body: {}, text: 'pełna treść' },
    ];

    const snapshot = await new GitHubGistProvider().pull();

    expect(snapshot.files?.[METADATA_FILE]).toBe('pełna treść');
    expect(calls[1]?.url).toBe('https://gist.githubusercontent.com/pelny');
  });

  it('skasowany ręcznie gist zaczyna od nowa, zamiast blokować synchronizację', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'znikniety' };
    responses = [{ status: 404, body: {} }];

    expect(await new GitHubGistProvider().pull()).toEqual({ files: null, revision: null });
    expect(storage.local['sync-github']).toEqual({ token: 'ghp_token', gistId: null });
  });
});

describe('push', () => {
  it('pierwszy zapis tworzy prywatnego gista i zapamiętuje jego id', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: null };
    responses = [{ body: { id: 'nowy', history: [{ version: 'sha-1' }] } }];

    const revision = await new GitHubGistProvider().push({ [METADATA_FILE]: '{}' }, null);

    expect(revision).toBe('sha-1');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toMatchObject({ public: false });
    expect(storage.local['sync-github']).toEqual({ token: 'ghp_token', gistId: 'nowy' });
  });

  it('kolejny zapis idzie PATCH-em po sprawdzeniu wersji', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'nasz' };
    responses = [
      { body: { history: [{ version: 'sha-1' }] } },
      { body: { history: [{ version: 'sha-2' }] } },
    ];

    const revision = await new GitHubGistProvider().push({ [METADATA_FILE]: '{}' }, 'sha-1');

    expect(revision).toBe('sha-2');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH']);
  });

  it('zmiana po drugiej stronie przerywa zapis zamiast nadpisać cudze dane', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'nasz' };
    responses = [{ body: { history: [{ version: 'sha-inna' }] } }];

    await expect(
      new GitHubGistProvider().push({ [METADATA_FILE]: '{}' }, 'sha-1'),
    ).rejects.toThrow(SyncConflictError);

    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('cofnięta zgoda na domenę zatrzymuje synchronizację z jasnym komunikatem', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'nasz' };
    storage.setGranted(false);

    await expect(new GitHubGistProvider().pull()).rejects.toThrow(/Cofnięto zgodę/);
    expect(calls).toEqual([]);
  });
});
