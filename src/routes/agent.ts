import { Router, type Request, type Response } from 'express';
import type { ChatService } from '../services/chatService.js';
import type { SessionService } from '../services/sessionService.js';

function requireNonEmptyString(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return `${field} is required`;
  return null;
}

export function createAgentRouter(deps: {
  chatService: ChatService;
  sessionService: SessionService;
}): Router {
  const router = Router();

  router.post('/chat', async (req: Request, res: Response) => {
    const tokenErr = requireNonEmptyString(req.body?.webUserToken, 'webUserToken');
    const msgErr = requireNonEmptyString(req.body?.userMessage, 'userMessage');
    if (tokenErr || msgErr) {
      return res.status(400).json({ error: tokenErr ?? msgErr });
    }

    try {
      await deps.chatService.streamChat(res, {
        webUserToken: req.body.webUserToken.trim(),
        userMessage: req.body.userMessage.trim(),
      });
    } catch (err) {
      if (!res.headersSent) {
        return res.status(503).json({
          error: err instanceof Error ? err.message : 'Chat failed',
        });
      }
      if (!res.writableEnded) res.end();
    }
  });

  router.post('/rebuild-session', async (req: Request, res: Response) => {
    const tokenErr = requireNonEmptyString(req.body?.webUserToken, 'webUserToken');
    if (tokenErr) return res.status(400).json({ error: tokenErr });

    try {
      const result = await deps.sessionService.rebuildSession(req.body.webUserToken.trim());
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(503).json({
        error: err instanceof Error ? err.message : 'Rebuild failed',
      });
    }
  });

  return router;
}
