import { Redis } from 'ioredis';

export const SESSION_TTL_SECONDS = 25 * 24 * 60 * 60;

function redisKey(tokenHash: string): string {
  return `ark:session:map:${tokenHash}`;
}

export class SessionStore {
  constructor(private readonly redis: Redis) {}

  async getSessionId(tokenHash: string): Promise<string | null> {
    return this.redis.get(redisKey(tokenHash));
  }

  async setSessionId(tokenHash: string, sessionId: string): Promise<void> {
    await this.redis.set(redisKey(tokenHash), sessionId, 'EX', SESSION_TTL_SECONDS);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.redis.del(redisKey(tokenHash));
  }
}
