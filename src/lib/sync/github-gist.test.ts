import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const local: Record<string, unknown> = {};
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

describe('connecting', () => {
  it('the token lands in storage.local and never in storage.sync', async () => {
    responses = [{ body: { login: 'someone' } }, { body: [] }];

    await new GitHubGistProvider().authorize('ghp_token');

    expect(storage.local['sync-github']).toEqual({ token: 'ghp_token', gistId: null });
    expect(storage.sync).toEqual({});
  });

  it('without the host permission not a single request goes out', async () => {
    storage.setGranted(false);

    await expect(new GitHubGistProvider().authorize('ghp_token')).rejects.toThrow(SyncAccessError);
    expect(calls).toEqual([]);
    expect(storage.local['sync-github']).toBeUndefined();
  });

  it('an empty token is rejected before anything is asked', async () => {
    await expect(new GitHubGistProvider().authorize('   ')).rejects.toThrow(/Paste a token/);
    expect(calls).toEqual([]);
  });

  it('a rejected token gives a message, not a raw HTTP error', async () => {
    responses = [{ status: 401, body: {} }];
    await expect(new GitHubGistProvider().authorize('bad')).rejects.toThrow(/rejected the token/);
  });

  it('an existing Savely gist is found instead of creating a second one', async () => {
    responses = [
      { body: { login: 'someone' } },
      { body: [{ id: 'other', files: { 'notes.txt': {} } }, { id: 'ours', files: { [METADATA_FILE]: {} } }] },
    ];

    await new GitHubGistProvider().authorize('ghp_token');

    expect(storage.local['sync-github']).toEqual({ token: 'ghp_token', gistId: 'ours' });
  });

  it('disconnecting erases the credentials but leaves the gist alone', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'ours' };

    await new GitHubGistProvider().disconnect();

    expect(storage.local['sync-github']).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('pull', () => {
  it('with no gist it returns emptiness rather than an error', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: null };

    expect(await new GitHubGistProvider().pull()).toEqual({ files: null, revision: null });
    expect(calls).toEqual([]);
  });

  it('reads the files and the revision from the history', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'ours' };
    responses = [
      {
        body: {
          id: 'ours',
          files: { [METADATA_FILE]: { content: '{"format":"savely-sync"}' } },
          history: [{ version: 'sha-2' }, { version: 'sha-1' }],
        },
      },
    ];

    const snapshot = await new GitHubGistProvider().pull();

    expect(snapshot.files?.[METADATA_FILE]).toBe('{"format":"savely-sync"}');
    expect(snapshot.revision).toBe('sha-2');
    expect(calls[0]?.url).toBe('https://api.github.com/gists/ours');
  });

  it('a file truncated by the API is fetched from raw_url', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'ours' };
    responses = [
      {
        body: {
          files: {
            [METADATA_FILE]: {
              truncated: true,
              content: 'truncat\u2026',
              raw_url: 'https://gist.githubusercontent.com/full',
            },
          },
          history: [{ version: 'sha-1' }],
        },
      },
      { body: {}, text: 'the full content' },
    ];

    const snapshot = await new GitHubGistProvider().pull();

    expect(snapshot.files?.[METADATA_FILE]).toBe('the full content');
    expect(calls[1]?.url).toBe('https://gist.githubusercontent.com/full');
  });

  it('a gist deleted by hand starts over instead of blocking sync', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'vanished' };
    responses = [{ status: 404, body: {} }];

    expect(await new GitHubGistProvider().pull()).toEqual({ files: null, revision: null });
    expect(storage.local['sync-github']).toEqual({ token: 'ghp_token', gistId: null });
  });
});

describe('push', () => {
  it('the first write creates a private gist and remembers its id', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: null };
    responses = [{ body: { id: 'fresh', history: [{ version: 'sha-1' }] } }];

    const revision = await new GitHubGistProvider().push({ [METADATA_FILE]: '{}' }, null);

    expect(revision).toBe('sha-1');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toMatchObject({ public: false });
    expect(storage.local['sync-github']).toEqual({ token: 'ghp_token', gistId: 'fresh' });
  });

  it('a subsequent write goes out as a PATCH after checking the revision', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'ours' };
    responses = [
      { body: { history: [{ version: 'sha-1' }] } },
      { body: { history: [{ version: 'sha-2' }] } },
    ];

    const revision = await new GitHubGistProvider().push({ [METADATA_FILE]: '{}' }, 'sha-1');

    expect(revision).toBe('sha-2');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH']);
  });

  it('a change on the other side aborts the write instead of overwriting data', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'ours' };
    responses = [{ body: { history: [{ version: 'sha-other' }] } }];

    await expect(
      new GitHubGistProvider().push({ [METADATA_FILE]: '{}' }, 'sha-1'),
    ).rejects.toThrow(SyncConflictError);

    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('a revoked host permission stops the sync with a clear message', async () => {
    storage.local['sync-github'] = { token: 'ghp_token', gistId: 'ours' };
    storage.setGranted(false);

    await expect(new GitHubGistProvider().pull()).rejects.toThrow(/Permission for api.github.com was revoked/);
    expect(calls).toEqual([]);
  });
});
