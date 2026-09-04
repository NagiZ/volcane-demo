import { Redis } from 'ioredis';

export const MEMORY_LOCK_TTL_SECONDS = 30;

function memoryKey(tokenHash: string): string {
  return `ark:user_memory:${tokenHash}`;
}

function lockKey(tokenHash: string): string {
  return `ark:user_memory:lock:${tokenHash}`;
}

/** tokenHash → memory_store_id 永久映射 */
export class UserMemoryRedisStore {
  constructor(private readonly redis: Redis) {}

  async getMemoryStoreId(tokenHash: string): Promise<string | null> {
    return this.redis.get(memoryKey(tokenHash));
  }

  /** 永久绑定：不设置 EX */
  async setMemoryStoreId(tokenHash: string, memoryStoreId: string): Promise<void> {
    await this.redis.set(memoryKey(tokenHash), memoryStoreId);
  }

  /** @returns true 表示抢到锁 */
  async tryAcquireCreateLock(tokenHash: string): Promise<boolean> {
    const result = await this.redis.set(
      lockKey(tokenHash),
      '1',
      'EX',
      MEMORY_LOCK_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  }

  async releaseCreateLock(tokenHash: string): Promise<void> {
    await this.redis.del(lockKey(tokenHash));
  }
}
