import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../clients/arkClient.js', () => ({
  createArkSession: vi.fn(),
  ArkApiError: class ArkApiError extends Error {
    status?: number;
    code?: string;
    constructor(message: string, options?: { status?: number; code?: string }) {
      super(message);
      this.status = options?.status;
      this.code = options?.code;
    }
  },
}));

vi.mock('../clients/arkVaultClient.js', () => ({
  createEnvVault: vi.fn(),
  deleteVault: vi.fn(),
}));

import { createArkSession } from '../clients/arkClient.js';
import { createEnvVault, deleteVault } from '../clients/arkVaultClient.js';
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

function makeStore(overrides: Partial<SessionStore> = {}) {
  return {
    getSessionId: vi.fn().mockResolvedValue(null),
    setSessionId: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    getVaultId: vi.fn().mockResolvedValue(null),
    setVaultId: vi.fn().mockResolvedValue(undefined),
    deleteVaultId: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SessionStore;
}

describe('SessionService vault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('create path creates vault, passes vaultIds, stores mapping', async () => {
    const store = makeStore();
    const memoryService = {
      getOrCreateUserMemoryStore: vi.fn().mockResolvedValue('memstore-42'),
    } as unknown as MemoryService;
    vi.mocked(createEnvVault).mockResolvedValue({ vaultId: 'vault-1' });
    vi.mocked(createArkSession).mockResolvedValue({ sessionId: 'sess-1' });

    const svc = new SessionService(config, store, memoryService);
    const result = await svc.getOrCreateSession('web-token');

    expect(result).toMatchObject({ sessionId: 'sess-1', vaultId: 'vault-1' });
    expect(createEnvVault).toHaveBeenCalledWith(
      expect.objectContaining({ secretValue: 'web-token' }),
    );
    expect(createArkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultIds: ['vault-1'],
        resources: [
          {
            type: 'memory_store',
            memory_store_id: 'memstore-42',
            instructions: DEFAULT_MEMORY_INSTRUCTIONS,
          },
        ],
      }),
    );
    expect(createArkSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ userBearerToken: expect.anything() }),
    );
    expect(store.setVaultId).toHaveBeenCalled();
    expect(store.setSessionId).toHaveBeenCalled();
  });

  it('rolls back vault when createArkSession fails', async () => {
    const store = makeStore();
    const memoryService = {
      getOrCreateUserMemoryStore: vi.fn().mockResolvedValue('memstore-42'),
    } as unknown as MemoryService;
    vi.mocked(createEnvVault).mockResolvedValue({ vaultId: 'vault-1' });
    vi.mocked(createArkSession).mockRejectedValue(new Error('boom'));
    vi.mocked(deleteVault).mockResolvedValue(undefined);

    const svc = new SessionService(config, store, memoryService);
    await expect(svc.getOrCreateSession('web-token')).rejects.toThrow('boom');
    expect(deleteVault).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: 'vault-1' }),
    );
    expect(store.setSessionId).not.toHaveBeenCalled();
  });

  it('deleteVaultForToken deletes upstream and vault map only', async () => {
    const store = makeStore({
      getVaultId: vi.fn().mockResolvedValue('vault-1'),
    });
    const memoryService = {} as MemoryService;
    vi.mocked(deleteVault).mockResolvedValue(undefined);

    const svc = new SessionService(config, store, memoryService);
    await expect(svc.deleteVaultForToken('web-token')).resolves.toEqual({
      vaultId: 'vault-1',
    });
    expect(deleteVault).toHaveBeenCalled();
    expect(store.deleteVaultId).toHaveBeenCalled();
    expect(store.deleteSession).not.toHaveBeenCalled();
  });
});
