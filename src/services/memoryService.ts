import { ArkApiError } from '../clients/arkClient.js';
import {
  createMemoryFile,
  createMemoryStore,
  findMemoryByPath,
  getMemoryFile,
  updateMemoryFile,
} from '../clients/arkMemoryClient.js';
import type { AppConfig } from '../config.js';
import { UserMemoryRedisStore } from '../store/memoryStore.js';
import { resolveUserKey } from '../utils/hash.js';
import { normalizeMemoryPath } from '../utils/memoryPath.js';

const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class MemoryService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: UserMemoryRedisStore,
  ) {}

  async getOrCreateUserMemoryStore(tokenHash: string): Promise<string> {
    const existing = await this.store.getMemoryStoreId(tokenHash);
    if (existing) return existing;

    const locked = await this.store.tryAcquireCreateLock(tokenHash);
    if (!locked) {
      const waited = await this.waitForMemoryStoreId(tokenHash, LOCK_WAIT_MS);
      if (waited) return waited;
      throw new ArkApiError('memory store 创建中，请重试', {
        status: 503,
        code: 'MEMORY_LOCK_TIMEOUT',
      });
    }

    try {
      const again = await this.store.getMemoryStoreId(tokenHash);
      if (again) return again;

      const name = `user_memory_${tokenHash.slice(0, 16)}`;
      const description = `用户 ${tokenHash.slice(0, 8)} 专属持久化记忆库`;
      console.log(`[memory] creating store for hash=${tokenHash.slice(0, 8)} name=${name}`);
      const { id } = await createMemoryStore({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        name,
        description,
      });
      await this.store.setMemoryStoreId(tokenHash, id);
      console.log(`[memory] created store id=${id} hash=${tokenHash.slice(0, 8)}`);
      return id;
    } catch (err) {
      console.error(
        `[memory] create failed hash=${tokenHash.slice(0, 8)}:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    } finally {
      await this.store.releaseCreateLock(tokenHash);
    }
  }

  private async waitForMemoryStoreId(
    tokenHash: string,
    timeoutMs: number,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const id = await this.store.getMemoryStoreId(tokenHash);
      if (id) return id;
      await sleep(LOCK_POLL_MS);
    }
    return null;
  }

  async readUserMemory(
    webUserToken: string,
    filePath?: string,
  ): Promise<{ path: string; content: string; updated_at: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const path = normalizeMemoryPath(filePath);
    const memoryStoreId = await this.getOrCreateUserMemoryStore(tokenHash);
    const found = await findMemoryByPath({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      memoryStoreId,
      path,
    });
    if (!found) {
      throw new ArkApiError('memory file not found', {
        status: 404,
        code: 'MEMORY_NOT_FOUND',
      });
    }
    const file = await getMemoryFile({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      memoryStoreId,
      memoryId: found.id,
    });
    return {
      path: file.path,
      content: file.content,
      updated_at: file.updated_at ?? '',
    };
  }

  async writeUserMemory(
    webUserToken: string,
    filePath: string | undefined,
    content: string,
  ): Promise<{ success: true; path: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const path = normalizeMemoryPath(filePath);
    const memoryStoreId = await this.getOrCreateUserMemoryStore(tokenHash);
    const found = await findMemoryByPath({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      memoryStoreId,
      path,
    });

    if (!found) {
      await createMemoryFile({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        memoryStoreId,
        path,
        content,
      });
      return { success: true, path };
    }

    await this.updateWithOptionalRetry(memoryStoreId, found.id, content);
    return { success: true, path };
  }

  private async updateWithOptionalRetry(
    memoryStoreId: string,
    memoryId: string,
    content: string,
  ): Promise<void> {
    const current = await getMemoryFile({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      memoryStoreId,
      memoryId,
    });
    try {
      await updateMemoryFile({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        memoryStoreId,
        memoryId,
        content,
        contentSha256: current.content_sha256,
      });
    } catch (err) {
      const status = err instanceof ArkApiError ? err.status : undefined;
      if (status !== 409 && status !== 412 && status !== 400) throw err;
      const fresh = await getMemoryFile({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        memoryStoreId,
        memoryId,
      });
      await updateMemoryFile({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        memoryStoreId,
        memoryId,
        content,
        contentSha256: fresh.content_sha256,
      });
    }
  }
}
