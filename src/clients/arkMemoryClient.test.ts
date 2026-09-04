import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MEMORY_INSTRUCTIONS,
  buildMemoryStoreResource,
  createMemoryStore,
  getMemoryStoreInfo,
  listMemoryFiles,
  normalizeMemoryFile,
} from './arkMemoryClient.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildMemoryStoreResource', () => {
  it('builds memory_store resource', () => {
    expect(buildMemoryStoreResource('memstore-1')).toEqual({
      type: 'memory_store',
      memory_store_id: 'memstore-1',
      instructions: DEFAULT_MEMORY_INSTRUCTIONS,
    });
    expect(buildMemoryStoreResource('memstore-1', 'custom')).toMatchObject({
      instructions: 'custom',
    });
  });
});

describe('normalizeMemoryFile', () => {
  it('normalizes id/path/content', () => {
    expect(
      normalizeMemoryFile({
        id: 'mem-1',
        path: '/user_profile.json',
        content: '{}',
        updated_at: '2026-01-01T00:00:00Z',
        content_sha256: 'abc',
      }),
    ).toEqual({
      id: 'mem-1',
      path: '/user_profile.json',
      content: '{}',
      updated_at: '2026-01-01T00:00:00Z',
      content_sha256: 'abc',
    });
    expect(normalizeMemoryFile(null)).toBeNull();
  });

  it('accepts memory_id as id alias', () => {
    expect(
      normalizeMemoryFile({
        memory_id: 'mem-alias',
        path: '/user_profile.json',
        content: '{}',
      }),
    ).toMatchObject({ id: 'mem-alias', path: '/user_profile.json' });
  });
});

describe('listMemoryFiles id asymmetry', () => {
  it('accepts id or memory_id on list items', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        data: [
          { id: 'm1', path: '/a.json' },
          { memory_id: 'm2', path: '/b.json' },
          { path: '/missing-id.json' },
        ],
      },
    });

    const files = await listMemoryFiles({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      memoryStoreId: 'store-1',
    });

    expect(files).toEqual([
      { id: 'm1', path: '/a.json' },
      { id: 'm2', path: '/b.json' },
    ]);
  });
});

describe('memory store id aliases', () => {
  it('createMemoryStore accepts memory_store_id', async () => {
    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      data: { memory_store_id: 'store-from-alias' },
    });
    await expect(
      createMemoryStore({
        arkApiKey: 'k',
        arkBaseUrl: 'https://example.com/api/v3',
        name: 'n',
        description: 'd',
      }),
    ).resolves.toEqual({ id: 'store-from-alias' });
  });

  it('getMemoryStoreInfo accepts memory_store_id', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: { memory_store_id: 'store-from-alias', name: 'named' },
    });
    await expect(
      getMemoryStoreInfo({
        arkApiKey: 'k',
        arkBaseUrl: 'https://example.com/api/v3',
        memoryStoreId: 'store-from-alias',
      }),
    ).resolves.toEqual({ id: 'store-from-alias', name: 'named' });
  });
});
