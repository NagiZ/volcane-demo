import { createArkSession } from '../clients/arkClient.js';
import { buildMemoryStoreResource } from '../clients/arkMemoryClient.js';
import type { AppConfig } from '../config.js';
import { SessionStore } from '../store/sessionStore.js';
import { resolveUserKey } from '../utils/hash.js';
import type { MemoryService } from './memoryService.js';

export class SessionService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: SessionStore,
    private readonly memoryService: MemoryService,
  ) {}

  private async createAndPersist(tokenHash: string, webUserToken: string): Promise<string> {
    const memoryStoreId = await this.memoryService.getOrCreateUserMemoryStore(tokenHash);
    const { sessionId } = await createArkSession({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      agentId: this.config.arkAgentId,
      baseEnvironmentId: this.config.arkBaseEnvironmentId,
      userId: tokenHash,
      vaultIds: [], // Task 4 替换为真实 vaultId
      resources: [buildMemoryStoreResource(memoryStoreId)],
    });
    await this.store.setSessionId(tokenHash, sessionId);
    return sessionId;
  }

  async getOrCreateSession(webUserToken: string): Promise<{ tokenHash: string; sessionId: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const existing = await this.store.getSessionId(tokenHash);
    if (existing) return { tokenHash, sessionId: existing };
    const sessionId = await this.createAndPersist(tokenHash, webUserToken);
    return { tokenHash, sessionId };
  }

  async getExistingSession(
    webUserToken: string,
  ): Promise<{ tokenHash: string; sessionId: string } | null> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const existing = await this.store.getSessionId(tokenHash);
    if (!existing) return null;
    return { tokenHash, sessionId: existing };
  }

  async rebuildSession(webUserToken: string): Promise<{ tokenHash: string; sessionId: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    await this.store.deleteSession(tokenHash);
    const sessionId = await this.createAndPersist(tokenHash, webUserToken);
    return { tokenHash, sessionId };
  }

  async invalidateAndRecreate(webUserToken: string): Promise<{ tokenHash: string; sessionId: string }> {
    return this.rebuildSession(webUserToken);
  }
}
