import { createArkSession, ArkApiError } from '../clients/arkClient.js';
import {
  createVaultWithLeyoCredential,
  deleteVault,
  updateCredential,
} from '../clients/arkVaultClient.js';
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

  private async rollbackVaultArtifacts(tokenHash: string, vaultId: string): Promise<void> {
    try {
      await this.store.deleteSession(tokenHash);
    } catch {
      // 尽力回滚
    }
    try {
      await this.store.deleteVaultId(tokenHash);
    } catch {
      // 尽力回滚
    }
    try {
      await this.store.deleteCredentialId(tokenHash);
    } catch {
      // 尽力回滚
    }
    try {
      await deleteVault({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        vaultId,
      });
    } catch {
      // 尽力回滚
    }
  }

  private async createAndPersist(
    tokenHash: string,
    webUserToken: string,
  ): Promise<{ sessionId: string; vaultId: string; credentialId: string }> {
    const memoryStoreId = await this.memoryService.getOrCreateUserMemoryStore(tokenHash);
    // 两层 API：先空 Vault，再 credentials（不可在 POST /vaults 带 auth）
    const { vaultId, credentialId } = await createVaultWithLeyoCredential({
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
        vaultIds: [vaultId],
        resources: [buildMemoryStoreResource(memoryStoreId)],
      });
      try {
        await this.store.setSessionId(tokenHash, sessionId);
        await this.store.setVaultId(tokenHash, vaultId);
        await this.store.setCredentialId(tokenHash, credentialId);
      } catch (redisErr) {
        await this.rollbackVaultArtifacts(tokenHash, vaultId);
        throw redisErr;
      }
      return { sessionId, vaultId, credentialId };
    } catch (err) {
      await this.rollbackVaultArtifacts(tokenHash, vaultId);
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
      } catch (err) {
        console.warn('rebuildSession: deleteVault(old) failed', {
          vaultId: oldVaultId,
          err,
        });
      }
      await this.store.deleteVaultId(tokenHash);
      await this.store.deleteCredentialId(tokenHash);
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
    await this.store.deleteCredentialId(tokenHash);
    return { vaultId };
  }

  /** 更新已有 Vault 下唯一凭据的 secret_value，无需重建 Session。 */
  async updateCredentialForToken(webUserToken: string, newToken: string): Promise<{
    vaultId: string;
    credentialId: string;
  }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const vaultId = await this.store.getVaultId(tokenHash);
    const credentialId = await this.store.getCredentialId(tokenHash);
    if (!vaultId || !credentialId) {
      throw new ArkApiError('No vault/credential mapping', {
        code: 'NO_VAULT',
        status: 404,
      });
    }
    await updateCredential({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      vaultId,
      credentialId,
      secretValue: newToken,
    });
    return { vaultId, credentialId };
  }
}
