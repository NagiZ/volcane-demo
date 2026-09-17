import dotenv from 'dotenv';

dotenv.config();

export type StoreBackend = 'memory' | 'redis';

export interface AppConfig {
  arkApiKey: string;
  arkAgentId: string;
  arkBaseEnvironmentId: string;
  storeBackend: StoreBackend;
  redisUrl: string | null;
  port: number;
  arkBaseUrl: string;
}

const REQUIRED_KEYS = [
  'ARK_API_KEY',
  'ARK_AGENT_ID',
  'ARK_BASE_ENVIRONMENT_ID',
] as const;

const VALID_STORE_BACKENDS = ['auto', 'memory', 'redis'] as const;

export function loadConfig(): AppConfig {
  const missing = REQUIRED_KEYS.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }

  const mode = (process.env.STORE_BACKEND?.trim() || 'auto') as
    | (typeof VALID_STORE_BACKENDS)[number];
  if (!VALID_STORE_BACKENDS.includes(mode)) {
    throw new Error(
      `STORE_BACKEND must be one of: ${VALID_STORE_BACKENDS.join(', ')}`,
    );
  }

  const redisUrl = process.env.REDIS_URL?.trim() || null;
  const storeBackend: StoreBackend =
    mode === 'redis'
      ? 'redis'
      : mode === 'memory'
        ? 'memory'
        : redisUrl
          ? 'redis'
          : 'memory';

  if (storeBackend === 'redis' && !redisUrl) {
    throw new Error('REDIS_URL is required when STORE_BACKEND resolves to redis');
  }

  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('PORT must be a positive number');
  }

  return {
    arkApiKey: process.env.ARK_API_KEY!.trim(),
    arkAgentId: process.env.ARK_AGENT_ID!.trim(),
    arkBaseEnvironmentId: process.env.ARK_BASE_ENVIRONMENT_ID!.trim(),
    storeBackend,
    redisUrl,
    port,
    arkBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  };
}
