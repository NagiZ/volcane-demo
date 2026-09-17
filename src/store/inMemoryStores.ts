import { MEMORY_LOCK_TTL_SECONDS, type UserMemoryStore } from './memoryStore.js';
import { SESSION_TTL_SECONDS, type SessionMapStore } from './sessionStore.js';

interface ExpiringEntry {
  value: string;
  expiresAt: number | null;
}

/** 进程内会话映射：重启丢失，仅用于本地无 Redis 调试 */
export class InMemorySessionStore implements SessionMapStore {
  private readonly sessions = new Map<string, ExpiringEntry>();

  async getSessionId(tokenHash: string): Promise<string | null> {
    const entry = this.sessions.get(tokenHash);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.sessions.delete(tokenHash);
      return null;
    }
    return entry.value;
  }

  async setSessionId(tokenHash: string, sessionId: string): Promise<void> {
    this.sessions.set(tokenHash, {
      value: sessionId,
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    });
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }
}

/** 进程内记忆库映射 + 创建锁：重启丢失，仅用于本地无 Redis 调试 */
export class InMemoryUserMemoryStore implements UserMemoryStore {
  private readonly mappings = new Map<string, string>();
  private readonly locks = new Map<string, number>();

  async getMemoryStoreId(tokenHash: string): Promise<string | null> {
    return this.mappings.get(tokenHash) ?? null;
  }

  async setMemoryStoreId(tokenHash: string, memoryStoreId: string): Promise<void> {
    this.mappings.set(tokenHash, memoryStoreId);
  }

  async tryAcquireCreateLock(tokenHash: string): Promise<boolean> {
    const now = Date.now();
    const expiresAt = this.locks.get(tokenHash);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.locks.set(tokenHash, now + MEMORY_LOCK_TTL_SECONDS * 1000);
    return true;
  }

  async releaseCreateLock(tokenHash: string): Promise<void> {
    this.locks.delete(tokenHash);
  }
}
