import { createArkSession } from '../clients/arkClient.js';
import type { AppConfig } from '../config.js';
import { SessionStore } from '../store/sessionStore.js';
import { resolveUserKey } from '../utils/hash.js';

export class SessionService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: SessionStore,
  ) {}

  private async createAndPersist(tokenHash: string, webUserToken: string): Promise<string> {
    const { sessionId } = await createArkSession({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      agentId: this.config.arkAgentId,
      baseEnvironmentId: this.config.arkBaseEnvironmentId,
      userId: tokenHash,
      userBearerToken: webUserToken,
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
