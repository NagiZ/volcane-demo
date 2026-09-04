import cors from 'cors';
import express from 'express';
import type { AppConfig } from './config.js';
import { createAgentRouter } from './routes/agent.js';
import type { ChatService } from './services/chatService.js';
import type { FileService } from './services/fileService.js';
import type { MemoryService } from './services/memoryService.js';
import type { SessionService } from './services/sessionService.js';

export function createApp(deps: {
  config: AppConfig;
  chatService: ChatService;
  sessionService: SessionService;
  fileService: FileService;
  memoryService: MemoryService;
}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/agent', createAgentRouter(deps));
  return app;
}
