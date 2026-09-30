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
  disconnectSync,
  loadSyncState,
  parseSyncState,
  saveSyncState,
  syncNow,
  type SyncState,
} from './engine';
