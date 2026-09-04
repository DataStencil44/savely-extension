/**
 * Kontrakt synchronizacji: co provider musi umieć i co przez niego przechodzi.
 *
 * Provider jest **głupi z założenia** - dostaje kilka nazwanych plików
 * tekstowych i nieprzezroczysty znacznik wersji, oddaje to samo. Nie wie nic
 * o pozycjach, tagach ani scalaniu; nie parsuje zawartości. Dzięki temu
 * dopisanie drugiego providera (np. "lokalny folder" na File System Access API,
 * Chrome-only) to jeden nowy plik i wpis w rejestrze - reszta kodu zostaje
 * nietknięta.
 *
 * Serializacją, kompresją i scalaniem zajmują się `payload.ts` i `merge.ts`,
 * a zapisem do bazy `applySync` z `src/lib/db.ts`.
 */

/** Nazwa pliku -> jego zawartość tekstowa. Provider nie zagląda do środka. */
export type SyncFiles = Record<string, string>;

export interface RemoteSnapshot {
  /** `null`, gdy po drugiej stronie nie ma jeszcze niczego. */
  files: SyncFiles | null;
  /**
   * Znacznik wersji zdalnej - sha commita, etag, czas modyfikacji pliku.
   * Nieprzezroczysty: silnik tylko oddaje go z powrotem przy zapisie, żeby
   * provider mógł wykryć, że ktoś zmienił dane w międzyczasie.
   */
  revision: string | null;
}

/** Jak UI ma poprosić o połączenie. Każdy provider łączy się inaczej. */
export interface ConnectPrompt {
  /** `secret` = pole tekstowe (token), `picker` = jeden przycisk (folder). */
  kind: 'secret' | 'picker';
  label: string;
  /** Co to jest i skąd to wziąć - pokazywane pod polem. */
  help: string;
  placeholder?: string;
}

/** Podnoszony, gdy zdalna wersja zmieniła się między odczytem a zapisem. */
export class SyncConflictError extends Error {
  override readonly name = 'SyncConflictError';
}

/** Podnoszony przy braku zgody, złym tokenie i innych problemach dostępu. */
export class SyncAccessError extends Error {
  override readonly name = 'SyncAccessError';
}

export interface SyncProvider {
  readonly id: string;
  readonly label: string;
  /**
   * Jedno zdanie o tym, gdzie fizycznie lądują dane i kto je zobaczy.
   * UI pokazuje to **przed** połączeniem - użytkownik ma wiedzieć, na co się
   * godzi, zanim wklei token.
   */
  readonly dataLocation: string;
  readonly prompt: ConnectPrompt;

  /** Nawiązuje połączenie. `secret` dla `kind: 'secret'`, inaczej pominięty. */
  authorize(secret?: string): Promise<void>;
  isConnected(): Promise<boolean>;
  /** Konkretne miejsce docelowe (adres gista, nazwa folderu) albo `null`. */
  describe(): Promise<string | null>;

  pull(): Promise<RemoteSnapshot>;
  /** Zwraca nowy znacznik wersji. Rzuca `SyncConflictError` przy rozjeździe. */
  push(files: SyncFiles, expectedRevision: string | null): Promise<string>;
  /** Kasuje lokalne poświadczenia. Danych po drugiej stronie NIE rusza. */
  disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Ładunek
// ---------------------------------------------------------------------------

export const SYNC_FORMAT = 'savely-sync';
export const SYNC_FORMAT_VERSION = 1;

/** Nazwy plików u providera. Stałe - po nich poznajemy własne dane. */
export const METADATA_FILE = 'savely-sync.json';
export const CONTENTS_FILE = 'savely-contents.json.gz.base64';

/**
 * Zaznaczenie w ładunku: bez `id` i `itemId`, bo identyfikatory są lokalne dla
 * urządzenia. Tożsamość zaznaczenia to cytat plus offsety.
 */
export interface SyncHighlight {
  text: string;
  note: string | null;
  createdAt: number;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

/**
 * Pozycja w ładunku. Kluczem jest **znormalizowany adres**, nie `id` - dwa
 * urządzenia nigdy nie wygenerują tych samych identyfikatorów.
 */
export interface SyncItem {
  url: string;
  resolvedUrl: string;
  title: string;
  excerpt: string;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  wordCount: number;
  estReadingMinutes: number;
  savedAt: number;
  updatedAt: number;
  readAt: number | null;
  archived: boolean;
  favorite: boolean;
  tags: string[];
  contentHash: string | null;
  status: 'pending' | 'ready' | 'failed';
  readingProgress: number;
  highlights: SyncHighlight[];
}

export interface SyncContent {
  html: string;
  text: string;
  updatedAt: number;
}

export interface SyncPayload {
  format: typeof SYNC_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  updatedAt: number;
  items: SyncItem[];
  tombstones: { url: string; deletedAt: number }[];
  /** Adres -> treść. W pliku osobno i skompresowane (gzip + base64). */
  contents: Record<string, SyncContent>;
}

// ---------------------------------------------------------------------------
// Wynik synchronizacji
// ---------------------------------------------------------------------------

export interface SyncReport {
  at: number;
  /** Pozycje, które przyszły z drugiej strony. */
  added: number;
  /** Pozycje zaktualizowane lokalnie (zdalna wersja była nowsza albo scalona). */
  updated: number;
  /** Pozycje skasowane lokalnie, bo po drugiej stronie zniknęły. */
  deleted: number;
  contents: number;
  highlights: number;
  /** Ile pozycji poszło na drugą stronę w tym ładunku. */
  pushed: number;
  /** Konflikty rozstrzygnięte po `updatedAt` (obie strony miały zmiany). */
  conflicts: number;
}
