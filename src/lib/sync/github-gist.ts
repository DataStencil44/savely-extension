import browser from 'webextension-polyfill';

import { isRecord } from '../unknown';

import {
  CONTENTS_FILE,
  METADATA_FILE,
  SyncAccessError,
  SyncConflictError,
  type ConnectPrompt,
  type RemoteSnapshot,
  type SyncFiles,
  type SyncProvider,
} from './types';

const STORAGE_KEY = 'sync-github';
const API = 'https://api.github.com';
const ORIGIN = 'https://api.github.com/*';
const DESCRIPTION = 'Savely - sync (private gist, extension data)';

const MAX_FILE_BYTES = 9 * 1024 * 1024;

interface Credentials {
  token: string;
  gistId: string | null;
}

interface GistFile {
  filename?: string;
  content?: string;
  truncated?: boolean;
  raw_url?: string;
}

interface GistResponse {
  id?: string;
  html_url?: string;
  updated_at?: string;
  files?: Record<string, GistFile | null>;
  history?: { version?: string }[];
}

async function readCredentials(): Promise<Credentials | null> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY];
  if (!isRecord(value)) return null;

  const token = value['token'];
  if (typeof token !== 'string' || token === '') return null;

  const gistId = value['gistId'];
  return { token, gistId: typeof gistId === 'string' && gistId !== '' ? gistId : null };
}

async function writeCredentials(credentials: Credentials): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: credentials });
}

function headers(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  };
}

async function fail(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new SyncAccessError('GitHub rejected the token. Generate a new one and connect again.');
  }
  if (response.status === 403 || response.status === 429) {
    throw new SyncAccessError(
      'GitHub refused (rate limit, or the token lacks the "gist" scope).',
    );
  }
  if (response.status === 404) {
    throw new SyncAccessError('The gist is gone, or the token has no access to it.');
  }

  const body = await response.text().catch(() => '');
  throw new SyncAccessError(
    `GitHub answered ${String(response.status)}${body === '' ? '' : `: ${body.slice(0, 200)}`}`,
  );
}

async function call(token: string, path: string, init?: RequestInit): Promise<GistResponse> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers: headers(token) });
  } catch (error) {
    throw new SyncAccessError(
      `Could not reach api.github.com (${error instanceof Error ? error.message : 'no network'}).`,
    );
  }

  if (!response.ok) await fail(response);
  return (await response.json()) as GistResponse;
}

function revisionOf(gist: GistResponse): string {
  return gist.history?.[0]?.version ?? gist.updated_at ?? '';
}

export class GitHubGistProvider implements SyncProvider {
  readonly id = 'github-gist';
  readonly label = 'GitHub Gist';

  readonly dataLocation =
    'Your data goes into a single private Gist on your GitHub account: metadata as readable JSON, article content gzipped. A private gist is not indexed, but it is not encrypted either - anyone holding this token, or with access to your GitHub account, can read everything you saved.';

  readonly prompt: ConnectPrompt = {
    kind: 'secret',
    label: 'GitHub personal access token',
    help: 'github.com \u2192 Settings \u2192 Developer settings \u2192 Personal access tokens. A classic token needs only the "gist" scope; a fine-grained token needs "Gists: read and write". The token stays on this device (storage.local) and never goes into settings sync.',
    placeholder: 'ghp_\u2026 or github_pat_\u2026',
  };

  async authorize(secret?: string): Promise<void> {
    const token = (secret ?? '').trim();
    if (token === '') throw new SyncAccessError('Paste a token, otherwise there is no way to connect.');

    const granted = await browser.permissions.request({ origins: [ORIGIN] });
    if (!granted) {
      throw new SyncAccessError('Without permission for api.github.com there is no way to sync.');
    }

    await call(token, '/user');
    await writeCredentials({ token, gistId: await this.#findGist(token) });
  }

  async isConnected(): Promise<boolean> {
    return (await readCredentials()) !== null;
  }

  async describe(): Promise<string | null> {
    const credentials = await readCredentials();
    if (credentials === null) return null;
    if (credentials.gistId === null) return 'the gist will be created on the first sync';
    return `https://gist.github.com/${credentials.gistId}`;
  }

  async pull(): Promise<RemoteSnapshot> {
    const credentials = await this.#credentials();
    if (credentials.gistId === null) return { files: null, revision: null };

    let gist: GistResponse;
    try {
      gist = await call(credentials.token, `/gists/${credentials.gistId}`);
    } catch (error) {
      if (error instanceof SyncAccessError && error.message.includes('is gone')) {
        await writeCredentials({ ...credentials, gistId: null });
        return { files: null, revision: null };
      }
      throw error;
    }

    const files: SyncFiles = {};
    for (const [name, file] of Object.entries(gist.files ?? {})) {
      if (file === null || file === undefined) continue;
      files[name] = file.truncated === true ? await this.#raw(file) : (file.content ?? '');
    }

    return { files, revision: revisionOf(gist) };
  }

  async push(files: SyncFiles, expectedRevision: string | null): Promise<string> {
    const credentials = await this.#credentials();
    this.#checkSize(files);

    const payload = {
      description: DESCRIPTION,
      public: false,
      files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { content }])),
    };

    if (credentials.gistId === null) {
      const created = await call(credentials.token, '/gists', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (created.id === undefined) throw new SyncAccessError('GitHub did not return a gist identifier.');
      await writeCredentials({ ...credentials, gistId: created.id });
      return revisionOf(created);
    }

    if (expectedRevision !== null) {
      const current = await call(credentials.token, `/gists/${credentials.gistId}`);
      if (revisionOf(current) !== expectedRevision) {
        throw new SyncConflictError(
          'The gist data changed mid-sync (another device got there first). Run the sync again.',
        );
      }
    }

    const updated = await call(credentials.token, `/gists/${credentials.gistId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    return revisionOf(updated);
  }

  async disconnect(): Promise<void> {
    await browser.storage.local.remove(STORAGE_KEY);
  }

  async #credentials(): Promise<Credentials> {
    const credentials = await readCredentials();
    if (credentials === null) throw new SyncAccessError('Not connected to GitHub.');

    if (!(await browser.permissions.contains({ origins: [ORIGIN] }))) {
      throw new SyncAccessError(
        'Permission for api.github.com was revoked - connect again on the options page.',
      );
    }
    return credentials;
  }

  async #findGist(token: string): Promise<string | null> {
    const response = await fetch(`${API}/gists?per_page=100`, { headers: headers(token) });
    if (!response.ok) await fail(response);

    const gists = (await response.json()) as GistResponse[];
    for (const gist of gists) {
      if (gist.id !== undefined && Object.keys(gist.files ?? {}).includes(METADATA_FILE)) {
        return gist.id;
      }
    }
    return null;
  }

  async #raw(file: GistFile): Promise<string> {
    if (file.raw_url === undefined) return file.content ?? '';
    const response = await fetch(file.raw_url);
    if (!response.ok) {
      throw new SyncAccessError('Could not fetch the full gist content.');
    }
    return response.text();
  }

  #checkSize(files: SyncFiles): void {
    for (const [name, content] of Object.entries(files)) {
      if (content.length > MAX_FILE_BYTES) {
        throw new SyncAccessError(
          `The ${name} file is ${String(Math.round(content.length / 1024 / 1024))} MB - a Gist will not take it. Archive or delete some of the items that carry content.`,
        );
      }
    }
  }
}

export { CONTENTS_FILE, METADATA_FILE };
