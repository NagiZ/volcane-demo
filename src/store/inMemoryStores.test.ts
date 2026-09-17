import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySessionStore, InMemoryUserMemoryStore } from './inMemoryStores.js';
import { MEMORY_LOCK_TTL_SECONDS } from './memoryStore.js';
import { SESSION_TTL_SECONDS } from './sessionStore.js';

describe('InMemorySessionStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stores and deletes session mappings', async () => {
    const store = new InMemorySessionStore();
    expect(await store.getSessionId('hash1')).toBeNull();
    await store.setSessionId('hash1', 'sesn-1');
    expect(await store.getSessionId('hash1')).toBe('sesn-1');
    await store.deleteSession('hash1');
    expect(await store.getSessionId('hash1')).toBeNull();
  });

  it('expires mappings after the session TTL', async () => {
    const store = new InMemorySessionStore();
    await store.setSessionId('hash1', 'sesn-1');
    vi.advanceTimersByTime(SESSION_TTL_SECONDS * 1000 + 1);
    expect(await store.getSessionId('hash1')).toBeNull();
  });
});

describe('InMemoryUserMemoryStore', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('stores permanent mappings', async () => {
    const store = new InMemoryUserMemoryStore();
    expect(await store.getMemoryStoreId('hash1')).toBeNull();
    await store.setMemoryStoreId('hash1', 'memstore-1');
    expect(await store.getMemoryStoreId('hash1')).toBe('memstore-1');
  });

  it('acquires the create lock once and re-acquires after release', async () => {
    const store = new InMemoryUserMemoryStore();
    expect(await store.tryAcquireCreateLock('hash1')).toBe(true);
    expect(await store.tryAcquireCreateLock('hash1')).toBe(false);
    await store.releaseCreateLock('hash1');
    expect(await store.tryAcquireCreateLock('hash1')).toBe(true);
  });

  it('treats an expired lock as releasable', async () => {
    const store = new InMemoryUserMemoryStore();
    expect(await store.tryAcquireCreateLock('hash1')).toBe(true);
    vi.advanceTimersByTime(MEMORY_LOCK_TTL_SECONDS * 1000 + 1);
    expect(await store.tryAcquireCreateLock('hash1')).toBe(true);
  });
});
