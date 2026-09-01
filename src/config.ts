import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  arkApiKey: string;
  arkAgentId: string;
  arkBaseEnvironmentId: string;
  redisUrl: string;
  port: number;
  arkBaseUrl: string;
}

const REQUIRED_KEYS = [
  'ARK_API_KEY',
  'ARK_AGENT_ID',
  'ARK_BASE_ENVIRONMENT_ID',
  'REDIS_URL',
] as const;

export function loadConfig(): AppConfig {
  const missing = REQUIRED_KEYS.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }

  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('PORT must be a positive number');
  }

  return {
    arkApiKey: process.env.ARK_API_KEY!.trim(),
    arkAgentId: process.env.ARK_AGENT_ID!.trim(),
    arkBaseEnvironmentId: process.env.ARK_BASE_ENVIRONMENT_ID!.trim(),
    redisUrl: process.env.REDIS_URL!.trim(),
    port,
    arkBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  };
}
