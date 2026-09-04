/**
 * Rejestr providerów - jedyne miejsce, które wie, jacy oni w ogóle są.
 *
 * Dopisanie providera „lokalny folder" (File System Access API, Chrome-only)
 * sprowadza się do nowego pliku obok `github-gist.ts` i jednej linii tutaj:
 * jego `prompt.kind` to `picker`, więc opcje pokażą przycisk zamiast pola na
 * token, a silnik, alarm i scalanie nie zauważą różnicy.
 */
import { GitHubGistProvider } from './github-gist';
import { loadSyncState } from './engine';
import type { SyncProvider } from './types';

const PROVIDERS: readonly SyncProvider[] = [new GitHubGistProvider()];

export function listProviders(): readonly SyncProvider[] {
  return PROVIDERS;
}

export function getProvider(id: string | null): SyncProvider | undefined {
  if (id === null) return undefined;
  return PROVIDERS.find((provider) => provider.id === id);
}

/** Provider wybrany w ustawieniach, o ile wciąż ma poświadczenia. */
export async function activeProvider(): Promise<SyncProvider | null> {
  const state = await loadSyncState();
  const provider = getProvider(state.providerId);
  if (provider === undefined) return null;
  return (await provider.isConnected()) ? provider : null;
}

export * from './types';
export {
  DEFAULT_SYNC_STATE,
  SYNC_ALARM,
  SYNC_INTERVAL_MINUTES,
  applyAutoSync,
  loadSyncState,
  parseSyncState,
  saveSyncState,
  syncNow,
  type SyncState,
} from './engine';
