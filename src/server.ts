import { Redis } from 'ioredis';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ChatService } from './services/chatService.js';
import { FileService } from './services/fileService.js';
import { MemoryService } from './services/memoryService.js';
import { SessionService } from './services/sessionService.js';
import { UserMemoryRedisStore } from './store/memoryStore.js';
import { SessionStore } from './store/sessionStore.js';
import { registerBuiltinTools } from './tools/builtinTools.js';

async function main() {
  const config = loadConfig();
  registerBuiltinTools();
  const redis = new Redis(config.redisUrl);
  const sessionStore = new SessionStore(redis);
  const memoryRedisStore = new UserMemoryRedisStore(redis);
  const memoryService = new MemoryService(config, memoryRedisStore);
  const sessionService = new SessionService(config, sessionStore, memoryService);
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
