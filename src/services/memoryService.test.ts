import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../clients/arkMemoryClient.js', () => ({
  createMemoryStore: vi.fn(),
  findMemoryByPath: vi.fn(),
  getMemoryFile: vi.fn(),
  createMemoryFile: vi.fn(),
  updateMemoryFile: vi.fn(),
}));

import {
  createMemoryFile,
  createMemoryStore,
  findMemoryByPath,
  getMemoryFile,
  updateMemoryFile,
} from '../clients/arkMemoryClient.js';
import { MemoryService } from './memoryService.js';
import type { AppConfig } from '../config.js';
import type { UserMemoryRedisStore } from '../store/memoryStore.js';

const config = {
  arkApiKey: 'k',
  arkBaseUrl: 'https://example.com/api/v3',
} as AppConfig;

describe('MemoryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing memory store id from redis', async () => {
    const store = {
      getMemoryStoreId: vi.fn().mockResolvedValue('memstore-existing'),
      tryAcquireCreateLock: vi.fn(),
      setMemoryStoreId: vi.fn(),
      releaseCreateLock: vi.fn(),
    } as unknown as UserMemoryRedisStore;
    const svc = new MemoryService(config, store);
    await expect(svc.getOrCreateUserMemoryStore('hash')).resolves.toBe('memstore-existing');
    expect(createMemoryStore).not.toHaveBeenCalled();
  });

  it('creates store when missing and lock acquired', async () => {
    const hash = 'abcd'.repeat(8);
    const store = {
      getMemoryStoreId: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
      tryAcquireCreateLock: vi.fn().mockResolvedValue(true),
      setMemoryStoreId: vi.fn().mockResolvedValue(undefined),
      releaseCreateLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as UserMemoryRedisStore;
    vi.mocked(createMemoryStore).mockResolvedValue({ id: 'memstore-new' });
    const svc = new MemoryService(config, store);
    await expect(svc.getOrCreateUserMemoryStore(hash)).resolves.toBe('memstore-new');
    expect(createMemoryStore).toHaveBeenCalled();
    expect(store.setMemoryStoreId).toHaveBeenCalledWith(hash, 'memstore-new');
    expect(store.releaseCreateLock).toHaveBeenCalledWith(hash);
  });

  it('write creates when path missing', async () => {
    const store = {
      getMemoryStoreId: vi.fn().mockResolvedValue('memstore-1'),
      tryAcquireCreateLock: vi.fn(),
      setMemoryStoreId: vi.fn(),
      releaseCreateLock: vi.fn(),
    } as unknown as UserMemoryRedisStore;
    vi.mocked(findMemoryByPath).mockResolvedValue(null);
    vi.mocked(createMemoryFile).mockResolvedValue({
      id: 'm1',
      path: '/user_profile.json',
      content: '{}',
    });
    const svc = new MemoryService(config, store);
    await expect(svc.writeUserMemory('token', 'user_profile.json', '{}')).resolves.toEqual({
      success: true,
      path: '/user_profile.json',
    });
    expect(createMemoryFile).toHaveBeenCalled();
    expect(updateMemoryFile).not.toHaveBeenCalled();
  });

  it('write updates when path exists', async () => {
    const store = {
      getMemoryStoreId: vi.fn().mockResolvedValue('memstore-1'),
      tryAcquireCreateLock: vi.fn(),
      setMemoryStoreId: vi.fn(),
      releaseCreateLock: vi.fn(),
    } as unknown as UserMemoryRedisStore;
    vi.mocked(findMemoryByPath).mockResolvedValue({ id: 'm1', path: '/user_profile.json' });
    vi.mocked(getMemoryFile).mockResolvedValue({
      id: 'm1',
      path: '/user_profile.json',
      content: 'old',
      content_sha256: 'sha',
    });
    vi.mocked(updateMemoryFile).mockResolvedValue({
      id: 'm1',
      path: '/user_profile.json',
      content: 'new',
    });
    const svc = new MemoryService(config, store);
    await expect(svc.writeUserMemory('token', '/user_profile.json', 'new')).resolves.toEqual({
      success: true,
      path: '/user_profile.json',
    });
    expect(updateMemoryFile).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: 'm1', content: 'new', contentSha256: 'sha' }),
    );
  });
});
