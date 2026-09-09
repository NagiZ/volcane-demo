import { createArkSession, ArkApiError } from '../clients/arkClient.js';
import { createEnvVault, deleteVault } from '../clients/arkVaultClient.js';
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

  private async createAndPersist(
    tokenHash: string,
    webUserToken: string,
  ): Promise<{ sessionId: string; vaultId: string }> {
    const memoryStoreId = await this.memoryService.getOrCreateUserMemoryStore(tokenHash);
    const { vaultId } = await createEnvVault({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      secretValue: webUserToken,
    });
    try {
      const { sessionId } = await createArkSession({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        agentId: this.config.arkAgentId,
        baseEnvironmentId: this.config.arkBaseEnvironmentId,
        userId: tokenHash,
        vaultIds: [vaultId],
        resources: [buildMemoryStoreResource(memoryStoreId)],
      });
      await this.store.setSessionId(tokenHash, sessionId);
      await this.store.setVaultId(tokenHash, vaultId);
      return { sessionId, vaultId };
    } catch (err) {
      try {
        await deleteVault({
          arkApiKey: this.config.arkApiKey,
          arkBaseUrl: this.config.arkBaseUrl,
          vaultId,
        });
      } catch {
        // 尽力回滚
      }
      throw err;
    }
  }

  async getOrCreateSession(
    webUserToken: string,
  ): Promise<{ tokenHash: string; sessionId: string; vaultId?: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const existing = await this.store.getSessionId(tokenHash);
    if (existing) return { tokenHash, sessionId: existing };
    const { sessionId, vaultId } = await this.createAndPersist(tokenHash, webUserToken);
    return { tokenHash, sessionId, vaultId };
  }

  async getExistingSession(
    webUserToken: string,
  ): Promise<{ tokenHash: string; sessionId: string } | null> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const existing = await this.store.getSessionId(tokenHash);
    if (!existing) return null;
    return { tokenHash, sessionId: existing };
  }

  async rebuildSession(
    webUserToken: string,
  ): Promise<{ tokenHash: string; sessionId: string; vaultId: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const oldVaultId = await this.store.getVaultId(tokenHash);
    if (oldVaultId) {
      try {
        await deleteVault({
          arkApiKey: this.config.arkApiKey,
          arkBaseUrl: this.config.arkBaseUrl,
          vaultId: oldVaultId,
        });
      } catch {
        // 尽力删除旧 Vault
      }
      await this.store.deleteVaultId(tokenHash);
    }
    await this.store.deleteSession(tokenHash);
    const { sessionId, vaultId } = await this.createAndPersist(tokenHash, webUserToken);
    return { tokenHash, sessionId, vaultId };
  }

  async invalidateAndRecreate(
    webUserToken: string,
  ): Promise<{ tokenHash: string; sessionId: string; vaultId: string }> {
    return this.rebuildSession(webUserToken);
  }

  async deleteVaultForToken(webUserToken: string): Promise<{ vaultId: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const vaultId = await this.store.getVaultId(tokenHash);
    if (!vaultId) {
      throw new ArkApiError('No vault mapping', { code: 'NO_VAULT', status: 404 });
    }
    await deleteVault({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      vaultId,
    });
    await this.store.deleteVaultId(tokenHash);
    return { vaultId };
  }
}
