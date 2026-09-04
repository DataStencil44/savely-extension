/**
 * Provider "GitHub Gist": jeden prywatny Gist jako skrzynka na dane.
 *
 * Dlaczego token osobisty, a nie OAuth Device Flow: Device Flow wymaga
 * `client_id` aplikacji, czyli konta, które ktoś musi utrzymywać, i wymiany
 * kodu na token po stronie GitHuba - a przy okazji sugeruje, że po drugiej
 * stronie stoi „usługa Savely". Nie stoi. Token, który użytkownik generuje sam
 * i sam może unieważnić, jest uczciwszy: widać dokładnie, czyje to konto,
 * jakie ma uprawnienia i kto ma dostęp do danych.
 *
 * Token żyje wyłącznie w `storage.local` - nigdy w `storage.sync`, bo tamto
 * wychodzi na serwery przeglądarki i na wszystkie zalogowane urządzenia.
 */
import browser from 'webextension-polyfill';

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
const DESCRIPTION = 'Savely - synchronizacja (prywatny gist, dane rozszerzenia)';

/** Gist bywa ucinany przy większych plikach; nad ~10 MB API zaczyna odmawiać. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

/** Zamienia odpowiedź GitHuba na komunikat, z którym da się cokolwiek zrobić. */
async function fail(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new SyncAccessError('GitHub odrzucił token. Wygeneruj nowy i połącz ponownie.');
  }
  if (response.status === 403 || response.status === 429) {
    throw new SyncAccessError(
      'GitHub odmówił (limit zapytań albo brak uprawnienia "gist" w tokenie).',
    );
  }
  if (response.status === 404) {
    throw new SyncAccessError('Gist zniknął albo token nie ma do niego dostępu.');
  }

  const body = await response.text().catch(() => '');
  throw new SyncAccessError(
    `GitHub odpowiedział ${String(response.status)}${body === '' ? '' : `: ${body.slice(0, 200)}`}`,
  );
}

async function call(token: string, path: string, init?: RequestInit): Promise<GistResponse> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers: headers(token) });
  } catch (error) {
    throw new SyncAccessError(
      `Nie udało się połączyć z api.github.com (${error instanceof Error ? error.message : 'brak sieci'}).`,
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
    'Dane trafiają do jednego prywatnego Gista na Twoim koncie GitHub: metadane jako czytelny JSON, treści artykułów spakowane gzipem. Prywatny gist nie jest indeksowany, ale nie jest też zaszyfrowany - kto ma ten token albo dostęp do Twojego konta GitHub, przeczyta wszystko, co zapisałeś.';

  readonly prompt: ConnectPrompt = {
    kind: 'secret',
    label: 'Token osobisty GitHub',
    help: 'github.com → Settings → Developer settings → Personal access tokens. Klasyczny token potrzebuje wyłącznie uprawnienia "gist"; token fine-grained - uprawnienia "Gists: read and write". Token zostaje na tym urządzeniu (storage.local) i nigdy nie idzie do synchronizacji ustawień.',
    placeholder: 'ghp_… albo github_pat_…',
  };

  async authorize(secret?: string): Promise<void> {
    const token = (secret ?? '').trim();
    if (token === '') throw new SyncAccessError('Wklej token, inaczej nie ma jak się połączyć.');

    // PIERWSZY `await` w obsłudze kliknięcia - w Firefoksie prośba o dostęp
    // musi wyjść prosto z gestu użytkownika (CLAUDE.md 5.3).
    const granted = await browser.permissions.request({ origins: [ORIGIN] });
    if (!granted) {
      throw new SyncAccessError('Bez zgody na dostęp do api.github.com nie ma jak synchronizować.');
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
    if (credentials.gistId === null) return 'gist powstanie przy pierwszej synchronizacji';
    return `https://gist.github.com/${credentials.gistId}`;
  }

  async pull(): Promise<RemoteSnapshot> {
    const credentials = await this.#credentials();
    if (credentials.gistId === null) return { files: null, revision: null };

    let gist: GistResponse;
    try {
      gist = await call(credentials.token, `/gists/${credentials.gistId}`);
    } catch (error) {
      // Gist skasowany ręcznie: zapominamy o nim i zaczynamy od nowa, zamiast
      // blokować synchronizację na zawsze.
      if (error instanceof SyncAccessError && error.message.includes('zniknął')) {
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
      if (created.id === undefined) throw new SyncAccessError('GitHub nie oddał identyfikatora gista.');
      await writeCredentials({ ...credentials, gistId: created.id });
      return revisionOf(created);
    }

    // Gisty nie mają `If-Match`, więc wersję sprawdzamy tuż przed zapisem.
    // Okno wyścigu zostaje, ale zwykły przypadek - drugie urządzenie
    // zsynchronizowane w międzyczasie - łapiemy i mówimy o tym wprost.
    if (expectedRevision !== null) {
      const current = await call(credentials.token, `/gists/${credentials.gistId}`);
      if (revisionOf(current) !== expectedRevision) {
        throw new SyncConflictError(
          'Dane w gistcie zmieniły się w trakcie synchronizacji (inne urządzenie zdążyło pierwsze). Uruchom synchronizację jeszcze raz.',
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
    // Sam gist zostaje - kasujemy tylko dostęp do niego z tego urządzenia.
    await browser.storage.local.remove(STORAGE_KEY);
  }

  async #credentials(): Promise<Credentials> {
    const credentials = await readCredentials();
    if (credentials === null) throw new SyncAccessError('Brak połączenia z GitHubem.');

    if (!(await browser.permissions.contains({ origins: [ORIGIN] }))) {
      throw new SyncAccessError(
        'Cofnięto zgodę na dostęp do api.github.com - połącz się ponownie w opcjach.',
      );
    }
    return credentials;
  }

  /**
   * Szuka gista Savely na koncie, zamiast od razu robić nowy: drugie urządzenie
   * ma się podpiąć do tych samych danych, a nie założyć drugą skrzynkę.
   */
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
      throw new SyncAccessError('Nie udało się pobrać pełnej zawartości gista.');
    }
    return response.text();
  }

  #checkSize(files: SyncFiles): void {
    for (const [name, content] of Object.entries(files)) {
      if (content.length > MAX_FILE_BYTES) {
        throw new SyncAccessError(
          `Plik ${name} ma ${String(Math.round(content.length / 1024 / 1024))} MB - Gist tego nie przyjmie. Zarchiwizuj albo usuń część pozycji z treścią.`,
        );
      }
    }
  }
}

export { CONTENTS_FILE, METADATA_FILE };
