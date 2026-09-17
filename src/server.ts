import { Redis } from 'ioredis';
import { createApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { ChatService } from './services/chatService.js';
import { FileService } from './services/fileService.js';
import { MemoryService } from './services/memoryService.js';
import { SessionService } from './services/sessionService.js';
import { UserMemoryRedisStore, type UserMemoryStore } from './store/memoryStore.js';
import { InMemorySessionStore, InMemoryUserMemoryStore } from './store/inMemoryStores.js';
import { SessionStore, type SessionMapStore } from './store/sessionStore.js';
import { registerBuiltinTools } from './tools/builtinTools.js';

interface Stores {
  sessionStore: SessionMapStore;
  userMemoryStore: UserMemoryStore;
  redis: Redis | null;
}

async function createStores(config: AppConfig): Promise<Stores> {
  if (config.storeBackend === 'memory') {
    console.warn(
      '[store] STORE_BACKEND=memory：使用进程内内存存储，重启后会话/记忆映射丢失，仅限本地调试',
    );
    return {
      sessionStore: new InMemorySessionStore(),
      userMemoryStore: new InMemoryUserMemoryStore(),
      redis: null,
    };
  }

  const redis = new Redis(config.redisUrl ?? '', {
    lazyConnect: true,
    retryStrategy: () => null,
  });
  redis.on('error', (err) => console.error('[redis] error:', err.message));
  try {
    await redis.connect();
  } catch (err) {
    redis.disconnect();
    throw new Error(
      `无法连接 Redis（${config.redisUrl}）：${err instanceof Error ? err.message : err}。` +
        '请先 `docker compose up -d` 启动 Redis，或将 .env 中 STORE_BACKEND 设为 memory 进行无 Docker 调试',
    );
  }
  return {
    sessionStore: new SessionStore(redis),
    userMemoryStore: new UserMemoryRedisStore(redis),
    redis,
  };
}

async function main() {
  const config = loadConfig();
  registerBuiltinTools();
  const stores = await createStores(config);
  const memoryService = new MemoryService(config, stores.userMemoryStore);
  const sessionService = new SessionService(config, stores.sessionStore, memoryService);
  const chatService = new ChatService(config, sessionService);
  const fileService = new FileService(config, sessionService);

  const app = createApp({ config, chatService, sessionService, fileService, memoryService });
  const server = app.listen(config.port, () => {
    // DEBUG: 仅打印端口；禁止打印密钥
    console.log(`Server listening on http://127.0.0.1:${config.port}`);
  });
  // Node 18+ 默认 requestTimeout=300000；SSE 长对话需关闭这些限制
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
