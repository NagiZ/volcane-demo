import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../clients/arkClient.js', () => ({
  createArkSession: vi.fn(),
}));

import { createArkSession } from '../clients/arkClient.js';
import { DEFAULT_MEMORY_INSTRUCTIONS } from '../clients/arkMemoryClient.js';
import type { AppConfig } from '../config.js';
import type { SessionStore } from '../store/sessionStore.js';
import type { MemoryService } from './memoryService.js';
import { SessionService } from './sessionService.js';

const config = {
  arkApiKey: 'k',
  arkBaseUrl: 'https://example.com/api/v3',
  arkAgentId: 'agent-1',
  arkBaseEnvironmentId: 'env-1',
} as AppConfig;

describe('SessionService memory mount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('create path passes memory_store resource to createArkSession', async () => {
    const store = {
      getSessionId: vi.fn().mockResolvedValue(null),
      setSessionId: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn(),
    } as unknown as SessionStore;
    const memoryService = {
      getOrCreateUserMemoryStore: vi.fn().mockResolvedValue('memstore-42'),
    } as unknown as MemoryService;
    vi.mocked(createArkSession).mockResolvedValue({ sessionId: 'sess-1' });

    const svc = new SessionService(config, store, memoryService);
    await expect(svc.getOrCreateSession('web-token')).resolves.toMatchObject({
      sessionId: 'sess-1',
    });

    expect(memoryService.getOrCreateUserMemoryStore).toHaveBeenCalled();
    expect(createArkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: [
          {
            type: 'memory_store',
            memory_store_id: 'memstore-42',
            instructions: DEFAULT_MEMORY_INSTRUCTIONS,
          },
        ],
      }),
    );
  });
});
