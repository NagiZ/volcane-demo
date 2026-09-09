import { describe, expect, it, vi } from 'vitest';
import { SESSION_TTL_SECONDS, SessionStore } from './sessionStore.js';

function fakeRedis() {
  const map = new Map<string, string>();
  return {
    map,
    get: vi.fn(async (k: string) => map.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, _ex?: string, _ttl?: number) => {
      map.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => {
      map.delete(k);
      return 1;
    }),
  };
}

describe('SessionStore vault map', () => {
  it('sets and gets vault id with TTL flag', async () => {
    const redis = fakeRedis();
    const store = new SessionStore(redis as never);
    await store.setVaultId('hash1', 'vault-1');
    expect(redis.set).toHaveBeenCalledWith(
      'ark:vault:map:hash1',
      'vault-1',
      'EX',
      SESSION_TTL_SECONDS,
    );
    await expect(store.getVaultId('hash1')).resolves.toBe('vault-1');
  });

  it('deletes vault id', async () => {
    const redis = fakeRedis();
    const store = new SessionStore(redis as never);
    await store.setVaultId('hash1', 'vault-1');
    await store.deleteVaultId('hash1');
    await expect(store.getVaultId('hash1')).resolves.toBeNull();
  });
});
