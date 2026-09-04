import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_INSTRUCTIONS,
  buildMemoryStoreResource,
  normalizeMemoryFile,
} from './arkMemoryClient.js';

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
});
