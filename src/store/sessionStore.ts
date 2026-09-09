import { Redis } from 'ioredis';

export const SESSION_TTL_SECONDS = 25 * 24 * 60 * 60;

function redisKey(tokenHash: string): string {
  return `ark:session:map:${tokenHash}`;
}

function vaultRedisKey(tokenHash: string): string {
  return `ark:vault:map:${tokenHash}`;
}

function credentialRedisKey(tokenHash: string): string {
  return `ark:vault:cred:${tokenHash}`;
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

  async getVaultId(tokenHash: string): Promise<string | null> {
    return this.redis.get(vaultRedisKey(tokenHash));
  }

  async setVaultId(tokenHash: string, vaultId: string): Promise<void> {
    await this.redis.set(vaultRedisKey(tokenHash), vaultId, 'EX', SESSION_TTL_SECONDS);
  }

  async deleteVaultId(tokenHash: string): Promise<void> {
    await this.redis.del(vaultRedisKey(tokenHash));
  }

  async getCredentialId(tokenHash: string): Promise<string | null> {
    return this.redis.get(credentialRedisKey(tokenHash));
  }

  async setCredentialId(tokenHash: string, credentialId: string): Promise<void> {
    await this.redis.set(credentialRedisKey(tokenHash), credentialId, 'EX', SESSION_TTL_SECONDS);
  }

  async deleteCredentialId(tokenHash: string): Promise<void> {
    await this.redis.del(credentialRedisKey(tokenHash));
  }
}
