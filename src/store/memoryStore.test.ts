import { describe, expect, it } from 'vitest';
import { UserMemoryRedisStore } from './memoryStore.js';

function createFakeRedis() {
  const map = new Map<string, string>();
  return {
    map,
    async get(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    async set(key: string, value: string, ...args: unknown[]) {
      if (args.includes('NX') && map.has(key)) return null;
      map.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      map.delete(key);
      return 1;
    },
  };
}

describe('UserMemoryRedisStore', () => {
  it('stores mapping without requiring TTL args', async () => {
    const redis = createFakeRedis();
    const store = new UserMemoryRedisStore(redis as never);
    await store.setMemoryStoreId('hash1', 'memstore-1');
    expect(await store.getMemoryStoreId('hash1')).toBe('memstore-1');
    expect(redis.map.get('ark:user_memory:hash1')).toBe('memstore-1');
  });

  it('acquires lock only once via SET NX', async () => {
    const redis = createFakeRedis();
    const store = new UserMemoryRedisStore(redis as never);
    expect(await store.tryAcquireCreateLock('hash1')).toBe(true);
    expect(await store.tryAcquireCreateLock('hash1')).toBe(false);
    await store.releaseCreateLock('hash1');
    expect(await store.tryAcquireCreateLock('hash1')).toBe(true);
  });
});
